// Skycare YKF — MX Parts push notification sender
// Triggered by Cloudflare Worker when a mechanic adds an item.

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

async function main() {
  const snap = await db.collection('pushSubscriptions').get();
  const docs = snap.docs.map(d => ({ id: d.id, sub: d.data().sub })).filter(d => d.sub);

  if (!docs.length) {
    console.log('No push subscriptions — skipping');
    process.exit(0);
  }

  console.log(`Sending MX notification to ${docs.length} device(s)`);

  const payload = JSON.stringify({
    title: process.env.NOTIF_TITLE || '🔧 MX Parts Request',
    body:  process.env.NOTIF_BODY  || 'New item added to the MX order list',
    icon:  'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    badge: 'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    tag:   `mx-parts-${Date.now()}`,
    url:   'https://aristihernandez-svg.github.io/groomers-ykf/',
  });

  const results = await Promise.allSettled(
    docs.map(d => webpush.sendNotification(d.sub, payload))
  );

  const ok   = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  console.log(`Done — ${ok} sent, ${fail} failed`);

  // Remove expired subscriptions
  const stale = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const status = r.reason?.statusCode;
      if (status === 404 || status === 410) stale.push(docs[i].id);
    }
  });
  if (stale.length) {
    const batch = db.batch();
    stale.forEach(id => batch.delete(db.collection('pushSubscriptions').doc(id)));
    await batch.commit();
    console.log(`Removed ${stale.length} expired subscription(s)`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
