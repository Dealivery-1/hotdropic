// Pages the Worker builds on the fly:
//   /p/<product-id>  product page: the store page plus that product's title, photo and price in the tags, so links
//                    shared on social media show a proper preview and Google can list it
//   /sitemap.xml     every page and product, for Google Search Console
//   /feed.xml        product feed for Google Merchant Center free listings (and Pinterest / Meta catalogs)
import SITE from '../../site.config.json' with { type: 'json' };
import { absUrl, CATEGORIES, loadCatalog, publicProduct } from './catalog.js';
import { escapeHtml, money, safeJson, SECURITY_HEADERS, siteOrigin } from './http.js';

const xml = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** Short stable hash, so long product ids still give every variant its own feed id. */
function shortHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
const feedId = (pid, vid) => {
  const id = `${pid}--${vid}`;
  return id.length <= 50 ? id : `${pid.slice(0, 40)}-${shortHash(id)}`;
};
const htmlHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  ...SECURITY_HEADERS,
};

async function asset(env, request, path) {
  return env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: { accept: 'text/html' } }));
}

export async function productPage(request, env, rawId) {
  let id = '';
  try {
    id = decodeURIComponent(rawId).replace(/\/+$/, '');
  } catch {
    id = '';
  }
  const { products } = await loadCatalog(env);
  const p = products.find((x) => x.id === id);
  if (!p) {
    const nf = await asset(env, request, '/404');
    return new Response(await nf.text(), { status: 404, headers: htmlHeaders });
  }
  let html = await (await asset(env, request, '/')).text();
  const origin = siteOrigin(request, env, SITE);
  const url = `${origin}/p/${p.id}`;
  const img = absUrl(origin, p.images[0]);
  const desc = String(p.description || '').replace(/\s+/g, ' ').slice(0, 155);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.title,
    image: p.images.slice(0, 4).map((i) => absUrl(origin, i)),
    description: String(p.description || '').slice(0, 500),
    sku: p.id,
    brand: { '@type': 'Brand', name: SITE.name },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'USD',
      price: (p.price / 100).toFixed(2),
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
    },
  };
  const meta = [
    `<title>${escapeHtml(`${p.title} | ${SITE.name}`)}</title>`,
    `<meta name="description" content="${escapeHtml(desc)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    '<meta property="og:type" content="product">',
    `<meta property="og:site_name" content="${escapeHtml(SITE.name)}">`,
    `<meta property="og:title" content="${escapeHtml(`${p.title} - ${money(p.price)}`)}">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(img)}">`,
    `<meta property="product:price:amount" content="${(p.price / 100).toFixed(2)}">`,
    '<meta property="product:price:currency" content="USD">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<script type="application/ld+json">${safeJson(ld)}</script>`,
  ].join('\n');
  // function replacers: product text can contain $& or $' and must never be treated as a pattern
  html = html.replace(/<!--meta:start-->[\s\S]*?<!--meta:end-->/, () => `<!--meta:start-->\n${meta}\n<!--meta:end-->`);
  const ssr =
    `<script type="application/json" id="ssr-product">${safeJson(publicProduct(p))}</script>` +
    `<noscript><article class="ssr"><h1>${escapeHtml(p.title)}</h1><p>${money(p.price)}</p>` +
    `<img src="${escapeHtml(p.images[0])}" alt="${escapeHtml(p.title)}" width="400" height="400"><p>${escapeHtml(p.description)}</p></article></noscript>`;
  html = html.replace('<!--ssr-->', () => ssr);
  return new Response(html, { headers: htmlHeaders });
}

export async function sitemap(request, env) {
  const origin = siteOrigin(request, env, SITE);
  const { products } = await loadCatalog(env);
  const urls = [
    `${origin}/`,
    ...CATEGORIES.map((c) => `${origin}/?tab=${c.id}`),
    ...products.map((p) => `${origin}/p/${p.id}`),
    `${origin}/shipping`,
    `${origin}/order`,
    `${origin}/terms`,
    `${origin}/privacy`,
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${xml(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

const GOOGLE_CATEGORY = {
  'meme-tees': 'Apparel & Accessories > Clothing > Shirts & Tops',
  tech: 'Electronics',
  room: 'Home & Garden > Lighting',
  beauty: 'Health & Beauty > Personal Care',
  toys: 'Toys & Games',
  pets: 'Animals & Pet Supplies > Pet Supplies',
  home: 'Home & Garden > Kitchen & Dining',
  cozy: 'Home & Garden',
};

export async function productFeed(request, env) {
  const origin = siteOrigin(request, env, SITE);
  const { products } = await loadCatalog(env);
  const items = [];
  for (const p of products) {
    const pub = publicProduct(p);
    for (const v of pub.variants) {
      const apparel = p.category === 'meme-tees';
      const parts = [
        `<g:id>${xml(feedId(p.id, v.id))}</g:id>`,
        pub.variants.length > 1 ? `<g:item_group_id>${xml(p.id)}</g:item_group_id>` : '',
        `<title>${xml(`${p.title}${v.label && v.label !== 'Standard' ? ` - ${v.label}` : ''}`.slice(0, 150))}</title>`,
        `<description>${xml(String(p.description || p.title).slice(0, 4900))}</description>`,
        `<link>${xml(`${origin}/p/${p.id}?variant=${encodeURIComponent(v.id)}`)}</link>`,
        `<g:image_link>${xml(absUrl(origin, v.image || p.images[0]))}</g:image_link>`,
        ...p.images.slice(1, 6).map((i) => `<g:additional_image_link>${xml(absUrl(origin, i))}</g:additional_image_link>`),
        '<g:availability>in_stock</g:availability>',
        `<g:price>${(v.price / 100).toFixed(2)} USD</g:price>`,
        '<g:condition>new</g:condition>',
        `<g:brand>${xml(SITE.name)}</g:brand>`,
        '<g:identifier_exists>no</g:identifier_exists>',
        `<g:google_product_category>${xml(GOOGLE_CATEGORY[p.category] || 'Home & Garden')}</g:google_product_category>`,
        apparel ? `<g:color>${xml(v.options.Color || '')}</g:color><g:size>${xml(v.options.Size || '')}</g:size><g:gender>unisex</g:gender><g:age_group>adult</g:age_group>` : '',
      ].filter(Boolean);
      items.push(`<item>${parts.join('')}</item>`);
    }
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${xml(SITE.name)}</title><link>${xml(origin)}</link><description>${xml(SITE.tagline)}</description>\n${items.join('\n')}\n</channel></rss>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=1800' } });
}
