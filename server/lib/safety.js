// Keeps knockoffs, banned and regulated items out of the store (see catalog/blocklist.json),
// and cleans supplier titles and descriptions into something presentable.
import BLOCK from '../../catalog/blocklist.json' with { type: 'json' };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${esc(w.toLowerCase())}(?=$|[^a-z0-9])`, 'i');
const BRAND_RES = BLOCK.brands.map((w) => [w, wordRe(w)]);
const BANNED_RES = BLOCK.banned.map((w) => [w, wordRe(w)]);

/** Returns the reason a product name is not allowed, or null if it's fine. */
export function blockedReason(name, extra = {}) {
  const text = ` ${String(name || '').toLowerCase()} `;
  for (const [w, re] of BANNED_RES) if (re.test(text)) return `banned word "${w}"`;
  for (const [w, re] of BRAND_RES) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(0, m.index + m[1].length).trimEnd();
    if (/(\bfor|compatible with|fits|works with)$/.test(before)) continue; // "case for iPhone 16" is fine
    return `brand name "${w}"`;
  }
  for (const w of extra.banned || []) if (wordRe(w).test(text)) return `blocked word "${w}"`;
  return null;
}

const JUNK = [
  /\b(hot|new|best|top)[ -]?(sale|selling|seller|style|arrival|product)s?\b/gi,
  /\b(tik ?tok|amazon|ebay|aliexpress|temu|shein|dropshipping|wholesale|cross[- ]?border|foreign trade|factory|manufacturer)\b/gi,
  /\b(same style|explosive|explosion|creative|internet celebrity|net red|in stock|free shipping)\b/gi,
  /\b20\d\d\b/g,
  /\b(new|hot)\b/gi,
];

const SPECIAL = { iphone: 'iPhone', ipad: 'iPad', magsafe: 'MagSafe', usb: 'USB', 'usb-c': 'USB-C', led: 'LED', rgb: 'RGB', '3d': '3D', tws: 'TWS', hd: 'HD', '4k': '4K' };
const SMALL = new Set(['a', 'an', 'and', 'or', 'for', 'of', 'the', 'to', 'in', 'on', 'with', 'by', 'at']);

export function cleanTitle(raw, max = 64) {
  let t = String(raw || '').replace(/<[^>]*>/g, ' ').replace(/[\u4e00-\u9fff]+/g, ' ');
  for (const re of JUNK) t = t.replace(re, ' ');
  t = t.replace(/[|_*#~^=+\\/]+/g, ' ').replace(/\s*[,;:]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key) && key.length > 2) continue; // CJ titles repeat words a lot
    seen.add(key);
    if (SPECIAL[key]) {
      out.push(SPECIAL[key]);
      continue;
    }
    const fixed = /^[A-Z0-9]{2,}$/.test(w) && w.length <= 4 ? w : w.toLowerCase();
    out.push(out.length && SMALL.has(fixed) ? fixed : fixed.charAt(0).toUpperCase() + fixed.slice(1));
  }
  let title = out.join(' ');
  if (title.length > max) title = title.slice(0, max).replace(/\s+\S*$/, '');
  return title.trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Supplier HTML description -> plain text bullets (never rendered as HTML). */
export function cleanDescription(html, max = 700) {
  let t = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? ' ';
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/[\u4e00-\u9fff]+/g, ' ');
  const lines = t
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 3 && !/^(product information|packing list|package (includes|content)|note|notes|specification)s?:?$/i.test(l))
    .filter((l) => !/(https?:\/\/|www\.|wechat|whatsapp|\.com\b)/i.test(l))
    .filter((l) => !blockedReason(l));
  let out = '';
  for (const l of lines) {
    if ((out + '\n' + l).length > max) break;
    out += (out ? '\n' : '') + l;
  }
  return out;
}

export const slugify = (s, max = 48) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
