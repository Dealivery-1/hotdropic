// Tests: node --test scripts/test.mjs   (npm test). No network: every outside API is mocked,
// and Node's built-in SQLite stands in for Cloudflare D1.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import worker from '../server/worker.js';
import { checkToken, login, makeToken } from '../server/lib/auth.js';
import { apparelProducts, invalidateCatalog, loadCatalog, publicProduct, trendingIds } from '../server/lib/catalog.js';
import { runCron } from '../server/lib/cron.js';
import { getOrder, insertOrder, kvGet, kvSet } from '../server/lib/db.js';
import { syncTracking, trackingList } from '../server/lib/fulfill.js';
import { parsePriceCents, retailCents } from '../server/lib/pricing.js';
import { buildPost, easternDate, runPromo } from '../server/lib/promo.js';
import { blockedReason, cleanDescription, cleanTitle } from '../server/lib/safety.js';
import { sanitizeSettings, saveSettings } from '../server/lib/settings.js';
import { fit, oauth1Header } from '../server/lib/social.js';
import { signStripePayload, verifyStripeSignature } from '../server/lib/stripe.js';
import { buildOptions, retire, runScan } from '../server/lib/trends.js';

const ORIGIN = 'https://hotdropic.wolfmaddox07.workers.dev';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  invalidateCatalog();
});

