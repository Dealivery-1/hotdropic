// THE AUTO-PROMOTER (like Dealivery's daily promo post). When switched on in /admin, once a day at `promoHour`
// (US Eastern) it posts to every connected network. It uses the post the AI trend hunter queued for today in
// marketing/queue.json, or writes one itself, rotating between a trending product, a meme tee, and a tab round-up.
// It never repeats a product within 14 days. You can preview or post right now from /admin.
import QUEUE from '../../marketing/queue.json' with { type: 'json' };
import SITE from '../../site.config.json' with { type: 'json' };
import { absUrl, CATEGORIES, loadCatalog, trendingIds } from './catalog.js';
import { kvGet, kvSet } from './db.js';
import { money } from './http.js';
import { channelReady, CHANNELS, SENDERS } from './social.js';

export const easternDate = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export const easternHour = (now = new Date()) => Number(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })) % 24;

const TAGS = {
  'meme-tees': ['#memes', '#memeshirt', '#funnyshirts'],
  tech: ['#gadgets', '#techtok', '#giftideas'],
  room: ['#roomdecor', '#roomglowup', '#aesthetic'],
  beauty: ['#beautytok', '#selfcare', '#giftideas'],
  toys: ['#fidgettoys', '#squishy', '#stockingstuffers'],
  pets: ['#pettok', '#petsoftiktok', '#giftsforpets'],
  home: ['#kitchengadgets', '#homehacks', '#giftideas'],
  cozy: ['#cozy', '#cozyseason', '#giftideas'],
};
const catLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label || 'Trending';
const pickOne = (arr, seed) => arr[Math.abs(seed) % arr.length];
const dayNumber = (dateStr) => Math.floor(Date.parse(`${dateStr}T12:00:00Z`) / 86400000);

export function hashtags(p) {
  return ['#TheHotDropic', ...(TAGS[p.category] || ['#trending']), ...(p.design?.startsWith('fih') ? ['#fih'] : [])].slice(0, 4).join(' ');
}

const SPOTLIGHT = [
  (p, s) => `🔥 Trending right now: ${p.title}. ${p.why || ''} ${s}`,
  (p, s) => `This one is everywhere this week: ${p.title}. ${s}`,
  (p, s) => `The ${catLabel(p.category)} find people keep asking about: ${p.title}. ${s}`,
  (p, s) => `Just dropped on The Hot Dropic: ${p.title}. ${p.why || ''} ${s}`,
];
const MEME = [
  (p, s) => `New meme drop 👕 ${p.title}. ${p.description} ${s}`,
  (p, s) => `If you know, you know. ${p.title}, printed just for you. ${s}`,
  (p, s) => `${p.title}: ${p.description} ${s}`,
];

