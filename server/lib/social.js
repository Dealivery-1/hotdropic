// Posting to social networks. Same channels and secret names as Dealivery's auto-poster, rewritten to run inside
// the Cloudflare Worker (no Node APIs, no GitHub Action needed), with product photos / link cards where allowed.
// Secrets go in Cloudflare: Workers & Pages > hotdropic > Settings > Variables and Secrets.
import { kvGet, kvSet } from './db.js';

export const CHANNELS = [
  { id: 'bluesky', name: 'Bluesky', keys: ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'], max: 295 },
  { id: 'mastodon', name: 'Mastodon', keys: ['MASTODON_URL', 'MASTODON_TOKEN'], max: 495 },
  { id: 'threads', name: 'Threads', keys: ['THREADS_ACCESS_TOKEN'], max: 480 },
  { id: 'telegram', name: 'Telegram channel', keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], max: 1000 },
  { id: 'discord', name: 'Discord', keys: ['DISCORD_WEBHOOK_URL'], max: 1900 },
  { id: 'x', name: 'X (paid API)', keys: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'], max: 270 },
];

export const channelReady = (env, ch) => ch.keys.every((k) => String(env[k] || '').trim());

/** Adds tracking tags so you can see in analytics which network sent the visit. */
export function utm(link, network, campaign = 'daily') {
  const u = new URL(link);
  u.searchParams.set('utm_source', network);
  u.searchParams.set('utm_medium', 'social');
  u.searchParams.set('utm_campaign', campaign);
  return u.toString();
}

/** Trims text so "text + blank line + link" fits in max characters (X counts any link as 23). */
export function fit(text, link, max, linkWeight = null) {
  const len = (s) => [...s].length;
  const linkLen = link ? 2 + (linkWeight ?? len(link)) : 0;
  let body = String(text || '').trim();
  if (len(body) + linkLen > max) body = [...body].slice(0, Math.max(0, max - linkLen - 1)).join('').replace(/\s+\S*$/, '') + '…';
  return link ? `${body}\n\n${link}` : body;
}

async function check(res, label) {
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

// ---------------------------------------------------------------- Bluesky (free)
export async function postBluesky(env, post) {
  const link = utm(post.link, 'bluesky');
  const text = fit(post.text, link, 295);
  const s = await (await check(await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }),
  }), 'Bluesky login')).json();
  const auth = { authorization: `Bearer ${s.accessJwt}` };
  let thumb;
  if (post.image) {
    try {
      const img = await fetch(post.image);
      const buf = img.ok ? await img.arrayBuffer() : null;
      if (buf && buf.byteLength < 950000) {
        const up = await fetch('https://bsky.social/xrpc/com.atproto.repo.uploadBlob', { method: 'POST', headers: { ...auth, 'content-type': img.headers.get('content-type') || 'image/jpeg' }, body: buf });
        if (up.ok) thumb = (await up.json()).blob;
      }
    } catch {
      /* post without a thumbnail */
    }
  }
  const enc = new TextEncoder();
  const facets = [];
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const start = enc.encode(text.slice(0, m.index)).length;
    facets.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  for (const m of text.matchAll(/(^|\s)(#[A-Za-z][A-Za-z0-9_]{1,40})/g)) {
    const start = enc.encode(text.slice(0, m.index + m[1].length)).length;
    facets.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[2]).length }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2].slice(1) }] });
  }
  const external = { uri: link, title: post.title.slice(0, 200), description: post.description.slice(0, 280) };
  if (thumb) external.thumb = thumb;
  await check(await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text, facets, createdAt: new Date().toISOString(), embed: { $type: 'app.bsky.embed.external', external } } }),
  }), 'Bluesky post');
}