// ---------------------------------------------------------------- helpers
function makeD1() {
  const sqlite = new DatabaseSync(':memory:');
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({ success: true, meta: { changes: sqlite.prepare(sql).run(...params).changes } }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

const ASSETS = {
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    const file = path === '/' ? 'public/index.html' : path === '/404' ? 'public/404.html' : null;
    if (!file) return new Response('static', { status: 200 });
    return new Response(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { headers: { 'content-type': 'text/html' } });
  },
};

function makeEnv(extra = {}) {
  return { DB: makeD1(), ASSETS, SITE_URL: ORIGIN, ADMIN_PASSWORD: 'correct horse battery', ...extra };
}

/** fetch mock: [[matcher, handler]] where matcher is a RegExp tested against "METHOD url". */
function mockFetch(routes) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body;
    calls.push({ url, method, body, headers: init.headers || {} });
    for (const [re, handler] of routes) {
      if (re.test(`${method} ${url}`)) {
        const out = await handler({ url, method, body });
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out?.body ?? out), { status: out?.status || 200, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error(`Unmocked fetch: ${method} ${url}`);
  };
  fn.calls = calls;
  globalThis.fetch = fn;
  return fn;
}

function ctx() {
  const jobs = [];
  return { waitUntil: (p) => jobs.push(p), passThroughOnException() {}, done: () => Promise.all(jobs) };
}

const req = (path, init = {}) => new Request(`${ORIGIN}${path}`, init);
const postJson = (path, body, headers = {}) => req(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const stripeSession = (orderId, extra = {}) => ({
  id: 'cs_test_abcdefghijklmnop',
  object: 'checkout.session',
  payment_status: 'paid',
  currency: 'usd',
  amount_subtotal: 5398,
  amount_total: 5398,
  metadata: { order_id: orderId },
  client_reference_id: orderId,
  customer_details: { email: 'buyer@example.com', name: 'Sam Buyer', phone: '+1 (314) 555-0100' },
  shipping_details: { name: 'Sam Buyer', address: { line1: '1 Main St', line2: '', city: 'St. Louis', state: 'MO', postal_code: '63101', country: 'US' } },
  total_details: { amount_discount: 0, amount_tax: 0 },
  ...extra,
});

// ---------------------------------------------------------------- pricing + safety
test('retail prices: multiplier, $8 minimum margin, .99 endings, $9.99 floor', () => {
  assert.equal(retailCents(500, 400), 2099);
  assert.equal(retailCents(0, 0), 999);
  assert.equal(retailCents(4000, 600), 7899);
  assert.equal(retailCents(1500, 500, 1.1), 4299);
  for (const [c, s] of [[100, 200], [1234, 567], [9000, 1000]]) assert.equal(retailCents(c, s) % 100, 99);
  assert.equal(parsePriceCents('1.23 -- 4.56'), 123);
  assert.equal(parsePriceCents(2.5), 250);
  assert.ok(Number.isNaN(parsePriceCents('n/a')));
});

test('blocklist catches knockoffs and banned items but allows "for iPhone"', () => {
  assert.equal(blockedReason('Magnetic Phone Case for iPhone 16'), null);
  assert.equal(blockedReason('Dash Cam 4K'), null);
  assert.match(blockedReason('AirPods Pro 2 Replica'), /banned word|brand/);
  assert.match(blockedReason('Stanley Style Tumbler'), /stanley/);
  assert.match(blockedReason('Folding Knife Keychain'), /knife/);
  assert.match(blockedReason('Baby Teether Toy'), /baby/);
});

test('supplier titles and descriptions are cleaned to plain text', () => {
  assert.equal(cleanTitle('2025 Hot Sale TikTok Galaxy Star Projector LED Night Light Galaxy'), 'Galaxy Star Projector LED Night Light');
  const d = cleanDescription('<p>Color: Black &amp; White</p><script>alert(1)</script><p>Visit www.shop.com</p><img src=x onerror=alert(2)>');
  assert.equal(d, 'Color: Black & White');
  assert.ok(!/[<>]/.test(d));
});

test('settings are clamped and cleaned', () => {
  const s = sanitizeSettings({ autoTrend: 'true', freeShippingMin: -5, promoHour: 40, markup: 9, announcement: '<b>hi</b>', cjPayType: 7, bogus: 1 });
  assert.deepEqual(s, { autoTrend: true, freeShippingMin: 0, promoHour: 23, markup: 3, announcement: 'bhi/b', cjPayType: 3 });
});

// ---------------------------------------------------------------- catalog
test('apparel catalog: 11 designs x tee/hoodie, 12 variants each, files referenced', () => {
  const list = apparelProducts();
  assert.equal(list.length, 22);
  for (const p of list) {
    assert.equal(p.variants.length, 12);
    assert.equal(p.category, 'meme-tees');
    assert.ok(p.images[0].startsWith('/img/products/'));
    for (const v of p.variants) assert.match(v.sup.file, /^\/designs\/[a-z0-9-]+-(dark|light)\.png$/);
  }
  const tee = list.find((p) => p.id === 'fih-tee');
  assert.equal(tee.variants.find((v) => v.id === 'black-2xl').price, 2899);
});

test('public products never expose costs or supplier ids', () => {
  for (const p of apparelProducts()) {
    const s = JSON.stringify(publicProduct(p));
    assert.ok(!s.includes('"sup"') && !s.includes('"cost"') && !s.includes('designs/'), p.id);
  }
});

test('trending tab mixes categories instead of listing one tab', () => {
  const mk = (id, category, score) => ({ id, category, score, pinned: false });
  const ids = trendingIds([mk('a1', 'tech', 99), mk('a2', 'tech', 98), mk('b1', 'room', 80), mk('c1', 'meme-tees', 70), { ...mk('z', 'pets', 10), pinned: true }], 5);
  assert.deepEqual(ids, ['z', 'a1', 'b1', 'c1', 'a2']);
});

// ---------------------------------------------------------------- stripe
test('stripe webhook signatures: valid, wrong secret, stale, tampered', async () => {
  const body = '{"id":"evt_1"}';
  const header = await signStripePayload(body, 'whsec_test');
  assert.equal(await verifyStripeSignature(body, header, 'whsec_test'), true);
  assert.equal(await verifyStripeSignature(body, header, 'whsec_other'), false);
  assert.equal(await verifyStripeSignature(`${body} `, header, 'whsec_test'), false);
  const old = await signStripePayload(body, 'whsec_test', Math.floor(Date.now() / 1000) - 3600);
  assert.equal(await verifyStripeSignature(body, old, 'whsec_test'), false);
});

async function checkoutOrder(env, items = [{ productId: 'fih-tee', variantId: 'black-m', qty: 2, price: 1 }]) {
  let stripeBody = null;
  mockFetch([[/POST https:\/\/api\.stripe\.com\/v1\/checkout\/sessions$/, ({ body }) => {
    stripeBody = new URLSearchParams(body);
    return { id: 'cs_test_abcdefghijklmnop', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' };
  }]]);
  const res = await worker.fetch(postJson('/api/checkout', { items }), env, ctx());
  const json = await res.json();
  if (stripeBody) json.orderId = stripeBody.get('metadata[order_id]');
  return { res, json, stripeBody };
}

test('checkout uses server prices, free shipping over $35, saves a pending order', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_123' });
  const { res, json, stripeBody } = await checkoutOrder(env);
  assert.equal(res.status, 200);
  assert.equal(json.url, 'https://checkout.stripe.com/c/pay/cs_test_abc');
  assert.equal(stripeBody.get('line_items[0][price_data][unit_amount]'), '2699');
  assert.equal(stripeBody.get('line_items[0][quantity]'), '2');
  assert.equal(stripeBody.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '0');
  assert.equal(stripeBody.get('shipping_address_collection[allowed_countries][0]'), 'US');
  assert.equal(stripeBody.get('metadata[order_id]'), json.orderId);
  assert.equal(stripeBody.get('success_url'), `${ORIGIN}/order.html?session_id={CHECKOUT_SESSION_ID}`);
  const order = await getOrder(env, json.orderId);
  assert.equal(order.status, 'pending');
  assert.equal(order.session_id, 'cs_test_abcdefghijklmnop');
  assert.equal(order.subtotal, 5398);
  assert.equal(order.items[0].sup.color, 'Black');
});

test('checkout: small order pays shipping; bad items are rejected', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_123' });
  const small = await checkoutOrder(env, [{ productId: 'aura-tee', variantId: 'white-s', qty: 1 }]);
  assert.equal(small.stripeBody.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '499');
  assert.equal((await checkoutOrder(env, [{ productId: 'nope', variantId: 'x', qty: 1 }])).res.status, 409);
  assert.equal((await checkoutOrder(env, [{ productId: 'fih-tee', variantId: 'black-m', qty: 0 }])).res.status, 400);
  assert.equal((await checkoutOrder(env, [])).res.status, 400);
  const noKey = await worker.fetch(postJson('/api/checkout', { items: [{ productId: 'fih-tee', variantId: 'black-m', qty: 1 }] }), makeEnv(), ctx());
  assert.equal(noKey.status, 503);
});

function printfulRoutes(record) {
  return [
    [/GET https:\/\/api\.printful\.com\/orders\/@/, () => ({ status: 404, body: { error: { message: 'Not found' } } })],
    [/GET https:\/\/api\.printful\.com\/products\/71$/, () => ({ result: { product: { id: 71, model: '3001' }, variants: [{ id: 4017, color: 'Black', size: 'M', in_stock: true }, { id: 4012, color: 'White', size: 'M', in_stock: true }] } })],
    [/GET https:\/\/api\.printful\.com\/products\/146$/, () => ({ result: { product: { id: 146, model: '18500' }, variants: [{ id: 5531, color: 'Black', size: 'L', in_stock: true }] } })],
    [/POST https:\/\/api\.printful\.com\/orders$/, ({ body }) => {
      record.push(JSON.parse(body));
      return { result: { id: 98765, status: 'draft' } };
    }],
    [/POST https:\/\/api\.printful\.com\/orders\/98765\/confirm$/, () => ({ result: { id: 98765, status: 'pending' } })],
  ];
}

test('paid webhook -> order paid -> sent to Printful with the right shirt and print file (once)', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', PRINTFUL_API_KEY: 'pf_token' });
  const { json } = await checkoutOrder(env);
  const pfOrders = [];
  mockFetch([
    [/GET https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/cs_test/, () => stripeSession(json.orderId)],
    ...printfulRoutes(pfOrders),
  ]);
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: stripeSession(json.orderId) } });
  const send = async () => {
    const c = ctx();
    const res = await worker.fetch(req('/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': await signStripePayload(payload, 'whsec_test') }, body: payload }), env, c);
    await c.done();
    return res;
  };
  assert.equal((await send()).status, 200);
  const order = await getOrder(env, json.orderId);
  assert.equal(order.status, 'submitted');
  assert.equal(order.email, 'buyer@example.com');
  assert.equal(order.shipping.state, 'MO');
  assert.equal(order.supplier.printful.id, 98765);
  assert.equal(pfOrders.length, 1);
  assert.equal(pfOrders[0].external_id, json.orderId);
  assert.equal(pfOrders[0].items[0].variant_id, 4017);
  assert.equal(pfOrders[0].items[0].quantity, 2);
  assert.equal(pfOrders[0].items[0].files[0].url, `${ORIGIN}/designs/fih-dark.png`);
  assert.equal(pfOrders[0].recipient.state_code, 'MO');
  assert.equal((await send()).status, 200); // Stripe retry
  assert.equal(pfOrders.length, 1, 'no double order');
  const bad = await worker.fetch(req('/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: payload }), env, ctx());
  assert.equal(bad.status, 400);
});

