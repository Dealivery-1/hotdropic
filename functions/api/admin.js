// /api/admin: everything behind the /admin page. GET = dashboard data. POST {action, ...} = do something.
// All of it needs the admin token from {action:"login"} except login itself.
import SITE from '../../site.config.json' with { type: 'json' };
import { login, requireAdmin } from '../../server/lib/auth.js';
import { invalidateCatalog, loadCatalog } from '../../server/lib/catalog.js';
import { cjReady, testCj } from '../../server/lib/cj.js';
import { getOrder, kvGet, kvGetMany, kvSet, listOrders, salesStats, updateOrder, withLog } from '../../server/lib/db.js';
import { fulfillOrder, syncTracking } from '../../server/lib/fulfill.js';
import { handle, HttpError, json, readJson, siteOrigin } from '../../server/lib/http.js';
import { notifyOwner, ownerChannels } from '../../server/lib/notify.js';
import { printfulReady, testPrintful } from '../../server/lib/printful.js';
import { promoKit, runPromo } from '../../server/lib/promo.js';
import { getSettings, saveSettings } from '../../server/lib/settings.js';
import { channelReady, CHANNELS } from '../../server/lib/social.js';
import { STRIPE_VERSION, stripe } from '../../server/lib/stripe.js';
import { runScan, SCAN_CATEGORIES, seedList } from '../../server/lib/trends.js';

const compactOrder = (o) => ({
  id: o.id,
  created: o.created_at,
  status: o.status,
  total: o.total,
  profit: o.total - o.est_cost - (o.tax || 0),
  email: o.email,
  name: o.name,
  place: [o.shipping?.city, o.shipping?.state].filter(Boolean).join(', '),
  items: (o.items || []).map((i) => `${i.qty} x ${i.title}${i.variantLabel ? ` (${i.variantLabel})` : ''}`),
  suppliers: [
    o.supplier?.printful ? `Printful ${o.supplier.printful.id || ''} ${o.supplier.printful.status || ''}${o.supplier.printful.error ? `: ${o.supplier.printful.error}` : ''}`.trim() : null,
    ...(o.supplier?.cj?.orders || []).map((c) => `CJ ${c.id || c.number} ${c.status}${c.needsPayment ? ' (pay it in CJ)' : ''}${c.tracking?.number ? ` - ${c.tracking.number}` : ''}`),
    o.supplier?.cj?.error ? `CJ: ${o.supplier.cj.error}` : null,
  ].filter(Boolean),
  log: (o.log || []).slice(-6),
});

async function overview(request, env) {
  const origin = siteOrigin(request, env, SITE);
  const settings = await getSettings(env);
  const [kv, stats, orders, catalog] = await Promise.all([
    kvGetMany(env, ['scan:state', 'promo:state', 'cron:last', 'seeds:custom', 'seeds:removed', 'stripe:webhook']),
    salesStats(env),
    listOrders(env, { limit: 60 }),
    loadCatalog(env, { includeHidden: true, fresh: true }),
  ]);
  const scan = kv['scan:state'] || { done: {}, runs: [] };
  const promo = kv['promo:state'] || { history: [] };
  const seeds = seedList(kv['seeds:custom'] || [], kv['seeds:removed'] || []);
  const counts = {};
  for (const p of catalog.products) if (p.source?.keyword) counts[p.source.keyword] = (counts[p.source.keyword] || 0) + 1;
  const stripeKey = String(env.STRIPE_SECRET_KEY || '').trim();
  const hook = kv['stripe:webhook'];
  const setup = [
    { key: 'db', label: 'Database (Cloudflare D1)', ok: true, note: 'Connected.' },
    { key: 'stripe', label: 'Payments (Stripe)', ok: Boolean(stripeKey), note: stripeKey ? (stripeKey.includes('_test_') ? 'Test mode: use card 4242 4242 4242 4242. Switch to your live key to take real money.' : 'Live mode: taking real payments.') : 'Add STRIPE_SECRET_KEY (SETUP.md step 3).' },
    { key: 'webhook', label: 'Stripe webhook (marks orders paid)', ok: Boolean(String(env.STRIPE_WEBHOOK_SECRET || '').trim() || hook?.secret), note: hook?.secret ? `Connected to ${hook.url} (${hook.mode}).` : 'Click "Connect Stripe webhook" once your Stripe key is in.', action: stripeKey ? 'stripe-webhook' : null },
    { key: 'printful', label: 'Meme apparel maker (Printful)', ok: printfulReady(env), note: printfulReady(env) ? 'Token added. Use Test to check it.' : 'Add PRINTFUL_API_KEY (SETUP.md step 4). Until then, apparel orders wait for you.', action: printfulReady(env) ? 'test-printful' : null },
    { key: 'cj', label: 'Gadget supplier + trend scanner (CJ Dropshipping)', ok: cjReady(env), note: cjReady(env) ? 'API key added. Use Test to check it.' : 'Add CJ_API_KEY (SETUP.md step 5). The gadget tabs fill up after that.', action: cjReady(env) ? 'test-cj' : null },
    { key: 'alerts', label: 'New-order alerts to you', ok: ownerChannels(env).length > 0, note: ownerChannels(env).length ? `Sending to ${ownerChannels(env).join(', ')}.` : 'Optional: DISCORD_ORDERS_WEBHOOK_URL or Telegram (SETUP.md step 7). The Stripe app also pings you.', action: ownerChannels(env).length ? 'test-alerts' : null },
    { key: 'social', label: 'Social accounts for auto-promotion', ok: CHANNELS.some((c) => channelReady(env, c)), note: CHANNELS.map((c) => `${channelReady(env, c) ? '✔' : '✖'} ${c.name}`).join('  ') },
    { key: 'emails', label: 'Shipping emails to customers', ok: Boolean(env.RESEND_API_KEY && env.FROM_EMAIL), note: env.RESEND_API_KEY && env.FROM_EMAIL ? 'On (Resend).' : 'Optional: needs a custom domain + Resend (SETUP.md step 9). Customers can always track at /order.html.' },
  ];
  return {
    site: { name: SITE.name, url: origin },
    settings,
    setup,
    stats,
    orders: orders.map(compactOrder),
    products: catalog.products.map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      price: p.price,
      cost: Math.min(...p.variants.map((v) => v.cost || 0)),
      score: p.score,
      hidden: p.hidden,
      pinned: p.pinned,
      supplier: p.supplier,
      image: p.images[0],
      addedAt: p.addedAt,
      refreshedAt: p.refreshedAt,
      keyword: p.source?.keyword || null,
      listed: p.source?.listed || null,
    })),
    scan: {
      lastRun: scan.lastRun || null,
      runs: scan.runs || [],
      radar: scan.radar || null,
      keywords: seeds.map((s) => ({ ...s, lastScanned: scan.done?.[s.q] || null, products: counts[s.q] || 0 })),
      removed: kv['seeds:removed'] || [],
      categories: [...SCAN_CATEGORIES],
    },
    promo: {
      lastDate: promo.lastDate || null,
      history: (promo.history || []).slice(0, 15),
      channels: CHANNELS.map((c) => ({ name: c.name, ok: channelReady(env, c) })),
      kit: promoKit(catalog.products.filter((p) => !p.hidden), origin, settings),
    },
    cron: kv['cron:last'] || null,
  };
}

