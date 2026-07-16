// Skycare YKF — Notification queue + Storage cleanup
// Runs once daily via cron-job.org.
// Deletes sent documents older than 30 days from mxNotifQueue and shopNotifQueue.
// Deletes audit photos in Firebase Storage older than 30 days.

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const bucket = admin.storage().bucket('groomer-ykf.firebasestorage.app');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

async function cleanAuditPhotos() {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const [files] = await bucket.getFiles({ prefix: 'audits/' });
  const stale = files.filter(f => {
    const updatedStr = f.metadata && f.metadata.updated;
    if (!updatedStr) return false; // skip files with no timestamp — never delete blindly
    const updated = new Date(updatedStr);
    return !isNaN(updated.getTime()) && updated < cutoff;
  });
  if (!stale.length) { console.log('auditPhotos: nothing to clean'); return; }
  const results = await Promise.allSettled(stale.map(f => f.delete()));
  const ok   = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  if (fail) console.warn(`auditPhotos: ${fail} file(s) failed to delete`);
  console.log(`auditPhotos: deleted ${ok} old file(s)`);
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
  await cleanAuditPhotos();
  await cleanCarLogs();
  await cleanOneOffTasks();
  console.log('Cleanup done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