test('customers can see their order by session link or order number + email', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  const { json } = await checkoutOrder(env);
  await saveSettings(env, { autoFulfill: false });
  mockFetch([[/checkout\/sessions\/cs_test/, () => stripeSession(json.orderId)]]);
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: stripeSession(json.orderId) } });
  const c = ctx();
  await worker.fetch(req('/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': await signStripePayload(payload, 'whsec_test') }, body: payload }), env, c);
  await c.done();
  const r1 = await worker.fetch(req('/api/order?session_id=cs_test_abcdefghijklmnop'), env, ctx());
  const o1 = (await r1.json()).order;
  assert.equal(o1.status, 'paid');
  assert.equal(o1.email, 'bu***@example.com');
  assert.ok(!JSON.stringify(o1).includes('Main St'));
  const ok = await worker.fetch(postJson('/api/order', { id: json.orderId, email: 'BUYER@example.com' }), env, ctx());
  assert.equal(ok.status, 200);
  const no = await worker.fetch(postJson('/api/order', { id: json.orderId, email: 'other@example.com' }), env, ctx());
  assert.equal(no.status, 404);
});

test('CJ items become a CJ order with the right variant, shipping method and warehouse', async () => {
  const env = makeEnv({ CJ_API_KEY: 'cj_key', PRINTFUL_API_KEY: 'pf' });
  const order = await insertOrder(env, {
    id: 'HDTEST0001', status: 'pending', subtotal: 2499, shipping_fee: 499, total: 2998,
    items: [{ productId: 'cj-x', variantId: 'black', title: 'Galaxy Projector', qty: 1, price: 2499, sup: { kind: 'cj', vid: 'VID-1', logistic: 'CJPacket Ordinary', from: 'CN' } }],
  });
  let body = null;
  mockFetch([
    [/authentication\/getAccessToken/, () => ({ code: 200, result: true, data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 86400000 * 10).toISOString() } })],
    [/createOrderV2/, ({ body: b }) => {
      body = JSON.parse(b);
      return { code: 200, result: true, data: { orderId: 'CJ123' } };
    }],
  ]);
  const { markPaid } = await import('../server/lib/fulfill.js');
  const paid = await markPaid(env, order, stripeSession('HDTEST0001'), { origin: ORIGIN, settings: { autoFulfill: true, cjPayType: 3 } });
  assert.equal(paid.status, 'paid');
  const saved = await getOrder(env, 'HDTEST0001');
  assert.equal(saved.status, 'submitted');
  assert.equal(saved.supplier.cj.orders[0].id, 'CJ123');
  assert.equal(saved.supplier.cj.orders[0].needsPayment, true);
  assert.deepEqual(body.products, [{ vid: 'VID-1', quantity: 1 }]);
  assert.equal(body.logisticName, 'CJPacket Ordinary');
  assert.equal(body.fromCountryCode, 'CN');
  assert.equal(body.shippingPhone, '+13145550100');
  assert.equal(body.shippingProvince, 'MO');
  assert.equal(body.payType, 3);
});

