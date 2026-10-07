// Skycare YKF — Fleet 60 nm arrival alert
// Runs every minute via GitHub Actions (triggered by cron-job.org), 6 AM – 8 PM Eastern only.
// Sends a push notification when a fleet aircraft crosses inside 60 nm of CYKF.
// Firestore collection `fleetNotifications/{tail}` tracks last-notified state
// so each inbound arrival fires exactly once. A plane must also be getting closer and not
// climbing since the last run (fleet-motion.js) — departures turning back over the field used to alert.

const admin   = require('firebase-admin');
const webpush = require('web-push');
const https   = require('https');
const { comingOrGoing } = require('./fleet-motion');

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
const ALERT_NM = 60;
const RESET_NM = 120;  // re-arm the alert once aircraft goes beyond this (or lands)
const COOLDOWN_MS = 15 * 60 * 1000; // minimum gap between two alerts for the same tail
// A sent alert counts as "this arrival" for at most an hour. Landings often go unseen
// (transponder off before a ground report), and without this the next arrival never alerted.
const ALERT_EXPIRE_MS = 60 * 60 * 1000;
const MIN_ALERT_NM = 5;             // inside this it's departing or over the field, not "approaching"
const INBOUND_TOL_DEG = 75;         // heading must point within this of the airport to count as inbound
const MAX_AGE_S = 180;              // ignore positions older than this
// Live tracking only runs 6 AM – 8 PM Eastern (the apps say so overnight). Outside it the job
// makes no requests at all — not OpenSky, not adsb.lol, not Firestore.
const TRACK_FROM_H = 6, TRACK_TO_H = 20;
function easternHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(d));
}
const PREV_MAX_AGE_MS = 15 * 60 * 1000; // last run's positions older than this are too stale to compare with

// YAV (St. Andrews) gets its own alert, measured only from CYAV, sent to the
// YAV app's own subscribers (skycare-yav) with YAV's own push key.
const CYAV_LAT = 50.0564;
const CYAV_LON = -97.0325;
const YAV_ALERT_NM = 40;
const YAV_RESET_NM = 80;
const YAV_VAPID_PUBLIC = 'BL-9QbyPlFMPIv8T_C_aeM4MTkv2Mb9ogKZLlQjk9IJeHbCGYNJKlThwgJyqdxbuDdCGQf7dR5sDeNSEyNsgAVA';
const YAV_APP = 'https://aristihernandez-svg.github.io/groomers-yav/';

// Canadian registrations map to ICAO24 (Mode S) addresses arithmetically:
// C-FAAA = C00001, C-GAAA = C00001 + 26^3. Checked against 64 live Canadian aircraft.
function icao24For(reg) {
  const L = c => c.charCodeAt(0) - 65;
  const s = reg.replace('-', '');
  const base = s[1] === 'F' ? 0 : 17576;
  return (0xC00001 + base + L(s[2]) * 676 + L(s[3]) * 26 + L(s[4])).toString(16);
}

// cs = call signs the crews actually use (matched exactly, spaces ignored)
const FLEET = [
  { reg: 'C-FIOC', tail: 'IOC', type: 'Metroliner', cs: ['PHX632'] },
  { reg: 'C-FIOE', tail: 'IOE', type: 'Metroliner', cs: ['PHX706'] },
  { reg: 'C-FIOJ', tail: 'IOJ', type: 'Metroliner', cs: ['PHX594'] },
  { reg: 'C-FIOA', tail: 'IOA', type: 'Metroliner', cs: ['PHX680'] },
  { reg: 'C-FIOB', tail: 'IOB', type: 'Metroliner', cs: ['PHX614'] },
  { reg: 'C-FIOH', tail: 'IOH', type: 'Metroliner', cs: ['PHX432'] },
  { reg: 'C-GTIM', tail: 'TIM', type: 'Metroliner', cs: ['PHX274'] },
  { reg: 'C-GCPX', tail: 'CPX', type: 'Metroliner', cs: ['PHX11']  },
  { reg: 'C-GKKC', tail: 'KKC', type: 'Metroliner', cs: ['PHX370'] },
  { reg: 'C-FXAW', tail: 'XAW', type: 'Westwind',   cs: ['PHX280'] },
  { reg: 'C-FXDP', tail: 'XDP', type: 'Westwind',   cs: ['PHX303'] },
  { reg: 'C-FDAX', tail: 'DAX', type: 'Astra',      cs: ['PHX58']  },
  { reg: 'C-FAJR', tail: 'AJR', type: 'Navajo',     cs: ['PHX410'] },
  { reg: 'C-FAQR', tail: 'AQR', type: 'Navajo',     cs: ['PHX411'] },
  { reg: 'C-FTJX', tail: 'TJX', type: 'Navajo',     cs: ['PHX412'] },
  { reg: 'C-GCJH', tail: 'CJH', type: 'Navajo',     cs: ['PHX413'] },
  { reg: 'C-GJHX', tail: 'JHX', type: 'Navajo',     cs: ['PHX414'] },
  { reg: 'C-GJRH', tail: 'JRH', type: 'Navajo',     cs: ['PHX415'] },
  { reg: 'C-GQXD', tail: 'QXD', type: 'Navajo',     cs: ['PHX416'] },
  { reg: 'C-GQXX', tail: 'QXX', type: 'Navajo',     cs: ['PHX417'] },
  { reg: 'C-GTJF', tail: 'TJF', type: 'Navajo',     cs: ['PHX418'] },
  { reg: 'C-FBHO', tail: 'BHO', type: 'Navajo',     cs: ['PHX419'] },
].map(a => ({ ...a, icao24: icao24For(a.reg) }));

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

