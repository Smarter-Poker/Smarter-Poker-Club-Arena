/**
 * LAW: THE HEADER PORTRAIT'S FRAME IS A 0.5px BLACK HAIRLINE, AND THE BAKED
 * ORNAMENT IS MASKED - AT EVERY WIDTH.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-07, with a screenshot of the artwork's chrome ring showing
 * around his photo: "the profile pic is supposed to be a .5 pixel black frame
 * that 'appears invisible' instead of this thick broken frame that exists
 * now. once you fix it back, i need you to harden it, and make it regression
 * proof."
 *
 * The same ruling, three times before:
 *   2026-08-31  remove the profile ring (#2183, #2305: "Only the live circular
 *               portrait and its nearly invisible edge remain"), 0.5px (#2366)
 *   2026-09-03  "THE FRAME IN THE GLOBAL HEADER AROUND THE PROFILE IMAGE
 *               REGRESSED AND CHANGED (INSTEAD OF HAVING THE .50 PIXEL BLACK
 *               INVISIBLE CIRCLE FRAME)."
 *   2026-09-05  "THE PROFILE PIC IN THE GLOBAL HEADER IS DISTORTED AND NOT IN
 *               ITS FRAME"
 *
 * WHY IT KEPT COMING BACK. The approved artwork bakes a silver ring with a
 * blue glow around a placeholder silhouette. On 2026-09-01 (#2515) "the
 * profile image needs to be fixed" was read as "show that ring": the black
 * disc that masked it was removed below 901px, the photo was seated in the
 * ring's aperture, and the tests were rewritten to FORBID the disc as "a shape
 * drawn over approved artwork". From then on every agent obeyed the tests: the
 * 09-03 fix restored only the hairline and left the ring; the 09-05 fix moved
 * the photo inside the ring. The ring IS the "thick broken frame" - the photo
 * and the baked ring are two circles that never agree to the pixel, so the
 * ring always reads as a chipped bezel. The treatment Dan approved has one
 * frame, the hairline, and nothing else visible around the photo.
 *
 * WHAT THIS LAW PINS - by arithmetic, not by literal, so the disc cannot be
 * nudged until the ring peeks out without failing here:
 *   1. `.profileBtn` paints an opaque #000 disc (border-radius 50%) whose
 *      geometry, resolved on the artwork's 1648x168 plane, covers the
 *      ornament's glow (r 52 around (1159.75, 80.5)) and stays off the silver
 *      rails (r 62). Every `.profileBtn` rule that touches `background`, in
 *      any media query, bottoms out in #000. Same check for the desktop band.
 *   2. `.profileAvatarSlot` declares `border: 0.5px solid rgba(0, 0, 0, 0.94)`
 *      in exactly ONE rule in the file (the base rule), so there is one copy
 *      to regress and no override can disagree with it.
 *   3. Nothing else may draw around the photo: no box-shadow or outline on
 *      the button or slot, no border on the <img>.
 *
 * "NO BOXES OVER HEADER ICONS" (2026-09-01) is about focus rings on icons. The
 * disc is Dan's mask and is that rule's one deliberate exception. If you find
 * a written rule that contradicts this one, STOP and ask Dan (CLAUDE.md 10.8);
 * do not write a third law and do not "fix" this by showing the ring.
 *
 * Rendered proof lives in tests/e2e/header-portrait-frame.spec.ts, which
 * paints the real CSS over the real artwork and samples the pixels.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CSS_PATH = 'src/components/navigation/GlobalHeader.module.css';
const RAW_CSS = readFileSync(join(ROOT, CSS_PATH), 'utf8');
const TSX = readFileSync(join(ROOT, 'src/components/navigation/GlobalHeader.tsx'), 'utf8');
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/* Measured off public/images/global-header/global-header-desktop.png, the
   1648x168 file this header renders. Radial luminance around the ornament
   centre: ring r 40-48, glow gone by r 52, black until the header's silver
   rails begin at r 62. */
const PLANE_W = 1648;
const PLANE_H = 168;
const ORNAMENT = { cx: 1159.75, cy: 80.5, glowR: 52, railR: 62 };
const DESKTOP_BAND_PX = 96;
const HAIRLINE = /border:\s*0\.5px\s+solid\s+rgba\(0,\s*0,\s*0,\s*0?\.94\)\s*;/;

type Rule = { media: string | null; body: string; decls: Map<string, string> };

