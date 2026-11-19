// POST /api/stripe-webhook: Stripe tells us when a checkout is paid, expired or refunded.
// Every message is signature-checked. The secret comes from STRIPE_WEBHOOK_SECRET or from the
// "Connect Stripe webhook" button in /admin (which creates the endpoint and saves its secret in D1).
import SITE from '../../site.config.json' with { type: 'json' };
import { getOrder, getOrderBySession, kvGet, transitionOrder, updateOrder, withLog } from '../../server/lib/db.js';
import { markPaid } from '../../server/lib/fulfill.js';
import { errorResponse, json, siteOrigin } from '../../server/lib/http.js';
import { notifyOwner } from '../../server/lib/notify.js';
import { getSettings } from '../../server/lib/settings.js';
import { stripe, verifyStripeSignature } from '../../server/lib/stripe.js';

async function secrets(env) {
  const out = [];
  if (String(env.STRIPE_WEBHOOK_SECRET || '').trim()) out.push(env.STRIPE_WEBHOOK_SECRET.trim());
  const saved = await kvGet(env, 'stripe:webhook', null).catch(() => null);
  if (saved?.secret) out.push(saved.secret);
  return out;
}

/** The order this Checkout Session belongs to. The session id must match the one we created at checkout. */
async function findOrder(env, obj) {
  if (!obj?.id) return null;
  let order = await getOrderBySession(env, obj.id);
  if (!order && obj.metadata?.order_id) order = await getOrder(env, obj.metadata.order_id);
  return order && order.session_id === obj.id ? order : null;
}

/** Refuses payments that don't match the order (wrong amount, currency or test/live mode). Returns a reason or ''. */
function mismatch(order, session, event, env) {
  const live = String(env.STRIPE_SECRET_KEY || '').trim().startsWith('sk_live_') || String(env.STRIPE_SECRET_KEY || '').trim().startsWith('rk_live_');
  if (typeof event.livemode === 'boolean' && event.livemode !== live) return `event is ${event.livemode ? 'live' : 'test'} mode but the store key is ${live ? 'live' : 'test'} mode`;
  if (String(session.currency || 'usd').toLowerCase() !== 'usd') return `currency ${session.currency}`;
  if (Number.isFinite(session.amount_subtotal) && session.amount_subtotal !== order.subtotal) return `subtotal ${session.amount_subtotal} does not match the order's ${order.subtotal}`;
  return '';
}

export async function onRequestPost({ request, env, waitUntil }) {
  const payload = await request.text();
  const header = request.headers.get('stripe-signature');
  const keys = await secrets(env);
  if (!keys.length) return errorResponse(503, 'Webhook secret not set up yet.');
  let valid = false;
  for (const k of keys) if (await verifyStripeSignature(payload, header, k)) valid = true;
  if (!valid) return errorResponse(400, 'Invalid signature.');

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return errorResponse(400, 'Bad JSON.');
  }
  const obj = event.data?.object || {};
  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (event.type === 'checkout.session.completed' && !['paid', 'no_payment_required'].includes(obj.payment_status)) break; // bank payments: wait
        const order = await findOrder(env, obj);
        if (!order) {
          console.warn('Webhook for a session that is not one of our checkouts', obj.id);
          break;
        }
        // Re-read the session from Stripe (pinned API version) so the fields and amounts are trustworthy.
        const session = await stripe(env, 'GET', `/checkout/sessions/${encodeURIComponent(obj.id)}`);
        if (!['paid', 'no_payment_required'].includes(session.payment_status)) break;
        const bad = mismatch(order, session, event, env);
        if (bad) {
          await updateOrder(env, order.id, { log: withLog(order, `Ignored a Stripe payment message: ${bad}.`) });
          await notifyOwner(env, `Order ${order.id}: ignored a Stripe payment that didn't match (${bad}). Check it in Stripe.`).catch(() => 0);
          break;
        }
        const settings = await getSettings(env);
        await markPaid(env, order, session, { origin: siteOrigin(request, env, SITE), settings, waitUntil });
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const order = await findOrder(env, obj);
        if (order) await transitionOrder(env, order.id, ['pending'], { status: 'canceled', log: withLog(order, 'Bank payment failed.') });
        break;
      }
      case 'checkout.session.expired': {
        const order = await findOrder(env, obj);
        if (order) await transitionOrder(env, order.id, ['pending'], { status: 'expired', next_check: 0, log: withLog(order, 'Checkout abandoned.') });
        break;
      }
      case 'charge.refunded': {
        if (!obj.payment_intent) break;
        const pi = await stripe(env, 'GET', `/payment_intents/${encodeURIComponent(obj.payment_intent)}`).catch(() => null);
        const order = pi?.metadata?.order_id ? await getOrder(env, pi.metadata.order_id) : null;
        if (!order) break;
        const full = obj.amount_refunded >= obj.amount;
        await updateOrder(env, order.id, {
          status: full ? 'refunded' : order.status,
          log: withLog(order, `${full ? 'Refunded' : 'Partly refunded'} $${(obj.amount_refunded / 100).toFixed(2)} in Stripe.${order.status === 'submitted' ? ' Cancel it with the supplier too if it has not shipped.' : ''}`),
        });
        if (full) await notifyOwner(env, `Order ${order.id} was refunded. If it hasn't shipped, cancel it in Printful/CJ too.`).catch(() => 0);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error('Webhook handling failed', event.type, e?.stack || e);
    return errorResponse(500, 'Temporary problem; Stripe will retry.');
  }
  return json({ received: true });
}