function bearingDeg(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

// True when the aircraft's track points toward the airport (CYKF unless told otherwise).
// Unknown track counts as inbound.
function isInbound(ac, lat = CYKF_LAT, lon = CYKF_LON) {
  if (ac.track == null) return true;
  const want = bearingDeg(ac.lat, ac.lon, lat, lon);
  const diff = Math.abs(((ac.track - want + 540) % 360) - 180);
  return diff <= INBOUND_TOL_DEG;
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SkycarYKF-FleetAlert/1.0', ...headers } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${body.slice(0, 80)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Two small requests: our planes' ICAO24 codes inside a 5° × 5° box around each base.
// OpenSky charges by box size — 25 sq° or less is 1 credit, so 2 a run (measured 2026-10-06;
// codes with no box are charged as a whole-world search, 4). Each box reaches ~100–150 nm from
// its base, well past the 60 / 40 nm alert rings; adsb.lol still finds our planes anywhere.
function fetchOpenSky() {
  const codes = FLEET.map(a => 'icao24=' + a.icao24).join('&');
  const box = (lat, lon) => `&lamin=${(lat - 2.5).toFixed(2)}&lamax=${(lat + 2.5).toFixed(2)}&lomin=${(lon - 2.5).toFixed(2)}&lomax=${(lon + 2.5).toFixed(2)}`;
  const auth = 'Basic ' + Buffer.from(`aristihernandez@gmail.com:${process.env.OPENSKY_PASSWORD}`).toString('base64');
  const ask = (lat, lon) => getJson('https://opensky-network.org/api/states/all?' + codes + box(lat, lon), { Authorization: auth });
  // Either base failing must not lose the other
  return Promise.allSettled([ask(CYKF_LAT, CYKF_LON), ask(CYAV_LAT, CYAV_LON)]).then(([k, v]) => {
    if (k.status === 'rejected') console.error('OpenSky (CYKF box):', k.reason?.message);
    if (v.status === 'rejected') console.error('OpenSky (CYAV box):', v.reason?.message);
    if (k.status === 'rejected' && v.status === 'rejected') throw k.reason;
    return { states: [...(k.value?.states || []), ...(v.value?.states || [])] };
  });
}

// Free community ADS-B network (no key). Second opinion next to OpenSky:
// every fleet ICAO24 worldwide, plus everything within 250 nm of CYKF and of CYAV (for call-sign matches).
// One request at a time, spaced out: three at once gets rate-limited (HTTP 420), and the
// fleet hex lookup -- the one that really matters -- goes first so it never gets lost.
async function fetchAdsbLol() {
  const hexes = FLEET.map(a => a.icao24).join(',');
  const pause = () => new Promise(r => setTimeout(r, 1200));
  const byHex = await getJson(`https://api.adsb.lol/v2/hex/${hexes}`);
  await pause();
  const near = await getJson(`https://api.adsb.lol/v2/point/${CYKF_LAT}/${CYKF_LON}/250`).catch(e => { console.error('adsb.lol near CYKF:', e.message); return { ac: [] }; });
  await pause();
  const nearYav = await getJson(`https://api.adsb.lol/v2/point/${CYAV_LAT}/${CYAV_LON}/250`).catch(e => { console.error('adsb.lol near CYAV:', e.message); return { ac: [] }; });
  const seen = new Set();
  return [...(byHex.ac || []), ...(near.ac || []), ...(nearYav.ac || [])].filter(p => p.hex && !seen.has(p.hex) && seen.add(p.hex));
}

// Match by ICAO24 first (permanent, independent of call sign), then the crews' call signs,
// then the registration written as a call sign (CFXAW / CGTIM).
function matchAircraft(hex, callsign) {
  const h = (hex || '').toLowerCase();
  const byHex = h && FLEET.find(a => a.icao24 === h);
  if (byHex) return byHex;
  const cs = (callsign || '').trim().toUpperCase().replace(/\s/g, '');
  if (!cs) return null;
  return FLEET.find(a => a.cs.includes(cs) || cs === a.reg.replace('-', '')) || null;
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

// ── YAV ──────────────────────────────────────────────────────────────────────
// Firestore REST value -> plain JS (the YAV app's subscriptions live in skycare-yav,
// read here over REST; its rules let the app read them without a login).
function fsValue(v) {
  if (!v) return null;
  if ('stringValue' in v)  return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v)  return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v)     return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fsValue(x)]));
  if ('arrayValue' in v)   return (v.arrayValue.values || []).map(fsValue);
  if ('timestampValue' in v) return v.timestampValue;
  return null;
}
async function yavSubscriptions() {
  const subs = [];
  let token = '';
  do {
    const r = await getJson('https://firestore.googleapis.com/v1/projects/skycare-yav/databases/(default)/documents/pushSubscriptions?pageSize=300'
      + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (r.documents || []).forEach(d => { const s = fsValue(d.fields?.sub); if (s?.endpoint && s.keys) subs.push(s); });
    token = r.nextPageToken || '';
  } while (token);
  return subs;
}
async function sendToYav(title, body, tag, type) {
  if (!process.env.VAPID_PRIVATE_KEY_YAV) { console.log('YAV: no push key configured — not sending'); return; }
  const subs = await yavSubscriptions();
  if (!subs.length) { console.log('YAV: no subscribers'); return; }
  const icon = YAV_APP + 'cars/' + (type === 'Navajo' ? 'Navajo_logo-removebg-preview.png' : 'Metroliner_logo-removebg-preview.png');
  const payload = JSON.stringify({ title, body, icon, badge: icon, tag, url: YAV_APP });
  const opts = { vapidDetails: { subject: 'mailto:aristihernandez@gmail.com', publicKey: YAV_VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE_KEY_YAV } };
  const results = await Promise.allSettled(subs.map(s => webpush.sendNotification(s, payload, opts)));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  console.log(`YAV push sent — ${ok} ok, ${results.length - ok} failed`);
}
// 40 nm arrival alert for CYAV. Every distance here is from CYAV; alert state is
// kept apart from YKF's (fleetNotificationsYAV) so the two bases never share a trigger.
async function checkYav(live, prevLive) {
  try {
    webpush.getVapidHeaders('https://fcm.googleapis.com', 'mailto:aristihernandez@gmail.com', YAV_VAPID_PUBLIC, process.env.VAPID_PRIVATE_KEY_YAV || '', 'aes128gcm');
    console.log('YAV push key OK');
  } catch (e) { console.error('YAV push key problem:', e.message); }
  const now = Date.now();
  for (const ac of Object.values(live)) {
    const distNm = Math.round(haversineNm(ac.lat, ac.lon, CYAV_LAT, CYAV_LON));
    const ref  = db.collection('fleetNotificationsYAV').doc(ac.tail);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;
    ac.leavingYav = false;

    // Under 50 kts it's rolling on a runway or taxiing, not "approaching" -- treat as on the ground.
    if (ac.onGround || (ac.speedKts != null && ac.speedKts < 50)) {
      if (prev?.active) {
        console.log(`YAV: ${ac.reg} on the ground — re-arming`);
        await ref.set({ active: false, distNm, resetAt: admin.firestore.FieldValue.serverTimestamp(), landed: true }, { merge: true });
      }
      continue;
    }
    const inbound = isInbound(ac, CYAV_LAT, CYAV_LON);
    const move = comingOrGoing(ac, prevLive[ac.tail], CYAV_LAT, CYAV_LON);
    ac.leavingYav = move.verdict === 'leaving';
    if (distNm <= YAV_ALERT_NM) {
      const lastNotified = prev?.notifiedAt?.toMillis?.() || 0;
      const alreadyActive = prev?.active === true && (now - lastNotified) < ALERT_EXPIRE_MS;
      const tooClose = distNm < MIN_ALERT_NM;
      if (!alreadyActive && !tooClose && inbound && move.verdict === 'arriving' && (now - lastNotified) > COOLDOWN_MS) {
        const eta  = etaStr(distNm, ac.speedKts);
        const body = [
          `${distNm} nm from CYAV`,
          ac.altFt ? ac.altFt.toLocaleString() + ' ft' : null,
          ac.speedKts ? ac.speedKts + ' KTS' : null,
          eta ? 'ETA ' + eta : null,
        ].filter(Boolean).join(' · ');
        console.log(`YAV ALERT: ${ac.reg} — ${body}`);
        await sendToYav(`✈ ${ac.reg} approaching CYAV`, body, `fleet-yav-${ac.tail}`, ac.type);
        await ref.set({ notifiedAt: admin.firestore.FieldValue.serverTimestamp(), active: true, distNm });
      } else {
        console.log(`YAV: ${ac.reg} ${distNm} nm — no alert (${alreadyActive ? 'already sent for this arrival' : tooClose ? 'inside 5 nm — departing or over the field' : !inbound ? 'not heading toward CYAV' : move.verdict !== 'arriving' ? (move.verdict === 'leaving' ? 'departing — ' : 'not sure yet — ') + move.why : 'cooldown'})`);
      }
    } else if (distNm > YAV_RESET_NM && prev?.active) {
      console.log(`YAV: ${ac.reg} beyond ${YAV_RESET_NM} nm — resetting`);
      await ref.set({ active: false, distNm, resetAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const h = easternHour();
  if (h < TRACK_FROM_H || h >= TRACK_TO_H) {
    console.log(`${h}:xx Eastern — outside live tracking hours (6 AM – 8 PM), no requests made.`);
    return;
  }
  // Ask both sources at once; either one failing must not stop the other.
  console.log('Fetching OpenSky + adsb.lol for fleet...');
  const [osRes, lolRes] = await Promise.allSettled([fetchOpenSky(), fetchAdsbLol()]);
  if (osRes.status === 'rejected')  console.error('OpenSky error:', osRes.reason?.message);
  if (lolRes.status === 'rejected') console.error('adsb.lol error:', lolRes.reason?.message);
  if (osRes.status === 'rejected' && lolRes.status === 'rejected') process.exit(0); // nothing to go on; keep last saved positions

  // Build live positions for fleet aircraft, per source
  const bySource = { opensky: {}, 'adsb.lol': {} };
  if (osRes.status === 'fulfilled') {
    const states = osRes.value?.states || [];
    console.log(`OpenSky: ${states.length} of our planes near CYKF / CYAV`);
    const nowS = Date.now() / 1000;
    states.forEach(s => {
      const ac = matchAircraft(s[0], s[1]);
      if (!ac) return;
      const lat = s[6], lon = s[5];
      if (lat == null || lon == null) return;
      const ageS = s[3] ? Math.round(nowS - s[3]) : 0;
      if (ageS > MAX_AGE_S) return;
      bySource.opensky[ac.tail] = {
        lat, lon, ageS,
        speedKts: s[9] ? Math.round(s[9] * 1.944) : null,
        altFt:    s[7] ? Math.round(s[7] * 3.28084) : null,
        onGround: !!s[8],
        track:    s[10] != null ? Math.round(s[10]) : null,
        vRateFpm: s[11] != null ? Math.round(s[11] * 196.85) : null,
      };
    });
  }
  if (lolRes.status === 'fulfilled') {
    console.log(`adsb.lol: ${lolRes.value.length} aircraft (fleet hex list + 250 nm around CYKF and CYAV)`);
    lolRes.value.forEach(p => {
      const ac = matchAircraft(p.hex, p.flight);
      if (!ac) return;
      if (typeof p.lat !== 'number' || typeof p.lon !== 'number') return;
      const ageS = Math.round(p.seen_pos ?? p.seen ?? 0);
      if (ageS > MAX_AGE_S) return;
      const onGround = p.alt_baro === 'ground';
      bySource['adsb.lol'][ac.tail] = {
        lat: p.lat, lon: p.lon, ageS,
        speedKts: typeof p.gs === 'number' ? Math.round(p.gs) : null,
        altFt:    onGround ? 0 : (typeof p.alt_baro === 'number' ? Math.round(p.alt_baro) : null),
        onGround,
        track:    typeof p.track === 'number' ? Math.round(p.track) : null,
        vRateFpm: typeof p.baro_rate === 'number' ? Math.round(p.baro_rate) : typeof p.geom_rate === 'number' ? Math.round(p.geom_rate) : null,
      };
    });
  }

  // Merge: the freshest position wins; note which source(s) saw each aircraft
  const live = {};
  FLEET.forEach(ac => {
    const o = bySource.opensky[ac.tail], l = bySource['adsb.lol'][ac.tail];
    const best = o && l ? (l.ageS < o.ageS ? l : o) : (o || l);
    if (!best) return;
    const src = o && l ? 'both' : o ? 'opensky' : 'adsb.lol';
    const distNm = Math.round(haversineNm(best.lat, best.lon, CYKF_LAT, CYKF_LON));
    live[ac.tail] = { reg: ac.reg, tail: ac.tail, type: ac.type, ...best, distNm, src };
  });
  console.log('Fleet found:', Object.values(live).map(a => `${a.tail}(${a.src})`).join(', ') || 'none');

  // Last run's positions (about 2 min ago) — to tell an arrival from a departure
  let prevLive = {};
  try {
    const ps = await db.collection('fleetPositions').doc('live').get();
    const pv = ps.exists ? ps.data() : null;
    const at = pv?.fetchedAt?.toMillis?.() || 0;
    if (pv && Date.now() - at < PREV_MAX_AGE_MS) prevLive = pv.positions || {};
    else console.log('Last run\'s positions missing or stale — first sightings only this run');
  } catch (e) { console.error('Could not read last run\'s positions:', e.message); }

  // Check each live aircraft against alert rules
  const now = Date.now();
  for (const [tail, ac] of Object.entries(live)) {
    const ref  = db.collection('fleetNotifications').doc(tail);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;

    ac.leavingYkf = false;
    if (ac.onGround) {
      // Landed (or parked): re-arm so the next arrival alerts, even on short local hops
      if (prev?.active) {
        console.log(`${ac.reg}: on the ground — re-arming alert`);
        await ref.set({ active: false, distNm: ac.distNm, resetAt: admin.firestore.FieldValue.serverTimestamp(), landed: true }, { merge: true });
      }
      continue;
    }

    const inbound = isInbound(ac);
    const move = comingOrGoing(ac, prevLive[tail], CYKF_LAT, CYKF_LON);
    ac.leavingYkf = move.verdict === 'leaving'; // the app leaves it out of "Inbound"
    const info = `${ac.reg} [${ac.src}] ${ac.distNm} nm, ${ac.altFt ?? '?'} ft, trk ${ac.track ?? '?'}°, ${inbound ? 'inbound' : 'not inbound'}, ${move.verdict} (${move.why}), ${prev?.active ? 'alert active' : 'armed'}`;

    if (ac.distNm <= ALERT_NM) {
      // Within 60 nm — should we notify?
      const lastNotified = prev?.notifiedAt?.toMillis?.() || 0;
      const alreadyActive = prev?.active === true && (now - lastNotified) < ALERT_EXPIRE_MS;
      const tooClose = ac.distNm < MIN_ALERT_NM;

      if (!alreadyActive && !tooClose && inbound && move.verdict === 'arriving' && (now - lastNotified) > COOLDOWN_MS) {
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
        const why = alreadyActive ? 'alert already sent for this arrival' : tooClose ? 'inside 5 nm — departing or over the field' : !inbound ? 'not heading toward CYKF' : move.verdict !== 'arriving' ? (move.verdict === 'leaving' ? 'departing — ' : 'not sure yet — ') + move.why : 'cooldown';
        console.log(`${info} — no alert (${why})`);
      }

    } else if (ac.distNm > RESET_NM && prev?.active) {
      // Aircraft moved well away — reset so next inbound fires again
      console.log(`${ac.reg}: beyond ${RESET_NM} nm — resetting alert`);
      await ref.set({ active: false, distNm: ac.distNm, resetAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } else {
      console.log(`${info} — outside ${ALERT_NM} nm`);
    }
  }

  // YAV's own 40 nm alert — kept separate so a YAV problem can never stop YKF's
  try { await checkYav(live, prevLive); } catch (e) { console.error('YAV alert check failed:', e.message); }

  // Write live positions to Firestore so the browser map can read them
  // without calling OpenSky directly (OpenSky blocks browser CORS requests)
  const positionData = {};
  FLEET.forEach(ac => {
    positionData[ac.tail] = live[ac.tail]
      ? { ...live[ac.tail], leavingYkf: !!live[ac.tail].leavingYkf, leavingYav: !!live[ac.tail].leavingYav, updatedAt: admin.firestore.FieldValue.serverTimestamp() }
      : null;
  });
  await db.collection('fleetPositions').doc('live').set({
    positions: positionData,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('Fleet positions written to Firestore.');

  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
