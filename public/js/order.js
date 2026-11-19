// Order page: right after checkout (?session_id=...) it shows the order and watches for payment confirmation;
// otherwise it's the "Track your order" form (order number + email).
import { cart } from './cart.js';

const $ = (s) => document.querySelector(s);
const money = (c) => `$${(Math.round(c) / 100).toFixed(2)}`;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const STEPS = [
  ['paid', 'Payment confirmed'],
  ['submitted', 'Sent to our makers & warehouses'],
  ['shipped', 'Shipped'],
];
const RANK = { pending: 0, paid: 1, needs_attention: 1, submitted: 2, partially_shipped: 2.5, shipped: 3 };
const LABEL = {
  pending: ['warn', 'Confirming payment...'],
  paid: ['ok', 'Paid'],
  needs_attention: ['warn', 'Being prepared'],
  submitted: ['ok', 'In production'],
  partially_shipped: ['ok', 'Partly shipped'],
  shipped: ['ok', 'Shipped'],
  canceled: ['bad', 'Canceled'],
  refunded: ['bad', 'Refunded'],
  expired: ['bad', 'Checkout not completed'],
};

function show(o, fresh) {
  const [cls, label] = LABEL[o.status] || ['warn', o.status];
  const rank = RANK[o.status] ?? 0;
  const box = $('#result');
  box.replaceChildren(
    h('h1', { text: fresh && rank >= 1 ? 'Thank you! Your order is in. 🔥' : `Order ${o.id}` }),
    h('p', { class: 'meta' }, `Order ${o.id}`, o.email ? ` · receipt sent to ${o.email}` : '', ' · ', h('span', { class: `status ${cls}`, text: label })),
    ['canceled', 'refunded', 'expired'].includes(o.status)
      ? null
      : h('ul', { class: 'steps' }, STEPS.map(([key, text]) => h('li', { class: rank >= RANK[key] ? 'done' : '' }, h('i'), text))),
    o.tracking?.length
      ? h('div', { class: 'panel' }, h('strong', { text: 'Tracking' }), o.tracking.map((t) => h('p', {}, `${t.carrier}: `, t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener', text: t.number }) : t.number)))
      : rank >= 1 && rank < 3
        ? h('p', { text: `Estimated delivery: about ${o.shipDays?.[0] || 5}–${o.shipDays?.[1] || 12} business days from today. Tracking appears here as soon as it ships${o.items.length > 1 ? ' (items can arrive separately)' : ''}.` })
        : null,
    h('div', { class: 'panel' },
      o.items.map((i) => h('div', { class: 'row' }, h('span', { text: `${i.qty} × ${i.title}${i.variant ? ` (${i.variant})` : ''}` }), h('span', { text: money(i.price * i.qty) }))),
      h('div', { class: 'row' }, h('span', { text: 'Shipping' }), h('span', { text: o.shipping ? money(o.shipping) : 'FREE' })),
      o.discount ? h('div', { class: 'row' }, h('span', { text: 'Discount' }), h('span', { text: `-${money(o.discount)}` })) : null,
      o.tax ? h('div', { class: 'row' }, h('span', { text: 'Tax' }), h('span', { text: money(o.tax) })) : null,
      h('div', { class: 'row total' }, h('span', { text: 'Total' }), h('span', { text: money(o.total) }))),
    h('p', { class: 'meta' }, 'Questions? Reply to your receipt or email us with your order number. Bookmark this page to check on your order any time.'),
    h('p', {}, h('a', { class: 'btn', href: '/' }, 'Keep shopping')),
  );
  box.hidden = false;
  $('#trackbox').hidden = true;
}

async function fromSession(sid) {
  let tries = 0;
  const tick = async () => {
    tries += 1;
    try {
      const r = await fetch(`/api/order?session_id=${encodeURIComponent(sid)}`);
      const j = await r.json();
      if (r.ok) {
        show(j.order, true);
        if (j.order.status !== 'pending') cart.clear();
        if (j.order.status === 'pending' && tries < 20) setTimeout(tick, 3000);
        return;
      }
    } catch {
      /* retry below */
    }
    if (tries < 20) setTimeout(tick, 3000);
  };
  tick();
}

$('#track').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#trackerr');
  err.hidden = true;
  try {
    const r = await fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: $('#oid').value, email: $('#oemail').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Not found');
    show(j.order, false);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

const params = new URLSearchParams(location.search);
const sid = params.get('session_id');
if (sid) fromSession(sid);
else if (params.get('id')) $('#oid').value = params.get('id').slice(0, 12);
