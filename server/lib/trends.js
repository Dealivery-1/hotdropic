// THE TREND SCANNER ("hot dropic" mode). When switched on in /admin it runs every 30 minutes and:
//   1. reads what's trending: Google's US "Trending now" feed (free, no key) as a radar, plus the keyword list in
//      catalog/trends.json (rewritten twice a week by the AI trend hunter) and any keywords you add in /admin;
//   2. searches CJ Dropshipping for each due keyword and picks the products the most other stores are selling;
//   3. imports new ones (photos, variants, real shipping quote, priced by server/lib/pricing.js), refreshes the ones
//      still trending, and retires products that stopped showing up, keeping each tab to its best `perCategory`.
// It works through a couple of keywords per run so it stays inside Cloudflare's and CJ's free limits.
import TRENDS from '../../catalog/trends.json' with { type: 'json' };
import { CATEGORIES, invalidateCatalog } from './catalog.js';
import { cjReady, productDetail, searchProducts, shippingQuote } from './cj.js';
import { kvGetMany, kvSet } from './db.js';
import { retailCents } from './pricing.js';
import { blockedReason, cleanDescription, cleanTitle, slugify } from './safety.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const PER_KEYWORD = 2;
export const SCAN_CATEGORIES = new Set(CATEGORIES.filter((c) => !c.auto && c.id !== 'meme-tees').map((c) => c.id));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));

/** Keyword list = trends.json + your own (from /admin) - the ones you removed. */
export function seedList(custom = [], removed = []) {
  const gone = new Set((removed || []).map((s) => String(s).toLowerCase().trim()));
  const map = new Map();
  for (const k of [...(TRENDS.keywords || []), ...(custom || [])]) {
    if (!k?.q || !SCAN_CATEGORIES.has(k.cat)) continue;
    const q = String(k.q).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!q || gone.has(q) || blockedReason(q)) continue;
    map.set(q, { q, cat: k.cat, score: clamp(k.score ?? 70, 1, 100), why: String(k.why || '').slice(0, 220), src: String(k.src || ''), custom: Boolean(k.custom) });
  }
  return [...map.values()];
}

/** Google's "Trending now" searches in the US (title + approximate traffic). */
export async function fetchRadar() {
  const res = await fetch('https://trends.google.com/trending/rss?geo=US', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; HotDropicTrendScanner/1.0)' } });
  if (!res.ok) return [];
  const xml = (await res.text()).slice(0, 300000);
  const tag = (s, t) => (s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
  const clean = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, '').trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 25).map((m) => ({
    title: clean(tag(m[1], 'title')).slice(0, 80),
    traffic: clean(tag(m[1], 'ht:approx_traffic')).slice(0, 20),
    news: clean(tag(m[1], 'ht:news_item_title')).slice(0, 140),
  })).filter((i) => i.title);
}

