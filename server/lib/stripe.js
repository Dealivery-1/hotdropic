// Minimal Stripe REST client (no SDK, works in Cloudflare Workers). Same as Dealivery's, plus webhook checks.
import { HttpError } from './http.js';

const API = 'https://api.stripe.com/v1';
// Pinned so a dashboard API upgrade can never silently change response shapes.
export const STRIPE_VERSION = '2024-06-20';

/** Stripe-style form encoding: a[b][0][c]=v */
export function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') {
      const nested = formEncode(v, key);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join('&');
}

export async function stripe(env, method, path, params, idempotencyKey) {
  const keyValue = (env.STRIPE_SECRET_KEY || '').trim();
  if (!keyValue) throw new HttpError(503, 'Payments are not set up yet (missing STRIPE_SECRET_KEY).');
  let url = API + path;
  const init = { method, headers: { authorization: `Bearer ${keyValue}`, 'stripe-version': STRIPE_VERSION } };
  if (params && method === 'GET') {
    const qs = formEncode(params);
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  } else if (params) {
    init.body = formEncode(params);
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (idempotencyKey) init.headers['idempotency-key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new HttpError(502, 'Could not reach the payment provider. Please try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe error ${res.status}`;
    console.error(`Stripe ${method} ${path} -> ${res.status}: ${msg}`);
    if (res.status === 401) throw new HttpError(503, 'Payments are misconfigured (Stripe key rejected).');
    if (res.status === 429 || res.status >= 500) throw new HttpError(502, 'The payment provider is busy. Please try again.');
    throw new HttpError(400, msg, { stripeCode: data?.error?.code || null });
  }
  return data;
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks the Stripe-Signature header (HMAC-SHA256 of "timestamp.body"). */
export async function verifyStripeSignature(payload, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const [k, v] = part.split('=');
    if (k?.trim() === 't') t = Number(v);
    else if (k?.trim() === 'v1' && v) sigs.push(v.trim());
  }
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, expected));
}

/** For tests: builds a valid Stripe-Signature header. */
export async function signStripePayload(payload, secret, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `t=${t},v1=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)))}`;
}

/** Shipping address from a Checkout Session, whichever API version shaped it. */
export function sessionShipping(s) {
  const sd = s?.shipping_details || s?.collected_information?.shipping_details || s?.shipping || null;
  const cd = s?.customer_details || {};
  const a = sd?.address || cd.address || {};
  return {
    name: sd?.name || cd.name || '',
    line1: a.line1 || '',
    line2: a.line2 || '',
    city: a.city || '',
    state: a.state || '',
    zip: a.postal_code || '',
    country: a.country || 'US',
    phone: cd.phone || sd?.phone || '',
    email: cd.email || s?.customer_email || '',
  };
}
