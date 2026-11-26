/**
 * Windows Golden Panel authentication relay (Cloudflare Worker).
 *
 * Relays GitHub Device Flow requests, because github.com/login/* does not allow
 * browser CORS requests. It only adds the OAuth client ID; no secret is stored
 * and no token is logged or kept.
 *
 * Variables (wrangler.toml [vars]):
 *   PANEL_ORIGINS     Comma-separated list of allowed origins, for example
 *                     "https://fox3000foxy.com,https://fox3000foxy.github.io".
 *   PANEL_ORIGIN      Single origin, still accepted for older configurations.
 *   GITHUB_CLIENT_ID  OAuth App client ID with Device Flow enabled.
 */

const DEV_ORIGINS = ['http://localhost:4321', 'http://127.0.0.1:4321'];
const SCOPE = 'repo workflow';

function allowedOrigins(env) {
  return [env.PANEL_ORIGINS, env.PANEL_ORIGIN]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .concat(DEV_ORIGINS);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin ? corsHeaders(origin) : {}),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function github(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  return new Response(text, { status: response.status });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = !!origin && allowedOrigins(env).includes(origin);

    // Unknown origins get a readable 403 (with CORS headers, so the panel can
    // show "origin not allowed" instead of an opaque CORS failure). The
    // response carries no data, so exposing it is harmless.
    if (!allowed) {
      return json({ error: 'origin_not_allowed', origin: origin ?? null }, 403, origin || null);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }
    if (!env.GITHUB_CLIENT_ID) {
      return json({ error: 'relay_misconfigured', error_description: 'GITHUB_CLIENT_ID is not set.' }, 500, origin);
    }

    const path = new URL(request.url).pathname;
    try {
      let upstream;
      if (path === '/device') {
        upstream = await github('https://github.com/login/device/code', {
          client_id: env.GITHUB_CLIENT_ID,
          scope: SCOPE,
        });
      } else if (path === '/token') {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'invalid_request', error_description: 'Body must be JSON.' }, 400, origin);
        }
        const deviceCode = body?.device_code;
        if (typeof deviceCode !== 'string' || !deviceCode || deviceCode.length > 200) {
          return json({ error: 'invalid_request', error_description: 'device_code is missing or invalid.' }, 400, origin);
        }
        upstream = await github('https://github.com/login/oauth/access_token', {
          client_id: env.GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
      } else {
        return json({ error: 'not_found' }, 404, origin);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch {
      return json({ error: 'upstream_unreachable', error_description: 'GitHub could not be reached.' }, 502, origin);
    }
  },
};