test('a supplier failure marks the order for attention and schedules a retry', async () => {
  const env = makeEnv({ PRINTFUL_API_KEY: 'pf' });
  const order = await insertOrder(env, { id: 'HDTEST0002', status: 'paid', subtotal: 2699, shipping_fee: 499, total: 3198, items: [{ productId: 'fih-tee', variantId: 'black-m', title: 'fih Tee', qty: 1, price: 2699, sup: { kind: 'printful', style: 'tee', color: 'Black', size: 'M', file: '/designs/fih-dark.png' } }] });
  mockFetch([[/printful/, () => ({ status: 401, body: { error: { message: 'Unauthorized' } } })]]);
  const { fulfillOrder } = await import('../server/lib/fulfill.js');
  const r = await fulfillOrder(env, { ...order, shipping: { name: 'A', line1: '1', city: 'X', state: 'MO', zip: '1', country: 'US' } }, { origin: ORIGIN, settings: { cjPayType: 3 } });
  assert.equal(r.status, 'needs_attention');
  assert.match(r.supplier.printful.error, /401/);
  assert.ok(r.next_check > Date.now() + 20 * 60000);
});

test('tracking sync marks shipped and lists tracking numbers', async () => {
  const env = makeEnv({ PRINTFUL_API_KEY: 'pf' });
  const order = await insertOrder(env, { id: 'HDTEST0003', status: 'submitted', subtotal: 2699, shipping_fee: 0, total: 2699, supplier: { printful: { id: 5, status: 'pending' } }, items: [{ productId: 'fih-tee', title: 'fih Tee', qty: 1, price: 2699, sup: { kind: 'printful' } }] });
  mockFetch([[/GET https:\/\/api\.printful\.com\/orders\/@HDTEST0003/, () => ({ result: { status: 'fulfilled', shipments: [{ carrier: 'USPS', tracking_number: '9400111', tracking_url: 'https://tools.usps.com/x' }] } })]]);
  const r = await syncTracking(env, order, { origin: ORIGIN });
  assert.equal(r.status, 'shipped');
  assert.deepEqual(trackingList(r), [{ carrier: 'USPS', number: '9400111', url: 'https://tools.usps.com/x' }]);
});

// ---------------------------------------------------------------- trend scanner
function cjScanRoutes({ listCalls }) {
  const product = (pid, name, listed, price = '3.20') => ({ id: pid, nameEn: name, bigImage: `https://cf.cjdropshipping.com/${pid}.jpg`, sellPrice: price, listedNum: listed });
  return [
    [/authentication\/getAccessToken/, () => ({ code: 200, result: true, data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 86400000 * 10).toISOString() } })],
    [/product\/listV2/, ({ url }) => {
      const u = new URL(url);
      listCalls.push(`${u.searchParams.get('keyWord')}|${u.searchParams.get('countryCode') || ''}`);
      if (u.searchParams.get('countryCode') === 'US') return { code: 200, result: true, data: { content: [{ productList: [] }] } };
      const kw = u.searchParams.get('keyWord');
      return { code: 200, result: true, data: { content: [{ productList: [product(`P-${kw}-1`, 'Folding Knife Light', 99999), product(`P-${kw}-2`, `2025 Hot Sale ${kw} Deluxe`, 12000), product(`P-${kw}-3`, `${kw} Basic`, 50)] }] } };
    }],
    [/product\/query/, ({ url }) => {
      const pid = new URL(url).searchParams.get('pid');
      return { code: 200, result: true, data: { pid, productNameEn: `${pid} Deluxe Edition`, productKeyEn: 'Color-Size', productImageSet: [`https://cf.cjdropshipping.com/${pid}-a.jpg`], description: '<p>Soft &amp; squishy.</p>', variants: [{ vid: `${pid}-v1`, variantKey: 'Pink-S', variantSellPrice: 3.2 }, { vid: `${pid}-v2`, variantKey: 'Blue-S', variantSellPrice: 3.4 }, { vid: `${pid}-v3`, variantKey: 'Blue-L', variantSellPrice: 99 }] } };
    }],
    [/logistic\/freightCalculate/, () => ({ code: 200, result: true, data: [{ logisticName: 'CJPacket Ordinary', logisticPrice: 3.5, logisticAging: '7-12' }, { logisticName: 'Slow Boat', logisticPrice: 1, logisticAging: '25-40' }] })],
    [/trends\.google\.com/, () => new Response('<rss><channel><item><title>squishy toy</title><ht:approx_traffic>50K+</ht:approx_traffic></item></channel></rss>', { status: 200 })],
  ];
}

test('scanner imports the most-listed safe product per keyword, priced and with options', async () => {
  const env = makeEnv({ CJ_API_KEY: 'cj_key' });
  const listCalls = [];
  mockFetch(cjScanRoutes({ listCalls }));
  const settings = { ...(await (await import('../server/lib/settings.js')).getSettings(env)) };
  const r = await runScan(env, { settings, maxKeywords: 2, now: Date.now() });
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 2);
  const list = await kvGet(env, 'catalog:trending');
  assert.equal(list.length, 2);
  const p = list[0];
  assert.equal(p.source.listed, 12000, 'skipped the knife, took the most-listed safe one');
  assert.equal(p.supplier, 'cj');
  assert.deepEqual(p.options.map((o) => o.name), ['Color', 'Size']);
  assert.equal(p.variants.length, 2, 'the $99 variant was over the max price');
  assert.equal(p.variants[0].price, retailCents(320, 350));
  assert.equal(p.variants[0].sup.logistic, 'CJPacket Ordinary');
  assert.ok(!/2025|Hot Sale/.test(p.title));
  assert.ok(p.why.includes('12K'));
  assert.ok(listCalls.some((c) => c.endsWith('|US')), 'tried US warehouses first');
  const { products } = await loadCatalog(env, { fresh: true });
  assert.ok(products.some((x) => x.id === p.id));
  const again = await runScan(env, { settings, maxKeywords: 2, force: true, now: Date.now() + 1000 });
  assert.ok(again.ok);
  assert.ok((await kvGet(env, 'catalog:trending')).length <= 4, 'no duplicates on re-scan');
});