// ---------------------------------------------------------------- Mastodon (free; the link card comes from our page tags)
export async function postMastodon(env, post, day = '') {
  const link = utm(post.link, 'mastodon');
  await check(await fetch(`${env.MASTODON_URL.replace(/\/+$/, '')}/api/v1/statuses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MASTODON_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `hotdropic-${day || Date.now()}` },
    body: new URLSearchParams({ status: fit(post.text, link, 495), visibility: 'public' }),
  }), 'Mastodon');
}

// ---------------------------------------------------------------- Telegram channel (free)
export async function postTelegram(env, post) {
  const link = utm(post.link, 'telegram');
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  if (post.image) {
    const r = await fetch(`${api}/sendPhoto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, photo: post.image, caption: fit(post.text, link, 1000) }) });
    if (r.ok) return;
  }
  await check(await fetch(`${api}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: fit(post.text, link, 3500) }) }), 'Telegram');
}

// ---------------------------------------------------------------- Discord webhook (free)
export async function postDiscord(env, post) {
  const link = utm(post.link, 'discord');
  const embed = { title: post.title.slice(0, 250), url: link, description: post.description.slice(0, 350), color: 0xff4d2e };
  if (post.image) embed.image = { url: post.image };
  await check(await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: post.text.slice(0, 1800), embeds: [embed] }) }), 'Discord');
}

// ---------------------------------------------------------------- Threads (free). Keys last 60 days; every run refreshes and saves the new one.
export async function postThreads(env, post) {
  const base = 'https://graph.threads.net';
  const saved = await kvGet(env, 'threads:token').catch(() => null);
  let token = saved?.from === env.THREADS_ACCESS_TOKEN && saved.token ? saved.token : env.THREADS_ACCESS_TOKEN;
  try {
    const r = await fetch(`${base}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`);
    if (r.ok) {
      const j = await r.json();
      if (j.access_token) {
        token = j.access_token;
        await kvSet(env, 'threads:token', { from: env.THREADS_ACCESS_TOKEN, token, at: Date.now() });
      }
    }
  } catch {
    /* posting below still uses the current key */
  }
  const fail = async (res, step) => {
    const body = (await res.text()).slice(0, 300);
    const hint = /access token|session has expired|OAuthException/i.test(body) ? ' (the Threads key expired or is wrong: make a new one)' : '';
    return new Error(`Threads ${step} ${res.status}${hint}: ${body}`);
  };
  const me = await fetch(`${base}/v1.0/me?fields=id&access_token=${encodeURIComponent(token)}`);
  if (!me.ok) throw await fail(me, 'account');
  const { id: userId } = await me.json();
  const link = utm(post.link, 'threads');
  const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...o, access_token: token }) });
  let created = await fetch(`${base}/v1.0/${encodeURIComponent(userId)}/threads`, form({ media_type: 'TEXT', text: fit(post.text, link, 480), link_attachment: link }));
  if (!created.ok) created = await fetch(`${base}/v1.0/${encodeURIComponent(userId)}/threads`, form({ media_type: 'TEXT', text: fit(post.text, link, 480) }));
  if (!created.ok) throw await fail(created, 'draft');
  const { id: creationId } = await created.json();
  const published = await fetch(`${base}/v1.0/${encodeURIComponent(userId)}/threads_publish`, form({ creation_id: creationId }));
  if (!published.ok) throw await fail(published, 'publish');
}

// ---------------------------------------------------------------- X (paid pay-per-use API, about $0.20 per post with a link)
const pct = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function oauth1Header({ method, url, params = {}, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join('&');
  const baseString = `${method.toUpperCase()}&${pct(url)}&${pct(paramString)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${pct(consumerSecret)}&${pct(tokenSecret)}`), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString)))));
  const header = { ...oauth, oauth_signature: sig };
  return `OAuth ${Object.keys(header).sort().map((k) => `${pct(k)}="${pct(header[k])}"`).join(', ')}`;
}

export async function postX(env, post) {
  const url = 'https://api.x.com/2/tweets';
  const link = utm(post.link, 'x');
  const authorization = await oauth1Header({ method: 'POST', url, consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_TOKEN_SECRET });
  const res = await fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ text: fit(post.text, link, 270, 23) }) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const hint = res.status === 401 ? ' (one of the 4 X keys is wrong)' : res.status === 402 || /credit/i.test(body) ? ' (add credits in the X developer console)' : res.status === 403 ? ' (set the app to "Read and write", then regenerate the access token)' : '';
    throw new Error(`X ${res.status}${hint}: ${body}`);
  }
}

export const SENDERS = { bluesky: postBluesky, mastodon: postMastodon, threads: postThreads, telegram: postTelegram, discord: postDiscord, x: postX };
