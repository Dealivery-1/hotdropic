// Build step (runs automatically before every deploy, and with `npm run build`):
//   1. checks the catalog files (a broken file stops the deploy, so the last good version stays live)
//   2. turns assets/b64/**/*.b64 into real images under public/ when the image itself is missing
//      (lets a text-only tool like the GitHub connector add an image in a pinch)
//   3. stamps the site address from site.config.json into the home page tags and robots.txt
// Zero dependencies. Usage: node scripts/build.mjs [--check]   (--check = validate only, write nothing)
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const errors = [];
const warnings = [];
const read = async (p) => JSON.parse(await readFile(join(ROOT, p), 'utf8'));

async function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 1. images from assets/b64
const b64Root = join(ROOT, 'assets', 'b64');
let written = 0;
for (const file of await walk(b64Root)) {
  if (!file.endsWith('.b64')) continue;
  const rel = relative(b64Root, file).slice(0, -4);
  if (!rel.startsWith('public/') && !rel.startsWith(`public\\`)) {
    errors.push(`assets/b64/${rel}.b64: must be under assets/b64/public/`);
    continue;
  }
  const data = Buffer.from((await readFile(file, 'utf8')).replace(/\s+/g, ''), 'base64');
  if (!data.length) {
    errors.push(`assets/b64/${rel}.b64 is empty or not base64`);
    continue;
  }
  const target = join(ROOT, rel);
  // Only fills in images that are missing: a real file committed with GitHub Desktop always wins.
  if (!existsSync(target) && !CHECK_ONLY) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    written += 1;
  }
}

// ---------------------------------------------------------------- 2. catalog checks
const site = await read('site.config.json');
const { categories } = await read('catalog/categories.json');
const designs = await read('catalog/designs.json');
const trends = await read('catalog/trends.json');
const block = await read('catalog/blocklist.json');
const queue = await read('marketing/queue.json');
if (existsSync(join(ROOT, 'catalog', 'design-ideas.json'))) {
  const ideas = await read('catalog/design-ideas.json');
  if (!Array.isArray(ideas.ideas)) errors.push('design-ideas.json: needs an "ideas" list');
}

if (!/^https:\/\/[^/\s]+$/.test(site.url || '')) errors.push('site.config.json: url must look like https://example.com (no trailing slash)');
const catIds = new Set();
for (const c of categories) {
  if (!/^[a-z0-9-]+$/.test(c.id || '')) errors.push(`categories.json: bad id "${c.id}"`);
  if (catIds.has(c.id)) errors.push(`categories.json: duplicate id "${c.id}"`);
  catIds.add(c.id);
  if (!c.label) errors.push(`categories.json: "${c.id}" needs a label`);
}
if (!catIds.has('meme-tees')) errors.push('categories.json: the "meme-tees" tab is required');

