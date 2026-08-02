/**
 * Skycare YKF — Quota Tracker Worker
 * Runs every 15 minutes via Cloudflare Cron.
 * Queries Google Cloud Monitoring for Firestore & Storage usage,
 * then writes the results to Firestore adminStats/quota so admin.html can read them.
 *
 * Environment variables required (set in Cloudflare dashboard → Worker → Settings → Variables):
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — full JSON content of the service account key file
 */

const PROJECT_ID   = 'groomer-ykf';
const FIRESTORE_DB = '(default)';

// ── JWT / OAuth ──────────────────────────────────────────────────────────────

function b64url(input) {
  const str = typeof input === 'string'
    ? input
    : String.fromCharCode(...new Uint8Array(input));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function importPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey(
    'pkcs8', buf.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

async function getAccessToken(serviceAccountJson) {
  const sa  = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/datastore',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }));

  const sigInput = `${header}.${payload}`;
  const key      = await importPrivateKey(sa.private_key);
  const sig      = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(sigInput)
  );
  const jwt = `${sigInput}.${b64url(sig)}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

// ── CLOUD MONITORING ─────────────────────────────────────────────────────────

async function queryMetric(token, metricType, aligner = 'ALIGN_SUM') {
  const now      = new Date();
  // For GAUGE metrics (storage sizes) use the last hour; for DELTA (counts) use since midnight
  const isDelta  = aligner === 'ALIGN_SUM';
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const startTime = isDelta
    ? midnight.toISOString()
    : new Date(now - 3_600_000).toISOString();

  const params = new URLSearchParams({
    filter:                           `metric.type="${metricType}" AND resource.labels.project_id="${PROJECT_ID}"`,
    'interval.startTime':             startTime,
    'interval.endTime':               now.toISOString(),
    'aggregation.alignmentPeriod':    '86400s',
    'aggregation.perSeriesAligner':   aligner,
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    'aggregation.groupByFields':      'resource.label.project_id',
  });

  const res  = await fetch(
    `https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();

  if (!data.timeSeries?.length) return 0;
  const point = data.timeSeries[0].points?.[0];
  if (!point) return 0;
  const v = point.value;
  return Number(v.int64Value ?? v.doubleValue ?? v.int32Value ?? 0);
}

// ── FIRESTORE WRITE (REST) ───────────────────────────────────────────────────

async function writeToFirestore(token, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${FIRESTORE_DB}/documents/adminStats/quota`;

  const fsFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') fsFields[k] = { doubleValue: v };
    else                       fsFields[k] = { stringValue: String(v) };
  }

  const res = await fetch(url, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields: fsFields }),
  });
  if (!res.ok) throw new Error(`Firestore write failed: ${await res.text()}`);
}

// ── MAIN RUN ─────────────────────────────────────────────────────────────────

async function run(env) {
  const token = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_KEY);

  const [reads, writes, deletes, fsDocBytes, fsIdxBytes, gcsBytes] = await Promise.all([
    queryMetric(token, 'firestore.googleapis.com/document/read_count',   'ALIGN_SUM'),
    queryMetric(token, 'firestore.googleapis.com/document/write_count',  'ALIGN_SUM'),
    queryMetric(token, 'firestore.googleapis.com/document/delete_count', 'ALIGN_SUM'),
    queryMetric(token, 'firestore.googleapis.com/storage/document_size', 'ALIGN_MEAN'),
    queryMetric(token, 'firestore.googleapis.com/storage/index_size',    'ALIGN_MEAN'),
    queryMetric(token, 'storage.googleapis.com/storage/total_bytes',     'ALIGN_MEAN'),
  ]);

  await writeToFirestore(token, {
    reads_today:     reads,
    writes_today:    writes,
    deletes_today:   deletes,
    firestore_bytes: fsDocBytes + fsIdxBytes,
    storage_bytes:   gcsBytes,
    updated_at:      new Date().toISOString(),
  });

  return { reads, writes, deletes, fsDocBytes, fsIdxBytes, gcsBytes };
}

// ── EXPORTS ──────────────────────────────────────────────────────────────────

export default {
  // Cron trigger — add "*/15 * * * *" in Cloudflare dashboard → Worker → Triggers → Cron
  async scheduled(event, env) {
    await run(env);
  },

  // HTTP trigger — visit the Worker URL to force an immediate refresh
  async fetch(request, env) {
    try {
      const result = await run(env);
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), ...result }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }, null, 2), {
        status:  500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
