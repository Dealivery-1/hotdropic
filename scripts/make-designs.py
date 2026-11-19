#!/usr/bin/env python3
"""Make print files + storefront mockups for the meme apparel in catalog/designs.json (and the brand images).

Usage (from the project folder):
  python3 scripts/make-designs.py              # every design whose files are missing
  python3 scripts/make-designs.py fih aura     # just these design ids (always redrawn)
  python3 scripts/make-designs.py --force      # redraw everything
  python3 scripts/make-designs.py --brand      # logo, app icons and the social preview image (og.png)
  python3 scripts/make-designs.py --sheet      # also write /tmp/designs-sheet.png (contact sheet to eyeball)

Needs Pillow, cairosvg and fonttools:  pip install pillow cairosvg fonttools --break-system-packages
Fonts: Lato, Poppins, URW base35 and DejaVu (preinstalled in Claude's Linux sandbox; free licenses).

Writes:
  public/designs/<id>-<variant>.png              print file Printful prints (1800x2400, transparent, 150 dpi at 12x16 in)
  public/img/products/<id>-<style>-<color>.jpg   storefront mockup (800x800)
  assets/b64/<same path>.b64                     base64 text copy of each image. The GitHub connector can only commit
                                                 text, so scripts/build.mjs rebuilds the real images from these.

Art recipes (the "art" field of a design):
  stack   icon on top, 1-3 big lines of text, small caption        {icon, lines:[{t, font, size}], caption}
  call    phone call screen: avatar, caller name, two buttons      {icon, caller, status}
  badge   round club badge with text around the ring              {icon, ring, center}
  sign    "prohibited" sign over an icon, text below               {icon, lines, caption}
  seesaw  two big characters at different heights                  {left, right, caption}
Fonts: black, heavy, bold, narrow, retro, mono, gothic.   Icons: see ICONS below.
Palettes need text, accent, accent2 (and optional muted, panel, line2). 'dark' = for black garments, 'light' = for white.
"""
import base64
import io
import json
import math
import sys
from pathlib import Path

import cairosvg
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PRINT_W, PRINT_H = 1800, 2400
MOCK = 800
INK = '#141414'

FONT_FILES = {
    'black': ['/usr/share/fonts/truetype/lato/Lato-Black.ttf'],
    'heavy': ['/usr/share/fonts/truetype/lato/Lato-Heavy.ttf'],
    'bold': ['/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf', '/usr/share/fonts/truetype/lato/Lato-Bold.ttf'],
    'narrow': ['/usr/share/fonts/opentype/urw-base35/NimbusSansNarrow-Bold.otf'],
    'retro': ['/usr/share/fonts/opentype/urw-base35/URWBookman-Demi.otf'],
    'mono': ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'],
    'gothic': ['/usr/share/fonts/opentype/urw-base35/URWGothic-Demi.otf'],
}
FALLBACK_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
_fonts = {}


class Font:
    def __init__(self, path):
        self.tt = TTFont(path, fontNumber=0, lazy=True)
        self.gs = self.tt.getGlyphSet()
        self.cmap = self.tt.getBestCmap()
        self.upm = self.tt['head'].unitsPerEm

    def _name(self, ch):
        return self.cmap.get(ord(ch)) or self.cmap.get(ord('?')) or '.notdef'

    def advance(self, text, size, tracking=0.0):
        s = size / self.upm
        total = sum(self.gs[self._name(c)].width * s for c in text)
        return total + tracking * size * max(0, len(text) - 1)

    def path(self, text, size, ox=0.0, oy=0.0, tracking=0.0):
        """SVG path data for text with its baseline at (ox, oy). Returns (d, advance, ink_bounds)."""
        s = size / self.upm
        pen, bp, x = SVGPathPen(self.gs), BoundsPen(self.gs), 0.0
        for c in text:
            g = self.gs[self._name(c)]
            t = (s, 0, 0, -s, ox + x, oy)
            g.draw(TransformPen(pen, t))
            g.draw(TransformPen(bp, t))
            x += g.width * s + tracking * size
        return pen.getCommands(), x - (tracking * size if text else 0), bp.bounds


def font(key):
    if key not in _fonts:
        path = next((p for p in FONT_FILES.get(key, []) if Path(p).exists()), FALLBACK_FONT)
        _fonts[key] = Font(path)
    return _fonts[key]


def fit_text(f, text, cx, top, max_w, max_h=None, tracking=0.0):
    """Path for text centred on cx with its ink top at `top`, as big as fits in max_w x max_h."""
    _, _, b = f.path(text, 1000, 0, 0, tracking)
    w, h = b[2] - b[0], b[3] - b[1]
    k = max_w / w
    if max_h and h * k > max_h:
        k = max_h / h
    d, _, bb = f.path(text, 1000 * k, cx - (w * k) / 2 - b[0] * k, top - b[1] * k, tracking)
    return d, bb


