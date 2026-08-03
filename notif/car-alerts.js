// Skycare YKF — Crew car alert sender
// Runs daily at 11:00 AM Eastern; checks fuel and service KM, sends push to all subscribers.

const admin   = require('firebase-admin');
const webpush = require('web-push');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

webpush.setVapidDetails(
  'mailto:aristihernandez@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const CAR_NAMES = {
  escape:  'Ford Escape',
  elantra: 'Hyundai Elantra',
  micra:   'Nissan Micra',
  impala:  'Chevrolet Impala',
  whtruck: 'White MX Truck',
  brtruck: 'Brown MX Truck',
  kubota:  'Kubota',
  civic:   'Honda Civic',
};

// Same worker the app itself calls for live GPS/OBD data — see bouncie-worker/index.js
const BOUNCIE_WORKER_URL = 'https://bouncie-proxy.skycare.workers.dev';
const FUEL_PCT = { 'Empty': 0, '1/4': 0.25, '1/2': 0.5, '3/4': 0.75, 'Full': 1 };
const FUEL_ALERT_PCT = 0.25;

async function fetchBouncieData() {
  try {
    const res = await fetch(BOUNCIE_WORKER_URL + '/vehicles');
    if (!res.ok) { console.log('Bouncie fetch failed:', res.status); return {}; }
    return await res.json();
  } catch (e) {
    console.log('Bouncie fetch error:', e.message);
    return {};
  }
}

async function main() {
  // Read car data
  const carSnap = await db.collection('crewCarData').doc('all').get();
  if (!carSnap.exists) { console.log('No crewCarData found'); process.exit(0); }
  const cars = carSnap.data();
  const bouncie = await fetchBouncieData();

  // Build alerts
  const alerts = [];
  for (const [key, name] of Object.entries(CAR_NAMES)) {
    const d = cars[key];
    if (!d) continue;
    const b = bouncie[key];
    const bOk = b && b.status === 'ok';

    // Fuel — prefer live Bouncie %, fall back to the manually-logged gauge reading
    const fuelPct = bOk && b.fuelLevel != null ? b.fuelLevel / 100 : FUEL_PCT[d.fuel] ?? null;
    if (fuelPct != null && fuelPct <= FUEL_ALERT_PCT) {
      const fuelLabel = bOk && b.fuelLevel != null ? `${Math.round(b.fuelLevel)}%` : d.fuel;
      alerts.push({ car: name, type: 'fuel', message: `⛽ ${name} is at ${fuelLabel} — needs fuel!` });
    }

    // Check engine light (Bouncie MIL)
    if (bOk && b.milOn) {
      const codes = (b.dtcList || []).length ? ` (codes: ${b.dtcList.join(', ')})` : '';
      alerts.push({ car: name, type: 'engine', message: `🚨 ${name} check engine light is ON!${codes}` });
    }

    // Battery (Bouncie)
    if (bOk && (b.battery === 'low' || b.battery === 'shutdown')) {
      alerts.push({ car: name, type: 'battery', message: `🔋 ${name} battery alert — ${b.battery}!` });
    }

    const current = parseFloat(d.currentKm);
    const next    = parseFloat(d.nextServiceKm);
    if (!isNaN(current) && !isNaN(next) && next - current <= 500 && next - current >= 0) {
      const remaining = Math.round(next - current);
      alerts.push({ car: name, type: 'service', message: `🔧 ${name} needs service in ${remaining} km!` });
    }
  }

  if (!alerts.length) {
    console.log('All cars OK — no alerts to send');
    process.exit(0);
  }

  console.log(`Found ${alerts.length} alert(s):`, alerts.map(a => a.message));

  // Read push subscriptions
  const subSnap = await db.collection('pushSubscriptions').get();
  const subs    = subSnap.docs.map(d => ({ id: d.id, sub: d.data().sub })).filter(d => d.sub);

  if (!subs.length) {
    console.log('No push subscriptions — skipping');
    process.exit(0);
  }

  console.log(`Sending to ${subs.length} device(s)`);

  // Send one notification per alert
  for (const alert of alerts) {
    const payload = JSON.stringify({
      title: '✈ Skycare — Car Alert',
      body:  alert.message,
      icon:  'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
      badge: 'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
      tag:   `car-alert-${alert.car}-${alert.type}`,
      url:   'https://aristihernandez-svg.github.io/groomers-ykf/',
    });

    const results = await Promise.allSettled(
      subs.map(d => webpush.sendNotification(d.sub, payload))
    );

    const ok   = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(`"${alert.message}" → ${ok} sent, ${fail} failed`);

    // Remove expired subscriptions
    const stale = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const status = r.reason?.statusCode;
        if (status === 404 || status === 410) stale.push(subs[i].id);
      }
    });
    if (stale.length) {
      const batch = db.batch();
      stale.forEach(id => batch.delete(db.collection('pushSubscriptions').doc(id)));
      await batch.commit();
      console.log(`Removed ${stale.length} expired subscription(s)`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
