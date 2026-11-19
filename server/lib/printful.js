// Printful (print on demand) for the meme apparel. API v1 with a private token.
// Orders are sent "on the fly": the catalog variant (shirt model + color + size) plus a link to our print file,
// so nothing has to be set up in Printful first. Setup: SETUP.md, step 4.
import { kvGet, kvSet } from './db.js';
import { STYLES, absUrl } from './catalog.js';

const API = 'https://api.printful.com';

export const printfulReady = (env) => Boolean((env.PRINTFUL_API_KEY || '').trim());

export async function pf(env, method, path, body) {
  const token = (env.PRINTFUL_API_KEY || '').trim();
  if (!token) throw new Error('Printful is not connected yet (add PRINTFUL_API_KEY in Cloudflare).');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if ((env.PRINTFUL_STORE_ID || '').trim()) headers['X-PF-Store-Id'] = env.PRINTFUL_STORE_ID.trim();
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || (typeof data?.result === 'string' ? data.result : '') || res.statusText;
    const hint = res.status === 401 ? ' (the Printful token is wrong or expired)' : res.status === 403 ? ' (give the token the Orders and Catalog scopes)' : '';
    const err = new Error(`Printful ${res.status}${hint}: ${msg}`.slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return data.result;
}

/** { "Black|M": 4017, ... } for a style (tee/hoodie), looked up in Printful's catalog and cached for a week. */
const memo = new Map();

export async function variantMap(env, styleKey) {
  const style = STYLES[styleKey];
  if (!style) throw new Error(`Unknown apparel style "${styleKey}"`);
  const cacheKey = `printful:variants:${styleKey}`;
  const hit = memo.get(cacheKey);
  if (hit && hit.db === env.DB && Date.now() - hit.t < 10 * 60000) return hit.v;
  const cached = await kvGet(env, cacheKey);
  if (cached?.map && Date.now() - cached.at < 7 * 86400000) {
    memo.set(cacheKey, { db: env.DB, t: Date.now(), v: cached });
    return cached;
  }
  const want = style.printful;
  const override = Number(env[`PRINTFUL_${styleKey.toUpperCase()}_PRODUCT_ID`]);
  let productId = override || want.productId;
  let r = await pf(env, 'GET', `/products/${productId}`).catch(() => null);
  if (!override && !String(r?.product?.model || '').includes(want.model)) {
    const list = await pf(env, 'GET', '/products');
    const brand = want.brand.toLowerCase().split(/\s+/)[0];
    const hit = (list || []).find((p) => String(p.model || '').includes(want.model) && String(p.brand || '').toLowerCase().includes(brand) && !p.is_discontinued);
    if (!hit) throw new Error(`Printful's catalog has no ${want.brand} ${want.model}. Set PRINTFUL_${styleKey.toUpperCase()}_PRODUCT_ID.`);
    productId = hit.id;
    r = await pf(env, 'GET', `/products/${productId}`);
  }
  if (!r) throw new Error(`Printful product ${productId} not found`);
  const map = {};
  for (const v of r.variants || []) if (v.in_stock !== false) map[`${v.color}|${v.size}`] = v.id;
  const out = { productId, model: r.product?.model || want.model, at: Date.now(), map };
  await kvSet(env, cacheKey, out);
  memo.set(cacheKey, { db: env.DB, t: Date.now(), v: out });
  return out;
}

export function recipientFrom(order) {
  const s = order.shipping || {};
  return {
    name: s.name || order.name || 'Customer',
    address1: s.line1,
    address2: s.line2 || undefined,
    city: s.city,
    state_code: s.state || undefined,
    country_code: s.country || 'US',
    zip: s.zip,
    phone: s.phone || order.phone || undefined,
    email: s.email || order.email || undefined,
  };
}

/** Creates (or finds, if it was already sent) the Printful order and submits it for fulfillment. */
export async function createPrintfulOrder(env, order, items, origin, { confirm = true } = {}) {
  let existing = null;
  try {
    existing = await pf(env, 'GET', `/orders/@${encodeURIComponent(order.id)}`);
  } catch (e) {
    if (e.status && e.status !== 404) throw e;
  }
  let result = existing;
  if (!result) {
    const lines = [];
    for (const it of items) {
      const vm = await variantMap(env, it.sup.style);
      const variantId = vm.map[`${it.sup.color}|${it.sup.size}`];
      if (!variantId) throw new Error(`Printful has no ${it.sup.color} / ${it.sup.size} for the ${STYLES[it.sup.style].label} right now`);
      lines.push({
        variant_id: variantId,
        quantity: it.qty,
        name: it.title,
        retail_price: (it.price / 100).toFixed(2),
        files: [{ url: absUrl(origin, it.sup.file) }],
      });
    }
    result = await pf(env, 'POST', '/orders', {
      external_id: order.id,
      shipping: 'STANDARD',
      recipient: recipientFrom(order),
      items: lines,
      retail_costs: { currency: 'USD', subtotal: (order.subtotal / 100).toFixed(2), shipping: (order.shipping_fee / 100).toFixed(2), discount: ((order.discount || 0) / 100).toFixed(2) },
    });
  }
  if (confirm && result.status === 'draft') result = await pf(env, 'POST', `/orders/${result.id}/confirm`);
  return { id: result.id, status: result.status, costs: result.costs?.total || null, link: `https://www.printful.com/dashboard/default/orders` };
}

export async function printfulStatus(env, externalId) {
  const r = await pf(env, 'GET', `/orders/@${encodeURIComponent(externalId)}`);
  return {
    status: r.status, // draft, pending, failed, canceled, inprocess, onhold, partial, fulfilled
    shipments: (r.shipments || []).map((s) => ({ carrier: s.carrier, service: s.service, number: s.tracking_number, url: s.tracking_url, shipped: s.ship_date })),
  };
}

/** Admin "Test" button: is the token good, and can we see the tee + hoodie? */
export async function testPrintful(env) {
  const out = [];
  for (const k of Object.keys(STYLES)) {
    const vm = await variantMap(env, k);
    out.push(`${STYLES[k].label}: catalog product ${vm.productId} (${Object.keys(vm.map).length} colour/size options)`);
  }
  return out;
}
