// CJ Dropshipping (gadgets, room decor, beauty tools, pets...). API v2 with an API key from your CJ account.
// Used by the trend scanner (search, product details, shipping quotes) and by fulfillment (create orders, tracking).
// Setup: SETUP.md, step 5. Free accounts get about 1,000 API calls a day; the scanner uses ~5 per keyword.
import { kvGet, kvSet } from './db.js';
import { parsePriceCents } from './pricing.js';

const API = 'https://developers.cjdropshipping.com/api2.0/v1';

export const cjReady = (env) => Boolean((env.CJ_API_KEY || '').trim());

const hashKey = (k) => {
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (Math.imul(31, h) + k.charCodeAt(i)) | 0;
  return String(h);
};

class CjError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function call(method, path, { token, query, body } = {}) {
  let url = API + path;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    if (qs) url += `?${qs}`;
  }
  const headers = { 'content-type': 'application/json' };
  if (token) headers['CJ-Access-Token'] = token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  const ok = res.ok && data.result !== false && (data.code === undefined || Number(data.code) === 200);
  if (!ok) {
    const code = data.code ?? res.status;
    const hint = res.status === 429 || Number(code) === 1600200 ? ' (CJ rate limit: try again later)' : '';
    throw new CjError(`CJ ${code}${hint}: ${data.message || res.statusText || 'request failed'}`.slice(0, 300), code);
  }
  return data.data;
}

/** Access token, cached in D1 (CJ tokens last about 15 days; asking for new ones too often gets rate limited). */
let tokenMemo = null;

export async function cjToken(env, { force = false } = {}) {
  const key = (env.CJ_API_KEY || '').trim();
  if (!key) throw new Error('CJ is not connected yet (add CJ_API_KEY in Cloudflare).');
  const now = Date.now();
  if (!force && tokenMemo?.db === env.DB && tokenMemo.keyHash === hashKey(key) && tokenMemo.exp > now + 3600000) return tokenMemo.accessToken;
  const cached = await kvGet(env, 'cj:token');
  if (!force && cached?.keyHash === hashKey(key) && cached.accessToken && cached.exp > now + 3600000) {
    tokenMemo = { db: env.DB, keyHash: cached.keyHash, accessToken: cached.accessToken, exp: cached.exp };
    return cached.accessToken;
  }
  let d = null;
  if (cached?.keyHash === hashKey(key) && cached.refreshToken && cached.refreshExp > now + 3600000) {
    d = await call('POST', '/authentication/refreshAccessToken', { body: { refreshToken: cached.refreshToken } }).catch(() => null);
  }
  if (!d) d = await call('POST', '/authentication/getAccessToken', { body: { apiKey: key } });
  if (!d?.accessToken) throw new Error('CJ did not return an access token. Check CJ_API_KEY.');
  const exp = Date.parse(d.accessTokenExpiryDate) || now + 14 * 86400000;
  const refreshExp = Date.parse(d.refreshTokenExpiryDate) || now + 150 * 86400000;
  await kvSet(env, 'cj:token', { keyHash: hashKey(key), accessToken: d.accessToken, exp, refreshToken: d.refreshToken || null, refreshExp });
  tokenMemo = { db: env.DB, keyHash: hashKey(key), accessToken: d.accessToken, exp };
  return d.accessToken;
}

async function cj(env, method, path, opts = {}) {
  const token = await cjToken(env);
  try {
    return await call(method, path, { ...opts, token });
  } catch (e) {
    if (/token/i.test(e.message) && /(invalid|expired)/i.test(e.message)) return call(method, path, { ...opts, token: await cjToken(env, { force: true }) });
    throw e;
  }
}

export function toArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      return toArray(JSON.parse(s));
    } catch {
      /* fall through */
    }
  }
  return s.split(/[,\s]+/).filter((x) => /^https?:\/\//i.test(x));
}

const https = (u) => String(u || '').replace(/^http:\/\//i, 'https://');

function normalizeItem(x) {
  return {
    pid: String(x.id || x.pid || ''),
    name: String(x.nameEn || x.productNameEn || x.productName || ''),
    image: https(x.bigImage || x.productImage || toArray(x.productImageSet)[0] || ''),
    cost: parsePriceCents(x.nowPrice || x.sellPrice || x.discountPrice),
    listed: Number(x.listedNum || x.listingCount || 0) || 0,
    category: String(x.threeCategoryName || x.categoryName || ''),
  };
}

/** Product search. Tries List V2 first, then the older list endpoint. */
export async function searchProducts(env, keyword, { countryCode, size = 20 } = {}) {
  let items = [];
  try {
    const d = await cj(env, 'GET', '/product/listV2', { query: { keyWord: keyword, page: 1, size, countryCode } });
    const content = Array.isArray(d?.content) ? d.content : [];
    items = content.flatMap((c) => (Array.isArray(c?.productList) ? c.productList : []));
    if (!items.length && Array.isArray(d?.list)) items = d.list;
  } catch (e) {
    if (Number(e.code) === 1600200) throw e; // rate limited: don't double the damage
    const d = await cj(env, 'GET', '/product/list', { query: { productNameEn: keyword, pageNum: 1, pageSize: size, countryCode } });
    items = Array.isArray(d?.list) ? d.list : [];
  }
  return items.map(normalizeItem).filter((x) => x.pid && x.name);
}

export async function productDetail(env, pid) {
  const d = await cj(env, 'GET', '/product/query', { query: { pid } });
  if (!d) throw new Error(`CJ product ${pid} not found`);
  const optionNames = String(d.productKeyEn || '').split('-').map((s) => s.trim()).filter(Boolean);
  return {
    pid: String(d.pid || pid),
    name: String(d.productNameEn || d.productName || ''),
    images: [...new Set([...toArray(d.productImageSet), ...toArray(d.productImage)].map(https))].slice(0, 8),
    description: String(d.description || d.remark || ''),
    optionNames,
    variants: (Array.isArray(d.variants) ? d.variants : [])
      .map((v) => ({
        vid: String(v.vid || ''),
        key: String(v.variantKey || v.variantNameEn || v.variantName || '').trim(),
        image: https(v.variantImage || ''),
        cost: parsePriceCents(v.variantSellPrice ?? v.variantPrice),
        sku: String(v.variantSku || ''),
      }))
      .filter((v) => v.vid && Number.isFinite(v.cost) && v.cost > 0),
  };
}

export function parseAging(s) {
  const nums = String(s || '').match(/\d+/g)?.map(Number) || [];
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)];
}

