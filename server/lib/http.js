// Tiny HTTP helpers shared by every endpoint (same pattern as Dealivery).

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

export const errorResponse = (status, message, extra = {}) => json({ error: message, ...extra }, status);

/** Wrap a handler so thrown errors become clean JSON responses (secrets never leak). */
export function handle(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message, err.extra);
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return errorResponse(500, 'Something went wrong on our side. Please try again in a moment.');
    }
  };
}

export function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export async function readJson(request, maxBytes = 20000) {
  try {
    const text = await request.text();
    if (text.length > maxBytes) throw new HttpError(413, 'Request too large.');
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : {};
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return {};
  }
}

/** Public origin of the site, used for Stripe return URLs, feeds and social links. */
export function siteOrigin(request, env, site = {}) {
  for (const candidate of [env.SITE_URL, site.url]) {
    const v = String(candidate || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\/[^/\s]+$/i.test(v)) return v;
  }
  return request ? new URL(request.url).origin : 'http://localhost:8787';
}

export function intEnv(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** JSON that is safe to put inside <script type="application/json">. */
export const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export const money = (cents) => `$${(Math.round(cents) / 100).toFixed(2)}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
