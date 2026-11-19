// Owner dashboard (/admin): the on/off switches, setup checklist, orders, trend scanner, products, promotion
// and settings. Everything goes through /api/admin with the token from signing in.
const $ = (s, el = document) => el.querySelector(s);
const money = (c) => `$${(Math.round(Number(c) || 0) / 100).toFixed(2)}`;
const TOKEN_KEY = 'hd_admin_token';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = Boolean(v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

function ago(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};
const setToken = (t) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
};

let D = null;
let productFilter = 'all';

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

async function api(method, body) {
  const token = getToken();
  const r = await fetch('/api/admin', {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && body?.action !== 'login') {
    setToken('');
    showLogin(j.error);
    throw new Error(j.error || 'Please sign in.');
  }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

async function load() {
  D = await api('GET');
  render();
}

/** Runs an action, shows its result lines in `out` (or a toast), then refreshes the dashboard. */
async function act(body, out, btn) {
  if (btn) btn.disabled = true;
  try {
    const j = await api('POST', body);
    const text = (j.lines || []).join('\n') || 'Done.';
    if (out) {
      out.textContent = text;
      out.hidden = false;
    } else toast(text.split('\n')[0]);
    await load();
    return j;
  } catch (e) {
    if (out) {
      out.textContent = `✖ ${e.message}`;
      out.hidden = false;
    } else toast(e.message);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function showLogin(msg) {
  $('#dash').hidden = true;
  $('#logout').hidden = true;
  $('#login').hidden = false;
  if (msg && msg !== 'Please sign in again.') {
    $('#loginerr').textContent = msg;
    $('#loginerr').hidden = false;
  }
  $('#pw').focus();
}

// ---------------------------------------------------------------- sections
function switches() {
  const s = D.settings;
  const scan = D.scan;
  const card = (key, title, desc, status) =>
    h('div', { class: `sw${s[key] ? ' on' : ''}` },
      h('div', { class: 'head' }, h('h3', { text: title }),
        h('label', { class: 'toggle', title: s[key] ? 'On' : 'Off' },
          h('input', { type: 'checkbox', checked: s[key], 'aria-label': title, onchange: (e) => act({ action: 'settings', patch: { [key]: e.target.checked } }) }),
          h('span'))),
      h('p', { text: desc }),
      status ? h('p', {}, h('b', { text: status })) : null);
  const ch = D.promo.channels.filter((c) => c.ok).map((c) => c.name);
  return h('section', {},
    h('h2', { text: 'Switches' }),
    h('div', { class: 'cards' },
      card('autoTrend', '🔥 Auto-trend scanner', 'Swaps products in and out on its own, based on what is trending. Checks a couple of keywords every 30 minutes.', `Last run ${ago(scan.lastRun)} · ${scan.keywords.length} keywords · ${D.products.filter((p) => p.supplier === 'cj').length} scanner products`),
      card('autoPromo', '📣 Auto-promote', `Posts one promo a day at ${s.promoHour}:00 US Eastern to your connected accounts.`, ch.length ? `Posting to: ${ch.join(', ')}` : 'No accounts connected yet (see Promotion below)'),
      card('autoFulfill', '📦 Auto-fulfill orders', 'Sends paid orders to Printful and CJ automatically. Turn off to approve each order by hand.', null),
      card('storeOpen', '🛒 Store open', 'Turn off to pause checkout (shoppers can still browse).', null)));
}

function sales() {
  const s = D.stats;
  const tile = (k, v, sub) => h('div', { class: 'tile' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), h('div', { class: 's', text: sub }));
  return h('section', {},
    h('h2', {}, 'Sales ', h('span', { class: 'meta muted', text: 'profit = after supplier cost, shipping and card fees (estimate)' })),
    h('div', { class: 'tiles' },
      tile('Today', money(s.d1_revenue), `${s.d1_orders} order${s.d1_orders === 1 ? '' : 's'}`),
      tile('Last 7 days', money(s.d7_revenue), `${s.d7_orders} orders · ~${money(s.d7_profit)} profit`),
      tile('Last 30 days', money(s.d30_revenue), `${s.d30_orders} orders · ~${money(s.d30_profit)} profit`),
      tile('All time', money(s.all_revenue), `${s.all_orders} orders · ~${money(s.all_profit)} profit`)));
}

function setup() {
  const out = h('pre', { class: 'out', hidden: true });
  return h('section', {},
    h('h2', { text: 'Setup checklist' }),
    h('ul', { class: 'check' }, D.setup.map((it) =>
      h('li', { class: it.ok ? 'ok' : '' },
        h('span', { class: 'ic', text: it.ok ? '✓' : '!' }),
        h('div', {}, h('b', { text: it.label }), h('small', { text: it.note })),
        it.action ? h('button', { class: 'btn tiny', type: 'button', onclick: (e) => act({ action: 'setup', op: it.action }, out, e.target) }, it.action === 'stripe-webhook' ? (it.ok ? 'Reconnect' : 'Connect Stripe webhook') : 'Test') : h('span')))),
    out);
}

const STATUS = {
  pending: 'warn', paid: 'warn', fulfilling: 'warn', needs_attention: 'bad', submitted: 'ok', partially_shipped: 'ok', shipped: 'ok', canceled: 'bad', refunded: 'bad', expired: '',
};

function orders() {
  const out = h('pre', { class: 'out', hidden: true });
  const rows = D.orders.map((o) => {
    const btns = [];
    if (['paid', 'needs_attention'].includes(o.status)) btns.push(['Send to suppliers', 'fulfill']);
    if (['submitted', 'partially_shipped', 'needs_attention'].includes(o.status)) btns.push(['Check tracking', 'sync']);
    if (!['shipped', 'canceled', 'refunded'].includes(o.status)) btns.push(['Mark shipped', 'mark_shipped'], ['Cancel', 'cancel']);
    return h('tr', {},
      h('td', {}, h('b', { text: o.id }), h('div', { class: 'muted', text: new Date(o.created).toLocaleString() })),
      h('td', {}, o.items.map((i) => h('div', { text: i })), h('div', { class: 'muted', text: [o.name, o.place].filter(Boolean).join(' · ') })),
      h('td', {}, h('b', { text: money(o.total) }), h('div', { class: 'muted', text: `~${money(o.profit)} profit` })),
      h('td', {}, h('span', { class: `pill ${STATUS[o.status] || ''}`, text: o.status.replace('_', ' ') }), o.suppliers.map((s) => h('div', { class: 'muted', text: s }))),
      h('td', {},
        h('div', { class: 'actions' }, btns.map(([label, op]) => h('button', { class: `btn tiny${op === 'cancel' ? ' danger' : ''}`, type: 'button', onclick: (e) => {
          if (op === 'cancel' && !confirm(`Cancel ${o.id}? Refund it in Stripe and cancel it with the supplier too if needed.`)) return;
          act({ action: 'order', id: o.id, op }, out, e.target);
        } }, label))),
        o.log.length ? h('ul', { class: 'log' }, o.log.map((l) => h('li', { text: `${new Date(l.t).toLocaleString()}: ${l.msg}` }))) : null));
  });
  return h('section', {},
    h('h2', {}, 'Orders ', h('span', { class: 'meta muted', text: 'Refunds happen in your Stripe dashboard. Stripe emails receipts automatically.' })),
    D.orders.length
      ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Order', 'Items', 'Total', 'Status', 'Actions'].map((t) => h('th', { text: t })))), h('tbody', {}, rows)))
      : h('p', { class: 'muted', text: 'No orders yet. Share your store link and turn on Auto-promote!' }),
    out);
}

function scanner() {
  const sc = D.scan;
  const out = h('pre', { class: 'out', hidden: true });
  const force = h('input', { type: 'checkbox', id: 'force' });
  const last = sc.runs[0];
  const catSel = h('select', { id: 'kwcat' }, sc.categories.map((c) => h('option', { value: c, text: c })));
  const q = h('input', { id: 'kwq', placeholder: 'e.g. heated lunch box', maxlength: 60 });
  const why = h('input', { id: 'kwwhy', placeholder: 'Why it is hot (shown to shoppers, optional)', maxlength: 200 });
  return h('section', {},
    h('h2', {}, '🔥 Trend scanner ', h('span', { class: 'meta muted', text: D.settings.autoTrend ? 'Auto mode is ON' : 'Auto mode is OFF (turn it on in Switches)' })),
    h('div', { class: 'inline' },
      h('button', { class: 'btn hot small', type: 'button', onclick: (e) => act({ action: 'scan', force: force.checked }, out, e.target) }, 'Scan now'),
      h('label', { class: 'muted' }, force, ' re-check everything (uses more CJ calls)')),
    last ? h('pre', { class: 'out', text: `Last run ${ago(last.t)}:\n${last.lines.join('\n') || 'nothing to do'}` }) : null,
    out,
    sc.radar?.items?.length
      ? h('div', {}, h('h3', {}, 'Google trending searches (US) ', h('small', { class: 'muted', text: `checked ${ago(sc.radar.at)}. Keywords that match get a boost.` })),
        h('div', { class: 'radar' }, sc.radar.items.slice(0, 20).map((i) => h('span', {}, i.title, i.traffic ? h('small', { text: ` ${i.traffic}` }) : null))))
      : null,
    h('h3', { text: 'Keywords the scanner shops for' }),
    h('p', { class: 'muted', text: 'From catalog/trends.json (the AI trend hunter rewrites it twice a week) plus any you add here.' }),
    h('div', { class: 'inline' },
      h('div', { class: 'field' }, h('label', { for: 'kwq', text: 'New keyword' }), q),
      h('div', { class: 'field' }, h('label', { for: 'kwcat', text: 'Tab' }), catSel),
      h('div', { class: 'field', style: 'flex:1;min-width:220px' }, h('label', { for: 'kwwhy', text: 'Why it is hot' }), why),
      h('button', { class: 'btn small', type: 'button', onclick: (e) => act({ action: 'keyword', op: 'add', q: q.value, cat: catSel.value, why: why.value }, out, e.target) }, 'Add')),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Keyword', 'Tab', 'Heat', 'Last checked', 'Products', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, [...sc.keywords].sort((a, b) => b.score - a.score).map((k) => h('tr', {},
        h('td', {}, h('b', { text: k.q }), k.why ? h('div', { class: 'muted', text: k.why }) : null),
        h('td', { text: k.cat }),
        h('td', { text: String(k.score) }),
        h('td', { text: ago(k.lastScanned) }),
        h('td', { text: String(k.products) }),
        h('td', {}, h('button', { class: 'btn tiny', type: 'button', onclick: (e) => act({ action: 'keyword', op: 'remove', q: k.q }, out, e.target) }, 'Remove'))))))),
    sc.removed.length ? h('p', { class: 'muted' }, 'Removed: ', sc.removed.map((r) => h('button', { class: 'btn tiny', type: 'button', onclick: (e) => act({ action: 'keyword', op: 'restore', q: r }, out, e.target) }, `↺ ${r}`))) : null);
}

