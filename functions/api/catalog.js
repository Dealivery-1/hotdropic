// GET /api/catalog: everything the store page needs in one request (tabs, products, shipping rules, store status).
import SITE from '../../site.config.json' with { type: 'json' };
import { CATEGORIES, loadCatalog, publicProduct, trendingIds } from '../../server/lib/catalog.js';
import { handle, json } from '../../server/lib/http.js';
import { DEFAULT_SETTINGS, getSettings } from '../../server/lib/settings.js';

export const onRequestGet = handle(async ({ env }) => {
  let settings = DEFAULT_SETTINGS;
  let dbOk = true;
  try {
    settings = await getSettings(env);
  } catch {
    dbOk = false;
  }
  const { products } = await loadCatalog(env);
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  const now = Date.now();
  return json(
    {
      config: {
        siteName: SITE.name,
        storeOpen: settings.storeOpen,
        payments: Boolean(key) && dbOk,
        testMode: /^(sk|rk)_test_/.test(key),
        freeShippingMin: settings.freeShippingMin,
        shippingFee: settings.shippingFee,
        announcement: settings.announcement,
        supportEmail: SITE.supportEmail,
      },
      categories: CATEGORIES,
      trending: trendingIds(products, 24),
      products: products.map((p) => publicProduct(p, now)),
    },
    200,
    { 'cache-control': 'public, max-age=30' },
  );
});