async function connectWebhook(request, env) {
  const origin = siteOrigin(request, env, SITE);
  if (!origin.startsWith('https://')) throw new HttpError(400, 'Open /admin on your live https:// site to connect the webhook.');
  const url = `${origin}/api/stripe-webhook`;
  const list = await stripe(env, 'GET', '/webhook_endpoints', { limit: 100 });
  for (const ep of list.data || []) if (ep.url === url) await stripe(env, 'DELETE', `/webhook_endpoints/${ep.id}`);
  const ep = await stripe(env, 'POST', '/webhook_endpoints', {
    url,
    api_version: STRIPE_VERSION,
    description: `${SITE.name} orders (created from /admin)`,
    enabled_events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired', 'charge.refunded'],
  });
  const mode = String(env.STRIPE_SECRET_KEY).includes('_test_') ? 'test mode' : 'live mode';
  await kvSet(env, 'stripe:webhook', { id: ep.id, secret: ep.secret, url, mode, at: Date.now() });
  return [`Stripe webhook connected (${mode}). Paid orders now show up here automatically.`, 'If you switch Stripe from test to live (or back), click this button again.'];
}

async function editProduct(env, body) {
  const id = String(body.id || '');
  const op = String(body.op || '');
  const ov = (await kvGet(env, 'catalog:overrides', null)) || { hidden: [], pinned: [] };
  const set = (k, on) => {
    ov[k] = [...new Set((ov[k] || []).filter((x) => x !== id).concat(on ? [id] : []))];
  };
  if (op === 'hide') set('hidden', true);
  else if (op === 'show') set('hidden', false);
  else if (op === 'pin') set('pinned', true);
  else if (op === 'unpin') set('pinned', false);
  else if (op === 'remove') {
    const list = (await kvGet(env, 'catalog:trending', [])) || [];
    const p = list.find((x) => x.id === id);
    if (!p) throw new HttpError(400, 'Only scanner products can be removed. Hide apparel instead (or delete it from catalog/designs.json).');
    await kvSet(env, 'catalog:trending', list.filter((x) => x.id !== id));
    // don't let the scanner bring the same item straight back
    const scan = (await kvGet(env, 'scan:state', null)) || {};
    scan.banned = [...new Set([...(scan.banned || []), String(p.source?.pid || '')])].slice(-500);
    await kvSet(env, 'scan:state', scan);
  } else throw new HttpError(400, 'Unknown product action.');
  if (op !== 'remove') await kvSet(env, 'catalog:overrides', ov);
  invalidateCatalog();
  return [`Done: ${op} ${id}`];
}