function products() {
  const out = h('pre', { class: 'out', hidden: true });
  const cats = [...new Set(D.products.map((p) => p.category))];
  const list = D.products.filter((p) => productFilter === 'all' || p.category === productFilter).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
  const sel = h('select', { onchange: (e) => { productFilter = e.target.value; render(); } }, h('option', { value: 'all', text: `All (${D.products.length})` }), cats.map((c) => h('option', { value: c, selected: c === productFilter, text: `${c} (${D.products.filter((p) => p.category === c).length})` })));
  return h('section', {},
    h('h2', {}, 'Products ', sel),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['', 'Product', 'Price', 'Est. margin', 'Heat', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, list.map((p) => h('tr', {},
        h('td', {}, h('img', { src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })),
        h('td', {}, h('a', { href: `/p/${encodeURIComponent(p.id)}`, target: '_blank', rel: 'noopener', text: p.title }),
          h('div', { class: 'muted', text: [p.category, p.supplier === 'cj' ? `scanner: "${p.keyword}"${p.listed ? `, ${p.listed} stores` : ''}` : 'Printful', p.supplier === 'cj' ? `seen ${ago(p.refreshedAt)}` : ''].filter(Boolean).join(' · ') }),
          p.hidden ? h('span', { class: 'pill bad', text: 'hidden' }) : null, p.pinned ? h('span', { class: 'pill ok', text: 'pinned' }) : null),
        h('td', { text: money(p.price) }),
        h('td', { text: `~${money(p.price - p.cost - Math.round(p.price * 0.029 + 30))}` }),
        h('td', { text: String(p.score) }),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn tiny', type: 'button', onclick: (e) => act({ action: 'product', id: p.id, op: p.pinned ? 'unpin' : 'pin' }, out, e.target) }, p.pinned ? 'Unpin' : 'Pin to top'),
          h('button', { class: 'btn tiny', type: 'button', onclick: (e) => act({ action: 'product', id: p.id, op: p.hidden ? 'show' : 'hide' }, out, e.target) }, p.hidden ? 'Show' : 'Hide'),
          p.supplier === 'cj' ? h('button', { class: 'btn tiny danger', type: 'button', onclick: (e) => act({ action: 'product', id: p.id, op: 'remove' }, out, e.target) }, 'Remove') : null))))))),
    out);
}