/** Picks today's post. kind rotates: trending product, meme apparel, tab round-up. */
export function buildPost({ products, entry, history = [], origin, date, settings }) {
  const recent = new Set(history.filter((h) => Date.parse(h.date) > Date.parse(date) - 14 * 86400000).map((h) => h.productId));
  const byId = new Map(products.map((p) => [p.id, p]));
  const shipLine = settings.freeShippingMin > 0 ? `Free US shipping on ${money(settings.freeShippingMin)}+.` : 'Free US shipping.';
  const day = dayNumber(date);
  if (entry?.text) {
    const p = entry.product ? byId.get(entry.product) : null;
    const text = entry.text.replace(/https?:\/\/\S+/g, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').trim();
    return {
      kind: 'queued',
      productId: p?.id || null,
      text,
      link: p ? `${origin}/p/${p.id}` : `${origin}/`,
      image: absUrl(origin, p?.images?.[0] || '/og.png'),
      title: p ? `${p.title} - ${money(p.price)}` : SITE.name,
      description: p ? p.description.slice(0, 200) : SITE.tagline,
    };
  }
  const trendingOrder = trendingIds(products, 40).map((id) => byId.get(id)).filter(Boolean);
  const kinds = ['spotlight', 'meme', 'spotlight', 'roundup'];
  let kind = kinds[day % kinds.length];
  const fresh = (list) => list.filter((p) => !recent.has(p.id));
  const memes = fresh(products.filter((p) => p.category === 'meme-tees' && p.style !== 'hoodie')).sort((a, b) => b.score - a.score);
  const others = fresh(trendingOrder.filter((p) => p.category !== 'meme-tees'));
  if (kind === 'spotlight' && !others.length) kind = 'meme';
  if (kind === 'roundup') {
    const cats = [...new Set(others.map((p) => p.category))];
    const cat = cats.length ? pickOne(cats, day) : null;
    const items = cat ? others.filter((p) => p.category === cat).slice(0, 4) : [];
    if (items.length >= 3) {
      return {
        kind,
        productId: items[0].id,
        text: `${items.length} things blowing up in ${catLabel(cat)} right now: ${items.map((p) => p.title).join(', ')}. ${shipLine} ${hashtags(items[0])}`.replace(/\s+/g, ' ').trim(),
        link: `${origin}/?tab=${encodeURIComponent(cat)}`,
        image: absUrl(origin, items[0].images[0]),
        title: `${catLabel(cat)} - ${SITE.name}`,
        description: `The hottest ${catLabel(cat).toLowerCase()} right now, updated automatically.`,
      };
    }
    kind = others.length ? 'spotlight' : 'meme';
  }
  const pool = kind === 'meme' ? memes : others;
  const p = pool[day % Math.max(1, Math.min(pool.length, 5))] || memes[0] || trendingOrder[0] || products[0];
  if (!p) return null;
  const tail = `${money(p.price)}. ${shipLine} ${hashtags(p)}`;
  const tpl = p.category === 'meme-tees' ? pickOne(MEME, day) : pickOne(SPOTLIGHT, day);
  return {
    kind: p.category === 'meme-tees' ? 'meme' : 'spotlight',
    productId: p.id,
    text: tpl(p, tail).replace(/\s+/g, ' ').trim(),
    link: `${origin}/p/${p.id}`,
    image: absUrl(origin, p.images[0]),
    title: `${p.title} - ${money(p.price)}`,
    description: p.description.slice(0, 200),
  };
}

/** Caption + share links for the manual "promo kit" (TikTok, Instagram, Pinterest have no free posting API). */
export function promoKit(products, origin, settings, n = 6) {
  const byId = new Map(products.map((p) => [p.id, p]));
  return trendingIds(products, n).map((id) => byId.get(id)).filter(Boolean).map((p) => {
    const link = `${origin}/p/${p.id}`;
    const caption = `${p.title} 🔥 ${p.why || p.description} ${money(p.price)} at The Hot Dropic (link in bio). ${hashtags(p)} #TikTokMadeMeBuyIt`.replace(/\s+/g, ' ').trim();
    return {
      id: p.id,
      title: p.title,
      image: absUrl(origin, p.images[0]),
      link,
      caption,
      pinterest: `https://www.pinterest.com/pin/create/button/?url=${encodeURIComponent(link)}&media=${encodeURIComponent(absUrl(origin, p.images[0]))}&description=${encodeURIComponent(`${p.title} - ${money(p.price)}`)}`,
    };
  });
}

/** One promo run. force = ignore "already posted today"; dryRun = build the post but send nothing. */
export async function runPromo(env, { origin, settings, force = false, dryRun = false, now = new Date() }) {
  const state = (await kvGet(env, 'promo:state', null)) || { lastDate: '', history: [] };
  const date = easternDate(now);
  if (!force && !dryRun && state.lastDate === date) return { skipped: true, reason: 'Already posted today.' };
  const { products } = await loadCatalog(env);
  const entry = (QUEUE.posts || []).find((p) => p && p.date === date && typeof p.text === 'string');
  const post = buildPost({ products, entry, history: state.history, origin, date, settings });
  const active = CHANNELS.filter((ch) => channelReady(env, ch));
  if (!post) return { skipped: true, reason: 'No products to promote yet.' };
  if (dryRun) return { dryRun: true, post, channels: active.map((c) => c.name) };
  if (!active.length) return { post, results: [], reason: 'No social accounts connected yet. Add their keys in Cloudflare (SETUP.md step 8).' };
  const results = [];
  for (const ch of active) {
    try {
      await SENDERS[ch.id](env, post, date);
      results.push({ channel: ch.name, ok: true });
    } catch (e) {
      results.push({ channel: ch.name, ok: false, error: String(e.message || e).slice(0, 240) });
    }
  }
  state.lastDate = date;
  state.history = [{ date, t: Date.now(), productId: post.productId, kind: post.kind, text: post.text.slice(0, 300), results }, ...(state.history || [])].slice(0, 40);
  await kvSet(env, 'promo:state', state);
  return { post, results };
}
