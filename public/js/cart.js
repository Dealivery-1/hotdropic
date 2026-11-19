// The cart lives in this browser (localStorage), so it survives reloads. Only ids + quantities are stored;
// names and prices always come fresh from the catalog, and the server re-prices everything at checkout.
const KEY = 'hd_cart_v1';
const MAX_QTY = 10;
const listeners = new Set();

const valid = (i) => i && typeof i.productId === 'string' && typeof i.variantId === 'string' && Number.isInteger(i.qty) && i.qty > 0;

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(valid).slice(0, 30) : [];
  } catch {
    return [];
  }
}

let items = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* private mode: the cart still works until the page closes */
  }
  for (const fn of listeners) fn(items);
}

const same = (i, p, v) => i.productId === p && i.variantId === v;

export const cart = {
  get items() {
    return items;
  },
  add(productId, variantId, qty = 1) {
    const hit = items.find((i) => same(i, productId, variantId));
    if (hit) hit.qty = Math.min(MAX_QTY, hit.qty + qty);
    else items.push({ productId, variantId, qty: Math.min(MAX_QTY, qty) });
    save();
  },
  set(productId, variantId, qty) {
    if (qty <= 0) return cart.remove(productId, variantId);
    const hit = items.find((i) => same(i, productId, variantId));
    if (hit) hit.qty = Math.min(MAX_QTY, qty);
    save();
  },
  remove(productId, variantId) {
    items = items.filter((i) => !same(i, productId, variantId));
    save();
  },
  clear() {
    items = [];
    save();
  },
  count() {
    return items.reduce((s, i) => s + i.qty, 0);
  },
  onChange(fn) {
    listeners.add(fn);
  },
};

window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  items = load();
  for (const fn of listeners) fn(items);
});