function promotion() {
  const pr = D.promo;
  const out = h('pre', { class: 'out', hidden: true });
  const show = async (mode, btn) => {
    const j = await act({ action: 'promo', mode }, out, btn);
    if (j?.post) out.textContent += `\n\n${j.post.text}\n${j.post.link}`;
  };
  return h('section', {},
    h('h2', {}, '📣 Promotion ', h('span', { class: 'meta muted', text: pr.lastDate ? `last posted ${pr.lastDate}` : 'nothing posted yet' })),
    h('p', { class: 'muted' }, 'Connected: ', pr.channels.map((c) => h('span', { class: `pill ${c.ok ? 'ok' : ''}`, text: `${c.ok ? '✔' : '✖'} ${c.name}` }), ' '), ' Add accounts in Cloudflare (SETUP.md step 8).'),
    h('div', { class: 'inline' },
      h('button', { class: 'btn small', type: 'button', onclick: (e) => show('preview', e.target) }, "Preview today's post"),
      h('button', { class: 'btn hot small', type: 'button', onclick: (e) => { if (confirm('Post to every connected account now?')) show('post', e.target); } }, 'Post now')),
    out,
    pr.history.length ? h('div', { class: 'tablewrap', style: 'margin-top:12px' }, h('table', {}, h('tbody', {}, pr.history.map((x) => h('tr', {},
      h('td', { text: x.date }), h('td', { text: x.text }), h('td', {}, x.results.map((r) => h('div', { class: r.ok ? '' : 'muted', text: `${r.ok ? '✔' : '✖'} ${r.channel}${r.error ? `: ${r.error}` : ''}` })))))))) : null,
    h('h3', { text: 'Promo kit for TikTok, Instagram and Pinterest' }),
    h('p', { class: 'muted', text: 'Those apps have no free auto-posting, so here are ready-to-post captions for your top products. Post the photo (or a quick video of it) with the caption, and put your store link in your bio.' }),
    h('div', { class: 'kit' }, pr.kit.map((k) => {
      const ta = h('textarea', { 'aria-label': `Caption for ${k.title}` });
      ta.value = k.caption;
      return h('div', { class: 'item' },
        h('img', { src: k.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
        h('div', {}, h('b', { text: k.title }), ta,
          h('div', { class: 'actions' },
            h('button', { class: 'btn tiny', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(ta.value); toast('Caption copied'); } catch { ta.select(); } } }, 'Copy caption'),
            h('a', { class: 'btn tiny', href: k.pinterest, target: '_blank', rel: 'noopener' }, 'Pin it'),
            h('a', { class: 'btn tiny', href: k.image, target: '_blank', rel: 'noopener' }, 'Photo'),
            h('a', { class: 'btn tiny', href: k.link, target: '_blank', rel: 'noopener' }, 'Product'))));
    })),
    h('p', { class: 'muted' }, 'Free listings: submit ', h('code', { text: `${D.site.url}/feed.xml` }), ' to Google Merchant Center and Pinterest catalogs, and ', h('code', { text: `${D.site.url}/sitemap.xml` }), ' to Google Search Console. They update as the scanner swaps products.'));
}

