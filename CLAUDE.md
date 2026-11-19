# CLAUDE.md: how to work on The Hot Dropic

Instructions for any AI agent (or developer) editing this project. Read this before changing anything.

## What this is
The Hot Dropic is a trend-driven dropshipping store ("Hot Topic, but for whatever is viral right now"). Owner: Maddox Wolf.
- **Meme apparel** (tab `meme-tees`): original designs in `catalog/designs.json`, printed on demand by **Printful** when someone orders. Nothing is stocked.
- **Everything else** (tech, room/LED, beauty tools, toys, pets, home, cozy): imported automatically from **CJ Dropshipping** by the **trend scanner**, which searches CJ for the keywords in `catalog/trends.json` and keeps the products the most other stores are selling.
- **Checkout**: Stripe Checkout (cards, Apple Pay, Google Pay). A signed webhook marks the order paid, then it's sent to Printful/CJ automatically.
- **Auto-promote**: one post a day to Bluesky, Mastodon, Threads, Telegram, Discord and X (same secret names as Dealivery), plus a promo kit for TikTok/Instagram/Pinterest and a Google Shopping feed.
- **Owner dashboard**: `/admin` (password = `ADMIN_PASSWORD` secret). Switches for Auto-trend, Auto-promote, Auto-fulfill, Store open. Orders, products, keywords, settings.

Hosting: **Cloudflare Workers** with static assets (free plan), live at https://hotdropic.wolfmaddox07.workers.dev. `wrangler.jsonc` serves `public/`, runs `server/worker.js`, binds the D1 database `hotdropic` (created automatically on deploy) and a cron every 30 minutes. Every push to `main` redeploys in about a minute; `scripts/build.mjs` runs first and stops the deploy if the catalog is broken (the last good version stays live).
No frameworks, no bundler, no npm dependencies. Vanilla ES modules.

## Where things live
- GitHub repo `Dealivery-1/hotdropic` (private), branch `main`, project at the repo root.
- The GitHub connector ("Claude Github MCP Connector" app) can commit to `main`. It **cannot create repos or edit `.github/workflows/*`** (403). There are no workflows here; the cron runs inside the Worker.
- Maddox's local copy (GitHub Desktop): `~/Documents/GitHub/hotdropic`. Images and bigger changes go through that folder: connect it to the session, edit/render there, `git -c user.name="Dealivery-1" -c user.email="wolfmaddox07@gmail.com" commit`, then Maddox clicks **Push origin**. Pull first if the bots have committed since (`git fetch` + `git merge --ff-only origin/main`, or **Fetch origin** then **Pull origin**).
- The connector commits text only (and every character goes through the model), so use it for small text files (JSON, code), never for images. `assets/b64/<path>.b64` holds base64 copies of the images; `scripts/build.mjs` uses them only when the real image is missing.
- The **AI trend hunter** (Claude scheduled task, Mon + Thu) commits `catalog/trends.json`, `marketing/queue.json` and new shirt ideas to `catalog/design-ideas.json` (text only). Ideas become real products only after Maddox says so (see Common tasks).

## File map
```
catalog/
  categories.json   the tabs (order, label, icon). 'auto' tabs fill themselves (trending, under:2500)
  designs.json      meme apparel: styles (tee/hoodie: Printful model, sizes, prices in cents) + designs (art recipe + palette)
  trends.json       keywords the scanner shops for {q, cat, score 1-100, why, src}. AI hunter rewrites it
  design-ideas.json new shirt ideas from the AI hunter, waiting for Maddox's OK
  blocklist.json    brands (knockoff risk) + banned/regulated words. The scanner never imports these
marketing/queue.json  dated posts for the daily auto-poster {date, product?, text}
site.config.json    name, URL, support email, owner name/state (used by build, legal pages, feeds)
server/worker.js    entry: /api/* routes, /p/<id> product pages, /sitemap.xml, /feed.xml, scheduled() cron
server/lib/
  catalog.js        builds the catalog (apparel + D1 "catalog:trending"), publicProduct() strips costs/supplier ids
  trends.js         THE TREND SCANNER (Google trending radar + CJ search, import, refresh, retire)
  promo.js          THE AUTO-PROMOTER (queue or generated post, rotation, promo kit)
  social.js         posting to each network (Workers port of Dealivery's poster)
  fulfill.js        order lifecycle: markPaid -> fulfillOrder -> syncTracking; publicOrder()
  printful.js       Printful API v1 (catalog variant lookup, on-the-fly orders with our print file URL)
  cj.js             CJ API v2 (token cache, listV2 search, product detail, freight quote, createOrderV2, status)
  stripe.js         Stripe REST + webhook signature check (API version pinned to 2024-06-20)
  cron.js           what runs every 30 min (orders, promo at promoHour, scanner otherwise, cleanup)
  pricing.js        retail price rule for scanner products
  safety.js         blocklist check, title/description cleanup
  settings.js       owner settings (defaults + limits), stored in D1
  db.js             D1 helpers (kv table + orders table, created on first use)
  auth.js           admin password login + signed 7-day token, lockout after 8 bad tries
  notify.js         owner alerts (Discord/Telegram/email) + optional customer shipping emails (Resend)
  pages.js          SSR product pages (meta + JSON-LD), sitemap, Google Merchant feed
functions/api/      catalog.js, checkout.js, stripe-webhook.js, order.js, admin.js (one file per endpoint)
public/             index.html (store; keep the <!--meta:start-->, <!--meta:end--> and <!--ssr--> markers),
                    js/store.js, js/cart.js, js/order.js, js/admin.js, css/, admin.html, order.html,
                    shipping.html, terms.html, privacy.html, 404.html, designs/ (print files), img/products/ (mockups)
scripts/
  build.mjs         validate catalog, restore images from assets/b64, stamp site URL, robots.txt
  test.mjs          tests (all APIs mocked; node:sqlite stands in for D1)
  make-designs.py   draws print files + mockups from designs.json (Pillow + cairosvg + fonttools)
```

