// Runs every 30 minutes (the "triggers" in wrangler.jsonc). Each run does one small slice of work so it stays
// inside Cloudflare's free limits (50 outbound requests, 50 database queries, ~10 ms CPU per run):
//   - at your promo hour (US Eastern), if Auto-promote is on and today's post hasn't gone out: ONLY the daily post
//   - every other run: orders (retry up to 2 that a supplier hasn't accepted, check tracking on up to 3),
//     then the next 2 trend keywords if Auto-trend is on
//   - always: mark checkouts abandoned more than 2 days ago as expired
// Worst case for an orders+scan run is about 35 outbound requests and 35 queries.
import SITE from '../../site.config.json' with { type: 'json' };
import { db, dueOrders, kvGet, kvSet } from './db.js';
import { fulfillOrder, syncTracking } from './fulfill.js';
import { siteOrigin } from './http.js';
import { easternDate, easternHour, runPromo } from './promo.js';
import { getSettings } from './settings.js';
import { runScan } from './trends.js';

export async function runCron(env, now = new Date()) {
  const t = now.getTime();
  const lines = [];
  const settings = await getSettings(env);
  const origin = siteOrigin(null, env, SITE);
  let promoDue = false;
  if (settings.autoPromo && easternHour(now) === settings.promoHour) {
    const st = await kvGet(env, 'promo:state', null).catch(() => null);
    promoDue = st?.lastDate !== easternDate(now);
  }
  if (promoDue) {
    try {
      const r = await runPromo(env, { origin, settings, now });
      lines.push(r.skipped ? `promo: ${r.reason}` : `promo: ${r.reason || r.results.map((x) => `${x.channel} ${x.ok ? 'ok' : 'failed'}`).join(', ')}`);
    } catch (e) {
      lines.push(`promo: ${e.message}`);
    }
  } else {
    try {
      if (settings.autoFulfill) {
        for (const o of await dueOrders(env, ['paid', 'needs_attention', 'fulfilling'], 2, t)) {
          const r = await fulfillOrder(env, o, { origin, settings });
          lines.push(`order ${o.id}: ${r.skipped ? 'busy elsewhere' : r.status}`);
        }
      }
      for (const o of await dueOrders(env, ['submitted', 'partially_shipped'], 3, t)) {
        const r = await syncTracking(env, o, { origin });
        lines.push(`tracking ${o.id}: ${r.skipped ? 'changed meanwhile' : r.status}`);
      }
    } catch (e) {
      lines.push(`orders: ${e.message}`);
    }
    if (settings.autoTrend) {
      try {
        const r = await runScan(env, { settings, maxKeywords: 2, now: t });
        lines.push(`scan: ${r.ok ? `${r.scanned} keyword(s), ${r.products} products` : r.lines[0]}`);
      } catch (e) {
        lines.push(`scan: ${e.message}`);
      }
    }
  }
  try {
    await (await db(env)).prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND created_at < ?").bind(t - 2 * 86400000).run();
  } catch {
    /* not important */
  }
  await kvSet(env, 'cron:last', { t, lines }).catch(() => {});
  return lines;
}
