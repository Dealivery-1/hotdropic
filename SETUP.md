# Launch The Hot Dropic (about 45 minutes)

By the end you'll have:

- A live store at `https://hotdropic.wolfmaddox07.workers.dev` with 22 original meme tees and hoodies ready to sell
- Tabs for tech, room/LED, beauty, toys, pets, home and cozy finds that fill themselves from CJ Dropshipping
- A **trend scanner** switch that swaps products in and out based on what's trending
- An **auto-promote** switch that posts once a day to your social accounts (like Dealivery)
- Orders that go to the printer/warehouse automatically, with tracking for customers
- An owner dashboard at `/admin`

**Cost to run: $0/month.** You only pay per sale:

| Example | Customer pays | Supplier gets | Stripe fee | You keep (about) |
|---|---|---|---|---|
| 1 fih tee | $26.99 + $4.99 shipping | Printful ~$16.67 (shirt + shipping) | ~$1.23 | **~$14** |
| 2 tees (free shipping) | $53.98 | Printful ~$30.79 | ~$1.87 | **~$21** |
| $19.99 gadget + $4.99 shipping | $24.98 | CJ ~$9–10 | ~$1.02 | **~$14** |

Supplier prices are estimates and change; /admin shows an estimated profit for every order and product.

**How the money moves:** customers pay through Stripe. Stripe sends the money to your bank (first payout 7–14 days after your first sale, then about 2 business days). Printful charges your card and CJ charges your CJ wallet for each order when it's sent to them, so keep a card on file with a little room on it.

Do the steps in order; each one gives you something the next one needs.

---

## Step 1: Put the code on GitHub with GitHub Desktop (5 min)

