// The product catalog = meme apparel from catalog/designs.json (always there)
//                     + products the trend scanner imported from CJ (stored in D1 under "catalog:trending").
// Prices and supplier details live only on the server: publicProduct() strips cost and supplier ids.
import DESIGNS from '../../catalog/designs.json' with { type: 'json' };
import CATS from '../../catalog/categories.json' with { type: 'json' };
import { kvGetMany } from './db.js';

export const CATEGORIES = CATS.categories;
export const STYLES = DESIGNS.styles;
const DAY = 86400000;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function apparelProducts() {
  const out = [];
  for (const d of DESIGNS.designs) {
    for (const styleKey of d.styles) {
      const st = DESIGNS.styles[styleKey];
      if (!st) continue;
      const colors = Object.keys(d.colors).sort((a, b) => (a === d.defaultColor ? -1 : b === d.defaultColor ? 1 : 0));
      const variants = [];
      for (const color of colors) {
        for (const size of st.sizes) {
          variants.push({
            id: `${slug(color)}-${slug(size)}`,
            label: `${color} / ${size}`,
            options: { Color: color, Size: size },
            price: st.price[size] ?? st.price.default,
            image: `/img/products/${d.id}-${styleKey}-${slug(color)}.jpg`,
            cost: (st.estCost[size] ?? st.estCost.default) + (st.estShipping || 0),
            sup: { kind: 'printful', style: styleKey, color, size, file: `/designs/${d.id}-${d.colors[color]}.png` },
          });
        }
      }
      out.push({
        id: `${d.id}-${styleKey}`,
        title: `${d.name} ${st.label}`,
        category: 'meme-tees',
        supplier: 'printful',
        images: colors.map((c) => `/img/products/${d.id}-${styleKey}-${slug(c)}.jpg`),
        options: [
          { name: 'Color', values: colors },
          { name: 'Size', values: st.sizes },
        ],
        variants,
        price: Math.min(...variants.map((v) => v.price)),
        description: d.blurb,
        details: st.details,
        why: d.trendNote,
        tags: d.tags,
        score: d.score - (styleKey === 'tee' ? 0 : 6),
        addedAt: Date.parse(d.added) || 0,
        refreshedAt: Date.parse(d.added) || 0,
        shipDays: st.shipDays,
        design: d.id,
        style: styleKey,
      });
    }
  }
  return out;
}

const APPAREL = apparelProducts();
let cache = { at: 0, db: null, data: null };
const TTL = 30000;

export function invalidateCatalog() {
  cache = { at: 0, db: null, data: null };
}

/** All products (hidden ones only when includeHidden). Falls back to apparel only if the database isn't ready. */
export async function loadCatalog(env, { fresh = false, includeHidden = false } = {}) {
  if (fresh || !cache.data || cache.db !== env.DB || Date.now() - cache.at > TTL) {
    let stored = {};
    let dbOk = true;
    try {
      stored = await kvGetMany(env, ['catalog:trending', 'catalog:overrides']);
    } catch (e) {
      dbOk = false;
    }
    const trending = Array.isArray(stored['catalog:trending']) ? stored['catalog:trending'] : [];
    const ov = stored['catalog:overrides'] || {};
    const hidden = new Set(ov.hidden || []);
    const pinned = new Set(ov.pinned || []);
    const seen = new Set();
    const products = [];
    for (const p of [...APPAREL, ...trending]) {
      if (!p || !p.id || seen.has(p.id) || !Array.isArray(p.variants) || !p.variants.length) continue;
      seen.add(p.id);
      products.push({ ...p, hidden: hidden.has(p.id), pinned: pinned.has(p.id) });
    }
    cache = { at: Date.now(), db: env.DB, data: { products, categories: CATEGORIES, dbOk } };
  }
  const d = cache.data;
  return includeHidden ? d : { ...d, products: d.products.filter((p) => !p.hidden) };
}

export function badges(p, now = Date.now()) {
  const b = [];
  if (p.pinned) b.push('pick');
  if (p.score >= 90) b.push('hot');
  if (now - (p.addedAt || 0) < 7 * DAY) b.push('new');
  return b;
}

/** What browsers may see: no supplier ids, no costs. */
export function publicProduct(p, now = Date.now()) {
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    images: p.images,
    options: p.options || [],
    price: p.price,
    description: p.description || '',
    details: p.details || [],
    why: p.why || '',
    tags: p.tags || [],
    shipDays: p.shipDays || [7, 14],
    printed: p.supplier === 'printful',
    badges: badges(p, now),
    score: Math.round((p.score || 0) + (p.pinned ? 1000 : 0)),
    variants: p.variants.map((v) => ({ id: v.id, label: v.label, options: v.options || {}, price: v.price, image: v.image || null })),
  };
}

/** Product ids for the Trending tab: pinned first, then the hottest item from each tab in turn (so it isn't all tees). */
export function trendingIds(products, n = 24) {
  const sorted = [...products].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
  const out = sorted.filter((p) => p.pinned).map((p) => p.id);
  const byCat = new Map();
  for (const p of sorted) {
    if (p.pinned) continue;
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push(p);
  }
  const queues = [...byCat.values()];
  while (out.length < n && queues.some((q) => q.length)) {
    queues.sort((a, b) => (b[0]?.score ?? -1) - (a[0]?.score ?? -1));
    for (const q of queues) if (q.length && out.length < n) out.push(q.shift().id);
  }
  return out.slice(0, n);
}

export function findVariant(products, productId, variantId) {
  const p = products.find((x) => x.id === productId);
  if (!p) return null;
  const v = p.variants.find((x) => x.id === variantId) || (p.variants.length === 1 && !variantId ? p.variants[0] : null);
  return v ? { p, v } : null;
}

export const absUrl = (origin, path) => (/^https?:\/\//i.test(path || '') ? path : `${origin}${String(path || '').startsWith('/') ? '' : '/'}${path || ''}`);
