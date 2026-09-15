/**
 * Bouncie GPS Proxy — Cloudflare Worker (SHARED across all Skycare bases)
 *
 * One Bouncie account/app (client_id: skycare-yk) covers every base's
 * vehicles. This is the single Worker that ever calls Bouncie's OAuth —
 * every base's app (YKF, YAV, and later YQT/YXL) points its
 * bouncieWorkerUrl at THIS SAME Worker, not a separate one per base.
 *
 * Why: two independent Workers each refreshing their own copy of the same
 * underlying refresh token collide — Bouncie rotates the token on every
 * refresh, so whichever Worker refreshes first invalidates the other's
 * copy. One Worker, one refresh cycle, no race. (This is also why a
 * re-authorization on 2026-08-10 broke both YKF's and YAV's separate
 * Workers simultaneously — there was never really an isolated token per
 * base to begin with, just separate copies of the one that already existed.)
 *
 * Each base's app only ever reads the keys listed in its own CREW_CARS
 * (baseConfig.js) — so even though this Worker returns every base's
 * vehicles in one response, a given base's UI only displays its own.
 * Only odometer/fuel/battery/engine-fault fields are exposed below —
 * never GPS location — so this cross-base visibility is low-sensitivity
 * by design, not just by convention.
 *
 * Secrets (Worker Settings > Variables & Secrets):
 *   BOUNCIE_CLIENT_ID     = skycare-yk
 *   BOUNCIE_CLIENT_SECRET = (client secret from bouncie.dev)
 *
 * KV binding (Worker Settings > Bindings > KV Namespace):
 *   Variable name: BOUNCIE_KV  →  Namespace: BOUNCIE_TOKENS
 *   Initial KV key: refresh_token = <current refresh token>
 *
 * Bouncie rotates refresh tokens on every use — KV stores the latest one.
 */

const VEHICLE_MAP = {
  // YKF
  escape:  { imei: '864486065705564', name: 'Ford Escape'      },
  elantra: { imei: '864486065704609', name: 'Hyundai Elantra'  },
  micra:   { imei: '864486067025912', name: 'Nissan Micra'     },
  impala:  { imei: '864486065672418', name: 'Chevrolet Impala' },
  whtruck: { imei: '864486067777199', name: 'White MX Truck'   },
  brtruck: { imei: '864486065705507', name: 'Brown MX Truck'   },
  kubota:  { imei: null,              name: 'Kubota'           },
  civic:   { imei: '864486064882232', name: 'Honda Civic'      },

  // YAV
  caravan: { imei: '864486066542313', name: 'Dodge Caravan' },

  // YQT — keys are provisional; align them with YQT's real CREW_CARS keys
  // once that base's baseConfig.js is actually built (Phase 6)
  yqtBlueVan:  { imei: '864486065699221', name: '013 Blue Van YQT'  },
  yqtWhiteVan: { imei: '864486065833440', name: '011 White Van YQT' },
  yqtSpark:    { imei: '866392065193629', name: '005 Spark YQT'     },

  // YXL — same caveat as YQT above (Phase 7)
  yxlShopTruck: { imei: '864486065700979', name: '001 YXL Shop Truck' },
  yxlWhiteVan:  { imei: '864486065700987', name: '003 White Van YXL'  },
  yxlSonic:     { imei: '864486065704740', name: '020 Sonic YXL'      },
  yxlFocus:     { imei: '864486065823144', name: '010 Focus YXL'      },
  yxlGrandPrix: { imei: '864486065885663', name: '006 Grand Prix YXL' },
  yxlBlackVan:  { imei: '864486065913341', name: '004 Black Van YXL'  },
  yxlSilverVan: { imei: '864486066507225', name: '008 Silver Van YXL' },

  // Unlabeled in Bouncie ("15", 2010 Mazda3, imei 864486067872552) —
  // excluded until someone confirms which base it actually belongs to.
};

const CORS = {
  'Access-Control-Allow-Origin':  'https://aristihernandez-svg.github.io',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// In-memory cache for the current access token within a Worker instance lifetime
let cachedToken = null;
let tokenExpiresAt = 0;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/vehicles') {
      try {
        const token = await getAccessToken(env);
        const results = await fetchAllVehicles(token);
        return Response.json(results, { headers: CORS });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 502, headers: CORS });
      }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};

