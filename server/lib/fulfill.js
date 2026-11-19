// The life of an order after checkout:
//   pending (checkout started) -> paid (Stripe confirmed) -> fulfilling (being sent) -> submitted (Printful / CJ have it)
//   -> partially_shipped / shipped (tracking numbers in)
// Side branches: needs_attention (a supplier refused it, it was paid suspiciously little, or a supplier cancelled it;
// supplier errors are retried 3 times, everything else waits for you), expired (checkout abandoned), canceled, refunded.
// Every status change is atomic (transitionOrder), so webhook retries, the cron and the admin button can never
// send the same order to a supplier twice.
import SITE from '../../site.config.json' with { type: 'json' };
import { createCjOrders, cjOrderStatus } from './cj.js';
import { getOrder, transitionOrder, updateOrderIf, withLog } from './db.js';
import { money } from './http.js';
import { emailCustomerShipped, notifyOwner, orderSummary } from './notify.js';
import { createPrintfulOrder, printfulStatus } from './printful.js';
import { sessionShipping } from './stripe.js';

const MIN = 60000;
const LEASE = 15 * MIN;
const RETRY_AFTER = [30 * MIN, 120 * MIN, 360 * MIN];
const NEVER = 3650 * 86400000;
const TRACK_EVERY = 3 * 60 * MIN;

/** Stripe confirmed payment (already checked against this order): save the customer's details, alert you, fulfill. */
export async function markPaid(env, order, session, { origin, settings, waitUntil }) {
  const ship = sessionShipping(session);
  const total = Number.isFinite(session.amount_total) ? session.amount_total : order.total;
  // A 100%-off promo code (or similar) shouldn't silently cost you money: hold it for a look.
  const suspicious = total < Math.round((order.est_cost || 0) * 0.9);
  const now = Date.now();
  const patch = {
    status: suspicious ? 'needs_attention' : 'paid',
    email: ship.email || order.email,
    name: ship.name,
    phone: ship.phone,
    shipping: ship,
    total,
    discount: session.total_details?.amount_discount || 0,
    tax: session.total_details?.amount_tax || 0,
    next_check: suspicious ? now + NEVER : now + LEASE, // the cron only steps in if the work below dies
    log: withLog(
      order,
      `Paid ${money(total)} (Stripe ${session.id}).`,
      suspicious ? `Held: paid less than the estimated supplier cost (${money(order.est_cost)}). Check the discount, then click "Send to suppliers" or refund it in Stripe.` : '',
    ),
  };
  if (!(await transitionOrder(env, order.id, ['pending', 'expired'], patch))) return null; // already handled (Stripe retries)
  const paid = { ...order, ...patch };
  const note = suspicious ? '\nHELD for review: it was paid less than it costs you.' : settings.autoFulfill ? '' : '\nAuto-fulfill is OFF: send it from the admin page.';
  const alert = notifyOwner(env, `New order! ${orderSummary(paid)}${note}`, 'New Hot Dropic order').catch(() => 0);
  const work = settings.autoFulfill && !suspicious ? fulfillOrder(env, paid, { origin, settings }).catch((e) => console.error('fulfill failed', e)) : Promise.resolve();
  if (waitUntil) {
    waitUntil(alert);
    waitUntil(work);
  } else await Promise.all([alert, work]);
  return paid;
}

/** Sends the order to whichever suppliers don't have it yet. Safe to call any number of times. */
export async function fulfillOrder(env, order, { origin, settings, manual = false }) {
  const now = Date.now();
  const claimed = await transitionOrder(env, order.id, ['paid', 'needs_attention'], { status: 'fulfilling', next_check: now + LEASE }, { staleBefore: now });
  if (!claimed) return { ...order, skipped: true };
  const fresh = (await getOrder(env, order.id)) || order;
  const supplier = { ...(fresh.supplier || {}) };
  const lines = [];
  let failed = 0;
  let sent = 0;
  const pfItems = fresh.items.filter((i) => i.sup?.kind === 'printful');
  const cjItems = fresh.items.filter((i) => i.sup?.kind === 'cj');
  if (pfItems.length && !supplier.printful?.id) {
    sent += 1;
    try {
      supplier.printful = await createPrintfulOrder(env, fresh, pfItems, origin, { confirm: true });
      lines.push(`Sent to Printful: order ${supplier.printful.id} (${supplier.printful.status}).`);
    } catch (e) {
      failed += 1;
      supplier.printful = { error: e.message, at: Date.now() };
      lines.push(`Printful problem: ${e.message}`);
    }
  }
  const cjDone = (supplier.cj?.orders || []).filter((o) => o.id);
  if (cjItems.length && cjDone.length < new Set(cjItems.map((i) => i.sup.from || 'CN')).size) {
    sent += 1;
    const orders = await createCjOrders(env, fresh, cjItems, { payType: settings.cjPayType, existing: supplier.cj?.orders || [] });
    supplier.cj = { orders };
    for (const o of orders) {
      if (o.id) lines.push(`CJ order ${o.id} (${o.status})${o.needsPayment ? ': pay it in CJ (My CJ > Orders) so it ships.' : '.'}`);
      else {
        failed += 1;
        lines.push(`CJ problem (${o.number}): ${o.error || o.status}`);
      }
    }
  }
  const attempts = manual ? 1 : (fresh.attempts || 0) + 1;
  const patch = failed
    ? { supplier, status: 'needs_attention', attempts, next_check: Date.now() + (RETRY_AFTER[attempts - 1] ?? NEVER) }
    : { supplier, status: 'submitted', attempts: 0, next_check: Date.now() + TRACK_EVERY };
  if (!sent) lines.push('Nothing left to send: every supplier already has this order.');
  patch.log = withLog(fresh, ...lines);
  await updateOrderIf(env, order.id, 'fulfilling', patch);
  if (failed && (attempts === 1 || attempts === RETRY_AFTER.length + 1)) {
    await notifyOwner(env, `Order ${order.id} needs attention: ${lines.filter((l) => /problem/.test(l)).join(' ')}`, 'Hot Dropic order needs attention').catch(() => 0);
  }
  return { ...fresh, ...patch };
}

