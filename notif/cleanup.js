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
  const snap = await db.collection(collectionName)
    .where('sent', '==', true)
    .where('sentAt', '<', cutoff)
    .get();

  if (snap.empty) { console.log(`${collectionName}: nothing to clean`); return; }

  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  console.log(`${collectionName}: deleted ${snap.size} old document(s)`);
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
    const updated = new Date(f.metadata.updated);
    return updated < cutoff;
  });
  if (!stale.length) { console.log('auditPhotos: nothing to clean'); return; }
  await Promise.all(stale.map(f => f.delete()));
  console.log(`auditPhotos: deleted ${stale.length} old file(s)`);
}

async function main() {
  await cleanQueue('mxNotifQueue');
  await cleanQueue('shopNotifQueue');
  await cleanCoffeeSent();
  await cleanAuditPhotos();
  console.log('Cleanup done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