## Commands
```bash
npm test                                   # must pass before every commit
npm run build                              # validate + restore images + stamp URL
python3 scripts/make-designs.py <id> --sheet   # draw one design (+ /tmp/designs-sheet.png to look at)
python3 scripts/make-designs.py --brand    # logo, icons, og.png
npx wrangler dev                           # local server (needs .dev.vars, see .dev.vars.example)
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"   # run the cron once locally
```

## Rules (important)
1. **Original art only.** No copyrighted characters, logos, brand names, real people's names/faces/quotes, song lyrics, or another seller's shirt design. Memes = original drawings + the meme's words. No tragedies, politics, slurs, sexual content, or anything aimed at kids under 13. The build rejects designs containing blocklist words.
2. **Never invent trends, numbers or claims.** Every keyword in `trends.json` needs a real `src` URL. `why` is shown to shoppers as "Why it's hot", so it must be true and modest. No fake reviews, fake "was" prices, fake scarcity or countdowns.
3. **No knockoffs or regulated items.** Don't add brand names to keywords. Keep `blocklist.json`; add to it when a bad product slips through. Avoid baby/kids products, cosmetics that go on skin, supplements, weapons, vapes.
4. **Prices are in cents.** Apparel prices live in `designs.json` styles; scanner prices come from `server/lib/pricing.js` (+ the admin markup setting). The browser never decides a price; checkout re-prices from the catalog.
5. **Never commit secrets** (`sk_live_`, `sk_test_`, tokens, API keys). They go in Cloudflare variables. `.dev.vars` is gitignored.
6. Keep the "not affiliated with Hot Topic, TikTok..." line in the footers and Terms.
7. Mobile first. Check about 375px wide. Product text from suppliers is untrusted: insert it with textContent / escapeHtml only.
8. Stay inside the free plan: Cloudflare allows 50 outbound requests and 50 D1 queries per cron run. A promo run does only the promo; other runs do at most 2 fulfillments + 3 tracking checks + 2 scan keywords (about 35 of each). Don't raise those numbers in cron.js, and keep `perCategory` at 24 or less.
9. Order status changes go through `transitionOrder` / `updateOrderIf` (atomic). Never write an order's status with a plain update in code that can run twice (webhook retries, cron, admin button).
10. After changes: `npm test && npm run build`, then commit the source (and, for new images, the files in `public/` plus their `assets/b64/` copies).

## Common tasks
- **Add a meme design** (or publish ideas from `catalog/design-ideas.json`): work in the local GitHub Desktop folder. Add the entry to `catalog/designs.json` (copy one; `art.recipe` is stack | call | badge | sign | seesaw; icons: fish, fish-santa, heart, pterodactyl, robot, sparkles, stars, lock, brain; fonts: black, heavy, bold, narrow, retro, mono, gothic). Run `python3 scripts/make-designs.py <id> --sheet`, look at `/tmp/designs-sheet.png` and both print files in `public/designs/`, fix anything cut off or cramped, remove the idea from design-ideas.json, run `npm test && npm run build`, commit everything (designs.json, `public/designs/*`, `public/img/products/*`, `assets/b64/**`), and have Maddox click Push origin.
- **Add/remove trend keywords:** edit `catalog/trends.json` (or use /admin > Trend scanner). `cat` must be a non-auto tab other than meme-tees.
- **Change apparel prices:** `designs.json` > styles > price (cents). Printful's cost is in `estCost` (profit estimates only).
- **Change scanner pricing:** `server/lib/pricing.js`, or the admin "price multiplier" setting.
- **Add a tab:** `catalog/categories.json` + keywords with that `cat` in trends.json (+ a hashtag set in `promo.js` TAGS and a Google category in `pages.js`).
- **Rename / new URL:** `site.config.json` (`url` drives canonical tags, robots, feeds), the `SITE_URL` variable in Cloudflare, then click "Connect Stripe webhook" again in /admin.
- **Something failed for an order:** /admin > Orders shows each supplier's reply in the log. "Send to suppliers" retries safely (never double-orders: Printful by external_id, CJ by orderNumber).

## How the money flow works (don't break it)
`POST /api/checkout` saves a `pending` order (items with supplier ids + cost snapshot) and creates a Checkout Session (`metadata.order_id`; the session id is stored on the order). Stripe calls `/api/stripe-webhook` (signature checked against `STRIPE_WEBHOOK_SECRET` or the secret saved by the admin "Connect Stripe webhook" button). On `checkout.session.completed` (paid) the worker finds the order **by session id** (it must match the one saved at checkout), re-reads the session from Stripe, refuses it if the currency, subtotal or test/live mode don't match, holds it for review if it was paid less than its cost, then saves address/email, alerts the owner, and (if Auto-fulfill) sends Printful items to Printful (`/orders` with `variant_id` + `files[].url` of our print file, then `/confirm`) and CJ items to CJ (`createOrderV2`, payType 3 = owner pays in CJ, 2 = wallet). The cron retries failures (30 min, 2 h, 6 h) and pulls tracking every 3 hours until shipped.
