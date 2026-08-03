// Skycare YKF — Audit deadline alert
// Runs via GitHub Actions at 14:00 UTC on the 8th, 9th, and 10th of each month.
// Checks Firestore for pending crew car, aircraft (Metro/Westwind/Astra + custom
// tails, excluding disabled/hidden), and facility audits, and sends a push
// notification if any are incomplete.

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

const CREW_CAR_KEYS = ['escape', 'elantra', 'micra', 'impala', 'whtruck', 'brtruck', 'kubota', 'civic'];

const AIRCRAFT_METRO    = ['CPX', 'TIM', 'IOC', 'IOB', 'IOJ', 'IOA', 'IOH', 'KKC'];
const AIRCRAFT_WESTWIND = ['IAW', 'XDP', 'XAW'];
const AIRCRAFT_ASTRA    = ['FDAX'];

const FACILITY_AUDITS = [
  { doc: 'crewhouse', label: 'Crew House' },
  { doc: 'hangar',    label: 'Hangar & Office' },
  { doc: 'msds',      label: 'MSDS' },
  { doc: 'parking',   label: 'Parking Lot MX' },
  { doc: 'ykfbase',   label: 'YKF Base' },
];

// Matches the app's auditMonth() / acAuditMonthKey() — e.g. "July 2026"
function auditMonth() {
  return new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long' });
}

// Mirrors the app's Metro/Westwind/Astra + custom-tail + disabled/hidden logic.
// NOTE: fully custom aircraft *types* (built via checklist import) live only in each
// device's localStorage, never in Firestore — this script has no way to see those,
// so they're covered by the in-app popup only, not this push notification.
async function getPendingAircraft(db, month) {
  const [stateSnap, customSnap, disabledSnap, hiddenSnap] = await Promise.all([
    db.collection('auditAircraftState').doc(month).get(),
    db.collection('appConfig').doc('acCustomAircraft').get(),
    db.collection('acState').doc('disabled').get(),
    db.collection('acState').doc('hidden').get(),
  ]);

  const state    = stateSnap.exists ? stateSnap.data() : {};
  const custom   = customSnap.exists ? customSnap.data() : {};
  const disabled = new Set((disabledSnap.exists ? (disabledSnap.data().data || {})[month] : []) || []);
  const hidden   = new Set((hiddenSnap.exists ? hiddenSnap.data().regs : []) || []);

  const groups = [
    { label: 'Metro',    regs: [...AIRCRAFT_METRO,    ...(custom.metro    || [])] },
    { label: 'Westwind', regs: [...AIRCRAFT_WESTWIND, ...(custom.westwind || [])] },
    { label: 'Astra',    regs: [...AIRCRAFT_ASTRA] },
  ];

  const pending = [];
  groups.forEach(g => {
    g.regs.filter(r => !disabled.has(r) && !hidden.has(r)).forEach(r => {
      if (!state[r] || !state[r].done) pending.push(`${g.label} · ${r}`);
    });
  });
  return pending;
}

async function getPendingFacilities(db) {
  const snaps = await Promise.all(
    FACILITY_AUDITS.map(f => db.collection('facilityAudits').doc(f.doc).get())
  );
  return FACILITY_AUDITS
    .filter((f, i) => !snaps[i].exists || !snaps[i].data().done)
    .map(f => f.label);
}

async function main() {
  const now     = new Date();
  const day     = now.getUTCDate();
  const daysLeft = 10 - day;

  console.log(`Running audit alert check — UTC day ${day}, days left: ${daysLeft}`);

  // Only run on 8th, 9th, 10th
  if (day < 8 || day > 10) {
    console.log('Not an alert day — skipping');
    process.exit(0);
  }

  // Dedup — only send once per day
  const dateStr = now.toISOString().slice(0, 10);
  const sentRef = db.collection('auditAlertSent').doc(dateStr);
  const sentSnap = await sentRef.get();
  if (sentSnap.exists) {
    console.log(`Already sent audit alert for ${dateStr} — skipping duplicate`);
    process.exit(0);
  }

  // Check how many cars have completed audits this month
  const month = auditMonth();
  const auditSnap = await db.collection('auditCars').where('month', '==', month).get();
  const doneCars = new Set();
  auditSnap.docs.forEach(d => { if (d.data().done) doneCars.add(d.data().carKey); });
  const pendingCars = CREW_CAR_KEYS.filter(k => !doneCars.has(k));

  const pendingAircraft   = await getPendingAircraft(db, month);
  const pendingFacilities = await getPendingFacilities(db);

  const pending = [...pendingCars, ...pendingAircraft, ...pendingFacilities];
  console.log(`Month: ${month} — ${pendingCars.length} car(s), ${pendingAircraft.length} aircraft, ${pendingFacilities.length} facility audit(s) pending`);

  if (pending.length === 0) {
    console.log('All audits complete — no notification needed');
    process.exit(0);
  }

  // Mark as sent before pushing so a retry doesn't double-send
  await sentRef.set({ sentAt: admin.firestore.FieldValue.serverTimestamp(), pending: pending.length });

  const daysText = daysLeft === 0
    ? 'due TODAY'
    : daysLeft === 1
      ? '1 day left'
      : `${daysLeft} days left`;

  const body = `🚨 ${pending.length} audit${pending.length > 1 ? 's' : ''} still pending — ${daysText} — move your @$$!`;

  const payload = JSON.stringify({
    title: '✈ Skycare · Audit Deadline',
    body,
    icon:  'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    badge: 'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    tag:   `audit-alert-${dateStr}`,
    url:   'https://aristihernandez-svg.github.io/groomers-ykf/',
  });

  const snap  = await db.collection('pushSubscriptions').get();
  const docs  = snap.docs.map(d => ({ id: d.id, sub: d.data().sub })).filter(d => d.sub);

  if (!docs.length) {
    console.log('No push subscriptions — no one to notify');
    process.exit(0);
  }

  console.log(`Sending to ${docs.length} device(s): "${body}"`);

  const results = await Promise.allSettled(
    docs.map(d => webpush.sendNotification(d.sub, payload))
  );

  const ok   = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  console.log(`Done — ${ok} sent, ${fail} failed`);

  // Remove expired/invalid subscriptions
  const stale = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const status = r.reason?.statusCode;
      console.error(`Device ${i} failed (${status}):`, r.reason?.body || r.reason?.message);
      if (status === 404 || status === 410) stale.push(docs[i].id);
    }
  });

  if (stale.length) {
    console.log(`Removing ${stale.length} expired subscription(s)`);
    await Promise.all(stale.map(id => db.collection('pushSubscriptions').doc(id).delete()));
  }
}

main().catch(e => { console.error('Audit alert fatal error:', e); process.exit(1); });