const styleKeys = Object.keys(designs.styles || {});
for (const [k, st] of Object.entries(designs.styles || {})) {
  if (!st.printful?.model || !st.printful?.brand) errors.push(`designs.json: style "${k}" needs printful.brand and printful.model`);
  if (!Array.isArray(st.sizes) || !st.sizes.length) errors.push(`designs.json: style "${k}" needs sizes`);
  if (!Number.isInteger(st.price?.default) || st.price.default < 500) errors.push(`designs.json: style "${k}" needs price.default in cents (e.g. 2699)`);
}
const ids = new Set();
const BANNED_WORDS = [...block.brands, ...block.banned].map((w) => w.toLowerCase());
const hasBanned = (text) => {
  const t = ` ${String(text).toLowerCase()} `;
  return BANNED_WORDS.find((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`).test(t));
};
for (const d of designs.designs || []) {
  const where = `designs.json: "${d.id}"`;
  if (!/^[a-z0-9-]+$/.test(d.id || '')) errors.push(`${where}: id must be lowercase letters, numbers and dashes`);
  if (ids.has(d.id)) errors.push(`${where}: duplicate id`);
  ids.add(d.id);
  for (const f of ['name', 'blurb']) if (!d[f]) errors.push(`${where}: missing ${f}`);
  const bad = hasBanned(`${d.name} ${d.blurb} ${(d.tags || []).join(' ')}`);
  if (bad) errors.push(`${where}: uses the blocked word "${bad}" (brands and banned topics can't be on shirts)`);
  for (const s of d.styles || []) if (!styleKeys.includes(s)) errors.push(`${where}: unknown style "${s}"`);
  if (!d.colors || !Object.keys(d.colors).length) errors.push(`${where}: needs colors, e.g. {"Black":"dark","White":"light"}`);
  for (const [color, variant] of Object.entries(d.colors || {})) {
    if (!d.palette?.[variant]) errors.push(`${where}: no palette for "${variant}"`);
    const print = join(ROOT, 'public', 'designs', `${d.id}-${variant}.png`);
    if (!existsSync(print) && !CHECK_ONLY) errors.push(`${where}: missing print file public/designs/${d.id}-${variant}.png (run python3 scripts/make-designs.py ${d.id})`);
    for (const s of d.styles || []) {
      const mock = join(ROOT, 'public', 'img', 'products', `${d.id}-${s}-${color.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`);
      if (!existsSync(mock) && !CHECK_ONLY) errors.push(`${where}: missing mockup ${relative(ROOT, mock)}`);
    }
  }
  if (d.defaultColor && !d.colors?.[d.defaultColor]) errors.push(`${where}: defaultColor "${d.defaultColor}" is not one of its colors`);
}

const scanCats = new Set(categories.filter((c) => !c.auto && c.id !== 'meme-tees').map((c) => c.id));
const qs = new Set();
for (const k of trends.keywords || []) {
  const where = `trends.json: "${k.q}"`;
  if (!k.q || typeof k.q !== 'string') errors.push('trends.json: every keyword needs "q"');
  if (!scanCats.has(k.cat)) errors.push(`${where}: "cat" must be one of ${[...scanCats].join(', ')}`);
  if (qs.has(String(k.q).toLowerCase())) warnings.push(`${where}: listed twice`);
  qs.add(String(k.q).toLowerCase());
  const bad = hasBanned(k.q);
  if (bad) errors.push(`${where}: contains the blocked word "${bad}"`);
  if (k.score !== undefined && !(k.score >= 1 && k.score <= 100)) errors.push(`${where}: score must be 1-100`);
  if (k.why && /[<>]/.test(k.why)) errors.push(`${where}: no < or > in "why"`);
}
if ((trends.keywords || []).length < 5) errors.push('trends.json: keep at least 5 keywords');

const apparelIds = new Set((designs.designs || []).flatMap((d) => (d.styles || []).map((s) => `${d.id}-${s}`)));
const dates = new Set();
for (const p of queue.posts || []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) errors.push(`queue.json: bad date "${p.date}"`);
  if (dates.has(p.date)) errors.push(`queue.json: two posts for ${p.date}`);
  dates.add(p.date);
  if (!p.text || p.text.length < 10) errors.push(`queue.json: post for ${p.date} needs text`);
  if (/https?:\/\//.test(p.text || '')) warnings.push(`queue.json: ${p.date} has a link in the text (the poster adds its own)`);
  if (p.product && !apparelIds.has(p.product) && !String(p.product).startsWith('cj-')) warnings.push(`queue.json: ${p.date} links product "${p.product}", which isn't in designs.json`);
}

// ---------------------------------------------------------------- 3. stamp the site address
if (!errors.length && !CHECK_ONLY) {
  const url = site.url.replace(/\/+$/, '');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const meta = [
    `<title>${esc(site.name)} | ${esc(site.tagline)}</title>`,
    `<meta name="description" content="${esc(site.description)}">`,
    `<link rel="canonical" href="${url}/">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:title" content="${esc(site.name)}: ${esc(site.tagline)}">`,
    `<meta property="og:description" content="${esc(site.description)}">`,
    `<meta property="og:url" content="${url}/">`,
    `<meta property="og:image" content="${url}/og.png">`,
    '<meta name="twitter:card" content="summary_large_image">',
    site.verification?.google ? `<meta name="google-site-verification" content="${esc(site.verification.google)}">` : '',
  ].filter(Boolean).join('\n');
  const indexPath = join(ROOT, 'public', 'index.html');
  const html = await readFile(indexPath, 'utf8');
  if (!html.includes('<!--meta:start-->')) errors.push('public/index.html lost its <!--meta:start--> marker');
  else {
    const next = html.replace(/<!--meta:start-->[\s\S]*?<!--meta:end-->/, () => `<!--meta:start-->\n${meta}\n<!--meta:end-->`);
    if (next !== html) await writeFile(indexPath, next);
  }
  if (!html.includes('<!--ssr-->')) errors.push('public/index.html lost its <!--ssr--> marker (product pages need it)');
  await writeFile(join(ROOT, 'public', 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${url}/sitemap.xml\n`);
}

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error(`\nBuild stopped, ${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`Build OK: ${ids.size} designs, ${(trends.keywords || []).length} trend keywords, ${categories.length} tabs${written ? `, ${written} image(s) restored from assets/b64` : ''}.`);
