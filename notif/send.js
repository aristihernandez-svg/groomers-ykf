// Skycare YKF — Coffee notification sender
// Run by GitHub Actions at scheduled times; reads push subscriptions from Firestore and sends via Web Push.

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

const COFFEE_TIMES = [
  { hour: 9,  minute: 40, message: '☕ Hurry... gotta make coffee!' },
  { hour: 11, minute: 40, message: '☕ Hurry... gotta make coffee!' },
  { hour: 15, minute: 40, message: '☕ Hurry... gotta make coffee!' },
  { hour: 22, minute: 25, message: '🧪 Test — notifications are working!' },
];

async function main() {
  const now     = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const h = eastern.getHours();
  const m = eastern.getMinutes();

  const match = COFFEE_TIMES.find(t => t.hour === h && Math.abs(t.minute - m) <= 6);
  if (!match) {
    console.log(`No coffee time match for ${h}:${String(m).padStart(2,'0')} Eastern — skipping`);
    process.exit(0);
  }

  console.log(`Coffee time! Sending for ${h}:${String(match.minute).padStart(2,'0')} Eastern`);

  const snap  = await db.collection('pushSubscriptions').get();
  const docs  = snap.docs.map(d => ({ id: d.id, sub: d.data().sub })).filter(d => d.sub);

  if (!docs.length) {
    console.log('No push subscriptions in Firestore — no one has enabled notifications yet');
    process.exit(0);
  }

  console.log(`Sending to ${docs.length} device(s)`);

  const payload = JSON.stringify({
    title: '✈ Skycare',
    body:  match.message,
    icon:  'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    badge: 'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
    tag:   `coffee-${h}`,
    url:   'https://aristihernandez-svg.github.io/groomers-ykf/',
  });

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
    const batch = db.batch();
    stale.forEach(id => batch.delete(db.collection('pushSubscriptions').doc(id)));
    await batch.commit();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