/** Every `selector { ... }` block in the stylesheet, with its enclosing @media. */
function rulesFor(selector: string): Rule[] {
  const out: Rule[] = [];
  const re = new RegExp(`(^|[\\s}])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    const open = m.index + m[0].length;
    const close = CSS.indexOf('}', open);
    const body = CSS.slice(open, close);
    // the nearest unclosed @media before this rule, if any
    let media: string | null = null;
    const before = CSS.slice(0, m.index);
    const mediaRe = /@media\s*([^{]+)\{/g;
    let mm: RegExpExecArray | null;
    while ((mm = mediaRe.exec(before))) {
      let depth = 1;
      for (let i = mm.index + mm[0].length; i < before.length && depth > 0; i++) {
        if (before[i] === '{') depth++;
        else if (before[i] === '}') depth--;
      }
      media = depth > 0 ? mm[1].trim() : media;
    }
    const decls = new Map<string, string>();
    for (const d of body.split(';')) {
      const idx = d.indexOf(':');
      if (idx > 0)
        decls.set(
          d.slice(0, idx).trim(),
          d
            .slice(idx + 1)
            .trim()
            .replace(/\s*!important$/, '')
        );
    }
    out.push({ media, body, decls });
  }
  return out;
}

const pct = (v: string | undefined, what: string): number => {
  expect(v, `${what} must be declared as a percentage`).toMatch(/^-?\d+(\.\d+)?%$/);
  return parseFloat(v!);
};

const btnRules = rulesFor('.profileBtn');
const slotRules = rulesFor('.profileAvatarSlot');
const base = btnRules.find((r) => r.media === null);
const desktop = btnRules.find((r) => /min-width:\s*901px/.test(r.media || ''));
const baseSlot = slotRules.find((r) => r.media === null);

describe('the header portrait frame is a hairline: the ornament is masked', () => {
  it('the profile button is an opaque black disc, centred on the ornament, covering its glow and clear of the rails', () => {
    expect(base, '.profileBtn base rule must exist').toBeTruthy();
    expect(base!.decls.get('background')).toBe('#000');
    expect(base!.decls.get('border-radius')).toBe('50%');
    expect(base!.decls.get('aspect-ratio')).toBe('1');
    expect(base!.decls.get('position')).toBe('absolute');

    // Resolve the disc on the artwork plane. The controls plane has the
    // artwork's aspect ratio, so % of width is % of 1648 and % of height is
    // % of 168; aspect-ratio 1 makes the height equal the width in units.
    const left = (pct(base!.decls.get('left'), '.profileBtn left') / 100) * PLANE_W;
    const top = (pct(base!.decls.get('top'), '.profileBtn top') / 100) * PLANE_H;
    const size = (pct(base!.decls.get('width'), '.profileBtn width') / 100) * PLANE_W;
    const r = size / 2;
    const offset = Math.hypot(left + r - ORNAMENT.cx, top + r - ORNAMENT.cy);

    // Covers the ring and its glow from every direction...
    expect(
      r - offset,
      'disc must cover the ornament glow (r 52) from its centre'
    ).toBeGreaterThanOrEqual(ORNAMENT.glowR + 2);
    // ...and never reaches the silver rails above and below it.
    expect(r + offset, 'disc must stay off the header rails (r 62)').toBeLessThanOrEqual(
      ORNAMENT.railR - 2
    );
  });

  it('every .profileBtn rule that paints a background, in any media query, bottoms out in #000', () => {
    expect(btnRules.length).toBeGreaterThanOrEqual(1);
    for (const rule of btnRules) {
      const bg = rule.decls.get('background');
      if (bg !== undefined)
        expect(bg, `in @media ${rule.media ?? '(none)'}`).toMatch(/(^|,\s*)#000$/);
      expect(rule.decls.get('background-color') ?? '#000').toBe('#000');
      expect(rule.decls.get('background-image') ?? 'none').toBe('none');
      for (const banned of [
        'opacity',
        'visibility',
        'display',
        'mix-blend-mode',
        'mask',
        'clip-path',
        'box-shadow',
        'outline',
      ]) {
        expect(
          rule.decls.has(banned),
          `${banned} on .profileBtn in @media ${rule.media ?? '(none)'}`
        ).toBe(false);
      }
      if (rule.decls.has('border-radius')) expect(rule.decls.get('border-radius')).toBe('50%');
    }
    // The shared .artButton:focus-visible glow would replace the black on
    // keyboard focus and show the ring for as long as the button is focused.
    const focus = rulesFor('.profileBtn:focus-visible');
    expect(
      focus.length,
      '.profileBtn:focus-visible must layer its glow over #000'
    ).toBeGreaterThanOrEqual(1);
    for (const rule of focus) expect(rule.decls.get('background')).toMatch(/,\s*#000$/);
  });

  it('the desktop band keeps the same mask: an ellipse that covers the squashed ornament and stays off both rails', () => {
    expect(desktop, '.profileBtn must have a @media (min-width: 901px) rule').toBeTruthy();
    expect(desktop!.decls.get('aspect-ratio')).toBe('auto');
    const topPct = pct(desktop!.decls.get('top'), 'desktop .profileBtn top');
    const heightPct = pct(desktop!.decls.get('height'), 'desktop .profileBtn height');
    const widthPct = pct(
      desktop!.decls.get('width') ?? base!.decls.get('width'),
      '.profileBtn width'
    );

    // object-fit: fill squashes the 168-unit plane into 96px; x keeps the
    // viewport's scale. Check the narrowest and the authority viewport.
    const yScale = DESKTOP_BAND_PX / PLANE_H;
    const glowY = ORNAMENT.glowR * yScale;
    const railY = ORNAMENT.railR * yScale;
    const ornamentY = ORNAMENT.cy * yScale;
    const b = ((heightPct / 100) * DESKTOP_BAND_PX) / 2;
    const centreY = (topPct / 100) * DESKTOP_BAND_PX + b;
    const dy = Math.abs(centreY - ornamentY);
    expect(b - dy, 'desktop disc must cover the glow vertically').toBeGreaterThanOrEqual(glowY + 1);
    expect(b + dy, 'desktop disc must stay off the rails vertically').toBeLessThanOrEqual(
      railY - 1
    );

    for (const viewport of [901, 1280, 1680, 2560]) {
      const xScale = viewport / PLANE_W;
      const a = ((widthPct / 100) * viewport) / 2;
      const leftPct = pct(
        desktop!.decls.get('left') ?? base!.decls.get('left'),
        '.profileBtn left'
      );
      const centreX = (leftPct / 100) * viewport + a;
      const dx = Math.abs(centreX - ORNAMENT.cx * xScale);
      expect(
        a - dx,
        `desktop disc must cover the glow horizontally at ${viewport}px`
      ).toBeGreaterThanOrEqual(ORNAMENT.glowR * xScale + 1);
    }
  });

  it('the slot declares the 0.5px hairline exactly once, in the base rule, and it is a circle', () => {
    expect(baseSlot, '.profileAvatarSlot base rule must exist').toBeTruthy();
    expect(baseSlot!.body).toMatch(HAIRLINE);
    expect(baseSlot!.decls.get('border-radius')).toBe('50%');
    expect(baseSlot!.decls.get('aspect-ratio')).toBe('1');
    expect(baseSlot!.decls.get('overflow')).toBe('hidden');
    expect(baseSlot!.decls.get('background')).toBe('transparent');

    const withBorder = slotRules.filter((r) =>
      /(^|[\s;])border(-(top|right|bottom|left|width|color|style))?\s*:/.test(r.body)
    );
    expect(
      withBorder.length,
      'exactly one .profileAvatarSlot rule may declare the border - one copy to regress'
    ).toBe(1);
    expect(withBorder[0].media).toBeNull();
    expect(
      CSS.match(/border:\s*0?\.5px/g)?.length,
      'the half-pixel edge belongs to the slot alone'
    ).toBe(1);

    // The photo sits inside the disc with black around it - never the disc's
    // full width, or the photo's own edge lands on the artwork again.
    const width = pct(baseSlot!.decls.get('width'), '.profileAvatarSlot width');
    expect(width).toBeGreaterThanOrEqual(65);
    expect(width).toBeLessThanOrEqual(80);
    for (const rule of slotRules) {
      for (const banned of ['box-shadow', 'outline', 'filter', 'mix-blend-mode']) {
        expect(rule.decls.has(banned), `${banned} on .profileAvatarSlot`).toBe(false);
      }
      const w = rule.decls.get('width');
      if (w && w !== 'auto') expect(parseFloat(w)).toBeLessThanOrEqual(80);
      const h = rule.decls.get('height');
      if (h && h !== 'auto') expect(parseFloat(h)).toBeLessThanOrEqual(90);
    }
  });

  it('nothing else draws around the photo: the image is borderless, round and covers', () => {
    const img = rulesFor('.profileAvatarSlot > .profileAvatar');
    expect(img.length).toBeGreaterThanOrEqual(1);
    for (const rule of img) {
      expect(rule.decls.get('border')).toBe('0');
      expect(rule.decls.get('border-radius')).toBe('50%');
      expect(rule.decls.get('object-fit')).toBe('cover');
      expect(rule.decls.has('box-shadow')).toBe(false);
      expect(rule.decls.has('outline')).toBe(false);
    }
    // button > slot > img, and the slot is the only thing the button paints.
    expect(TSX).toMatch(
      /className=\{`\$\{styles\.artButton\} \$\{styles\.profileBtn\}`\}[\s\S]*?<span className=\{styles\.profileAvatarSlot\}[^>]*>\s*<img[\s\S]*?className=\{styles\.profileAvatar\}/
    );
    expect(TSX).not.toMatch(/profileFrameOverlay|profileRing/);
  });

  it('the law is written where the next agent will read it', () => {
    // The explanation is what stops the disc being read as "a shape drawn over
    // approved artwork" and deleted again. It stays with the rule.
    expect(RAW_CSS).toContain(
      'THE PROFILE FRAME IS A 0.5px BLACK HAIRLINE. THE BAKED ORNAMENT IS MASKED.'
    );
    expect(RAW_CSS).toContain("'appears invisible'");
    expect(RAW_CSS).toContain('tests/the-header-portrait-frame-is-a-hairline.law.test.ts');
  });
});
