// Skycare YKF — Crew car alert sender
// Runs at 11:00 AM and 4:00 PM Eastern; checks fuel (Bouncie, falling back to the
// manually-logged gauge), engine (Bouncie MIL/DTC), battery (Bouncie), and service
// KM. Each car/issue only pushes once per day even if it stays broken.

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

// The workflow's cron has both an EDT and an EST line for each of 11am/4pm so that
// whichever offset is currently in effect fires at the right real-world time — but
// GitHub Actions cron isn't DST-aware, so BOTH lines fire year-round, twice a day
// each. This guard makes only the pair matching the currently-active offset proceed.
const TARGET_HOURS_ET = [11, 16]; // 11am and 4pm Eastern

async function main() {
  const now     = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const h = eastern.getHours();
  const m = eastern.getMinutes();
  console.log(`Eastern time: ${h}:${String(m).padStart(2, '0')}`);
  if (!TARGET_HOURS_ET.includes(h) || m > 15) {
    console.log('Not this offset\'s scheduled slot — skipping duplicate DST cron entry');
    process.exit(0);
  }
  const dateStr = eastern.toISOString().slice(0, 10);

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
      alerts.push({ key, car: name, type: 'fuel', message: `⛽ ${name} is at ${fuelLabel} — needs fuel!` });
    }

    // Check engine light (Bouncie MIL)
    if (bOk && b.milOn) {
      const codes = (b.dtcList || []).length ? ` (codes: ${b.dtcList.join(', ')})` : '';
      alerts.push({ key, car: name, type: 'engine', message: `🚨 ${name} check engine light is ON!${codes}` });
    }

    // Battery (Bouncie)
    if (bOk && (b.battery === 'low' || b.battery === 'shutdown')) {
      alerts.push({ key, car: name, type: 'battery', message: `🔋 ${name} battery alert — ${b.battery}!` });
    }

    const current = parseFloat(d.currentKm);
    const next    = parseFloat(d.nextServiceKm);
    if (!isNaN(current) && !isNaN(next) && next - current <= 500 && next - current >= 0) {
      const remaining = Math.round(next - current);
      alerts.push({ key, car: name, type: 'service', message: `🔧 ${name} needs service in ${remaining} km!` });
    }
  }

  if (!alerts.length) {
    console.log('All cars OK — no alerts to send');
    process.exit(0);
  }

  // De-dup — each car/issue only notifies once per day, even across multiple slots today
  const dedupRefs  = alerts.map(a => db.collection('carAlertSent').doc(`${dateStr}-${a.key}-${a.type}`));
  const dedupSnaps = await Promise.all(dedupRefs.map(r => r.get()));
  const toSend = alerts.filter((a, i) => !dedupSnaps[i].exists);

  if (!toSend.length) {
    console.log(`All ${alerts.length} alert(s) already sent today — skipping`);
    process.exit(0);
  }
  console.log(`${toSend.length} of ${alerts.length} alert(s) are new today:`, toSend.map(a => a.message));

  // Read push subscriptions
  const subSnap = await db.collection('pushSubscriptions').get();
  const subs    = subSnap.docs.map(d => ({ id: d.id, sub: d.data().sub })).filter(d => d.sub);

  if (!subs.length) {
    console.log('No push subscriptions — skipping');
    process.exit(0);
  }

  console.log(`Sending to ${subs.length} device(s)`);

  // Send one notification per alert, marking each as sent for today
  for (const alert of toSend) {
    const payload = JSON.stringify({
      title: '✈ Skycare — Car Alert',
      body:  alert.message,
      icon:  'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
      badge: 'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
      tag:   `car-alert-${alert.key}-${alert.type}`,
      url:   'https://aristihernandez-svg.github.io/groomers-ykf/',
    });

    const results = await Promise.allSettled(
      subs.map(d => webpush.sendNotification(d.sub, payload))
    );

    const ok   = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(`"${alert.message}" → ${ok} sent, ${fail} failed`);

    await db.collection('carAlertSent').doc(`${dateStr}-${alert.key}-${alert.type}`)
      .set({ sentAt: admin.firestore.FieldValue.serverTimestamp(), message: alert.message });

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