test('retire drops stale products and caps each tab, keeping pinned ones', () => {
  const now = Date.now();
  const mk = (id, score, days, category = 'tech') => ({ id, title: id, score, category, refreshedAt: now - days * 86400000 });
  const lines = [];
  const out = retire([mk('old', 99, 30), mk('a', 90, 1), mk('b', 80, 1), mk('c', 70, 1), mk('pin', 10, 40)], { staleDays: 10, perCategory: 2 }, new Set(['pin']), now, lines);
  assert.deepEqual(out.map((p) => p.id).sort(), ['a', 'b', 'pin']);
  assert.equal(lines.length, 2);
});

test('variant options: Color/Size when keys line up, single Style list otherwise', () => {
  const a = buildOptions([{ key: 'Red-S' }, { key: 'Red-L' }, { key: 'Blue-S' }], ['Color', 'Size']);
  assert.deepEqual(a.options, [{ name: 'Color', values: ['Red', 'Blue'] }, { name: 'Size', values: ['S', 'L'] }]);
  const b = buildOptions([{ key: 'A' }, { key: 'B-C' }], ['Color']);
  assert.deepEqual(b.options, [{ name: 'Style', values: ['A', 'B / C'] }]);
  assert.deepEqual(buildOptions([{ key: 'Only' }], []).options, []);
});

test('scanner without a CJ key explains what to do', async () => {
  const r = await runScan(makeEnv(), { settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /CJ_API_KEY/);
});

// ---------------------------------------------------------------- promotion
test('promo uses the queued post for today, otherwise writes one, and never repeats', async () => {
  const products = apparelProducts().map((p) => ({ ...p, pinned: false }));
  const settings = { freeShippingMin: 3500 };
  const queued = buildPost({ products, entry: { text: 'hello https://x.com fih', product: 'fih-tee' }, history: [], origin: ORIGIN, date: '2026-11-19', settings });
  assert.equal(queued.kind, 'queued');
  assert.equal(queued.text, 'hello fih');
  assert.equal(queued.link, `${ORIGIN}/p/fih-tee`);
  const gen = buildPost({ products, entry: null, history: [], origin: ORIGIN, date: '2026-12-02', settings });
  assert.ok(gen.text.length > 20 && gen.link.startsWith(`${ORIGIN}/p/`));
  assert.ok(gen.text.includes('$'));
  const next = buildPost({ products, entry: null, history: [{ date: '2026-12-02', productId: gen.productId }], origin: ORIGIN, date: '2026-12-02', settings });
  assert.notEqual(next.productId, gen.productId);
});

test('promo run posts to connected channels once a day', async () => {
  const env = makeEnv({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '@hd' });
  const f = mockFetch([[/discord\.com/, () => new Response(null, { status: 204 })], [/api\.telegram\.org/, () => ({ ok: true })]]);
  const settings = { freeShippingMin: 3500 };
  const now = new Date();
  const preview = await runPromo(env, { origin: ORIGIN, settings, dryRun: true, now });
  assert.deepEqual(preview.channels, ['Telegram channel', 'Discord']);
  assert.equal(f.calls.length, 0);
  const r = await runPromo(env, { origin: ORIGIN, settings, now });
  assert.deepEqual(r.results.map((x) => x.ok), [true, true]);
  const discord = JSON.parse(f.calls.find((c) => c.url.includes('discord')).body);
  assert.ok(discord.embeds[0].url.includes('utm_source=discord'));
  const again = await runPromo(env, { origin: ORIGIN, settings, now });
  assert.equal(again.skipped, true);
  assert.equal((await kvGet(env, 'promo:state')).lastDate, easternDate(now));
});

test('social helpers: fit() keeps links whole; X OAuth signature matches Node crypto', async () => {
  const t = fit('a'.repeat(400), 'https://x.co/p', 100);
  assert.ok([...t].length <= 100 && t.endsWith('\n\nhttps://x.co/p'));
  const args = { method: 'POST', url: 'https://api.x.com/2/tweets', consumerKey: 'ck', consumerSecret: 'cs', token: 'tk', tokenSecret: 'ts', nonce: 'abc', timestamp: 1700000000 };
  const header = await oauth1Header(args);
  const base = 'POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&oauth_consumer_key%3Dck%26oauth_nonce%3Dabc%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1700000000%26oauth_token%3Dtk%26oauth_version%3D1.0';
  const expected = encodeURIComponent(createHmac('sha1', 'cs&ts').update(base).digest('base64'));
  assert.ok(header.includes(`oauth_signature="${expected}"`));
});

// ---------------------------------------------------------------- admin
test('admin: login, token, lockout, overview and actions', async () => {
  const env = makeEnv();
  await assert.rejects(login(env, 'nope', '1.1.1.1'), /Wrong password/);
  const token = await login(env, 'correct horse battery', '1.1.1.1');
  assert.equal(await checkToken(env, token), true);
  assert.equal(await checkToken({ ...env, ADMIN_PASSWORD: 'a different password' }, token), false);
  assert.equal(await checkToken(env, await makeToken(env, -1)), false);
  for (let i = 0; i < 8; i++) await login(env, 'bad', '2.2.2.2').catch(() => {});
  await assert.rejects(login(env, 'correct horse battery', '2.2.2.2'), /Too many/);

  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await worker.fetch(req('/api/admin'), env, ctx())).status, 401);
  const ov = await (await worker.fetch(req('/api/admin', { headers: auth }), env, ctx())).json();
  assert.ok(ov.setup.find((s) => s.key === 'stripe' && s.ok === false));
  assert.equal(ov.products.length, 22);
  assert.ok(ov.scan.keywords.length >= 20);
  assert.ok(ov.promo.kit.length > 0);

  const save = await worker.fetch(postJson('/api/admin', { action: 'settings', patch: { autoTrend: true, freeShippingMin: 5000 } }, auth), env, ctx());
  assert.equal((await save.json()).settings.autoTrend, true);
  await worker.fetch(postJson('/api/admin', { action: 'product', id: 'aura-hoodie', op: 'hide' }, auth), env, ctx());
  const cat = await (await worker.fetch(req('/api/catalog'), env, ctx())).json();
  assert.ok(!cat.products.some((p) => p.id === 'aura-hoodie'));
  assert.equal(cat.config.freeShippingMin, 5000);
  const add = await worker.fetch(postJson('/api/admin', { action: 'keyword', op: 'add', q: 'Heated Lunch Box', cat: 'home' }, auth), env, ctx());
  assert.equal(add.status, 200);
  const ov2 = await (await worker.fetch(req('/api/admin', { headers: auth }), env, ctx())).json();
  assert.ok(ov2.scan.keywords.some((k) => k.q === 'heated lunch box' && k.cat === 'home'));
  const badKw = await worker.fetch(postJson('/api/admin', { action: 'keyword', op: 'add', q: 'x', cat: 'meme-tees' }, auth), env, ctx());
  assert.equal(badKw.status, 400);
});