function settingsForm() {
  const s = D.settings;
  const out = h('pre', { class: 'out', hidden: true });
  const f = {};
  const num = (key, label, hint, dollars = false, step = 1) => {
    f[key] = h('input', { type: 'number', step: dollars ? '0.01' : String(step), value: dollars ? (s[key] / 100).toFixed(2) : String(s[key]) });
    return h('div', { class: 'field' }, h('label', {}, label, ' ', h('small', { text: hint })), f[key]);
  };
  f.cjPayType = h('select', {}, h('option', { value: '3', selected: s.cjPayType === 3, text: 'I click Pay in CJ for each order' }), h('option', { value: '2', selected: s.cjPayType === 2, text: 'Pay automatically from my CJ wallet' }));
  f.usWarehouseFirst = h('input', { type: 'checkbox', checked: s.usWarehouseFirst });
  f.announcement = h('input', { value: s.announcement, maxlength: 140, placeholder: 'Leave empty for the default free-shipping message' });
  const save = (e) => {
    const patch = {
      freeShippingMin: Math.round(Number(f.freeShippingMin.value) * 100),
      shippingFee: Math.round(Number(f.shippingFee.value) * 100),
      maxPrice: Math.round(Number(f.maxPrice.value) * 100),
      minPrice: Math.round(Number(f.minPrice.value) * 100),
      promoHour: Number(f.promoHour.value),
      scanEveryHours: Number(f.scanEveryHours.value),
      perCategory: Number(f.perCategory.value),
      staleDays: Number(f.staleDays.value),
      markup: Number(f.markup.value),
      cjPayType: Number(f.cjPayType.value),
      usWarehouseFirst: f.usWarehouseFirst.checked,
      announcement: f.announcement.value,
    };
    act({ action: 'settings', patch }, out, e.target);
  };
  return h('section', {},
    h('h2', { text: 'Settings' }),
    h('div', { class: 'panel' },
      h('div', { class: 'formgrid' },
        num('freeShippingMin', 'Free shipping from', '($)', true),
        num('shippingFee', 'Shipping fee below that', '($)', true),
        num('promoHour', 'Daily post hour', '(0-23, US Eastern)'),
        num('scanEveryHours', 'Re-check each keyword every', '(hours)'),
        num('perCategory', 'Max scanner products per tab', ''),
        num('staleDays', 'Retire products not trending for', '(days)'),
        num('minPrice', 'Scanner min price', '($)', true),
        num('maxPrice', 'Scanner max price', '($)', true),
        num('markup', 'Scanner price multiplier', '(1.0 = normal, 1.1 = +10%)', false, 0.05),
        h('div', { class: 'field' }, h('label', {}, 'CJ orders ', h('small', { text: '(gadgets)' })), f.cjPayType),
        h('div', { class: 'field' }, h('label', {}, f.usWarehouseFirst, ' Prefer US-warehouse products ', h('small', { text: '(faster shipping)' }))),
        h('div', { class: 'field' }, h('label', { text: 'Announcement bar' }), f.announcement)),
      h('button', { class: 'btn hot small', type: 'button', onclick: save }, 'Save settings'),
      out));
}

function render() {
  const dash = $('#dash');
  const cron = D.cron;
  dash.replaceChildren(
    h('p', { class: 'muted' }, `Store: `, h('a', { href: D.site.url, target: '_blank', rel: 'noopener', text: D.site.url }), ` · Background jobs last ran ${ago(cron?.t)}${cron?.lines?.length ? ` (${cron.lines.slice(0, 3).join('; ')})` : ''}`),
    switches(),
    sales(),
    setup(),
    orders(),
    scanner(),
    products(),
    promotion(),
    settingsForm(),
  );
  dash.hidden = false;
  $('#login').hidden = true;
  $('#logout').hidden = false;
}

$('#loginform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginerr');
  err.hidden = true;
  try {
    const j = await api('POST', { action: 'login', password: $('#pw').value });
    setToken(j.token);
    $('#pw').value = '';
    await load();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#logout').addEventListener('click', () => {
  setToken('');
  showLogin();
});

if (getToken()) load().catch((e) => showLogin(e.message));
else showLogin();