async function getAccessToken(env) {
  const now = Date.now();
  // 1. In-memory cache — fastest, but only lives for this isolate's lifetime
  //    and isn't shared with any other concurrently-running copy of this
  //    Worker (Cloudflare runs multiple isolates of the same script).
  if (cachedToken && now < tokenExpiresAt - 120_000) {
    return cachedToken;
  }

  // 2. KV-cached access token — shared across every isolate, so under normal
  //    conditions only ONE isolate ever needs to actually refresh per token
  //    lifetime (~1hr), not every isolate on every request. This is the main
  //    defense against the refresh race described below: it shrinks the
  //    window where two isolates could both decide to refresh at once from
  //    "any request, any isolate" down to "the few seconds right at expiry."
  const [kvToken, kvExpiresAtStr] = await Promise.all([
    env.BOUNCIE_KV.get('access_token'),
    env.BOUNCIE_KV.get('access_token_expires_at'),
  ]);
  const kvExpiresAt = parseInt(kvExpiresAtStr || '0', 10);
  if (kvToken && now < kvExpiresAt - 120_000) {
    cachedToken = kvToken;
    tokenExpiresAt = kvExpiresAt;
    return cachedToken;
  }

  // 3. Actually need to refresh. Bouncie rotates the refresh token on every
  //    use and invalidates the old one immediately — if two isolates ever
  //    read the same refresh_token from KV and both redeem it near-
  //    simultaneously, Bouncie honors whichever arrives first and rejects
  //    the other with invalid_grant, which is exactly the failure this
  //    project hit. A short KV-based lock closes most of that window: if
  //    another isolate is already mid-refresh, wait for it and use what it
  //    saves instead of racing it. Not a true atomic lock (Workers KV has
  //    no compare-and-swap), but combined with step 2 above the real race
  //    window shrinks from "constant" to "a couple seconds, once an hour."
  //
  //    Retried up to 3 times (not just once) — a single 1.5s wait meant a
  //    slow-but-still-working refresh would get raced by every isolate that
  //    gave up too early, which is exactly the scenario this lock exists to
  //    prevent. Still bounded (max ~4.5s added latency) so a genuinely
  //    abandoned lock (the holder crashed without releasing it) doesn't
  //    block requests for its full 60s TTL.
  const lockKey = 'refresh_lock';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await env.BOUNCIE_KV.get(lockKey))) break;
    await new Promise(r => setTimeout(r, 1500));
    const [freshToken, freshExpiresAtStr] = await Promise.all([
      env.BOUNCIE_KV.get('access_token'),
      env.BOUNCIE_KV.get('access_token_expires_at'),
    ]);
    const freshExpiresAt = parseInt(freshExpiresAtStr || '0', 10);
    if (freshToken && Date.now() < freshExpiresAt - 60_000) {
      cachedToken = freshToken;
      tokenExpiresAt = freshExpiresAt;
      return cachedToken;
    }
    // Whoever held the lock didn't leave us anything usable this round —
    // loop again (if attempts remain) or fall through to refresh ourselves.
  }
  // Cloudflare KV rejects any expirationTtl below 60 seconds (400 error) --
  // 60 is the floor, not a real design choice; the lock is only ever meant
  // to live a few seconds in practice.
  await env.BOUNCIE_KV.put(lockKey, '1', { expirationTtl: 60 });

  const refreshToken = await env.BOUNCIE_KV.get('refresh_token');
  if (!refreshToken) throw new Error('No refresh_token in KV — add key "refresh_token" to BOUNCIE_TOKENS namespace');

  const res = await fetch('https://auth.bouncie.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     env.BOUNCIE_CLIENT_ID,
      client_secret: env.BOUNCIE_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));

  const expiresAt = now + (data.expires_in ?? 3600) * 1000;

  // Bouncie has already rotated the refresh token server-side by this point
  // — if we fail to persist data.refresh_token anywhere, it's gone for good
  // and the next refresh cycle hits invalid_grant using the now-stale one
  // still in KV. So: save it first, alone, with its own retries, before
  // anything else. The access token and lock-release are comparatively
  // cheap to redo if they fail (this isolate still has the access token in
  // memory either way), so they stay batched together afterward.
  if (data.refresh_token) {
    await putWithRetry(env.BOUNCIE_KV, 'refresh_token', data.refresh_token);
  }
  await Promise.all([
    putWithRetry(env.BOUNCIE_KV, 'access_token', data.access_token),
    putWithRetry(env.BOUNCIE_KV, 'access_token_expires_at', String(expiresAt)),
    env.BOUNCIE_KV.delete(lockKey),
  ]);

  cachedToken = data.access_token;
  tokenExpiresAt = expiresAt;
  return cachedToken;
}

// Workers KV writes are normally reliable, but a transient failure on the
// refresh_token write specifically would lose a token Bouncie has already
// rotated past recovery — a couple of quick retries costs nothing in the
// common case and meaningfully reduces that one-in-a-blue-moon risk.
async function putWithRetry(kv, key, value, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { await kv.put(key, value); return; }
    catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
}

async function fetchAllVehicles(token) {
  const results = {};

  await Promise.all(
    Object.entries(VEHICLE_MAP).map(async ([key, v]) => {
      if (!v.imei) {
        results[key] = { status: 'unconfigured' };
        return;
      }
      try {
        const res = await fetch(
          `https://api.bouncie.dev/v1/vehicles?imei=${v.imei}`,
          { headers: { Authorization: token, 'Content-Type': 'application/json' } }
        );
        if (!res.ok) throw new Error(`Bouncie API ${res.status}`);
        const data = await res.json();
        const vehicle = Array.isArray(data) ? data[0] : data;
        results[key] = {
          status:    'ok',
          odometer:  vehicle?.stats?.odometer                     ?? null,
          fuelLevel: vehicle?.stats?.fuelLevel                    ?? null,
          battery:   vehicle?.stats?.battery?.status              ?? null,
          milOn:     vehicle?.stats?.mil?.milOn                   ?? false,
          dtcList:   vehicle?.stats?.mil?.qualifiedDtcList        ?? [],
          updatedAt: vehicle?.stats?.lastUpdated                  ?? null,
        };
      } catch (e) {
        results[key] = { status: 'error', error: e.message };
      }
    })
  );

  return results;
}
