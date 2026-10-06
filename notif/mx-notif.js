// Skycare YKF — Items push notification sender
// Runs every 5 minutes via GitHub Actions.
// Checks two queues:
//   mxNotifQueue   — mechanics.html parts + crew car damage: sent as a PUSH to every subscriber
//   shopNotifQueue — Crew House / Sioux Lookout shopping requests: IN-APP ONLY, never a push.
//                    Each one becomes a 'notifications' doc, which only phones with the app
//                    open pick up (same as shopping changes made inside the app).
// Marks each item sent once handled.

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

async function sendToAll(title, body, tag) {
  const snap = await db.collection('pushSubscriptions').get();
  const docs = snap.docs.map(d => ({ id: d.id, sub: d.data().sub })).filter(d => d.sub);

  if (!docs.length) { console.log('No push subscriptions — skipping'); return; }

  console.log(`Sending to ${docs.length} device(s): ${title}`);

  const payload = JSON.stringify({
    title,
    body,
    icon:  'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    badge: 'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    tag,
    url:   'https://aristihernandez-svg.github.io/groomers-ykf/',
  });

  const results = await Promise.allSettled(docs.map(d => webpush.sendNotification(d.sub, payload)));
  const ok   = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  console.log(`Push sent — ${ok} ok, ${fail} failed`);

  // Clean up expired subscriptions
  const stale = [];
  docs.forEach((d, i) => {
    const r = results[i];
    if (r.status === 'rejected') {
      const status = r.reason?.statusCode;
      if (status === 404 || status === 410) stale.push(d.id);
    }
  });
  if (stale.length) {
    const batch = db.batch();
    stale.forEach(id => batch.delete(db.collection('pushSubscriptions').doc(id)));
    await batch.commit();
    console.log(`Removed ${stale.length} expired subscription(s)`);
  }
}

async function processQueue(collectionName, inAppOnly) {
  const snap = await db.collection(collectionName).where('sent', '==', false).get();
  if (snap.empty) { console.log(`${collectionName}: no pending items`); return; }

  console.log(`${collectionName}: found ${snap.size} pending notification(s)`);
  for (const doc of snap.docs) {
    const { title, body } = doc.data();
    if (inAppOnly) {
      await db.collection('notifications').add({ title, body, tag: 'shopping', ts: admin.firestore.FieldValue.serverTimestamp() });
      console.log(`In-app only: ${title}`);
    } else {
      await sendToAll(title, body, `${collectionName}-${doc.id}`);
    }
    await doc.ref.update({ sent: true, sentAt: admin.firestore.FieldValue.serverTimestamp() });
  }
}

async function main() {
  await processQueue('mxNotifQueue');
  await processQueue('shopNotifQueue', true);   // shopping never pushes to closed apps
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
