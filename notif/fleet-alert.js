// Skycare YKF — Fleet 60 nm arrival alert
// Runs every 5 minutes via GitHub Actions.
// Sends a push notification when a fleet aircraft crosses inside 60 nm of CYKF.
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
const ALERT_NM = 60;
const RESET_NM = 120;  // re-arm the alert once aircraft goes beyond this (or lands)
const COOLDOWN_MS = 15 * 60 * 1000; // minimum gap between two alerts for the same tail
const INBOUND_TOL_DEG = 75;         // heading must point within this of the airport to count as inbound
const MAX_AGE_S = 180;              // ignore positions older than this

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
  { reg: 'C-FIOE', tail: 'IOE', type: 'Metroliner', cs: [] },
  { reg: 'C-FIOJ', tail: 'IOJ', type: 'Metroliner', cs: ['PHX594'] },
  { reg: 'C-FIOA', tail: 'IOA', type: 'Metroliner', cs: ['PHX680'] },
  { reg: 'C-FIOB', tail: 'IOB', type: 'Metroliner', cs: ['PHX614'] },
  { reg: 'C-FIOH', tail: 'IOH', type: 'Metroliner', cs: ['PHX432'] },
  { reg: 'C-GTIM', tail: 'TIM', type: 'Metroliner', cs: ['PHX274'] },
  { reg: 'C-GCPX', tail: 'CPX', type: 'Metroliner', cs: ['PHX11']  },
  { reg: 'C-GKKC', tail: 'KKC', type: 'Metroliner', cs: ['PHX370'] },
  { reg: 'C-GIAW', tail: 'IAW', type: 'Westwind',   cs: [] },
  { reg: 'C-FXAW', tail: 'XAW', type: 'Westwind',   cs: ['PHX280'] },
  { reg: 'C-FXDP', tail: 'XDP', type: 'Westwind',   cs: ['PHX303'] },
  { reg: 'C-FDAX', tail: 'DAX', type: 'Astra',      cs: ['PHX58']  },
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

// True when the aircraft's track points toward CYKF. Unknown track counts as inbound.
function isInbound(ac) {
  if (ac.track == null) return true;
  const want = bearingDeg(ac.lat, ac.lon, CYKF_LAT, CYKF_LON);
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

function fetchOpenSky() {
  const url = 'https://opensky-network.org/api/states/all?lamin=41.0&lomin=-95.0&lamax=50.0&lomax=-60.0';
  const auth = 'Basic ' + Buffer.from(`aristihernandez@gmail.com:${process.env.OPENSKY_PASSWORD}`).toString('base64');
  return getJson(url, { Authorization: auth });
}

// Free community ADS-B network (no key). Second opinion next to OpenSky:
// every fleet ICAO24 worldwide, plus everything within 250 nm of CYKF (for call-sign matches).
async function fetchAdsbLol() {
  const hexes = FLEET.map(a => a.icao24).join(',');
  const [byHex, near] = await Promise.all([
    getJson(`https://api.adsb.lol/v2/hex/${hexes}`),
    getJson(`https://api.adsb.lol/v2/point/${CYKF_LAT}/${CYKF_LON}/250`).catch(() => ({ ac: [] })),
  ]);
  const seen = new Set();
  return [...(byHex.ac || []), ...(near.ac || [])].filter(p => p.hex && !seen.has(p.hex) && seen.add(p.hex));
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
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
    console.log(`OpenSky: ${states.length} state vectors in bounding box`);
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
      };
    });
  }
  if (lolRes.status === 'fulfilled') {
    console.log(`adsb.lol: ${lolRes.value.length} aircraft (fleet hex list + 250 nm around CYKF)`);
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

  // Check each live aircraft against alert rules
  const now = Date.now();
  for (const [tail, ac] of Object.entries(live)) {
    const ref  = db.collection('fleetNotifications').doc(tail);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;

    if (ac.onGround) {
      // Landed (or parked): re-arm so the next arrival alerts, even on short local hops
      if (prev?.active) {
        console.log(`${ac.reg}: on the ground — re-arming alert`);
        await ref.set({ active: false, distNm: ac.distNm, resetAt: admin.firestore.FieldValue.serverTimestamp(), landed: true }, { merge: true });
      }
      continue;
    }

    const inbound = isInbound(ac);
    const info = `${ac.reg} [${ac.src}] ${ac.distNm} nm, ${ac.altFt ?? '?'} ft, trk ${ac.track ?? '?'}°, ${inbound ? 'inbound' : 'not inbound'}, ${prev?.active ? 'alert active' : 'armed'}`;

    if (ac.distNm <= ALERT_NM) {
      // Within 60 nm — should we notify?
      const lastNotified = prev?.notifiedAt?.toMillis?.() || 0;
      const alreadyActive = prev?.active === true;

      if (!alreadyActive && inbound && (now - lastNotified) > COOLDOWN_MS) {
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
        const why = alreadyActive ? 'alert already sent for this arrival' : !inbound ? 'not heading toward CYKF' : 'cooldown';
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

  // Write live positions to Firestore so the browser map can read them
  // without calling OpenSky directly (OpenSky blocks browser CORS requests)
  const positionData = {};
  FLEET.forEach(ac => {
    positionData[ac.tail] = live[ac.tail]
      ? { ...live[ac.tail], updatedAt: admin.firestore.FieldValue.serverTimestamp() }
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
