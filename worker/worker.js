// Skycare YKF — Anthropic AI proxy
// Deployed on Cloudflare Workers. The API key lives here as a secret (ANTHROPIC_API_KEY),
// never in the browser. CORS is locked to the GitHub Pages origin.

const ALLOWED_ORIGIN = 'https://aristihernandez-svg.github.io';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (origin !== ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403 });

    let body;
    try { body = await request.json(); }
    catch { return new Response('Invalid JSON', { status: 400 }); }

    // Strip any apiKey the client may send — key comes from env secret only
    const { apiKey: _ignored, ...payload } = body;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'text/event-stream',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      },
    });
  },
};
