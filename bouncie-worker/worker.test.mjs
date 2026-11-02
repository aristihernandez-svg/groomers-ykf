// Offline test of the Bouncie worker with a fake Bouncie API and fake KV — never touches the real account or its tokens.
// Run: node bouncie-worker/worker.test.mjs
import assert from 'assert';
import worker from './index.js';

const calls = [];
const FLEET = Array.from({length: 23}, (_, i) => ({imei: String(864486000000000 + i), nickName: i === 3 ? '' : 'Tracker ' + i, vin: 'VIN0000000000' + (1000 + i), model: {make: 'Ford', name: 'Escape', year: 2015}, stats: {odometer: 1000 + i, fuelLevel: 50, battery: {status: 'normal'}, mil: {milOn: false, qualifiedDtcList: []}}}));
FLEET.push({imei: '864486065705564', nickName: 'Ford Escape YKF', vin: 'X', model: {}, stats: {odometer: 5, fuelLevel: 62}});   // the real Escape's tracker (in VEHICLE_MAP)
globalThis.fetch = async (u, opt) => {
  calls.push(String(u));
  const url = new URL(u);
  if (url.hostname === 'auth.bouncie.com') throw new Error('test must not refresh tokens');
  if (url.pathname === '/v1/vehicles') {
    const imei = url.searchParams.get('imei');
    if (imei) return new Response(JSON.stringify(FLEET.filter(v => v.imei === imei)), {status: 200});
    const skip = +url.searchParams.get('skip') || 0, limit = +url.searchParams.get('limit') || 10;
    return new Response(JSON.stringify(FLEET.slice(skip, skip + limit)), {status: 200});
  }
  return new Response('nope', {status: 404});
};
const kv = {access_token: 'test-token', access_token_expires_at: String(Date.now() + 3600e3)};
const env = {BOUNCIE_KV: {get: async k => kv[k] ?? null, put: async () => { throw new Error('test must not write KV'); }, delete: async () => {}}};
const get = async path => { const r = await worker.fetch(new Request('https://w.test' + path), env); return {status: r.status, body: await r.json().catch(() => null)}; };

// 1. /vehicles unchanged for the built-in cars
let r = await get('/vehicles');
assert.strictEqual(r.status, 200); assert.ok(r.body.escape && r.body.escape.status === 'ok' && r.body.escape.fuelLevel === 62, 'built-in cars still reported');
assert.strictEqual(r.body.kubota.status, 'unconfigured');
// 2. a car added in the app and linked to a tracker
r = await get('/vehicles?add=toyotarav4:864486000000005');
assert.strictEqual(r.body.toyotarav4.status, 'ok'); assert.strictEqual(r.body.toyotarav4.odometer, 1005);
// 3. bad or sneaky pairs are ignored: not digits, a built-in key, junk
r = await get('/vehicles?add=escape:864486000000007,bad-key!:123,x:abc,rav:12');
assert.strictEqual(r.body.escape.odometer, 5, 'a built-in car cannot be re-pointed'); assert.ok(!r.body['bad-key!'] && !r.body.x && !r.body.rav);
// 4. /devices lists every tracker across pages, marks the ones already linked, names unnamed ones
r = await get('/devices');
assert.strictEqual(r.status, 200); assert.strictEqual(r.body.length, 24, 'all trackers across pages');
assert.strictEqual(r.body.find(d => d.imei === '864486065705564').linkedTo, 'escape');
assert.strictEqual(r.body.find(d => d.imei === '864486000000003').name, '2015 Ford Escape');
assert.ok(r.body.every(d => !('stats' in d) && !('location' in d)), 'no stats or location in the device list');
assert.ok(calls.every(u => !u.includes('auth.bouncie.com')), 'never refreshed the token');
console.log('PASS — /vehicles unchanged + added cars, bad pairs ignored, /devices lists', r.body.length, 'trackers (linked ones marked), no token refresh, no KV writes');
