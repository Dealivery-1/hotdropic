// Owner settings, changed from the admin page (/admin) and stored in D1. Money is in cents.
import { kvGet, kvSet } from './db.js';

export const DEFAULT_SETTINGS = {
  storeOpen: true, // false = browsing only, checkout shows "back soon"
  autoTrend: false, // the trend scanner swaps products in and out on its own
  autoPromo: false, // posts one promo a day to your connected social accounts
  autoFulfill: true, // paid orders go to Printful / CJ automatically
  freeShippingMin: 3500, // free US shipping at or above this subtotal
  shippingFee: 499, // flat shipping below that
  promoHour: 13, // hour (US Eastern, 0-23) for the daily post
  scanEveryHours: 6, // how often each trend keyword is re-checked
  perCategory: 12, // max scanner products per tab
  staleDays: 10, // scanner products not seen again for this long are retired
  maxPrice: 6000, // the scanner skips products that would sell above this
  minPrice: 999, // ... or below this
  markup: 1.0, // 1.10 = everything from the scanner priced 10% higher
  cjPayType: 3, // 3 = CJ orders wait for you to click Pay in CJ; 2 = paid automatically from your CJ wallet
  usWarehouseFirst: true, // prefer CJ products stocked in US warehouses (faster shipping)
  announcement: '', // optional text for the bar at the top of the store
};

const LIMITS = {
  freeShippingMin: [0, 100000],
  shippingFee: [0, 5000],
  promoHour: [0, 23],
  scanEveryHours: [1, 72],
  perCategory: [1, 24],
  staleDays: [1, 90],
  maxPrice: [500, 50000],
  minPrice: [100, 20000],
  markup: [0.5, 3],
};

export function sanitizeSettings(input = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (typeof def === 'boolean') out[k] = v === true || v === 'true' || v === 1;
    else if (k === 'cjPayType') out[k] = Number(v) === 2 ? 2 : 3;
    else if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
      out[k] = Math.min(hi, Math.max(lo, k === 'markup' ? Math.round(n * 100) / 100 : Math.round(n)));
    } else if (typeof def === 'string') out[k] = String(v).replace(/[<>]/g, '').slice(0, 140).trim();
  }
  return out;
}

export async function getSettings(env) {
  const saved = (await kvGet(env, 'settings', {})) || {};
  return { ...DEFAULT_SETTINGS, ...sanitizeSettings(saved) };
}

export async function saveSettings(env, patch) {
  const next = { ...(await getSettings(env)), ...sanitizeSettings(patch) };
  await kvSet(env, 'settings', next);
  return next;
}

/** Shipping charged for a cart subtotal (cents). */
export const shippingFor = (subtotal, s) => (subtotal >= s.freeShippingMin ? 0 : s.shippingFee);
