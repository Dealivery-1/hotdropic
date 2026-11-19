// Cloudflare Workers entry point. Files in public/ are served directly; everything else lands here:
//   /api/*        the handlers in functions/api/ (same format as Dealivery's)
//   /p/<id>       product pages (server/lib/pages.js)
//   /sitemap.xml, /feed.xml
// The scheduled() handler is the 30-minute cron: trend scanner, daily promo, order follow-up (server/lib/cron.js).
import * as admin from '../functions/api/admin.js';
import * as catalog from '../functions/api/catalog.js';
import * as checkout from '../functions/api/checkout.js';
import * as order from '../functions/api/order.js';
import * as stripeWebhook from '../functions/api/stripe-webhook.js';
import { runCron } from './lib/cron.js';
import { errorResponse } from './lib/http.js';
import { productFeed, productPage, sitemap } from './lib/pages.js';

const ROUTES = {
  '/api/catalog': catalog,
  '/api/checkout': checkout,
  '/api/stripe-webhook': stripeWebhook,
  '/api/order': order,
  '/api/admin': admin,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const path = pathname.replace(/\/+$/, '') || '/';
    const route = ROUTES[path];
    if (route) {
      const method = request.method.toUpperCase();
      const handler = route[`onRequest${method.charAt(0)}${method.slice(1).toLowerCase()}`] || route.onRequest;
      if (!handler) {
        const allowed = Object.keys(route).filter((k) => k.startsWith('onRequest') && k.length > 9).map((k) => k.slice(9).toUpperCase());
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'content-type': 'application/json; charset=utf-8', allow: allowed.join(', ') } });
      }
      return handler({ request, env, params: {}, data: {}, waitUntil: (p) => ctx.waitUntil(p), next: () => env.ASSETS.fetch(request) });
    }
    try {
      if (path.startsWith('/p/') && request.method === 'GET') return await productPage(request, env, path.slice(3));
      if (path === '/sitemap.xml') return await sitemap(request, env);
      if (path === '/feed.xml') return await productFeed(request, env);
    } catch (e) {
      console.error('Page error', path, e?.stack || e);
      return errorResponse(500, 'Something went wrong. Please refresh.');
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime || Date.now())).catch((e) => console.error('cron failed', e?.stack || e)));
  },
};