def svg_doc(body, w, h, defs=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{w}" height="{h}" viewBox="0 0 {w} {h}"><defs>{defs}</defs>{body}</svg>')


def render(body, w=PRINT_W, h=PRINT_H, defs=''):
    png = cairosvg.svg2png(bytestring=svg_doc(body, w, h, defs).encode(), output_width=w, output_height=h)
    return Image.open(io.BytesIO(png)).convert('RGBA')


def knockout(img, eraser):
    """Clears img wherever eraser is opaque (a transparent gap, so no dark ink is printed on dark shirts)."""
    a = ImageChops.multiply(img.getchannel('A'), ImageChops.invert(eraser.getchannel('A')))
    img.putalpha(a)
    return img


# ---------------------------------------------------------------- icons (100 x 100 boxes)
_uid = [0]


def uid(prefix):
    _uid[0] += 1
    return f'{prefix}{_uid[0]}'


def star_points(cx, cy, r, inner=0.45, n=5, rot=-90):
    pts = []
    for i in range(n * 2):
        rr = r if i % 2 == 0 else r * inner
        a = math.radians(rot + i * 180 / n)
        pts.append(f'{cx + rr * math.cos(a):.2f},{cy + rr * math.sin(a):.2f}')
    return ' '.join(pts)


def icon_fish(p, hat=False):
    t, a, a2 = p['text'], p['accent'], p['accent2']
    s = f'''<g fill="none" stroke="{t}" stroke-width="3.6" stroke-linejoin="round" stroke-linecap="round">
  <path d="M27 50 C22 44 14 36 5 33 C9 42 9 58 5 67 C14 64 22 56 27 50 Z" fill="{a2}"/>
  <path d="M43 31 C46 20 58 16 67 24 C61 25 57 28 55 31 Z" fill="{a2}"/>
  <path d="M45 69 C48 78 56 80 61 74 C57 73 54 71 53 69 Z" fill="{a2}"/>
  <path d="M24 50 C33 30 56 24 74 31 C84 35 91 43 94 50 C91 57 84 65 74 69 C56 76 33 70 24 50 Z" fill="{a}"/>
  <path d="M60 35 C54 42 54 58 60 65"/>
  <circle cx="77" cy="46" r="6.2" fill="#FFFFFF"/>
  <circle cx="78.6" cy="46.6" r="3.5" fill="{INK}" stroke="none"/>
  <circle cx="79.8" cy="45.2" r="1.15" fill="#FFFFFF" stroke="none"/>
  <path d="M81 58 C84.5 60 88 58.5 90 55.5"/>'''
    if not hat:
        s += '<circle cx="90" cy="24" r="2.8"/><circle cx="96" cy="15" r="1.9"/>'
    s += '</g>'
    if hat:
        s += f'''<g stroke="{t}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round">
  <path d="M63 34 C63 22 70 11 82 8 C88 7 93 10 93 15 C89 14 85 16 84 20 C86 25 87 30 86 35 Z" fill="{a2}"/>
  <path d="M59 33.5 C68 28 80 28.5 90 34 L88.5 41 C80 36.5 69 36 61 40.5 Z" fill="#FFFFFF"/>
  <circle cx="93.5" cy="16" r="4.6" fill="#FFFFFF"/></g>'''
    return s


def icon_heart(p):
    t, a = p['text'], p['accent']
    return f'''<g stroke="{t}" stroke-width="3.6" stroke-linejoin="round" stroke-linecap="round">
  <path d="M50 87 C24 69 8 53 10 34 C12 20 24 12 36 14 C43 15 48 20 50 26 C52 20 57 15 64 14 C76 12 88 20 90 34 C92 53 76 69 50 87 Z" fill="{a}"/>
  <path d="M23 31 C25 25 30 21.5 36 21.5" fill="none" stroke="#FFFFFF" stroke-width="4.5" opacity="0.9"/>
  <path d="M4 22 L10 26 M2 38 L9 38 M96 22 L90 26 M98 38 L91 38" fill="none" stroke="{p['accent2']}" stroke-width="3.4"/></g>'''


PTERO = ('M50 53 C54 54 57 53 60 50 C65 47 70 46 75 47 C79 43 85 39 92 37 L100 35 C93 30 85 27 77 28 C69 29 61 35 55 41 '
         'C55 37 56 33 58 30 L72 22 L58 26 C56 23 53 21 50 21 L28 28 L48 29 C48 33 47 38 46 41 '
         'C40 35 32 29 24 28 C16 27 7 30 0 35 L8 37 C15 39 21 43 25 47 C30 46 35 47 40 50 C43 53 46 54 50 53 Z '
         'M46 53 L43 62 L48 57 Z M54 53 L57 62 L52 57 Z')


def icon_pterodactyl(p):
    t, a = p['text'], p['accent']
    cid = uid('sun')
    bars = ''.join(f'<rect x="0" y="{y}" width="100" height="{h}"/>' for y, h in
                   [(20, 42), (65, 6), (74.5, 5), (83, 4), (90.5, 3)])
    return f'''<clipPath id="{cid}"><circle cx="50" cy="60" r="36"/></clipPath>
  <g clip-path="url(#{cid})" fill="{a}">{bars}</g>
  <path d="{PTERO}" fill="{t}" transform="translate(0 6)"/>'''


def icon_robot(p):
    t, a, a2 = p['text'], p['accent'], p['accent2']
    return f'''<g stroke="{t}" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round">
  <line x1="50" y1="12" x2="50" y2="24"/><circle cx="50" cy="9" r="4.2" fill="{a}"/>
  <rect x="21" y="24" width="58" height="46" rx="11" fill="{a2}"/>
  <rect x="13" y="38" width="8" height="17" rx="3" fill="{a2}"/><rect x="79" y="38" width="8" height="17" rx="3" fill="{a2}"/>
  <circle cx="38" cy="44" r="7.5" fill="#FFFFFF"/><circle cx="62" cy="44" r="7.5" fill="#FFFFFF"/>
  <circle cx="38" cy="44" r="3.4" fill="{INK}" stroke="none"/><circle cx="62" cy="44" r="3.4" fill="{INK}" stroke="none"/>
  <rect x="33" y="56" width="34" height="8.5" rx="2.5" fill="#FFFFFF"/>
  <path d="M41.5 56 v8.5 M50 56 v8.5 M58.5 56 v8.5" stroke-width="2.2"/>
  <path d="M30 88 C30 78 36 73 50 73 C64 73 70 78 70 88 Z" fill="{a2}"/></g>'''


def icon_sparkles(p):
    t, a, a2 = p['text'], p['accent'], p['accent2']
    return f'''<g stroke="{t}" stroke-width="3" stroke-linejoin="round">
  <path d="M46 10 C49.5 36 57 43.5 84 47 C57 50.5 49.5 58 46 84 C42.5 58 35 50.5 8 47 C35 43.5 42.5 36 46 10 Z" fill="{a2}"/>
  <path d="M81 8 C82.6 18 85 20.4 95 22 C85 23.6 82.6 26 81 36 C79.4 26 77 23.6 67 22 C77 20.4 79.4 18 81 8 Z" fill="{a}"/>
  <path d="M20 66 C21.3 74 23 75.7 31 77 C23 78.3 21.3 80 20 88 C18.7 80 17 78.3 9 77 C17 75.7 18.7 74 20 66 Z" fill="{a}"/></g>'''


def icon_stars(p):
    t, a = p['text'], p['accent']
    return (f'<g stroke="{t}" stroke-width="2.6" stroke-linejoin="round" fill="{a}">'
            f'<polygon points="{star_points(50, 50, 24)}"/><polygon points="{star_points(17, 57, 14)}"/>'
            f'<polygon points="{star_points(83, 57, 14)}"/></g>')


def icon_lock(p):
    t, a = p['text'], p['accent']
    return f'''<g stroke="{t}" stroke-linejoin="round" stroke-linecap="round">
  <path d="M33 46 V33 C33 21 41 13 50 13 C59 13 67 21 67 33 V46" fill="none" stroke-width="9"/>
  <rect x="20" y="43" width="60" height="45" rx="9" fill="{a}" stroke-width="3.6"/>
  <circle cx="50" cy="61" r="6.5" fill="{INK}" stroke="none"/><rect x="47" y="63" width="6" height="14" rx="2" fill="{INK}" stroke="none"/>
  <path d="M27 51 C27 49 28.5 48 30 48" fill="none" stroke="#FFFFFF" stroke-width="3.5" opacity="0.85"/></g>'''


BRAIN_L = ('M50 18 C44 11 33 11 29 18 C20 16 13 23 15 32 C7 35 6 47 12 52 C7 59 11 70 20 71 '
           'C21 80 32 86 40 81 C44 86 50 85 50 80 Z')
BRAIN_FOLDS = ('M29 30 C35 27 40 31 38 37 M18 45 C25 42 30 48 26 54 M33 57 C39 55 44 60 41 66 '
               'M41 21 C39 27 43 31 47 29 M24 64 C27 61 31 63 31 66')


def icon_brain(p):
    t, a = p['text'], p['accent']
    half = (f'<path d="{BRAIN_L}" fill="{a}"/><path d="{BRAIN_FOLDS}" fill="none"/>')
    return (f'<g stroke="{t}" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round">{half}'
            f'<g transform="translate(100 0) scale(-1 1)">{half}</g>'
            f'<path d="M50 20 V80" fill="none"/></g>')


def icon_handset(color):
    return (f'<path fill="{color}" d="M18 47 C30 30 70 30 82 47 L84 50 C86 53 85 57 82 59 L72 64 C69 65.5 66 64.5 64.5 61.5 '
            f'L61 54 C55 51 45 51 39 54 L35.5 61.5 C34 64.5 31 65.5 28 64 L18 59 C15 57 14 53 16 50 Z"/>')


ICONS = {
    'fish': icon_fish, 'fish-santa': lambda p: icon_fish(p, hat=True), 'heart': icon_heart,
    'pterodactyl': icon_pterodactyl, 'robot': icon_robot, 'sparkles': icon_sparkles, 'stars': icon_stars,
    'lock': icon_lock, 'brain': icon_brain,
}


def place(svg, x, y, size):
    return f'<g transform="translate({x:.1f} {y:.1f}) scale({size / 100:.4f})">{svg}</g>'


# ---------------------------------------------------------------- recipes
def shadowed_text(paths, p, shadow_px, knock_px):
    """Returns (main, shadow, knock) layers for a list of text path strings."""
    fill = ''.join(f'<path d="{d}" fill="{p["text"]}"/>' for d in paths)
    shadow = ''.join(f'<path d="{d}" fill="{p["accent2"]}" transform="translate({shadow_px} {shadow_px})"/>' for d in paths)
    knock = ''.join(f'<path d="{d}" fill="#000" stroke="#000" stroke-width="{knock_px * 2}" stroke-linejoin="round"/>' for d in paths)
    return fill, shadow, knock


def compose(main_svg, shadow_svg='', knock_svg='', defs=''):
    img = render(main_svg, defs=defs)
    if shadow_svg:
        sh = render(shadow_svg, defs=defs)
        if knock_svg:
            sh = knockout(sh, render(knock_svg, defs=defs))
        img = Image.alpha_composite(sh, img)
    return img


def caption_el(text, p, top, color=None, size_px=104, max_w=1450):
    f = font('bold')
    adv = f.advance(text, size_px, 0.03)
    k = min(1.0, max_w / adv) if adv else 1
    d, bb = fit_text(f, text, PRINT_W / 2, top, adv * k, None, 0.03)
    return f'<path d="{d}" fill="{color or p.get("muted") or p["text"]}"/>', bb


def recipe_stack(art, p):
    cx, y, cw = PRINT_W / 2, 100, 1500
    main = shadow = knock = ''
    if art.get('icon'):
        size = 640 if len(art['lines']) == 1 else 560
        main += place(ICONS[art['icon']](p), cx - size / 2, y, size)
        y += size + 60
    lines = art['lines']
    budget = (2280 - y - (230 if art.get('caption') else 0) - 50 * (len(lines) - 1))
    paths = []
    for ln in lines:
        rel = ln.get('size', 1.0)
        max_h = budget / len(lines) * (1.15 if len(lines) > 1 and rel >= 1 else 1.0) * min(1.0, rel + 0.15)
        d, bb = fit_text(font(ln.get('font', 'black')), ln['t'], cx, y, cw * rel, max_h)
        paths.append((d, ln))
        y = bb[3] + 50
    th = max(1, (y - 50) - 100)
    sp = max(18, min(46, th * 0.03))
    for d, ln in paths:
        color = p.get('line2') if ln is not lines[0] and p.get('line2') else p['text']
        main += f'<path d="{d}" fill="{color}"/>'
        if art.get('shadow', True):
            shadow += f'<path d="{d}" fill="{p["accent2"]}" transform="translate({sp:.1f} {sp:.1f})"/>'
            knock += f'<path d="{d}" fill="#000" stroke="#000" stroke-width="{sp * 1.25:.1f}" stroke-linejoin="round"/>'
    if art.get('caption'):
        el, _ = caption_el(art['caption'], p, y + 30 + sp, color=p['accent'])
        main += el
    return compose(main, shadow, knock)


def recipe_call(art, p):
    cx = PRINT_W / 2
    panel = p.get('panel') or ('#2A2F38' if p['text'].upper() in ('#FFFFFF', '#FFF') else '#E6EAF0')
    muted = p.get('muted', p['text'])
    main = f'<circle cx="{cx}" cy="470" r="380" fill="{panel}"/>'
    main += place(ICONS[art.get('icon', 'fish')](p), cx - 300, 170, 600)
    d, bb = fit_text(font('black'), art['caller'], cx, 920, 1100, 470)
    main += f'<path d="{d}" fill="{p["text"]}"/>'
    el, sb = caption_el(art.get('status', 'incoming call...'), p, bb[3] + 60, color=muted, size_px=96)
    main += el
    by = sb[3] + 170
    for x, color, rot, label in ((cx - 420, '#FF3B30', 0, 'decline'), (cx + 420, '#34C759', 225, 'accept')):
        main += f'<circle cx="{x}" cy="{by + 165}" r="165" fill="{color}"/>'
        main += (f'<g transform="translate({x} {by + 165}) rotate({rot}) translate(-100 -100) scale(2)">'
                 f'{icon_handset("#FFFFFF")}</g>')
        f = font('bold')
        adv = f.advance(label, 80)
        dd, _ = fit_text(f, label, x, by + 365, adv)
        main += f'<path d="{dd}" fill="{muted}"/>'
    return compose(main)


def arc_text(text, f, cx, cy, r, size, color, center_deg, bottom=False, tracking=0.05):
    """Text along an arc, centred at center_deg (-90 = top, 90 = bottom), always upright and reading left to right.
    r is the baseline radius: top text grows outward from it, bottom text grows inward."""
    total = f.advance(text, size, tracking)
    out = ''
    angle = math.radians(center_deg) + (total / 2) / r * (1 if bottom else -1)
    for ch in text:
        w = f.advance(ch, size)
        mid = angle + (w / 2) / r * (-1 if bottom else 1)
        d, _, _ = f.path(ch, size, -w / 2, 0)
        if bottom:
            tf = f'translate({cx} {cy}) rotate({math.degrees(mid) - 90:.3f}) translate(0 {r:.2f})'
        else:
            tf = f'translate({cx} {cy}) rotate({math.degrees(mid) + 90:.3f}) translate(0 {-r:.2f})'
        out += f'<path d="{d}" fill="{color}" transform="{tf}"/>'
        angle += (w + tracking * size) / r * (-1 if bottom else 1)
    return out


def cap_ratio(f):
    _, _, b = f.path('H', 1000)
    return -b[1] / 1000


def text_block(lines, f, cx, top, max_w, max_line_h, color, gap=30):
    """Several lines at one shared font size (fits the widest line), centred. Returns (svg, bottom_y)."""
    ks = []
    for ln in lines:
        _, _, b = f.path(ln, 1000)
        ks.append(min(max_w / (b[2] - b[0]), max_line_h / (b[3] - b[1])))
    k = min(ks)
    out, y = '', top
    for ln in lines:
        _, _, b = f.path(ln, 1000)
        w = (b[2] - b[0]) * k
        d, _, bb = f.path(ln, 1000 * k, cx - w / 2 - b[0] * k, y - b[1] * k)
        out += f'<path d="{d}" fill="{color}"/>'
        y = bb[3] + gap
    return out, y - gap


def split_balanced(text):
    words = text.split()
    if len(text) <= 12 or len(words) < 2:
        return [text]
    best = min(range(1, len(words)), key=lambda i: abs(len(' '.join(words[:i])) - len(' '.join(words[i:]))))
    return [' '.join(words[:best]), ' '.join(words[best:])]


def recipe_badge(art, p):
    cx, cy, ro, ri, so, si = PRINT_W / 2, 880, 790, 590, 30, 18
    a, t = p['accent'], p['text']
    main = (f'<circle cx="{cx}" cy="{cy}" r="{ro}" fill="none" stroke="{a}" stroke-width="{so}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{ri}" fill="none" stroke="{a}" stroke-width="{si}"/>')
    f = font('black')
    segs = [x.strip() for x in art['ring'].split('*') if x.strip()]
    top_txt, bot_txt = segs[0], '  '.join(segs[1:])
    b_in, b_out = ri + si / 2, ro - so / 2
    band = b_out - b_in
    cr = cap_ratio(f)
    for txt, bottom, span in ((top_txt, False, 150), (bot_txt, True, 120)):
        if not txt:
            continue
        cap = band * 0.56
        size = cap / cr
        r_guess = b_in + band / 2
        size = min(size, size * math.radians(span) * r_guess / f.advance(txt, size, 0.05))
        cap = size * cr
        r = (b_in + (band - cap) / 2) if not bottom else (b_out - (band - cap) / 2)
        main += arc_text(txt, f, cx, cy, r, size, t, 90 if bottom else -90, bottom)
    for ang in (0, 180):
        rm = b_in + band / 2
        sx, sy = cx + rm * math.cos(math.radians(ang)), cy + rm * math.sin(math.radians(ang))
        main += f'<polygon points="{star_points(sx, sy, band * 0.36)}" fill="{p["accent2"]}"/>'
    main += place(ICONS[art['icon']](p), cx - 280, cy - 430, 560)
    if art.get('center'):
        lines = split_balanced(art['center'])
        svg, _ = text_block(lines, f, cx, cy + 170, 760 if len(lines) == 1 else 700, 150 if len(lines) == 1 else 112, t)
        main += svg
    return compose(main)


def recipe_sign(art, p):
    cx, cy, r = PRINT_W / 2, 760, 620
    a = p['accent']
    main = place(ICONS[art['icon']](p), cx - 400, cy - 410, 800)
    main += f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{a}" stroke-width="110"/>'
    k = r * math.cos(math.radians(45))
    main += f'<line x1="{cx - k}" y1="{cy - k}" x2="{cx + k}" y2="{cy + k}" stroke="{a}" stroke-width="110"/>'
    y = cy + r + 140
    for ln in art['lines']:
        d, bb = fit_text(font(ln.get('font', 'narrow')), ln['t'], cx, y, 1500, 330)
        main += f'<path d="{d}" fill="{p["text"]}"/>'
        y = bb[3] + 40
    if art.get('caption'):
        el, _ = caption_el(art['caption'], p, y + 10, color=p.get('accent2'))
        main += el
    return compose(main)


def recipe_seesaw(art, p):
    f = font('black')
    main = shadow = knock = ''
    paths = []
    for ch, x, top in ((art['left'], 445, 140), (art['right'], 1355, 560)):
        d, bb = fit_text(f, ch, x, top, 700, 1150)
        paths.append((d, bb))
    sp = 30
    for d, bb in paths:
        main += f'<path d="{d}" fill="{p["text"]}"/>'
        shadow += f'<path d="{d}" fill="{p["accent2"]}" transform="translate({sp} {sp})"/>'
        knock += f'<path d="{d}" fill="#000" stroke="#000" stroke-width="{sp * 1.3}" stroke-linejoin="round"/>'
    (_, b1), (_, b2) = paths
    a = p['accent']

    def arrow(x, y, up):
        s = -1 if up else 1
        return (f'<path d="M{x} {y} l0 {s * 150} M{x - 70} {y + s * 80} L{x} {y + s * 150} L{x + 70} {y + s * 80}" '
                f'fill="none" stroke="{a}" stroke-width="40" stroke-linecap="round" stroke-linejoin="round" '
                f'transform="rotate(180 {x} {y + s * 75})"/>')
    main += arrow((b1[0] + b1[2]) / 2, b1[3] + 220, True)
    main += arrow((b2[0] + b2[2]) / 2, b2[1] - 220, False)
    el, _ = caption_el(art['caption'], p, max(b1[3], b2[3]) + 90, color=p['accent'])
    main += el
    return compose(main, shadow, knock)


RECIPES = {'stack': recipe_stack, 'call': recipe_call, 'badge': recipe_badge, 'sign': recipe_sign, 'seesaw': recipe_seesaw}


def trim_top(img):
    """Moves the art to the top of the canvas (Printful prints the file top-aligned in the chest area)."""
    bbox = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bbox:
        return img
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    crop = img.crop((0, bbox[1], img.width, bbox[3]))
    out.paste(crop, (0, 40))
    return out


# ---------------------------------------------------------------- mockups
GARMENT = {'Black': '#1B1B1E', 'White': '#F7F7F5', 'Navy': '#1F2A44', 'Sport Grey': '#A9ABB0', 'Red': '#C62828'}
TEE = ('M418 152 C440 202 560 202 582 152 L668 168 C740 196 806 248 856 304 L790 404 L704 362 L704 896 '
       'Q500 912 296 896 L296 362 L210 404 L144 304 C194 248 260 196 332 168 Z')
TEE_COLLAR = 'M418 152 C440 202 560 202 582 152 C566 150 434 150 418 152 Z'
TEE_RIB = 'M412 150 C436 214 564 214 588 150'
HOOD_BACK = 'M372 214 C352 118 418 64 500 64 C582 64 648 118 628 214 C596 246 404 246 372 214 Z'
HOODIE = ('M398 196 C438 252 562 252 602 196 L688 212 C758 236 790 296 800 376 L862 786 L758 806 L716 444 '
          'L712 902 L288 902 L284 444 L242 806 L138 786 L200 376 C210 296 242 236 312 212 Z')
HOOD_OPEN = 'M414 202 C426 146 574 146 586 202 C566 254 434 254 414 202 Z'
PRINT_BOX = {'tee': (370, 240, 260, 347), 'hoodie': (386, 288, 228, 304)}


def garment_svg(style, color, shading=False):
    base = GARMENT.get(color, '#888888')
    dark = color in ('Black', 'Navy')
    line = '#FFFFFF' if dark else '#000000'
    if style == 'tee':
        if not shading:
            return (f'<path d="{TEE}" fill="{base}"/><path d="{TEE_COLLAR}" fill="{line}" opacity="{0.10 if dark else 0.08}"/>'
                    f'<path d="{TEE_RIB}" fill="none" stroke="{line}" stroke-opacity="0.18" stroke-width="10"/>')
        return (f'<path d="M296 362 L296 896" stroke="{line}" stroke-opacity="0.07" stroke-width="10"/>'
                f'<path d="M704 362 L704 896" stroke="{line}" stroke-opacity="0.07" stroke-width="10"/>'
                f'<path d="M332 168 L296 362 M668 168 L704 362" stroke="{line}" stroke-opacity="0.10" stroke-width="5" fill="none"/>'
                f'<path d="M210 404 L144 304 M790 404 L856 304" stroke="{line}" stroke-opacity="0.12" stroke-width="7"/>'
                f'<path d="M300 880 Q500 896 700 880" fill="none" stroke="{line}" stroke-opacity="0.12" stroke-width="6"/>'
                f'<path d="{TEE}" fill="url(#shade)"/>')
    if not shading:
        return (f'<path d="{HOOD_BACK}" fill="{base}"/><path d="{HOOD_BACK}" fill="#000" opacity="0.18"/>'
                f'<path d="{HOODIE}" fill="{base}"/><path d="{HOOD_OPEN}" fill="#000" opacity="{0.35 if dark else 0.16}"/>'
                )
    return (f'<path d="M372 664 L628 664 L668 830 L332 830 Z" fill="none" stroke="{line}" stroke-opacity="0.16" stroke-width="6" stroke-linejoin="round"/>'
            f'<path d="M290 862 L710 862" stroke="{line}" stroke-opacity="0.14" stroke-width="6"/>'
            + ''.join(f'<path d="M{x} 866 L{x} 900" stroke="{line}" stroke-opacity="0.07" stroke-width="4"/>' for x in range(306, 700, 18))
            + f'<path d="M150 760 L246 778 M850 760 L754 778" stroke="{line}" stroke-opacity="0.14" stroke-width="6"/>'
            f'<path d="M284 444 L288 902 M716 444 L712 902" stroke="{line}" stroke-opacity="0.07" stroke-width="10"/>'
            f'<path d="{HOODIE}" fill="url(#shade)"/>'
            f'<path d="M462 236 L456 400 M538 236 L544 400" stroke="{base}" stroke-width="9" stroke-linecap="round"/>'
            f'<path d="M462 236 L456 400 M538 236 L544 400" stroke="{line}" stroke-opacity="0.5" stroke-width="9" stroke-linecap="round"/>'
            f'<circle cx="456" cy="406" r="8" fill="{base}"/><circle cx="544" cy="406" r="8" fill="{base}"/>'
            f'<circle cx="456" cy="406" r="8" fill="{line}" opacity="0.55"/><circle cx="544" cy="406" r="8" fill="{line}" opacity="0.55"/>')


SHADE_DEFS = ('<linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">'
              '<stop offset="0" stop-color="#000" stop-opacity="0.16"/><stop offset="0.22" stop-color="#000" stop-opacity="0"/>'
              '<stop offset="0.78" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.16"/></linearGradient>')


def mockup(print_img, style, color):
    W = 1000
    bg = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    grad = Image.linear_gradient('L').resize((W, W)).point(lambda v: 236 + v * 12 // 255)
    bg = Image.merge('RGBA', (grad, grad, grad.point(lambda v: min(255, v + 4)), Image.new('L', (W, W), 255)))
    base = render(garment_svg(style, color), W, W)
    sil = base.getchannel('A')
    shadow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    shadow.putalpha(sil.point(lambda v: v * 70 // 255).filter(ImageFilter.GaussianBlur(18)))
    bg.alpha_composite(shadow, (8, 22))
    bg.alpha_composite(base)
    x, y, w, h = PRINT_BOX[style]
    art = print_img.resize((w, h), Image.LANCZOS)
    a = art.getchannel('A').point(lambda v: v * 96 // 100)
    art.putalpha(a)
    bg.alpha_composite(art, (x, y))
    bg.alpha_composite(render(garment_svg(style, color, shading=True), W, W, defs=SHADE_DEFS))
    return bg.convert('RGB').resize((MOCK, MOCK), Image.LANCZOS)


# ---------------------------------------------------------------- files
def save(img, rel, fmt='PNG', **kw):
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    data = buf.getvalue()
    out.write_bytes(data)
    b64 = ROOT / 'assets' / 'b64' / (rel + '.b64')
    b64.parent.mkdir(parents=True, exist_ok=True)
    b64.write_text(base64.b64encode(data).decode() + '\n')
    return len(data)


def make_design(d, styles, force=False):
    made = []
    for color, variant in d['colors'].items():
        rel = f'public/designs/{d["id"]}-{variant}.png'
        need = force or not (ROOT / rel).exists() or any(
            not (ROOT / f'public/img/products/{d["id"]}-{s}-{color.lower().replace(" ", "-")}.jpg').exists() for s in d['styles'])
        if not need:
            continue
        p = dict(d['palette'][variant])
        img = trim_top(RECIPES[d['art']['recipe']](d['art'], p))
        # 256-colour palette PNG (with transparency): looks identical, about a third of the size
        n = save(img.quantize(colors=256, method=Image.Quantize.FASTOCTREE), rel, 'PNG', optimize=True, dpi=(150, 150))
        made.append(f'{rel} ({n // 1024} KB)')
        for s in d['styles']:
            mrel = f'public/img/products/{d["id"]}-{s}-{color.lower().replace(" ", "-")}.jpg'
            n = save(mockup(img, s, color), mrel, 'JPEG', quality=82, optimize=True, progressive=True)
            made.append(f'{mrel} ({n // 1024} KB)')
    return made


# ---------------------------------------------------------------- brand
DROP = 'M50 5 C50 5 17 42 17 62 C17 81 32 95 50 95 C68 95 83 81 83 62 C83 42 50 5 50 5 Z'
FLAME = ('M51 33 C57 45 67 51 65 66 C64 77 57 83 50 83 C41 83 35 76 35 67 C35 59 40 55 44 49 '
         'C45 55 48 58 51 58 C48 50 48 41 51 33 Z')
GRAD = ('<linearGradient id="hot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFB000"/>'
        '<stop offset="0.5" stop-color="#FF4D2E"/><stop offset="1" stop-color="#FF2D78"/></linearGradient>')


def brand_mark(x, y, size):
    return place(f'<path d="{DROP}" fill="url(#hot)"/><path d="{FLAME}" fill="#0B0B0F"/>', x, y, size)


def wordmark_paths(height=100):
    f = font('black')
    parts = [('THE ', '#FFFFFF'), ('HOT ', 'url(#hot)'), ('DROPIC', '#FFFFFF')]
    x, out = 0.0, ''
    size = height / 0.72
    for text, fill in parts:
        d, adv, _ = f.path(text, size, x, height, 0.01)
        out += f'<path d="{d}" fill="{fill}"/>'
        x += adv + 0.01 * size
    return out, x


def make_brand():
    words, ww = wordmark_paths(100)
    w = int(130 + ww + 10)
    logo = svg_doc(f'{brand_mark(0, -8, 118)}<g transform="translate(130 0)">{words}</g>', w, 112, GRAD)
    (ROOT / 'public/img').mkdir(parents=True, exist_ok=True)
    (ROOT / 'public/img/logo.svg').write_text(logo + '\n')
    fav = svg_doc(f'<rect width="100" height="100" rx="22" fill="#0B0B0F"/>{brand_mark(10, 8, 80)}', 100, 100, GRAD)
    (ROOT / 'public/favicon.svg').write_text(fav + '\n')
    for size, rel, pad in ((512, 'public/icons/icon-512.png', 0.16), (192, 'public/icons/icon-192.png', 0.16),
                           (180, 'public/icons/apple-touch-icon.png', 0.14), (32, 'public/icons/favicon-32.png', 0.06)):
        m = size * pad
        img = render(f'<rect width="{size}" height="{size}" fill="#0B0B0F"/>{brand_mark(m, m * 0.85, size - 2 * m)}', size, size, GRAD)
        save(img, rel, 'PNG', optimize=True)
    # social preview 1200x630
    W, H = 1200, 630

    def left(fkey, text, x, top, max_w, max_h=None):
        f = font(fkey)
        _, _, bb0 = f.path(text, 1000)
        k = max_w / (bb0[2] - bb0[0])
        if max_h:
            k = min(k, max_h / (bb0[3] - bb0[1]))
        d, _, _ = f.path(text, 1000 * k, x - bb0[0] * k, top - bb0[1] * k)
        return d
    head1 = left('black', "What's hot", 64, 190, 560, 120)
    head2 = left('black', 'right now.', 64, 335, 560, 120)
    sub = left('bold', 'Meme tees, viral gadgets, room glow-ups.', 66, 492, 520)
    sub2 = left('bold', 'Auto-updated with the trends.', 66, 540, 390)
    body = (f'<rect width="{W}" height="{H}" fill="#0B0B0F"/>'
            f'<circle cx="960" cy="150" r="440" fill="url(#glow)"/>'
            f'<g transform="translate(64 60) scale(0.42)">{brand_mark(0, -8, 118)}<g transform="translate(130 0)">{words}</g></g>'
            f'<path d="{head1}" fill="#FFFFFF"/><path d="{head2}" fill="url(#hot2)"/>'
            f'<path d="{sub}" fill="#B9BCC6"/><path d="{sub2}" fill="#B9BCC6"/>')
    defs = (GRAD + '<radialGradient id="glow"><stop offset="0" stop-color="#FF4D2E" stop-opacity="0.45"/>'
            '<stop offset="1" stop-color="#FF4D2E" stop-opacity="0"/></radialGradient>'
            '<linearGradient id="hot2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFB000"/>'
            '<stop offset="0.5" stop-color="#FF4D2E"/><stop offset="1" stop-color="#FF2D78"/></linearGradient>')
    og = render(body, W, H, defs)
    cards = [('public/img/products/fih-tee-black.jpg', -6, 640, 150), ('public/img/products/bicep-heart-hoodie-black.jpg', 5, 880, 230)]
    for rel, rot, x, y in cards:
        pth = ROOT / rel
        if not pth.exists():
            continue
        im = Image.open(pth).convert('RGBA').resize((300, 300), Image.LANCZOS)
        mask = Image.new('L', im.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 299, 299), 28, fill=255)
        im.putalpha(mask)
        im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
        og.alpha_composite(im, (x - im.width // 2 + 150, y - 40))
    save(og.convert('RGB'), 'public/og.png', 'PNG', optimize=True)
    print('brand: public/img/logo.svg, public/favicon.svg, public/icons/*, public/og.png')


def sheet(ids):
    thumbs = []
    for rel in sorted((ROOT / 'public/img/products').glob('*.jpg')):
        if not ids or any(rel.name.startswith(i + '-') for i in ids):
            thumbs.append(Image.open(rel).resize((260, 260)))
    cols = 6
    rows = max(1, math.ceil(len(thumbs) / cols))
    s = Image.new('RGB', (cols * 260, rows * 260), 'white')
    for i, t in enumerate(thumbs):
        s.paste(t, ((i % cols) * 260, (i // cols) * 260))
    s.save('/tmp/designs-sheet.png')
    print(f'/tmp/designs-sheet.png ({len(thumbs)} mockups)')


def main(argv):
    data = json.loads((ROOT / 'catalog/designs.json').read_text())
    if '--brand' in argv:
        make_brand()
        return
    ids = [a for a in argv if not a.startswith('--')]
    force = '--force' in argv or bool(ids)
    known = {d['id'] for d in data['designs']}
    for i in ids:
        if i not in known:
            sys.exit(f'Unknown design id: {i}')
    for d in data['designs']:
        if ids and d['id'] not in ids:
            continue
        missing = [k for k in ('text', 'accent', 'accent2') for v in d['colors'].values() if k not in d['palette'].get(v, {})]
        if missing or d['art']['recipe'] not in RECIPES:
            sys.exit(f'{d["id"]}: bad palette or recipe')
        for line in make_design(d, data['styles'], force):
            print(line)
    if '--sheet' in argv:
        sheet(ids)


if __name__ == '__main__':
    main(sys.argv[1:])