1. Unzip **hotdropic.zip** and move the `hotdropic` folder into **Documents/GitHub/**.
2. In **GitHub Desktop**: **File** → **Add Local Repository** → choose `Documents/GitHub/hotdropic`. It says the folder isn't a Git repository yet: click **create a repository**, then **Create Repository**.
3. Click **Publish repository**. Name `hotdropic`, keep **Keep this code private** ticked, then **Publish**.
   - Already made an empty `hotdropic` repo on github.com? Then **File** → **Clone repository** → `hotdropic` instead, copy the contents of the unzipped folder into the cloned folder (press Cmd + Shift + . in Finder so hidden files like `.gitignore` come along), then **Commit to main** → **Push origin**.
4. Let Claude publish updates for you: **github.com/apps/claude-github-mcp-connector** → **Configure** → add `hotdropic` → **Save**.
5. Check it worked: the repo on github.com shows folders like `catalog`, `functions`, `public`, `scripts` and `server`.

## Step 2: Put it online with Cloudflare (5 min)

1. In **dash.cloudflare.com** (same account as Dealivery), go to **Workers & Pages** → **Create** → **Import a repository** (Workers). Pick `hotdropic`.
2. Settings: project name `hotdropic`, **Build command** `npm run build`, **Deploy command** `npx wrangler deploy`, root directory `/`.
3. Click **Deploy**. In about a minute the store is live at **`https://hotdropic.wolfmaddox07.workers.dev`**. The database and the 30-minute background job are created automatically.

If the build log mentions D1: in Cloudflare go to **Storage & Databases** → **D1** → **Create**, name it exactly `hotdropic`, then redeploy.

## Step 3: Your admin password (1 min)

1. **Workers & Pages** → `hotdropic` → **Settings** → **Variables and Secrets** → **Add**.
2. Name `ADMIN_PASSWORD`, type **Secret**, value: a password only you know, **12+ characters** (a short sentence works well). Click **Deploy**.
3. Open **`https://hotdropic.wolfmaddox07.workers.dev/admin`** and sign in. The **Setup checklist** there shows what's left.

## Step 4: Payments with Stripe (5 min)

1. In the **Stripe dashboard**, click your account name (top left) → **New account** → name it **The Hot Dropic**. (A separate account keeps the store's money and reports apart from Dealivery.)
2. Stay in **test mode**. **Developers** → **API keys** → copy the **Secret key** (`sk_test_…`).
3. In Cloudflare add `STRIPE_SECRET_KEY` (type **Secret**) → **Deploy**.
4. In **/admin**, click **Connect Stripe webhook**. (This creates the webhook in Stripe for you and saves its secret, so you don't have to.)
5. Test: add a tee to your cart and check out with card **4242 4242 4242 4242**, any future date, any CVC. You'll land on the order page, and the order shows up in /admin.
6. In Stripe: **Settings** → **Customer emails** → turn on **Successful payments** (customers get receipts). **Settings** → **Public details** → statement descriptor `HOTDROPIC`. Keep **Managed Payments turned off** (same as Dealivery).

**Go live** when you're ready: activate the account (your details and bank, like you did for Dealivery; business website = the store URL), switch off test mode, copy the **live** key (`sk_live_…`), replace `STRIPE_SECRET_KEY` in Cloudflare, Deploy, and click **Connect Stripe webhook** again in /admin.

## Step 5: The meme tee printer: Printful (7 min)

1. Make a free account at **printful.com**.
2. **Stores** → **Add store** → **Manual order platform / API**. Name it *The Hot Dropic*.
3. **Billing** → add a card (Printful charges the shirt + shipping when an order comes in).
4. Go to **developers.printful.com** → **Your tokens** → **Create token**. Pick *The Hot Dropic* store and allow the **orders** and **catalog** scopes. Copy the token.
5. In Cloudflare add `PRINTFUL_API_KEY` (Secret) → **Deploy**. In /admin, click **Test** next to Printful.

Optional: in Printful's store settings, add your support email and a short thank-you note to the packing slip.

## Step 6: Gadgets + the trend scanner: CJ Dropshipping (7 min)

1. Make a free account at **cjdropshipping.com**.
2. **My CJ** → **Authorization** → **API** → generate an **API key**. Copy it.
3. In Cloudflare add `CJ_API_KEY` (Secret) → **Deploy**.
4. In /admin: **Test** next to CJ, then **Trend scanner** → **Scan now** a few times. The tech, room, beauty, toys, pets, home and cozy tabs fill up (2 products per keyword).
5. Flip **🔥 Auto-trend scanner** on. From then on it checks 2 keywords every 30 minutes, adds what's hot, and retires what cooled off.
6. Paying CJ: by default each CJ order waits in your CJ dashboard (**My CJ** → **Orders**) for you to click **Pay**, and /admin plus your alerts remind you. Once you trust it, add money to your CJ wallet and switch **Settings** → *CJ orders* to **Pay automatically from my CJ wallet**.

## Step 7: Get pinged for every order (3 min)

Pick any:
- **Discord:** make a private channel → **Edit channel** → **Integrations** → **Webhooks** → **New webhook** → copy URL → Cloudflare `DISCORD_ORDERS_WEBHOOK_URL`.
- **Telegram:** message **@BotFather** to make a bot (`TELEGRAM_BOT_TOKEN`), message your bot once, then get your chat id from **@userinfobot** → `TELEGRAM_OWNER_CHAT_ID`.
- The free **Stripe app** on your phone also notifies you of every payment.

Click **Test** next to *New-order alerts* in /admin.

## Step 8: Turn on auto-promotion (10 min)

Make store accounts (for example @thehotdropic) and add their keys in Cloudflare. Same names as Dealivery, so skip any you don't want:

| Network | Variables | Where to get them |
|---|---|---|
| Bluesky | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | Settings → Privacy and security → App passwords |
| Telegram channel | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | @BotFather; add the bot as a channel admin; chat id like `@thehotdropic` |
| Discord server | `DISCORD_WEBHOOK_URL` | Server channel → Integrations → Webhooks |
| Mastodon | `MASTODON_URL`, `MASTODON_TOKEN` | Preferences → Development → New application (write access) |
| Threads | `THREADS_ACCESS_TOKEN` | Meta developer app with the Threads use case. The store refreshes and saves the key itself |
| X (paid, ~$0.20/post) | `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | console.x.com, app set to Read and write |

Then in /admin: **Promotion** → **Preview today's post** → **Post now**, and flip **📣 Auto-promote** on. It posts daily at 1 PM Eastern (change it in Settings), using the AI trend hunter's queued posts or writing its own, and never repeats a product within 14 days.

**TikTok, Instagram, Pinterest** have no free auto-posting, so /admin has a **promo kit**: photo + caption + Pin-it button for your top products. A 10-second video of a trending product with that caption is the single best free promotion for this kind of store. Put the store link in your bio.

**Free shopping listings (do this once, it keeps itself updated):**
- **Google Merchant Center** (merchants.google.com) → add your site → **Products** → **Add products from a file** → *Scheduled fetch* → `https://hotdropic.wolfmaddox07.workers.dev/feed.xml`. Set shipping there to free over $35, otherwise $4.99, 5–15 business days. Your products can then show up free on Google Shopping.
- **Google Search Console** → add the site → submit `https://hotdropic.wolfmaddox07.workers.dev/sitemap.xml`. Put the verification code in `site.config.json` → `verification.google`.
- **Pinterest business account** → **Catalogs** → data source = the same `/feed.xml`.

## Step 9 (optional): Custom domain and shipping emails

- **Domain** (about $10/year, e.g. thehotdropic.com): Worker → **Settings** → **Domains & Routes** → **Add**. Then change `url` in `site.config.json`, set `SITE_URL` in Cloudflare, and click **Connect Stripe webhook** again.
- **Shipping emails** to customers need a domain: make a free **resend.com** account, verify the domain, then add `RESEND_API_KEY` and `FROM_EMAIL` (like `orders@thehotdropic.com`). Add `OWNER_EMAIL` to also get order alerts by email. Without this, customers still get Stripe receipts and can track at `/order`.

## Before you tell everyone (please read)

This isn't legal or tax advice. Talk to a pro as you grow.
- **The name.** "The Hot Dropic" is a play on Hot Topic, a well-known trademark in the same business (apparel and pop-culture merch). They could object to it. The name is in `site.config.json`, the logo and a few pages, so ask Claude to rebrand if you ever need to.
- **Designs.** Every shirt is original art. Don't add characters, logos, celebrities, or copies of other sellers' shirts. That's the fastest way to lose your Stripe or Printful account.
- **Sales tax.** As a seller based in Missouri, you'll likely need to register with the Missouri Department of Revenue and collect sales tax on Missouri orders. Stripe Tax can calculate it automatically (0.5% per sale): turn it on in Stripe and add the Cloudflare variable `STRIPE_AUTOMATIC_TAX` = `true`.
- **Shipping promises.** The store shows delivery estimates. If an order will be late, email the customer and offer a refund (the FTC requires this). /admin flags orders a supplier hasn't shipped.
- **Kids' products.** Toys for kids under 12 need safety testing in the US. The scanner avoids baby/toddler items; stick to fidgets and desk toys for teens and adults.
- **Policies.** Your Terms, Privacy and Shipping & returns pages are filled in with your name, Missouri and your support email. Read them once.

## Your AI agent

- **Edits:** ask Claude anything, like *"add a 6 7 hoodie in navy"*, *"make shirts $24.99"*, *"add a Gaming tab"*. Claude follows `CLAUDE.md`, runs the tests and commits; Cloudflare publishes in about a minute.
- **AI trend hunter (Mondays and Thursdays, 6:40 PM):** a scheduled Claude task researches what's newly viral on TikTok Shop and in memes, updates the scanner's keywords, writes the next week of promo posts, checks its work and commits to GitHub. It also suggests new original shirt ideas in `catalog/design-ideas.json`; you approve them by saying *"make the new Hot Dropic designs"* in a chat with your `hotdropic` GitHub Desktop folder connected, then click **Push origin**. Claude must be open on your Mac when it runs.

---

## Reference

**Cloudflare variables** (Workers & Pages → hotdropic → Settings → Variables and Secrets; use **Secret** for keys)

| Variable | Needed | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Password for /admin (12+ characters) |
| `STRIPE_SECRET_KEY` | yes | Payments (`sk_test_…` or `sk_live_…`) |
| `PRINTFUL_API_KEY` | for apparel | Sends apparel orders to Printful |
| `CJ_API_KEY` | for gadgets + scanner | Trend scanner imports and CJ orders |
| `SITE_URL` | recommended | Your public address (no trailing slash) |
| `STRIPE_WEBHOOK_SECRET` | no | Only if you make the webhook by hand (the admin button does it) |
| `PRINTFUL_STORE_ID` | no | Only for an account-level Printful token |
| `PRINTFUL_TEE_PRODUCT_ID`, `PRINTFUL_HOODIE_PRODUCT_ID` | no | Use a different Printful blank |
| `DISCORD_ORDERS_WEBHOOK_URL`, `TELEGRAM_OWNER_CHAT_ID` | no | Order alerts |
| `RESEND_API_KEY`, `FROM_EMAIL`, `OWNER_EMAIL` | no | Shipping emails / email alerts |
| `STRIPE_AUTOMATIC_TAX` | no | `true` to have Stripe Tax add sales tax |
| social keys (step 8) | no | Auto-promotion |

**Abuse protection (optional, free):** in Cloudflare, go to **Security** → **WAF** → **Rate limiting rules** and limit `/api/checkout` and `/api/admin` to about 20 requests per minute per IP. The store also has its own basic limits.

**Free-tier limits:** Cloudflare Workers free = 100,000 requests/day and 5 GB of D1. CJ's free API = about 1,000 calls/day (the scanner uses roughly 400). If you ever outgrow Cloudflare free, the paid plan is $5/month.

**Troubleshooting**

| You see | Fix |
|---|---|
| Banner "Checkout opens very soon" | `STRIPE_SECRET_KEY` missing, or the database isn't connected. Check the /admin checklist. |
| Order stuck on "Confirming payment" | Click **Connect Stripe webhook** in /admin (again after switching test/live). |
| Order says *needs attention* | Read its log in /admin. Usually a missing card in Printful, an empty CJ wallet with auto-pay on, or a bad address. Fix it, then **Send to suppliers**. |
| Tech/room/... tabs missing | They appear once they have products: add `CJ_API_KEY`, then **Scan now**. |
| Scanner says "rate limit" | CJ's free limit. It continues on its own later. |
| A product you don't like | /admin → Products → **Hide** or **Remove** (removed items never come back). Add the word to `catalog/blocklist.json` to block similar ones. |
| A social network fails | /admin → Promotion shows each network's error. |
| Build failed on Cloudflare | Open the build log; it names the exact problem. The live site keeps the last good version. Ask Claude to fix it. |
