// Admin sign-in for /admin: one password (the ADMIN_PASSWORD secret in Cloudflare, 12+ characters).
// A successful login returns a token that lasts 7 days. Tokens are signed with a random secret kept in the
// database plus the password, so a leaked token can't be used to guess the password, and changing the
// password signs everyone out. 8 wrong tries from one IP (or IPv6 /64) in 15 minutes = locked out.
import { clearLogins, countLogin, kvGet, kvSet } from './db.js';
import { bearerToken, HttpError } from './http.js';

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const MIN_LENGTH = 12;
const secrets = new WeakMap();

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function signingKey(env) {
  let s = secrets.get(env.DB);
  if (!s) {
    s = (await kvGet(env, 'admin:secret', null))?.s;
    if (!s) {
      s = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await kvSet(env, 'admin:secret', { s });
    }
    secrets.set(env.DB, s);
  }
  return `hotdropic-admin:${s}:${env.ADMIN_PASSWORD}`;
}

export const adminConfigured = (env) => String(env.ADMIN_PASSWORD || '').length >= MIN_LENGTH;
const notConfigured = () => new HttpError(503, `Set an ADMIN_PASSWORD secret (${MIN_LENGTH}+ characters) in Cloudflare first. See SETUP.md step 3.`);

export async function makeToken(env, days = 7, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: now + days * 86400000 })));
  return `${payload}.${await hmac(await signingKey(env), payload)}`;
}

export async function checkToken(env, token, now = Date.now()) {
  if (!adminConfigured(env) || !token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig || '', await hmac(await signingKey(env), payload))) return false;
  try {
    return JSON.parse(fromB64url(payload)).exp > now;
  } catch {
    return false;
  }
}

export async function requireAdmin(request, env) {
  if (!adminConfigured(env)) throw notConfigured();
  if (!(await checkToken(env, bearerToken(request)))) throw new HttpError(401, 'Please sign in again.');
}

/** IPv6 addresses are grouped by /64 so rotating addresses doesn't reset the lockout. */
export function ipKey(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  const parts = s.split(':');
  return `${parts.slice(0, 4).join(':')}::/64`;
}

export async function login(env, password, ip = 'unknown', now = Date.now()) {
  if (!adminConfigured(env)) throw notConfigured();
  const key = ipKey(ip);
  // Count first (atomically), then check: parallel guesses can't slip past the limit.
  const n = await countLogin(env, key, now);
  if (n > 8) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
  const a = await hmac('cmp', String(password || ''));
  const b = await hmac('cmp', String(env.ADMIN_PASSWORD));
  if (!safeEqual(a, b)) throw new HttpError(401, 'Wrong password.');
  await clearLogins(env, key);
  return makeToken(env, 7, now);
}
