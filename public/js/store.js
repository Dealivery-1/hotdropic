// The store page: tabs, product grid, product view, cart drawer and checkout. Vanilla JS, no dependencies.
// Product data from suppliers is untrusted, so it is only ever inserted as text (never as HTML).
import { cart } from './cart.js';

const $ = (s, el = document) => el.querySelector(s);
const money = (c) => `$${(Math.round(c) / 100).toFixed(2)}`;
const moneyShort = (c) => (c % 100 === 0 ? `$${c / 100}` : money(c));

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

let DATA = { config: {}, categories: [], trending: [], products: [] };
let byId = new Map();
const state = { tab: 'trending', q: '' };
let lastFocus = null;

// ---------------------------------------------------------------- boot
function readSsr() {
  const el = document.getElementById('ssr-product');
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

async function boot() {
  $('#year').textContent = String(new Date().getFullYear());
  const ssr = readSsr();
  try {
    const r = await fetch('/api/catalog');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'catalog');
    DATA = j;
  } catch {
    DATA = { config: { payments: false, storeOpen: true, freeShippingMin: 3500, shippingFee: 499 }, categories: [{ id: 'trending', label: 'Trending', icon: '🔥', auto: 'trending' }], trending: ssr ? [ssr.id] : [], products: ssr ? [ssr] : [] };
    toast("Couldn't load everything. Please refresh.");
  }
  byId = new Map(DATA.products.map((p) => [p.id, p]));
  applyConfig();
  renderTicker();
  const params = new URLSearchParams(location.search);
  if (validTab(params.get('tab'))) state.tab = params.get('tab');
  renderTabs();
  renderGrid();
  cart.onChange(renderCart);
  renderCart();
  wire();
  const path = location.pathname.match(/^\/p\/([^/]+)/);
  if (path) openProduct(decodeURIComponent(path[1]), { replace: true, variant: params.get('variant') });
  if (params.get('checkout') === 'canceled') toast('Checkout canceled. Your cart is saved.');
}

function applyConfig() {
  const c = DATA.config || {};
  const free = c.freeShippingMin > 0 ? `Free US shipping on ${moneyShort(c.freeShippingMin)}+` : 'Free US shipping';
  $('#announce').textContent = c.announcement || `🔥 ${free} · New drops land automatically when they trend`;
  const bar = $('#testbar');
  const msg = !c.storeOpen ? 'The store is taking a quick break. Checkout is paused, but your cart is saved.'
    : !c.payments ? 'Checkout opens very soon. You can already fill your cart.'
    : c.testMode ? 'Test mode: pay with card 4242 4242 4242 4242, any future date, any CVC. No real money moves.' : '';
  bar.textContent = msg;
  bar.hidden = !msg;
  if (c.supportEmail) $('#contact').href = `mailto:${c.supportEmail}`;
}

// ---------------------------------------------------------------- tabs + grid
const validTab = (id) => DATA.categories.some((c) => c.id === id);

function productsFor(tabId) {
  const cat = DATA.categories.find((c) => c.id === tabId);
  if (!cat) return [];
  if (cat.auto === 'trending') return DATA.trending.map((id) => byId.get(id)).filter(Boolean);
  const under = /^under:(\d+)$/.exec(cat.auto || '');
  const list = under ? DATA.products.filter((p) => p.price < Number(under[1])) : DATA.products.filter((p) => p.category === cat.id);
  return list.sort((a, b) => b.score - a.score);
}

function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  for (const c of DATA.categories) {
    const n = productsFor(c.id).length;
    if (!n && c.id !== 'trending' && c.id !== 'meme-tees') continue;
    const a = h('a', { class: 'tab', href: c.id === 'trending' ? '/' : `/?tab=${c.id}`, 'aria-current': String(state.tab === c.id && !state.q) }, `${c.icon || ''} ${c.label}`, c.auto === 'trending' ? null : h('span', { class: 'n', text: String(n) }));
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      state.tab = c.id;
      state.q = '';
      $('#q').value = '';
      history.replaceState({}, '', c.id === 'trending' ? '/' : `/?tab=${c.id}`);
      renderTabs();
      renderGrid();
      $('#app').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.append(a);
  }
}

function badgeRow(p) {
  const map = { hot: ['hot', '🔥 Hot'], new: ['new', 'New'], pick: ['pick', 'Staff pick'] };
  const b = (p.badges || []).filter((x) => map[x]).slice(0, 2);
  return b.length ? h('div', { class: 'badges' }, b.map((x) => h('span', { class: `badge ${map[x][0]}`, text: map[x][1] }))) : null;
}

const hasRange = (p) => new Set(p.variants.map((v) => v.price)).size > 1;

