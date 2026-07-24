/**
 * Bouncie GPS Proxy — Cloudflare Worker
 *
 * Sits between the Skycare PWA and api.bouncie.dev so that:
 *  - API credentials never touch the browser
 *  - CORS is handled here, not blocked by Bouncie
 *
 * Deploy:
 *   1. wrangler deploy  (or paste into the Cloudflare dashboard)
 *
 * Secrets — set via Cloudflare dashboard > Worker > Settings > Variables:
 *   BOUNCIE_CLIENT_ID     = your Bouncie OAuth client ID
 *   BOUNCIE_CLIENT_SECRET = your Bouncie OAuth client secret
 *   BOUNCIE_AUTH_TOKEN    = your Bouncie API token (if using simple token auth)
 *
 * Mapping — edit VEHICLE_MAP below once you have your Bouncie vehicle IMEIs:
 *   key  = matches CREW_CARS[].key in index.html
 *   imei = the IMEI printed on the Bouncie OBD dongle or shown in the Bouncie dashboard
 */

const VEHICLE_MAP = {
  escape:  { imei: 'REPLACE_WITH_IMEI', name: 'Ford Escape'      },
  elantra: { imei: 'REPLACE_WITH_IMEI', name: 'Hyundai Elantra'  },
  micra:   { imei: 'REPLACE_WITH_IMEI', name: 'Nissan Micra'     },
  impala:  { imei: 'REPLACE_WITH_IMEI', name: 'Chevrolet Impala' },
  whtruck: { imei: 'REPLACE_WITH_IMEI', name: 'White MX Truck'   },
  brtruck: { imei: 'REPLACE_WITH_IMEI', name: 'Brown MX Truck'   },
  kubota:  { imei: 'REPLACE_WITH_IMEI', name: 'Kubota'           },
  civic:   { imei: 'REPLACE_WITH_IMEI', name: 'Honda Civic'      },
};

const CORS = {
  'Access-Control-Allow-Origin':  'https://aristihernandez-svg.github.io',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // GET /vehicles — returns location + status for all mapped vehicles
    if (url.pathname === '/vehicles') {
      try {
        const results = await fetchAllVehicles(env);
        return Response.json(results, { headers: CORS });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 502, headers: CORS });
      }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};

async function fetchAllVehicles(env) {
  const token = env.BOUNCIE_AUTH_TOKEN;
  if (!token) throw new Error('BOUNCIE_AUTH_TOKEN secret not set');

  const results = {};

  await Promise.all(
    Object.entries(VEHICLE_MAP).map(async ([key, v]) => {
      if (v.imei === 'REPLACE_WITH_IMEI') {
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
          lat:       vehicle?.stats?.lastTrip?.endLocation?.lat   ?? null,
          lng:       vehicle?.stats?.lastTrip?.endLocation?.lon   ?? null,
          speed:     vehicle?.stats?.speed                        ?? 0,
          isMoving:  vehicle?.stats?.isMoving                     ?? false,
          odometer:  vehicle?.stats?.odometer                     ?? null,
          updatedAt: vehicle?.stats?.lastTrip?.endTime            ?? null,
        };
      } catch (e) {
        results[key] = { status: 'error', error: e.message };
      }
    })
  );

  return results;
}
