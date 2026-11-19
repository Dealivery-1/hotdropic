// POST /api/checkout {items:[{productId, variantId, qty}]} -> { url } of a Stripe Checkout page.
// Prices always come from the server's catalog, never from the browser. The order is saved as "pending" first
// so the webhook can match Stripe's payment back to exactly what was bought.
import SITE from '../../site.config.json' with { type: 'json' };
import { absUrl, findVariant, loadCatalog } from '../../server/lib/catalog.js';
import { insertOrder, updateOrder } from '../../server/lib/db.js';
import { handle, HttpError, json, readJson, siteOrigin } from '../../server/lib/http.js';
import { stripeFee } from '../../server/lib/pricing.js';
import { getSettings, shippingFor } from '../../server/lib/settings.js';
import { stripe } from '../../server/lib/stripe.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newOrderId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `HD${[...bytes].map((b) => ALPHABET[b % 32]).join('')}`;
}

// Best-effort limit per visitor (per Cloudflare location): 12 checkouts in 10 minutes. For a hard limit,
// add a Cloudflare rate-limiting rule for /api/checkout (SETUP.md, Reference).
const recent = new Map();
function tooMany(ip, now = Date.now()) {
  const hits = (recent.get(ip) || []).filter((t) => now - t < 600000);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear();
  return hits.length > 12;
}

export const onRequestPost = handle(async ({ request, env }) => {
  if (!String(env.STRIPE_SECRET_KEY || '').trim()) throw new HttpError(503, 'Checkout is not switched on yet. Please check back soon!');
  if (tooMany(request.headers.get('cf-connecting-ip') || 'unknown')) throw new HttpError(429, 'Too many checkout attempts. Please wait a few minutes.');
  const body = await readJson(request);
  const settings = await getSettings(env);
  if (!settings.storeOpen) throw new HttpError(503, 'The store is taking a quick break. Please try again soon.');
  const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  if (!items.length) throw new HttpError(400, 'Your cart is empty.');

  const { products } = await loadCatalog(env);
  const merged = new Map();
  for (const it of items) {
    const qty = Math.floor(Number(it?.qty));
    if (!(qty >= 1 && qty <= 10)) throw new HttpError(400, 'Each item can have a quantity from 1 to 10.');
    const found = findVariant(products, String(it.productId || ''), String(it.variantId || ''));
    if (!found) throw new HttpError(409, 'Something in your cart sold out or changed. We removed it, so please check your cart and try again.', { productId: String(it.productId || ''), variantId: String(it.variantId || '') });
    const key = `${found.p.id}|${found.v.id}`;
    const prev = merged.get(key);
    merged.set(key, { p: found.p, v: found.v, qty: Math.min(10, (prev?.qty || 0) + qty) });
  }
  if (merged.size > 20) throw new HttpError(400, 'That is a lot of different items! Please split it into two orders.');

  const origin = siteOrigin(request, env, SITE);
  const lines = [...merged.values()].map(({ p, v, qty }) => ({
    productId: p.id,
    variantId: v.id,
    title: p.title,
    variantLabel: v.label === 'Standard' ? '' : v.label,
    qty,
    price: v.price,
    cost: v.cost || 0,
    image: v.image || p.images[0],
    sup: v.sup,
    shipDays: p.shipDays,
  }));
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const shippingFee = shippingFor(subtotal, settings);
  const total = subtotal + shippingFee;
  const id = newOrderId();
  await insertOrder(env, {
    id,
    status: 'pending',
    items: lines,
    subtotal,
    shipping_fee: shippingFee,
    total,
    est_cost: lines.reduce((s, l) => s + l.cost * l.qty, 0) + stripeFee(total),
    log: [{ t: Date.now(), msg: 'Checkout started.' }],
  });

  const days = lines.reduce((m, l) => [Math.max(m[0], l.shipDays?.[0] || 5), Math.max(m[1], l.shipDays?.[1] || 12)], [1, 1]);
  const https = origin.startsWith('https://');
  const params = {
    mode: 'payment',
    client_reference_id: id,
    metadata: { order_id: id },
    payment_intent_data: { metadata: { order_id: id }, description: `${SITE.name} order ${id}` },
    line_items: lines.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: 'usd',
        unit_amount: l.price,
        product_data: {
          name: (l.variantLabel ? `${l.title} (${l.variantLabel})` : l.title).slice(0, 250),
          ...(https ? { images: [absUrl(origin, l.image)] } : {}),
          metadata: { product_id: l.productId, variant_id: l.variantId },
        },
      },
    })),
    shipping_address_collection: { allowed_countries: SITE.shipCountries || ['US'] },
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: shippingFee, currency: 'usd' },
          display_name: shippingFee ? 'Standard shipping' : 'Free shipping',
          delivery_estimate: { minimum: { unit: 'business_day', value: days[0] }, maximum: { unit: 'business_day', value: days[1] } },
        },
      },
    ],
    phone_number_collection: { enabled: true },
    allow_promotion_codes: true,
    custom_text: { shipping_address: { message: 'US shipping only for now. Items from different makers may arrive in separate packages.' } },
    success_url: `${origin}/order.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=canceled`,
  };
  if (String(env.STRIPE_AUTOMATIC_TAX || '') === 'true') params.automatic_tax = { enabled: true };
  const session = await stripe(env, 'POST', '/checkout/sessions', params, `checkout-${id}`);
  await updateOrder(env, id, { session_id: session.id });
  return json({ url: session.url });
});
