// Skycare YKF — Fleet 25 nm arrival alert
// Runs every 5 minutes via GitHub Actions.
// Sends a push notification when a fleet aircraft crosses inside 25 nm of CYKF.
// Firestore collection `fleetNotifications/{tail}` tracks last-notified state
// so each inbound arrival fires exactly once.

const admin   = require('firebase-admin');
const webpush = require('web-push');
const https   = require('https');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

webpush.setVapidDetails(
  'mailto:aristihernandez@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Config ──────────────────────────────────────────────────────────────────
const CYKF_LAT = 43.4601;
const CYKF_LON = -80.3782;
const ALERT_NM = 25;
const RESET_NM = 50;   // re-arm the alert once aircraft goes beyond this
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2-hour cooldown per tail

const FLEET = [
  { reg: 'C-FIOC', tail: 'IOC', type: 'Metroliner' },
  { reg: 'C-FIOE', tail: 'IOE', type: 'Metroliner' },
  { reg: 'C-FIOJ', tail: 'IOJ', type: 'Metroliner' },
  { reg: 'C-FIOA', tail: 'IOA', type: 'Metroliner' },
  { reg: 'C-FIOB', tail: 'IOB', type: 'Metroliner' },
  { reg: 'C-FIOH', tail: 'IOH', type: 'Metroliner' },
  { reg: 'C-GIAW', tail: 'IAW', type: 'Westwind'   },
  { reg: 'C-FXAW', tail: 'XAW', type: 'Westwind'   },
  { reg: 'C-FXDP', tail: 'XDP', type: 'Westwind'   },
  { reg: 'C-FDAX', tail: 'DAX', type: 'Astra'      },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function etaStr(distNm, speedKts) {
  if (!speedKts || speedKts < 20) return null;
  const mins = Math.round(distNm / speedKts * 60);
  if (mins < 60) return mins + ' min';
  return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

function fetchOpenSky() {
  return new Promise((resolve, reject) => {
    const url = 'https://opensky-network.org/api/states/all?lamin=42.0&lomin=-82.5&lamax=45.0&lomax=-78.0';
    https.get(url, { headers: { 'User-Agent': 'SkycarYKF-FleetAlert/1.0' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function matchCallsign(callsign) {
  if (!callsign) return null;
  const cs = callsign.trim().toUpperCase().replace(/\s/g, '');
  return FLEET.find(a => {
    const reg = a.reg.replace('-', '').toUpperCase();
    return cs === reg || cs.endsWith(a.tail);
  }) || null;
}

async function sendToAll(title, body, tag) {
  const snap = await db.collection('pushSubscriptions').get();
  const subs = snap.docs.map(d => d.data().sub).filter(Boolean);
  if (!subs.length) { console.log('No subscribers'); return; }

  const payload = JSON.stringify({
    title,
    body,
    icon:  'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    badge: 'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    tag,
    url:   'https://aristihernandez-svg.github.io/groomers-ykf/',
  });

  const results = await Promise.allSettled(subs.map(s => webpush.sendNotification(s, payload)));
  const ok   = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  console.log(`Push sent — ${ok} ok, ${fail} failed`);

  // Clean up expired subscriptions
  const stale = [];
  snap.docs.forEach((doc, i) => {
    const r = results[i];
    if (r.status === 'rejected') {
      const status = r.reason?.statusCode;
      if (status === 404 || status === 410) stale.push(doc.id);
    }
  });
  if (stale.length) {
    const batch = db.batch();
    stale.forEach(id => batch.delete(db.collection('pushSubscriptions').doc(id)));
    await batch.commit();
    console.log(`Removed ${stale.length} expired subscription(s)`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching OpenSky for fleet...');
  let data;
  try { data = await fetchOpenSky(); } catch(e) { console.error('OpenSky error:', e.message); process.exit(0); }

  const states = data?.states || [];
  console.log(`Got ${states.length} state vectors in bounding box`);

  // Build live positions for fleet aircraft
  const live = {};
  states.forEach(s => {
    const ac = matchCallsign(s[1]);
    if (!ac) return;
    const lat = s[6], lon = s[5];
    if (lat == null || lon == null) return;
    const distNm  = Math.round(haversineNm(lat, lon, CYKF_LAT, CYKF_LON));
    const speedKts = s[9] ? Math.round(s[9] * 1.944) : null;
    const altFt    = s[7] ? Math.round(s[7] * 3.28084) : null;
    const onGround = !!s[8];
    live[ac.tail] = { ...ac, lat, lon, distNm, speedKts, altFt, onGround };
  });
  console.log('Fleet found:', Object.keys(live).join(', ') || 'none');

  // Check each live aircraft against alert rules
  const now = Date.now();
  for (const [tail, ac] of Object.entries(live)) {
    if (ac.onGround) continue; // ground aircraft don't trigger inbound alert

    const ref  = db.collection('fleetNotifications').doc(tail);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;

    if (ac.distNm <= ALERT_NM) {
      // Within 25 nm — should we notify?
      const lastNotified = prev?.notifiedAt?.toMillis?.() || 0;
      const alreadyActive = prev?.active === true;

      if (!alreadyActive && (now - lastNotified) > COOLDOWN_MS) {
        // Fire the alert
        const eta  = etaStr(ac.distNm, ac.speedKts);
        const body = [
          `${ac.distNm} nm from CYKF`,
          ac.altFt ? ac.altFt.toLocaleString() + ' ft' : null,
          ac.speedKts ? ac.speedKts + ' KTS' : null,
          eta ? 'ETA ' + eta : null,
        ].filter(Boolean).join(' · ');

        console.log(`ALERT: ${ac.reg} — ${body}`);
        await sendToAll(`✈ ${ac.reg} approaching CYKF`, body, `fleet-${tail}`);
        await ref.set({ notifiedAt: admin.firestore.FieldValue.serverTimestamp(), active: true, distNm: ac.distNm });
      } else {
        console.log(`${ac.reg}: within 25nm but alert already active or in cooldown`);
      }

    } else if (ac.distNm > RESET_NM && prev?.active) {
      // Aircraft moved beyond 50 nm — reset so next inbound fires again
      console.log(`${ac.reg}: beyond ${RESET_NM} nm — resetting alert`);
      await ref.set({ active: false, distNm: ac.distNm, resetAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } else {
      console.log(`${ac.reg}: ${ac.distNm} nm — no action needed`);
    }
  }

  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