function card(p) {
  return h(
    'a',
    {
      class: 'card',
      href: `/p/${encodeURIComponent(p.id)}`,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        e.preventDefault();
        openProduct(p.id);
      },
    },
    h('div', { class: 'img' }, h('img', { src: p.images[0], alt: p.title, loading: 'lazy', width: 400, height: 400, referrerpolicy: 'no-referrer' })),
    badgeRow(p),
    h('div', { class: 'body' }, h('h3', { text: p.title }), h('div', { class: 'price' }, hasRange(p) ? h('small', { text: 'from' }) : null, money(p.price))),
  );
}

function renderGrid() {
  const app = $('#app');
  const keep = [...app.children].filter((el) => el.id === 'ssr-product' || el.tagName === 'NOSCRIPT');
  app.replaceChildren(...keep);
  let list;
  let title;
  let blurb;
  if (state.q) {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    list = DATA.products.filter((p) => words.every((w) => `${p.title} ${(p.tags || []).join(' ')} ${p.category}`.toLowerCase().includes(w))).sort((a, b) => b.score - a.score);
    title = `Results for "${state.q}"`;
    blurb = `${list.length} item${list.length === 1 ? '' : 's'}`;
  } else {
    const cat = DATA.categories.find((c) => c.id === state.tab) || DATA.categories[0];
    list = productsFor(cat?.id);
    title = `${cat?.icon || ''} ${cat?.label || 'Trending'}`;
    blurb = cat?.blurb || '';
  }
  app.append(h('div', { class: 'section-head' }, h('h2', { text: title }), h('p', { text: blurb })));
  if (!list.length) {
    app.append(
      h('div', { class: 'empty' }, h('strong', { text: state.q ? 'Nothing matches that yet.' : 'Fresh drops are on the way.' }), state.q ? 'Try another word, or check out what is trending.' : 'Our trend scanner is restocking this tab. Meanwhile, see what is trending.'),
    );
    return;
  }
  app.append(h('div', { class: 'grid' }, list.map(card)));
}

function renderTicker() {
  const top = DATA.trending.slice(0, 12).map((id) => byId.get(id)).filter(Boolean);
  const track = $('#ticker');
  if (!top.length) {
    track.parentElement.hidden = true;
    return;
  }
  const items = top.map((p) => h('span', {}, '🔥 ', h('b', { text: p.title }), ` ${money(p.price)}`));
  track.replaceChildren(...items, ...items.map((n) => n.cloneNode(true)));
}

// ---------------------------------------------------------------- product view
function matchVariant(p, sel) {
  return p.variants.find((v) => Object.entries(sel).every(([k, val]) => v.options?.[k] === val)) || null;
}

function lockScroll(on) {
  document.body.style.overflow = on ? 'hidden' : '';
}