// ---------------------------------------------------------------- pages
test('product pages: social tags, embedded data, escaping, 404', async () => {
  const env = makeEnv();
  await kvSet(env, 'catalog:trending', [{ id: 'cj-evil-123456', title: '</script><script>alert(1)</script>"', category: 'tech', supplier: 'cj', images: ['https://cf.cjdropshipping.com/a.jpg'], options: [], price: 1999, description: '<img src=x onerror=alert(1)>', variants: [{ id: 'standard', label: 'Standard', options: {}, price: 1999, cost: 500, sup: { kind: 'cj', vid: 'SECRET-VID' } }], score: 50 }]);
  const res = await worker.fetch(req('/p/fih-tee'), env, ctx());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<meta property="og:title" content="fih Tee - $26.99">'));
  assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/p/fih-tee">`));
  assert.ok(html.includes('id="ssr-product"'));
  assert.ok(html.includes('"@type":"Product"'));
  const evil = await (await worker.fetch(req('/p/cj-evil-123456'), env, ctx())).text();
  assert.ok(!evil.includes('<script>alert(1)</script>'));
  assert.ok(!evil.includes('<img src=x onerror'));
  assert.ok(!evil.includes('SECRET-VID'));
  assert.equal((await worker.fetch(req('/p/does-not-exist'), env, ctx())).status, 404);
});

test('sitemap and Google product feed list the products', async () => {
  const env = makeEnv();
  const sm = await (await worker.fetch(req('/sitemap.xml'), env, ctx())).text();
  assert.ok(sm.includes(`<loc>${ORIGIN}/p/fih-tee</loc>`));
  const feed = await (await worker.fetch(req('/feed.xml'), env, ctx())).text();
  assert.ok(feed.includes('<g:price>26.99 USD</g:price>'));
  assert.ok(feed.includes('<g:item_group_id>fih-tee</g:item_group_id>'));
  assert.equal((feed.match(/<item>/g) || []).length, 22 * 12);
});

test('catalog API works even before the database exists (preview mode)', async () => {
  const res = await worker.fetch(req('/api/catalog'), { ASSETS, SITE_URL: ORIGIN }, ctx());
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.products.length, 22);
  assert.equal(j.config.payments, false);
  assert.ok(j.trending.length > 0);
});

// ---------------------------------------------------------------- cron
test('cron: fulfills paid orders, runs the scanner when on, records what it did', async () => {
  const env = makeEnv({ PRINTFUL_API_KEY: 'pf' });
  await saveSettings(env, { autoTrend: true, autoFulfill: true, autoPromo: false });
  await insertOrder(env, { id: 'HDTEST0009', status: 'paid', subtotal: 2699, shipping_fee: 499, total: 3198, shipping: { name: 'A', line1: '1 St', city: 'X', state: 'MO', zip: '63101', country: 'US' }, items: [{ productId: 'fih-tee', variantId: 'black-m', title: 'fih Tee', qty: 1, price: 2699, sup: { kind: 'printful', style: 'tee', color: 'Black', size: 'M', file: '/designs/fih-dark.png' } }] });
  const pfOrders = [];
  mockFetch(printfulRoutes(pfOrders));
  const lines = await runCron(env, new Date());
  assert.ok(lines.some((l) => l.startsWith('order HDTEST0009: submitted')));
  assert.ok(lines.some((l) => /scan: .*CJ_API_KEY/.test(l)));
  assert.equal(pfOrders.length, 1);
  assert.ok((await kvGet(env, 'cron:last')).t > 0);
});

// ---------------------------------------------------------------- hardening (from the pre-launch review)
async function paidWebhook(env, session, event = {}) {
  const payload = JSON.stringify({ type: 'checkout.session.completed', livemode: false, ...event, data: { object: session } });
  const c = ctx();
  const res = await worker.fetch(req('/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': await signStripePayload(payload, 'whsec_test') }, body: payload }), env, c);
  await c.done();
  return res;
}