async function editOrder(request, env, body) {
  const order = await getOrder(env, String(body.id || ''));
  if (!order) throw new HttpError(404, 'Order not found.');
  const origin = siteOrigin(request, env, SITE);
  const settings = await getSettings(env);
  const op = String(body.op || '');
  if (op === 'fulfill') {
    if (['pending', 'expired', 'canceled', 'refunded'].includes(order.status)) throw new HttpError(400, `This order is ${order.status}; it can't be sent to suppliers.`);
    const o = await fulfillOrder(env, order, { origin, settings, manual: true });
    return [`Order ${o.id} is now ${o.status}.`, ...o.log.slice(-3).map((l) => l.msg)];
  }
  if (op === 'sync') {
    const o = await syncTracking(env, order, { origin });
    return [`Order ${o.id} is ${o.status}.`];
  }
  if (op === 'mark_shipped' || op === 'cancel') {
    const status = op === 'cancel' ? 'canceled' : 'shipped';
    await updateOrder(env, order.id, { status, next_check: Date.now() + 3650 * 86400000, log: withLog(order, `Marked ${status} by you.${op === 'cancel' ? ' Refund it in Stripe if you took payment.' : ''}`) });
    return [`Order ${order.id} marked ${status}.`];
  }
  throw new HttpError(400, 'Unknown order action.');
}

async function editKeyword(env, body) {
  const op = String(body.op || '');
  const q = String(body.q || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!q) throw new HttpError(400, 'Type a keyword.');
  const custom = (await kvGet(env, 'seeds:custom', [])) || [];
  const removed = (await kvGet(env, 'seeds:removed', [])) || [];
  if (op === 'add') {
    const cat = String(body.cat || '');
    if (!SCAN_CATEGORIES.has(cat)) throw new HttpError(400, 'Pick a tab for this keyword.');
    const why = String(body.why || '').replace(/[<>]/g, '').slice(0, 200);
    await kvSet(env, 'seeds:custom', [...custom.filter((k) => k.q !== q), { q, cat, score: 80, why, custom: true }]);
    await kvSet(env, 'seeds:removed', removed.filter((r) => r !== q));
    return [`Added "${q}". The scanner checks it on its next run (or click Scan now).`];
  }
  if (op === 'remove') {
    await kvSet(env, 'seeds:custom', custom.filter((k) => k.q !== q));
    await kvSet(env, 'seeds:removed', [...new Set([...removed, q])]);
    return [`Removed "${q}". Its products retire on their own once they go stale.`];
  }
  if (op === 'restore') {
    await kvSet(env, 'seeds:removed', removed.filter((r) => r !== q));
    return [`Restored "${q}".`];
  }
  throw new HttpError(400, 'Unknown keyword action.');
}

export const onRequestGet = handle(async ({ request, env }) => {
  await requireAdmin(request, env);
  return json(await overview(request, env));
});

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const action = String(body.action || '');
  if (action === 'login') {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    return json({ token: await login(env, body.password, ip) });
  }
  await requireAdmin(request, env);
  const origin = siteOrigin(request, env, SITE);
  switch (action) {
    case 'settings':
      return json({ settings: await saveSettings(env, body.patch || {}), lines: ['Saved.'] });
    case 'scan': {
      const r = await runScan(env, { settings: await getSettings(env), maxKeywords: 4, force: Boolean(body.force) });
      return json({ lines: r.lines.length ? r.lines : ['Nothing was due. Tick "re-check everything" to force a scan.'], result: r });
    }
    case 'promo': {
      const r = await runPromo(env, { origin, settings: await getSettings(env), force: true, dryRun: body.mode !== 'post' });
      const lines = r.dryRun ? [`Preview (not posted). Would post to: ${r.channels.join(', ') || 'no accounts connected yet'}.`] : r.reason ? [r.reason] : r.results.map((x) => `${x.ok ? '✔' : '✖'} ${x.channel}${x.error ? `: ${x.error}` : ''}`);
      return json({ lines, post: r.post || null });
    }
    case 'product':
      return json({ lines: await editProduct(env, body) });
    case 'order':
      return json({ lines: await editOrder(request, env, body) });
    case 'keyword':
      return json({ lines: await editKeyword(env, body) });
    case 'setup': {
      const op = String(body.op || '');
      if (op === 'stripe-webhook') return json({ lines: await connectWebhook(request, env) });
      if (op === 'test-printful') return json({ lines: await testPrintful(env) });
      if (op === 'test-cj') return json({ lines: await testCj(env) });
      if (op === 'test-alerts') {
        const n = await notifyOwner(env, `Test alert from ${SITE.name}. New orders will look like this.`);
        return json({ lines: [n ? `Sent to ${n} channel(s).` : 'Nothing was delivered. Check the alert settings.'] });
      }
      throw new HttpError(400, 'Unknown setup action.');
    }
    default:
      throw new HttpError(400, 'Unknown action.');
  }
});