function openProduct(id, opts = {}) {
  const p = byId.get(id);
  if (!p) return;
  const modal = $('#modal');
  if (modal.hidden) lastFocus = document.activeElement;
  const start = p.variants.find((v) => v.id === opts.variant) || p.variants[0];
  const sel = { ...(start.options || {}) };
  let qty = 1;
  let img = start.image || p.images[0];

  const url = `/p/${encodeURIComponent(p.id)}`;
  if (location.pathname !== url) history[opts.replace ? 'replaceState' : 'pushState']({ p: p.id }, '', url);
  document.title = `${p.title} | The Hot Dropic`;

  function draw() {
    const v = matchVariant(p, sel);
    const gallery = [...new Set([img, ...p.images])].filter(Boolean).slice(0, 8);
    const ship = p.shipDays || [7, 14];
    const free = DATA.config.freeShippingMin;
    const view = h(
      'div',
      { class: 'pview' },
      h('button', { class: 'back', type: 'button', onclick: closeProduct }, '← Back to shop'),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: closeProduct }, '×'),
      h(
        'div',
        { class: 'pgrid' },
        h(
          'div',
          { class: 'gallery' },
          h('div', { class: 'main' }, h('img', { src: img, alt: p.title, width: 800, height: 800, referrerpolicy: 'no-referrer' })),
          gallery.length > 1
            ? h('div', { class: 'thumbs' }, gallery.map((g) => h('button', { type: 'button', 'aria-label': 'Show photo', 'aria-current': String(g === img), onclick: () => { img = g; draw(); } }, h('img', { src: g, alt: '', referrerpolicy: 'no-referrer' }))))
            : null,
        ),
        h(
          'div',
          { class: 'pinfo' },
          badgeRow(p) ? h('div', { class: 'chips' }, (p.badges || []).map((b) => h('span', { class: `badge ${b}`, text: b === 'hot' ? '🔥 Hot' : b === 'new' ? 'New' : 'Staff pick' }))) : null,
          h('h1', { id: 'ptitle', text: p.title }),
          h('div', { class: 'price', text: v ? money(v.price) : money(p.price) }),
          p.why ? h('p', { class: 'why' }, h('b', { text: 'Why it’s hot: ' }), p.why) : null,
          (p.options || []).map((o) =>
            h(
              'fieldset',
              { class: 'opt' },
              h('legend', {}, `${o.name}: `, h('span', { text: sel[o.name] || '' })),
              h(
                'div',
                { class: 'chips' },
                o.values.map((val) =>
                  h('button', {
                    class: 'chip',
                    type: 'button',
                    'aria-pressed': String(sel[o.name] === val),
                    onclick: () => {
                      sel[o.name] = val;
                      if (!matchVariant(p, sel)) Object.assign(sel, (p.variants.find((x) => x.options?.[o.name] === val) || p.variants[0]).options);
                      const nv = matchVariant(p, sel);
                      if (nv?.image) img = nv.image;
                      draw();
                    },
                  }, val),
                ),
              ),
            ),
          ),
          h(
            'div',
            { class: 'buy' },
            h('div', { class: 'qty' },
              h('button', { type: 'button', 'aria-label': 'Fewer', onclick: () => { qty = Math.max(1, qty - 1); draw(); } }, '−'),
              h('span', { text: String(qty) }),
              h('button', { type: 'button', 'aria-label': 'More', onclick: () => { qty = Math.min(10, qty + 1); draw(); } }, '+')),
            h('button', {
              class: 'btn hot',
              type: 'button',
              disabled: !v,
              onclick: () => {
                cart.add(p.id, v.id, qty);
                toast(`Added ${p.title} to your cart`);
                openCart();
              },
            }, v ? `Add to cart · ${money(v.price * qty)}` : 'Not available'),
          ),
          h('p', { class: 'shipline', text: `Arrives in about ${ship[0]}–${ship[1]} business days. ${free > 0 ? `Free US shipping on ${moneyShort(free)}+.` : 'Free US shipping.'}` }),
          p.description ? h('div', { class: 'desc', text: p.description }) : null,
          p.details?.length ? h('ul', { class: 'details' }, p.details.map((d) => h('li', { text: d }))) : null,
          h('div', { class: 'trust' },
            h('div', {}, h('b', { text: 'Secure checkout' }), 'Powered by Stripe'),
            h('div', {}, h('b', { text: p.printed ? 'Made for you' : 'Tracked shipping' }), p.printed ? 'Printed on demand' : 'Tracking on every order'),
            h('div', {}, h('b', { text: 'Real humans' }), 'Email us any time')),
        ),
      ),
      relatedRow(p),
    );
    modal.replaceChildren(view);
  }
  draw();
  modal.hidden = false;
  modal.scrollTop = 0;
  lockScroll(true);
  $('.pview .x', modal)?.focus({ preventScroll: true });
}

function relatedRow(p) {
  const pool = (p.category === 'meme-tees' ? DATA.products.filter((x) => x.category === 'meme-tees') : DATA.products.filter((x) => x.category === p.category)).filter((x) => x.id !== p.id);
  const picks = (pool.length >= 2 ? pool : DATA.trending.map((id) => byId.get(id)).filter((x) => x && x.id !== p.id)).sort((a, b) => b.score - a.score).slice(0, 4);
  if (!picks.length) return null;
  return h('section', { class: 'related' }, h('div', { class: 'section-head' }, h('h2', { text: 'You might also like' })), h('div', { class: 'grid' }, picks.map(card)));
}

function closeProduct() {
  const modal = $('#modal');
  if (modal.hidden) return;
  modal.hidden = true;
  modal.replaceChildren();
  lockScroll(false);
  document.title = 'The Hot Dropic | What’s hot right now, dropped to your door.';
  if (location.pathname.startsWith('/p/')) history.pushState({}, '', state.tab === 'trending' ? '/' : `/?tab=${state.tab}`);
  lastFocus?.focus?.({ preventScroll: true });
}

// ---------------------------------------------------------------- cart drawer
function cartLines() {
  return cart.items.map((i) => {
    const p = byId.get(i.productId);
    const v = p?.variants.find((x) => x.id === i.variantId);
    return { ...i, p, v };
  });
}

function totals() {
  const lines = cartLines().filter((l) => l.v);
  const subtotal = lines.reduce((s, l) => s + l.v.price * l.qty, 0);
  const c = DATA.config;
  const shipping = subtotal === 0 || subtotal >= c.freeShippingMin ? 0 : c.shippingFee;
  return { lines, subtotal, shipping, total: subtotal + shipping };
}