export const prettyKey = (k) => String(k || '').split('-').map((s) => s.trim()).filter(Boolean).join(' / ');
const prettyName = (n) => {
  const s = String(n || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : 'Style';
};

export function buildOptions(variants, names) {
  if (variants.length <= 1) return { options: [], maps: variants.map(() => ({})) };
  const parts = variants.map((v) => v.key.split('-').map((s) => s.trim()).filter(Boolean));
  const n = names.length;
  if (n >= 1 && parts.every((p) => p.length === n)) {
    const keys = names.map(prettyName);
    const combos = new Set(parts.map((p) => p.join('|')));
    if (combos.size === variants.length) {
      return { options: keys.map((name, i) => ({ name, values: [...new Set(parts.map((p) => p[i]))] })), maps: parts.map((p) => Object.fromEntries(keys.map((k, i) => [k, p[i]]))) };
    }
  }
  const seen = new Map();
  const labels = variants.map((v) => {
    const base = prettyKey(v.key) || 'Standard';
    const c = (seen.get(base) || 0) + 1;
    seen.set(base, c);
    return c > 1 ? `${base} (${c})` : base;
  });
  return { options: [{ name: 'Style', values: labels }], maps: labels.map((l) => ({ Style: l })) };
}

const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

export function scoreFor(seed, listed, radarHit) {
  return Math.min(99, Math.round(seed.score * 0.8 + 20 * Math.min(1, Math.log10((listed || 0) + 1) / 4) + (radarHit ? 5 : 0)));
}

/** Turns CJ data into a store product. Returns null if nothing is sellable. */
export function buildProduct({ seed, item, detail, quote, from, settings, radarHit = false, now = Date.now() }) {
  const title = cleanTitle(detail.name || item.name) || cleanTitle(seed.q);
  if (!title || blockedReason(detail.name || item.name) || blockedReason(title)) return null;
  const raw = detail.variants.slice(0, 12);
  const { options, maps } = buildOptions(raw, detail.optionNames || []);
  const usedIds = new Set();
  const variants = [];
  raw.forEach((v, i) => {
    const price = retailCents(v.cost, quote.cost, settings.markup);
    if (price > settings.maxPrice || price < settings.minPrice) return;
    let id = slugify(prettyKey(v.key), 28) || `v${i + 1}`;
    while (usedIds.has(id)) id = `${id}-${i + 1}`;
    usedIds.add(id);
    variants.push({
      id,
      label: Object.values(maps[i]).join(' / ') || 'Standard',
      options: maps[i],
      price,
      image: v.image || null,
      cost: v.cost + quote.cost,
      sup: { kind: 'cj', vid: v.vid, logistic: quote.name, from },
    });
  });
  if (!variants.length) return null;
  // options must only list values that survived the price filter
  const opts = options.map((o) => ({ name: o.name, values: o.values.filter((val) => variants.some((v) => v.options[o.name] === val)) })).filter((o) => o.values.length);
  const images = [...new Set([...(detail.images || []), item.image, ...variants.map((v) => v.image)].filter((u) => /^https:\/\//.test(u || '')))].slice(0, 8);
  if (!images.length) return null;
  const listed = item.listed || 0;
  const days = [quote.days[0] + 2, quote.days[1] + 3];
  return {
    id: `cj-${slugify(title, 40)}-${String(item.pid).replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`,
    title,
    category: seed.cat,
    supplier: 'cj',
    images,
    options: opts,
    variants,
    price: Math.min(...variants.map((v) => v.price)),
    description: cleanDescription(String(detail.description || '').slice(0, 30000)) || `${title}.`,
    details: [from === 'US' ? 'Ships from a US warehouse' : 'Ships from our partner warehouse', `Arrives in about ${days[0]}-${days[1]} business days`],
    why: [seed.why, listed >= 100 ? `Listed by ${fmtCount(listed)} other online shops.` : ''].filter(Boolean).join(' '),
    tags: [seed.q],
    score: scoreFor(seed, listed, radarHit),
    addedAt: now,
    refreshedAt: now,
    shipDays: days,
    source: { pid: item.pid, keyword: seed.q, listed, cost: item.cost },
  };
}

async function scanKeyword(env, seed, list, settings, radarText, now, banned = new Set()) {
  const lines = [];
  const radarHit = seed.q.split(' ').filter((w) => w.length > 3).some((w) => radarText.includes(w));
  const fits = (x) => !banned.has(x.pid) && x.image && Number.isFinite(x.cost) && x.cost > 0 && x.cost * 1.3 < settings.maxPrice && !blockedReason(x.name);
  let found = [];
  if (settings.usWarehouseFirst) found = (await searchProducts(env, seed.q, { countryCode: 'US' })).filter(fits).map((x) => ({ ...x, from: 'US' }));
  if (found.length < PER_KEYWORD) {
    const more = (await searchProducts(env, seed.q, {})).filter(fits).map((x) => ({ ...x, from: 'CN' }));
    const have = new Set(found.map((x) => x.pid));
    found = [...found, ...more.filter((x) => !have.has(x.pid))];
  }
  found.sort((a, b) => b.listed - a.listed || a.cost - b.cost);
  const byPid = new Map(list.map((p, i) => [String(p.source?.pid || ''), i]));
  const importProduct = async (pick, keep = null) => {
    const detail = await productDetail(env, pick.pid);
    if (!detail.variants.length) return `"${cleanTitle(pick.name)}" has no sellable variants`;
    const priciest = detail.variants.reduce((m, v) => (v.cost > m.cost ? v : m), detail.variants[0]);
    const quote = await shippingQuote(env, priciest.vid, pick.from);
    if (!quote) return `no shipping to the US for "${cleanTitle(pick.name)}"`;
    const product = buildProduct({ seed: keep ? { ...seed, cat: keep.category } : seed, item: pick, detail, quote, from: pick.from, settings, radarHit, now });
    if (!product) return `skipped "${cleanTitle(pick.name)}" (blocked word, price out of range, or no photos)`;
    if (keep) {
      const i = list.findIndex((p) => p.id === keep.id);
      if (i >= 0) list[i] = { ...product, id: keep.id, addedAt: keep.addedAt };
      return `re-priced "${product.title}" (supplier price changed) to $${(product.price / 100).toFixed(2)}`;
    }
    list.push(product);
    return `added "${product.title}" at $${(product.price / 100).toFixed(2)} (${product.category})`;
  };
  // still trending: refresh what we already sell from this search (re-import one whose supplier price moved)
  let repriced = false;
  for (const x of found) {
    const i = byPid.get(x.pid);
    if (i === undefined) continue;
    const p = list[i];
    const was = Number(p.source?.cost);
    const drift = Number.isFinite(was) && Math.abs(x.cost - was) > Math.max(50, was * 0.1);
    if (drift && !repriced) {
      repriced = true;
      lines.push(`"${seed.q}": ${await importProduct(x, p)}`);
      continue;
    }
    list[i] = { ...p, refreshedAt: now, score: scoreFor(seed, x.listed, radarHit), source: { ...p.source, listed: x.listed } };
  }
  const mine = list.filter((p) => p.source?.keyword === seed.q && now - (p.refreshedAt || 0) < DAY).length;
  if (mine >= PER_KEYWORD) return [...lines, `"${seed.q}": ${mine} products still trending, refreshed`];
  const pick = found.find((x) => !byPid.has(x.pid));
  if (!pick) return [...lines, `"${seed.q}": nothing new that passes the filters`];
  lines.push(`"${seed.q}": ${await importProduct(pick)}`);
  return lines;
}

/** Drops products that stopped trending and keeps each tab to its best `perCategory`. */
export function retire(list, settings, pinned = new Set(), now = Date.now(), lines = []) {
  const keep = [];
  for (const p of list) {
    if (!pinned.has(p.id) && now - (p.refreshedAt || 0) > settings.staleDays * DAY) {
      lines.push(`retired "${p.title}" (stopped trending)`);
      continue;
    }
    keep.push(p);
  }
  const byCat = new Map();
  for (const p of keep) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  const out = [];
  for (const group of byCat.values()) {
    group.sort((a, b) => b.score - a.score);
    let kept = 0;
    for (const p of group) {
      if (pinned.has(p.id)) out.push(p); // pinned products don't count toward the tab limit
      else if (kept < settings.perCategory) {
        out.push(p);
        kept += 1;
      } else lines.push(`retired "${p.title}" (tab full of hotter products)`);
    }
  }
  return out;
}

/** One scanner run. maxKeywords keeps each run small (Cloudflare free plan: 50 outbound requests per run). */
export async function runScan(env, { settings, maxKeywords = 2, force = false, now = Date.now() } = {}) {
  if (!cjReady(env)) return { ok: false, lines: ['CJ is not connected yet, so there is nothing to scan. Add CJ_API_KEY (SETUP.md step 5).'] };
  const st = await kvGetMany(env, ['scan:state', 'catalog:trending', 'seeds:custom', 'seeds:removed', 'catalog:overrides']);
  const state = { done: {}, runs: [], ...(st['scan:state'] || {}) };
  let list = Array.isArray(st['catalog:trending']) ? st['catalog:trending'] : [];
  const seeds = seedList(st['seeds:custom'] || [], st['seeds:removed'] || []);
  const pinned = new Set(st['catalog:overrides']?.pinned || []);
  const lines = [];
  if (!state.radar || now - state.radar.at > 3 * HOUR) {
    state.radar = { at: now, items: await fetchRadar().catch(() => state.radar?.items || []) };
  }
  const radarText = (state.radar.items || []).map((i) => `${i.title} ${i.news}`.toLowerCase()).join(' | ');
  const every = settings.scanEveryHours * HOUR;
  const due = seeds
    .filter((s) => force || now - (state.done[s.q] || 0) >= every)
    .sort((a, b) => (state.done[a.q] || 0) - (state.done[b.q] || 0) || b.score - a.score)
    .slice(0, maxKeywords);
  const startIds = new Set(list.map((p) => p.id));
  let errors = 0;
  for (const seed of due) {
    try {
      lines.push(...(await scanKeyword(env, seed, list, settings, radarText, now, new Set(state.banned || []))));
      state.done[seed.q] = now;
    } catch (e) {
      errors += 1;
      lines.push(`"${seed.q}": ${e.message}`);
      state.done[seed.q] = now - every + HOUR; // try again in about an hour
      if (/rate limit|1600200|429/i.test(e.message)) break;
    }
  }
  for (const q of Object.keys(state.done)) if (!seeds.some((s) => s.q === q)) delete state.done[q];
  // A CJ outage shouldn't empty the store: only retire stale products on runs that worked.
  if (!errors) list = retire(list, settings, pinned, now, lines);
  // Something may have changed while we were scanning (you removed a product in /admin): respect it.
  const latest = await kvGetMany(env, ['catalog:trending', 'scan:state']);
  const liveIds = new Set((latest['catalog:trending'] || []).map((p) => p.id));
  const banned = new Set([...(state.banned || []), ...(latest['scan:state']?.banned || [])]);
  list = list.filter((p) => (!startIds.has(p.id) || liveIds.has(p.id)) && !banned.has(String(p.source?.pid || '')));
  state.banned = [...banned].slice(-500);
  const waiting = seeds.filter((s) => now - (state.done[s.q] || 0) >= every).length;
  state.lastRun = now;
  state.runs = [{ t: now, lines: lines.slice(0, 30) }, ...(state.runs || [])].slice(0, 15);
  await kvSet(env, 'catalog:trending', list);
  await kvSet(env, 'scan:state', state);
  invalidateCatalog();
  return { ok: true, lines, scanned: due.length, products: list.length, keywords: seeds.length, waiting };
}
