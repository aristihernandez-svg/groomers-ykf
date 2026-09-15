// Skycare YKF — Notification queue + Storage cleanup
// Runs once daily via cron-job.org.
// Deletes sent documents older than 30 days from mxNotifQueue and shopNotifQueue.
// Retires audit records (Storage files + Firestore docs) older than 2 years.

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const bucket = admin.storage().bucket('groomer-ykf.firebasestorage.app');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

async function cleanQueue(collectionName) {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  // Query only by sent==true to avoid needing a composite index.
  // Filter by sentAt in JS — safe and index-free.
  const snap = await db.collection(collectionName)
    .where('sent', '==', true)
    .get();

  const stale = snap.docs.filter(doc => {
    const sentAt = doc.data().sentAt?.toDate?.();
    return sentAt && sentAt < cutoff;
  });

  if (!stale.length) { console.log(`${collectionName}: nothing to clean`); return; }

  const batch = db.batch();
  stale.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  console.log(`${collectionName}: deleted ${stale.length} old document(s)`);
}

async function cleanCoffeeSent() {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const snap = await db.collection('coffeeNotifSent')
    .where('sentAt', '<', cutoff)
    .get();

  if (snap.empty) { console.log('coffeeNotifSent: nothing to clean'); return; }

  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  console.log(`coffeeNotifSent: deleted ${snap.size} old document(s)`);
}

// Audit records (raw condition photos + the generated PDF/HTML reports that
// embed them, plus the Firestore documents behind them) are permanent for
// 2 years, then retired together as one unit. This used to be a 30-day
// Storage-only cleanup scoped to "audit photos" — but its `audits/` prefix
// matched the permanent PDF report files too (they live at the same path,
// e.g. audits/August 2026/facility-crewhouse.html), so it was silently
// deleting finished audit reports a month after they were generated. Fixed
// by (a) widening the retention window to the 2 years the business actually
// wants these kept, and (b) keying deletion off the audit's own month —
// parsed from the file/doc path, never from when a file was last touched —
// so a file's age always matches the audit it belongs to.
//
// Both categories under a stale month are deleted together deliberately:
// a generated report's <img> tags point at the raw photo's Storage URL
// (never embedded as data), so keeping one without the other would leave
// broken images in an otherwise-still-visible PDF.
// Strict on purpose: new Date('garbage 1') silently parses to a real (wrong)
// date instead of failing, which would make a malformed/unexpected label
// look infinitely old and get deleted. Only accept an exact "Month YYYY"
// shape with a real month name and a plausible year — anything else returns
// null, which every caller below treats as "never delete this."
const MONTH_NAMES = ['january','february','march','april','may','june','july',
  'august','september','october','november','december'];
function parseMonthLabel(label) {
  if (typeof label !== 'string') return null;
  const m = label.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const monthIdx = MONTH_NAMES.indexOf(m[1].toLowerCase());
  if (monthIdx === -1) return null;
  const year = parseInt(m[2], 10);
  if (year < 2000 || year > 2100) return null;
  return new Date(year, monthIdx, 1);
}

