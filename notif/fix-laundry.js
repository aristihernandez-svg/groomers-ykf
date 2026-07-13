// One-time script: fix Laundry task on Tuesday + add to Friday
// Removes any existing Laundry entry from Tuesday (header or bad item),
// then adds a proper task item to both Tuesday and Friday.

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TUESDAY = '2️⃣ Tuesday';
const FRIDAY  = '5️⃣ Friday';
const TASK = { task: 'Laundry', freq: 'Tue · Fri', area: '', done: false };

async function fixDay(dayName) {
  const ref = db.collection('tasks').doc(dayName);
  const snap = await ref.get();

  if (!snap.exists) {
    // Doc doesn't exist yet — just set it with the new task
    await ref.set({ tasks: [TASK], migrated: true }, { merge: true });
    console.log(`${dayName}: doc created with Laundry task`);
    return;
  }

  const existing = snap.data().tasks || [];
  // Remove any existing entry named 'Laundry' (case-insensitive) — fixes the bad header
  const cleaned = existing.filter(t => (t.task || '').toLowerCase() !== 'laundry');
  // Add the proper task at the end
  cleaned.push(TASK);

  await ref.set({ tasks: cleaned, migrated: true });
  const removed = existing.length - cleaned.length + 1; // +1 because we pushed one back
  console.log(`${dayName}: fixed (${existing.length - cleaned.length + 1 - 1} old entry removed, Laundry added)`);
}

async function main() {
  await fixDay(TUESDAY);
  await fixDay(FRIDAY);
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