/** Cheapest decent shipping method to the US for one unit of a variant: { name, cost, days:[min,max] } or null. */
export async function shippingQuote(env, vid, from = 'CN') {
  const d = await cj(env, 'POST', '/logistic/freightCalculate', { body: { startCountryCode: from, endCountryCode: 'US', products: [{ quantity: 1, vid }] } });
  const opts = (Array.isArray(d) ? d : [])
    .map((o) => ({ name: String(o.logisticName || ''), cost: Math.round(Number(o.logisticPrice) * 100), days: parseAging(o.logisticAging) }))
    .filter((o) => o.name && Number.isFinite(o.cost) && o.cost >= 0 && o.days && o.days[1] <= 20);
  if (!opts.length) return null;
  opts.sort((a, b) => a.cost - b.cost);
  const cheapest = opts[0];
  // a faster method that costs at most $1.50 more is worth it
  const better = opts.filter((o) => o.cost <= cheapest.cost + 150).sort((a, b) => a.days[1] - b.days[1] || a.cost - b.cost)[0];
  return better || cheapest;
}

/**
 * Creates the CJ order(s) for these items: one per warehouse country. Never throws: each warehouse group gets its
 * own result ({id} on success, {error} on failure), and groups already created (in `existing`) are kept as they are,
 * so a retry only re-sends the part that failed.
 */
export async function createCjOrders(env, order, items, { payType = 3, existing = [] } = {}) {
  const s = order.shipping || {};
  const groups = new Map();
  for (const it of items) {
    const from = it.sup.from || 'CN';
    if (!groups.has(from)) groups.set(from, []);
    groups.get(from).push(it);
  }
  const results = [];
  for (const [from, group] of groups) {
    const orderNumber = groups.size > 1 ? `${order.id}-${from}` : order.id;
    const prev = existing.find((o) => o.number === orderNumber);
    if (prev?.id) {
      results.push(prev);
      continue;
    }
    const body = {
      orderNumber,
      shippingZip: s.zip,
      shippingCountryCode: s.country || 'US',
      shippingCountry: (s.country || 'US') === 'US' ? 'United States' : s.country,
      shippingProvince: s.state,
      shippingCity: s.city,
      shippingAddress: s.line1,
      shippingAddress2: s.line2 || '',
      shippingCustomerName: s.name || order.name,
      shippingPhone: (s.phone || order.phone || '').replace(/[^\d+]/g, '') || '0000000000',
      email: s.email || order.email || '',
      remark: '',
      logisticName: group[0].sup.logistic,
      fromCountryCode: from,
      payType,
      products: group.map((it) => ({ vid: it.sup.vid, quantity: it.qty })),
    };
    try {
      const d = await cj(env, 'POST', '/shopping/order/createOrderV2', { body });
      const id = String(d?.orderId || d?.id || '');
      results.push(id
        ? { id, number: orderNumber, from, status: d?.orderStatus || (payType === 2 ? 'PAID' : 'UNPAID'), needsPayment: payType !== 2 }
        : { id: '', number: orderNumber, from, status: 'FAILED', error: 'CJ accepted the request but returned no order id. Check the CJ dashboard.' });
    } catch (e) {
      const dup = /exist|duplicate|repeat/i.test(e.message) || Number(e.code) === 1603003;
      results.push({
        id: '',
        number: orderNumber,
        from,
        status: dup ? 'ALREADY_CREATED' : 'FAILED',
        error: dup ? `CJ already has order ${orderNumber} but didn't return its id. Find it in the CJ dashboard (My CJ > Orders).` : e.message,
      });
    }
  }
  return results;
}

export async function cjOrderStatus(env, cjOrderId) {
  const d = await cj(env, 'GET', '/shopping/order/getOrderDetail', { query: { orderId: cjOrderId } });
  const number = d?.trackNumber || d?.trackingNumber || '';
  return {
    status: String(d?.orderStatus || ''), // CREATED, IN_CART, UNPAID, UNSHIPPED, SHIPPED, DELIVERED, CANCELLED
    number,
    carrier: d?.logisticName || '',
    url: number ? `https://t.17track.net/en#nums=${encodeURIComponent(number)}` : '',
  };
}

export async function testCj(env) {
  await cjToken(env);
  const r = await searchProducts(env, 'phone holder', { size: 5 });
  return [`Connected. Test search found ${r.length} products.`];
}
