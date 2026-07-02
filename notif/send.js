// Skycare YKF — Coffee notification sender
// Run by GitHub Actions at scheduled times; reads FCM tokens from Firestore and sends push.

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db        = admin.firestore();
const messaging = admin.messaging();

const COFFEE_TIMES = [
  { hour: 9,  minute: 40, message: '☕ Hurry... gotta make coffee!' },
  { hour: 11, minute: 40, message: '☕ Hurry... gotta make coffee!' },
  { hour: 15, minute: 40, message: '☕ Hurry... gotta make coffee!' },
  { hour: 22, minute: 0,  message: '🧪 Test notification — it works!' },
];

async function main() {
  // Determine current time in Eastern (handles EDT/EST automatically)
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

  // Read all stored FCM tokens
  const snap   = await db.collection('fcmTokens').get();
  const tokens = snap.docs.map(d => d.id).filter(Boolean);

  if (!tokens.length) {
    console.log('No FCM tokens in Firestore — no one has enabled notifications yet');
    process.exit(0);
  }

  console.log(`Sending to ${tokens.length} device(s)`);

  const results = await Promise.allSettled(tokens.map(token =>
    messaging.send({
      token,
      notification: {
        title: '✈ Skycare',
        body:  match.message,
      },
      webpush: {
        notification: {
          icon:      'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
          badge:     'https://aristihernandez-svg.github.io/groomers-ykf/cars/Metroliner_logo-removebg-preview.png',
          tag:       `coffee-${h}`,
          renotify:  true,
          vibrate:   [200, 100, 200],
        },
        fcmOptions: {
          link: 'https://aristihernandez-svg.github.io/groomers-ykf/',
        },
      },
    })
  ));

  const ok   = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  console.log(`Done — ${ok} sent, ${fail} failed`);

  // Remove stale/invalid tokens automatically
  const staleTokens = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const code = r.reason?.errorInfo?.code || r.reason?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        staleTokens.push(tokens[i]);
      } else {
        console.error(`Token ${i} failed:`, r.reason?.message || r.reason);
      }
    }
  });

  if (staleTokens.length) {
    console.log(`Removing ${staleTokens.length} stale token(s) from Firestore`);
    const batch = db.batch();
    staleTokens.forEach(t => batch.delete(db.collection('fcmTokens').doc(t)));
    await batch.commit();
  }
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