test('webhook ignores sessions that are not the checkout we created, or that do not match the order', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', PRINTFUL_API_KEY: 'pf' });
  const { json } = await checkoutOrder(env);
  const pfOrders = [];
  let served = null;
  mockFetch([[/GET https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\//, () => served], [/notify|discord|telegram/, () => ({})], ...printfulRoutes(pfOrders)]);
  // 1. a different (cheap) session that just names our order id
  served = stripeSession(json.orderId, { id: 'cs_test_attackerattacker1', amount_subtotal: 100, amount_total: 100 });
  await paidWebhook(env, served);
  assert.equal((await getOrder(env, json.orderId)).status, 'pending');
  // 2. our session, but Stripe says the subtotal was different
  served = stripeSession(json.orderId, { amount_subtotal: 100, amount_total: 100 });
  await paidWebhook(env, served);
  assert.equal((await getOrder(env, json.orderId)).status, 'pending');
  // 3. a live-mode event while the store uses a test key
  served = stripeSession(json.orderId);
  await paidWebhook(env, served, { livemode: true });
  assert.equal((await getOrder(env, json.orderId)).status, 'pending');
  assert.equal(pfOrders.length, 0);
  // 4. the real thing
  await paidWebhook(env, served);
  assert.equal((await getOrder(env, json.orderId)).status, 'submitted');
  assert.equal(pfOrders.length, 1);
});

test('a big discount (paid less than cost) is held for review instead of shipped', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', PRINTFUL_API_KEY: 'pf' });
  const { json } = await checkoutOrder(env);
  const pfOrders = [];
  const free = stripeSession(json.orderId, { payment_status: 'no_payment_required', amount_total: 0, total_details: { amount_discount: 5398, amount_tax: 0 } });
  mockFetch([[/checkout\/sessions\//, () => free], ...printfulRoutes(pfOrders)]);
  await paidWebhook(env, free);
  const o = await getOrder(env, json.orderId);
  assert.equal(o.status, 'needs_attention');
  assert.equal(pfOrders.length, 0);
  assert.ok(o.log.some((l) => /less than the estimated supplier cost/.test(l.msg)));
});

test('two workers fulfilling at once only order from the supplier once', async () => {
  const env = makeEnv({ PRINTFUL_API_KEY: 'pf' });
  const order = await insertOrder(env, { id: 'HDTEST0010', status: 'paid', subtotal: 2699, shipping_fee: 499, total: 3198, shipping: { name: 'A', line1: '1 St', city: 'X', state: 'MO', zip: '63101', country: 'US' }, items: [{ productId: 'fih-tee', variantId: 'black-m', title: 'fih Tee', qty: 1, price: 2699, sup: { kind: 'printful', style: 'tee', color: 'Black', size: 'M', file: '/designs/fih-dark.png' } }] });
  const pfOrders = [];
  const routes = printfulRoutes(pfOrders).map(([re, fn]) => [re, async (a) => { await new Promise((r) => setTimeout(r, 30)); return fn(a); }]);
  mockFetch(routes);
  const { fulfillOrder } = await import('../server/lib/fulfill.js');
  const settings = { cjPayType: 3 };
  const [a, b] = await Promise.all([fulfillOrder(env, order, { origin: ORIGIN, settings }), fulfillOrder(env, order, { origin: ORIGIN, settings, manual: true })]);
  assert.equal(pfOrders.length, 1);
  assert.equal([a, b].filter((x) => x.skipped).length, 1);
  assert.equal((await getOrder(env, 'HDTEST0010')).status, 'submitted');
});

test('CJ: a failed warehouse part is retried alone; the part already created is kept', async () => {
  const env = makeEnv({ CJ_API_KEY: 'cj' });
  const item = (vid, from) => ({ productId: `cj-${vid}`, variantId: 'v', title: vid, qty: 1, price: 1999, sup: { kind: 'cj', vid, logistic: 'CJPacket', from } });
  const order = await insertOrder(env, { id: 'HDTEST0011', status: 'paid', subtotal: 3998, shipping_fee: 0, total: 3998, shipping: { name: 'A', line1: '1 St', city: 'X', state: 'MO', zip: '63101', country: 'US', phone: '3145550100' }, items: [item('US-1', 'US'), item('CN-1', 'CN')] });
  const created = [];
  let cnFails = true;
  mockFetch([
    [/getAccessToken/, () => ({ code: 200, result: true, data: { accessToken: 't', accessTokenExpiryDate: new Date(Date.now() + 864e6).toISOString() } })],
    [/createOrderV2/, ({ body }) => {
      const b = JSON.parse(body);
      if (b.fromCountryCode === 'CN' && cnFails) return { code: 1600001, result: false, message: 'Address check failed' };
      created.push(b.orderNumber);
      return { code: 200, result: true, data: { orderId: `CJ-${b.fromCountryCode}` } };
    }],
  ]);
  const { fulfillOrder } = await import('../server/lib/fulfill.js');
  const r1 = await fulfillOrder(env, order, { origin: ORIGIN, settings: { cjPayType: 3 } });
  assert.equal(r1.status, 'needs_attention');
  assert.deepEqual(r1.supplier.cj.orders.map((o) => o.id), ['CJ-US', '']);
  cnFails = false;
  const r2 = await fulfillOrder(env, await getOrder(env, 'HDTEST0011'), { origin: ORIGIN, settings: { cjPayType: 3 }, manual: true });
  assert.equal(r2.status, 'submitted');
  assert.deepEqual(created, ['HDTEST0011-US', 'HDTEST0011-CN']);
});

test('supplier cancellations are parked for the owner, not retried in a loop', async () => {
  const env = makeEnv({ PRINTFUL_API_KEY: 'pf' });
  const order = await insertOrder(env, { id: 'HDTEST0012', status: 'submitted', subtotal: 2699, shipping_fee: 0, total: 2699, supplier: { printful: { id: 7, status: 'pending' } }, items: [{ productId: 'fih-tee', title: 'fih Tee', qty: 1, price: 2699, sup: { kind: 'printful' } }] });
  mockFetch([[/printful\.com\/orders\/@HDTEST0012/, () => ({ result: { status: 'canceled', shipments: [] } })]]);
  const r = await syncTracking(env, order, { origin: ORIGIN });
  assert.equal(r.status, 'needs_attention');
  assert.ok(r.next_check > Date.now() + 365 * 86400000);
  const { dueOrders } = await import('../server/lib/db.js');
  assert.equal((await dueOrders(env, ['paid', 'needs_attention', 'fulfilling'], 5)).length, 0);
});

test('login lockout holds under many parallel guesses', async () => {
  const env = makeEnv();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => login(env, 'wrong', '9.9.9.9')));
  const locked = results.filter((r) => r.status === 'rejected' && /Too many/.test(r.reason.message)).length;
  assert.ok(locked >= 12, `locked ${locked}`);
  await assert.rejects(login(env, 'correct horse battery', '9.9.9.9'), /Too many/);
  // IPv6 neighbours share a lockout
  for (let i = 0; i < 9; i++) await login(env, 'x', `2001:db8:1:2::${i + 1}`).catch(() => {});
  await assert.rejects(login(env, 'correct horse battery', '2001:db8:1:2::99'), /Too many/);
  assert.ok(await login(env, 'correct horse battery', '8.8.8.8'));
  await assert.rejects(login({ ...env, ADMIN_PASSWORD: 'short' }, 'short', '7.7.7.7'), /12\+ characters/);
});

test('product text with $ patterns cannot break the page template', async () => {
  const env = makeEnv();
  await kvSet(env, 'catalog:trending', [{ id: 'cj-dollar-1', title: "Mug $' $& $` 50% off", category: 'home', supplier: 'cj', images: ['https://cf.cjdropshipping.com/a.jpg'], options: [], price: 1999, description: "$' and $&", variants: [{ id: 'standard', label: 'Standard', options: {}, price: 1999, sup: { kind: 'cj', vid: 'v' } }], score: 50 }]);
  const html = await (await worker.fetch(req('/p/cj-dollar-1'), env, ctx())).text();
  assert.equal((html.match(/<!doctype html>/gi) || []).length, 1);
  assert.ok(html.includes('Mug $&#39; $&amp;'));
});

test('scanner keeps products during a CJ outage and re-prices when CJ changes price', async () => {
  const env = makeEnv({ CJ_API_KEY: 'cj_key' });
  const { getSettings } = await import('../server/lib/settings.js');
  const settings = await getSettings(env);
  const old = Date.now() - 20 * 86400000;
  await kvSet(env, 'catalog:trending', [{ id: 'cj-old-1', title: 'Old Thing', category: 'tech', supplier: 'cj', images: ['https://x/a.jpg'], options: [], price: 1999, variants: [{ id: 's', label: 'Standard', options: {}, price: 1999, sup: { kind: 'cj', vid: 'v' } }], score: 50, refreshedAt: old, source: { pid: 'P-OLD', keyword: 'nope', cost: 300 } }]);
  mockFetch([[/getAccessToken/, () => ({ status: 500, body: { code: 500, result: false, message: 'CJ is down' } })], [/trends\.google/, () => new Response('<rss></rss>')]]);
  const r = await runScan(env, { settings, maxKeywords: 1, force: true });
  assert.ok(r.lines.some((l) => /CJ is down/.test(l)));
  assert.equal((await kvGet(env, 'catalog:trending')).length, 1, 'nothing retired on a failed run');
  // re-price: same pid shows up at a new price
  const listCalls = [];
  const routes = cjScanRoutes({ listCalls });
  await kvSet(env, 'catalog:trending', []);
  invalidateCatalog();
  mockFetch(routes);
  await runScan(env, { settings, maxKeywords: 1, force: true });
  const first = (await kvGet(env, 'catalog:trending'))[0];
  const bumped = routes.map(([re, fn]) => [re, /listV2/.test(re.source) ? async (a) => {
    const out = await fn(a);
    for (const c of out.data?.content || []) for (const p of c.productList) p.sellPrice = '9.90';
    return out;
  } : fn]);
  mockFetch(bumped);
  const st = await kvGet(env, 'scan:state');
  st.done[first.source.keyword] = 0; // make that keyword next in line
  await kvSet(env, 'scan:state', st);
  const r2 = await runScan(env, { settings, maxKeywords: 1, force: true });
  assert.ok(r2.lines.some((l) => /re-priced/.test(l)), r2.lines.join('\n'));
  const after = (await kvGet(env, 'catalog:trending')).find((p) => p.id === first.id);
  assert.ok(after, 'same product id kept');
  assert.equal(after.source.cost, 990);
});

test('checkout rate limit per visitor', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_123' });
  mockFetch([[/checkout\/sessions$/, () => ({ id: 'cs_test_ratelimitratelimit', url: 'https://checkout.stripe.com/x' })]]);
  const body = { items: [{ productId: 'fih-tee', variantId: 'black-m', qty: 1 }] };
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await worker.fetch(postJson('/api/checkout', body, { 'cf-connecting-ip': '5.5.5.5' }), env, ctx())).status);
  assert.deepEqual(codes.slice(0, 12), Array(12).fill(200));
  assert.equal(codes[13], 429);
});