async function cleanOldAuditRecords() {
  const cutoff = new Date(Date.now() - TWO_YEARS_MS);

  // Storage: every audit file lives under audits/{Month Year}/... — parse
  // the month folder name itself, not the file's upload/update timestamp.
  const [files] = await bucket.getFiles({ prefix: 'audits/' });
  const staleFiles = files.filter(f => {
    const m = f.name.match(/^audits\/([^/]+)\//);
    if (!m) return false; // not inside a recognized month folder — never touch
    const monthDate = parseMonthLabel(m[1]);
    return monthDate && monthDate < cutoff;
  });
  if (staleFiles.length) {
    const results = await Promise.allSettled(staleFiles.map(f => f.delete()));
    const ok   = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    if (fail) console.warn(`auditRecords/storage: ${fail} file(s) failed to delete`);
    console.log(`auditRecords/storage: deleted ${ok} file(s) from audits 2+ years old`);
  } else {
    console.log('auditRecords/storage: nothing to clean');
  }

  // Firestore: retire the matching documents too, so Records never lists a
  // month whose files are already gone. Each collection keys its month
  // differently, so each gets its own accessor rather than one shared guess.
  async function cleanCollection(collectionName, getMonthLabel) {
    const snap = await db.collection(collectionName).get();
    const stale = snap.docs.filter(doc => {
      const label = getMonthLabel(doc);
      if (!label) return false;
      const monthDate = parseMonthLabel(label);
      return monthDate && monthDate < cutoff;
    });
    if (!stale.length) { console.log(`${collectionName}: nothing to clean`); return; }
    const batch = db.batch();
    stale.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`${collectionName}: deleted ${stale.length} record(s) 2+ years old`);
  }

  const FACILITY_TYPES = ['crewhouse', 'hangar', 'msds', 'parking', 'ykfbase'];
  await cleanCollection('auditCars', doc => doc.data().month);
  await cleanCollection('auditAircraft', doc => doc.data().month);
  await cleanCollection('monthSummaries', doc => doc.data().month || doc.id);
  await cleanCollection('auditArchive', doc => doc.id);
  await cleanCollection('facilityAudits', doc => {
    const type = FACILITY_TYPES.find(t => doc.id.startsWith(t + '-'));
    return type ? doc.id.slice(type.length + 1) : null;
  });
}

async function cleanCarLogs() {
  const snap = await db.collection('crewCarData').doc('all').get();
  if (!snap.exists) { console.log('crewCarData: document not found'); return; }

  const data = snap.data();
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const updates = {};
  let totalTrimmed = 0;

  const MAX_LOG = 60;
  for (const [carKey, carData] of Object.entries(data)) {
    if (!Array.isArray(carData?.log) || carData.log.length === 0) continue;
    const before = carData.log.length;
    // Drop malformed entries and entries older than 30 days, then cap at MAX_LOG most recent
    const filtered = carData.log.filter(entry => {
      if (!entry?.date) return false;
      return new Date(entry.date) >= cutoff;
    });
    const trimmed = filtered.length > MAX_LOG ? filtered.slice(-MAX_LOG) : filtered;
    if (trimmed.length < before) {
      updates[`${carKey}.log`] = trimmed;
      totalTrimmed += before - trimmed.length;
      console.log(`crewCarData/${carKey}: trimmed ${before - trimmed.length} entries (${before} → ${trimmed.length})`);
    }
  }

  if (!Object.keys(updates).length) { console.log('crewCarData: all logs within 30 days, nothing to trim'); return; }
  await db.collection('crewCarData').doc('all').update(updates);
  console.log(`crewCarData: total ${totalTrimmed} log entries removed`);
}

async function cleanOneOffTasks() {
  const DAYS = [
    '1️⃣ Monday','2️⃣ Tuesday','3️⃣ Wednesday','4️⃣ Thursday','5️⃣ Friday','🗓 Saturday',
  ];
  let totalRemoved = 0;
  for (const day of DAYS) {
    const snap = await db.collection('tasks').doc(day).get();
    if (!snap.exists || !snap.data().migrated) continue;
    const all = snap.data().tasks || [];
    const filtered = all.filter(t => t.freq !== 'One-off' && t.freq !== 'Once');
    if (filtered.length === all.length) continue;
    await db.collection('tasks').doc(day).set({ tasks: filtered, migrated: true });
    const removed = all.length - filtered.length;
    totalRemoved += removed;
    console.log(`tasks/${day}: removed ${removed} one-off task(s)`);
  }
  if (!totalRemoved) { console.log('oneOffTasks: nothing to remove'); return; }
  // Clear the client-side "already ran today" flag so the app doesn't skip cleanup on boot
  await db.collection('appConfig').doc('oneOffCleaned').delete();
  console.log(`oneOffTasks: total ${totalRemoved} removed, oneOffCleaned flag reset`);
}

async function main() {
  await cleanQueue('mxNotifQueue');
  await cleanQueue('shopNotifQueue');
  await cleanCoffeeSent();
  await cleanOldAuditRecords();
  await cleanCarLogs();
  await cleanOneOffTasks();
  console.log('Cleanup done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
