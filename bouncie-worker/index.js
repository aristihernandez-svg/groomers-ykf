/**
 * Bouncie GPS Proxy — Cloudflare Worker
 *
 * Sits between the Skycare PWA and api.bouncie.dev so that:
 *  - API credentials never touch the browser
 *  - CORS is handled here, not blocked by Bouncie
 *
 * Deploy:
 *   wrangler deploy  (from bouncie-worker/ directory)
 *
 * Secrets — set via Cloudflare dashboard > Worker > Settings > Variables:
 *   BOUNCIE_CLIENT_ID     = skycare-yk
 *   BOUNCIE_CLIENT_SECRET = (your client secret from bouncie.dev)
 *   BOUNCIE_REFRESH_TOKEN = (the refresh token obtained during OAuth setup)
 */

const VEHICLE_MAP = {
  escape:  { imei: '864486065705564', name: 'Ford Escape'        },
  elantra: { imei: '864486065704609', name: 'Hyundai Elantra'    },
  micra:   { imei: '864486067025912', name: 'Nissan Micra'       },
  impala:  { imei: '864486065672418', name: 'Chevrolet Impala'   },
  whtruck: { imei: '864486067777199', name: 'White MX Truck'     },
  brtruck: { imei: '864486065705507', name: 'Brown MX Truck'     },
  kubota:  { imei: null,              name: 'Kubota'             },
  civic:   { imei: '864486064882232', name: 'Honda Civic'        },
};

const CORS = {
  'Access-Control-Allow-Origin':  'https://aristihernandez-svg.github.io',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Module-level token cache — survives across requests within the same Worker instance
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
  // Use cached token if still valid (with 2-min buffer)
  if (cachedToken && now < tokenExpiresAt - 120_000) {
    return cachedToken;
  }

  const res = await fetch('https://auth.bouncie.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     env.BOUNCIE_CLIENT_ID,
      client_secret: env.BOUNCIE_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: env.BOUNCIE_REFRESH_TOKEN,
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));

  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
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
          lat:       vehicle?.stats?.location?.lat    ?? null,
          lng:       vehicle?.stats?.location?.lon    ?? null,
          speed:     vehicle?.stats?.speed            ?? 0,
          isMoving:  vehicle?.stats?.isRunning        ?? false,
          odometer:  vehicle?.stats?.odometer         ?? null,
          fuelLevel: vehicle?.stats?.fuelLevel        ?? null,
          address:   vehicle?.stats?.location?.address ?? null,
          updatedAt: vehicle?.stats?.lastUpdated      ?? null,
        };
      } catch (e) {
        results[key] = { status: 'error', error: e.message };
      }
    })
  );

  return results;
}