/** Tracking numbers for the customer, from whatever the suppliers have reported. */
export function trackingList(order) {
  const out = [];
  for (const s of order.supplier?.printful?.shipments || []) if (s.number) out.push({ carrier: s.carrier || 'Carrier', number: s.number, url: s.url || '' });
  for (const o of order.supplier?.cj?.orders || []) if (o.tracking?.number) out.push({ carrier: o.tracking.carrier || 'Carrier', number: o.tracking.number, url: o.tracking.url || '' });
  return out;
}

/** Asks the suppliers what has shipped and updates the order (run by the cron every few hours). */
export async function syncTracking(env, order, { origin }) {
  const supplier = JSON.parse(JSON.stringify(order.supplier || {}));
  const lines = [];
  let parts = 0;
  let shipped = 0;
  let problem = '';
  if (supplier.printful?.id) {
    parts += 1;
    try {
      const st = await printfulStatus(env, order.id);
      if (st.status !== supplier.printful.status) lines.push(`Printful status: ${st.status}.`);
      supplier.printful.status = st.status;
      supplier.printful.shipments = st.shipments;
      if (st.status === 'fulfilled') shipped += 1;
      if (['canceled', 'failed'].includes(st.status)) problem = `Printful marked it ${st.status}.`;
    } catch (e) {
      lines.push(`Printful check failed: ${e.message}`);
    }
  }
  for (const o of supplier.cj?.orders || []) {
    parts += 1;
    if (!o.id) {
      problem = problem || `CJ part ${o.number} has no CJ order id. Find it in the CJ dashboard.`;
      continue;
    }
    try {
      const st = await cjOrderStatus(env, o.id);
      if (st.status && st.status !== o.status) lines.push(`CJ order ${o.id}: ${st.status}.`);
      o.status = st.status || o.status;
      if (st.number) o.tracking = { number: st.number, carrier: st.carrier, url: st.url };
      if (['SHIPPED', 'DELIVERED'].includes(o.status) || st.number) shipped += 1;
      if (o.status === 'CANCELLED') problem = 'CJ cancelled it.';
      if (o.status !== 'UNPAID') o.needsPayment = false;
    } catch (e) {
      lines.push(`CJ check failed: ${e.message}`);
    }
  }
  const before = order.status;
  let status = before;
  if (problem) status = 'needs_attention';
  else if (parts && shipped === parts) status = 'shipped';
  else if (shipped) status = 'partially_shipped';
  if (problem) lines.push(`${problem} Refund the customer in Stripe or re-order it by hand.`);
  const tracking = trackingList({ supplier });
  const newlyShipped = ['shipped', 'partially_shipped'].includes(status) && status !== before;
  if (newlyShipped) lines.push(`Tracking: ${tracking.map((t) => t.number).join(', ')}`);
  const patch = {
    supplier,
    status,
    // supplier cancellations are parked for you (no automatic retry loop)
    next_check: status === 'shipped' || problem ? Date.now() + NEVER : Date.now() + TRACK_EVERY,
    log: withLog(order, ...lines),
  };
  const ok = await updateOrderIf(env, order.id, before, patch);
  if (!ok) return { ...order, skipped: true }; // something else changed it meanwhile (e.g. a refund)
  if (newlyShipped) await emailCustomerShipped(env, order, tracking, origin, SITE.name).catch(() => false);
  if (problem) await notifyOwner(env, `Order ${order.id} needs attention: ${problem}`).catch(() => 0);
  return { ...order, ...patch };
}

/** The parts of an order a customer may see (on the order page). */
export function publicOrder(order) {
  const email = order.email || '';
  const [u, d] = email.split('@');
  return {
    id: order.id,
    status: order.status === 'fulfilling' ? 'paid' : order.status,
    created: order.created_at,
    email: email ? `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}` : '',
    items: (order.items || []).map((i) => ({ title: i.title, variant: i.variantLabel, qty: i.qty, price: i.price, image: i.image })),
    subtotal: order.subtotal,
    shipping: order.shipping_fee,
    discount: order.discount || 0,
    tax: order.tax || 0,
    total: order.total,
    shipDays: order.items?.reduce((m, i) => [Math.max(m[0], i.shipDays?.[0] || 0), Math.max(m[1], i.shipDays?.[1] || 0)], [0, 0]),
    tracking: trackingList(order),
  };
}