function renderCart() {
  const n = cart.count();
  const badge = $('#cartcount');
  badge.textContent = String(n);
  badge.hidden = n === 0;
  const list = $('#lines');
  list.replaceChildren();
  const all = cartLines();
  if (!all.length) list.append(h('li', { class: 'emptycart' }, 'Your cart is empty. Go find something hot! 🔥'));
  for (const l of all) {
    if (!l.v) {
      list.append(h('li', { class: 'line gone' }, h('div', {}), h('div', {}, h('div', { class: 't', text: 'No longer available' }), h('button', { class: 'rm', type: 'button', onclick: () => cart.remove(l.productId, l.variantId) }, 'Remove')), h('div', {})));
      continue;
    }
    list.append(
      h('li', { class: 'line' },
        h('img', { src: l.v.image || l.p.images[0], alt: '', width: 64, height: 64, loading: 'lazy', referrerpolicy: 'no-referrer' }),
        h('div', {},
          h('div', { class: 't', text: l.p.title }),
          l.v.label && l.v.label !== 'Standard' ? h('div', { class: 'v', text: l.v.label }) : null,
          h('div', { class: 'q' },
            h('button', { type: 'button', 'aria-label': 'Fewer', onclick: () => cart.set(l.productId, l.variantId, l.qty - 1) }, '−'),
            h('span', { text: String(l.qty) }),
            h('button', { type: 'button', 'aria-label': 'More', onclick: () => cart.set(l.productId, l.variantId, l.qty + 1) }, '+'),
            h('button', { class: 'rm', type: 'button', onclick: () => cart.remove(l.productId, l.variantId) }, 'Remove'))),
        h('div', { class: 'p', text: money(l.v.price * l.qty) })),
    );
  }
  const t = totals();
  const c = DATA.config;
  $('#subtotal').textContent = money(t.subtotal);
  $('#shipping').textContent = t.subtotal === 0 ? '$0.00' : t.shipping ? money(t.shipping) : 'FREE';
  $('#total').textContent = money(t.total);
  const bar = $('#shipbar');
  if (c.freeShippingMin > 0 && t.subtotal > 0 && t.subtotal < c.freeShippingMin) {
    const pct = Math.min(100, Math.round((t.subtotal / c.freeShippingMin) * 100));
    bar.replaceChildren(`You're ${money(c.freeShippingMin - t.subtotal)} away from free US shipping`, h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })));
  } else bar.textContent = t.subtotal > 0 ? '🎉 You’ve unlocked free US shipping' : `Free US shipping on orders ${moneyShort(c.freeShippingMin || 0)}+`;
  const btn = $('#checkout');
  btn.disabled = !t.lines.length || !c.payments || !c.storeOpen;
  btn.textContent = !c.storeOpen ? 'Checkout paused' : !c.payments ? 'Checkout opens soon' : 'Checkout securely';
  $('#cartfoot').hidden = !all.length;
}

function openCart() {
  if (!$('#drawer').classList.contains('open')) lastFocus = document.activeElement;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  lockScroll(true);
  $('#closecart').focus({ preventScroll: true });
}

function closeCart() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  if ($('#modal').hidden) lockScroll(false);
  lastFocus?.focus?.({ preventScroll: true });
}

async function checkout() {
  const btn = $('#checkout');
  const err = $('#carterr');
  err.hidden = true;
  const items = totals().lines.map(({ productId, variantId, qty }) => ({ productId, variantId, qty }));
  if (!items.length) return;
  btn.disabled = true;
  btn.textContent = 'Opening secure checkout...';
  try {
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.url) {
      location.href = j.url;
      return;
    }
    if (r.status === 409 && j.productId) cart.remove(j.productId, j.variantId);
    err.textContent = j.error || 'Checkout could not start. Please try again.';
    err.hidden = false;
  } catch {
    err.textContent = 'Network problem. Please check your connection and try again.';
    err.hidden = false;
  }
  renderCart();
}

// ---------------------------------------------------------------- misc
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function wire() {
  $('#cartbtn').addEventListener('click', openCart);
  $('#closecart').addEventListener('click', closeCart);
  $('#scrim').addEventListener('click', closeCart);
  $('#checkout').addEventListener('click', checkout);
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') closeProduct();
  });
  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = e.target.value.trim().slice(0, 60);
      renderTabs();
      renderGrid();
    }, 150);
  });
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#q').blur();
    $('#app').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#drawer').classList.contains('open')) closeCart();
    else closeProduct();
  });
  window.addEventListener('popstate', () => {
    const m = location.pathname.match(/^\/p\/([^/]+)/);
    if (m) openProduct(decodeURIComponent(m[1]), { replace: true });
    else {
      const modal = $('#modal');
      if (!modal.hidden) {
        modal.hidden = true;
        modal.replaceChildren();
        lockScroll(false);
      }
    }
  });
}

boot();
