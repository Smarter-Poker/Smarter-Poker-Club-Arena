/**
 * LAW: the hero's hole cards are painted at full resolution whenever they are
 * at rest. Nothing may keep a resting hero card on its own compositor layer.
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, 2026-09-07, from an iPad: "THERE IS A BUG ON MOBILE THAT IS MAKING THE
 * CARDS 'BLURRY' OR 'NOT CLEAR' EVERY SO OFTEN."
 *
 * The hero's cards - only the hero's, only on a coarse-pointer viewport - came
 * out as a soft, washed-out upscale on some hands and pin-sharp on others,
 * while the board cards beside them, drawn from the same 360x504 WebP files,
 * were always crisp. Two declarations held the hero card on a permanent
 * compositor layer: `will-change: transform` on `.seat__cards--hero .seat__card`
 * inside TablePage.css's mobile "GPU hints" block (2026-03-17), and
 * `transform-style: preserve-3d` on the same card in SeatSlot.css (2026-03-10).
 * A promoted layer is rasterised at the scale WebKit sees when it is created,
 * and the card is created at the first frame of `heroCardDeal` - scale(0.94),
 * opacity 0. A layer that stays promoted is never repainted because its
 * animation ended, so which frame the layer was committed in decided whether
 * the card was sharp for the rest of the hand. That is the "every so often".
 *
 * The compositor promotes the card by itself for the 0.26s deal and the 0.38s
 * fold, and returns it to the seat's backing store - painted at device
 * resolution - when they end. A permanent hint bought nothing those windows
 * did not already get, and cost the resting card its resolution.
 *
 * The rule: a hero card may be promoted only while it is ANIMATING, by a rule
 * scoped to a transient state (`--dealing`, `--folding`, `--showdown`, the
 * squeeze while it turns). Never by a rule that matches the card at rest.
 * CardImage.css has recorded the same mechanism since 2026-08-21 ("force the
 * image onto its own compositor layer, which ... resamples and softens the
 * very edges"); this law extends it from the image to its card.
 *
 * Changelog: docs/changelog/2026-09-07-hero-cards-are-crisp-at-rest.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');

function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...cssFilesUnder(full));
    else if (name.endsWith('.css')) out.push(full);
  }
  return out;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every innermost `selector { body }` pair in a stylesheet, comments removed. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const code = stripComments(css);
  while ((m = re.exec(code))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

/**
 * A selector that can match the hero's card while it is at rest: it names the
 * hero row (or a bare seat card that the hero row's card also is) and carries
 * no transient-state scope that would limit it to an animation window.
 */
const TRANSIENT = /--dealing|--folding|--showdown|--squeeze|--discarding|\[data-/;
function matchesRestingHeroCard(selector: string): boolean {
  return selector
    .split(',')
    .map((s) => s.trim())
    .some(
      (s) =>
        (s.includes('.seat__cards--hero') || /(^|\s)\.seat__card\s*$/.test(s)) && !TRANSIENT.test(s)
    );
}

const SRC_CSS = cssFilesUnder(join(ROOT, 'src'));

describe('LAW: hero cards are crisp at rest (Dan 2026-09-07)', () => {
  it('no stylesheet keeps the resting hero card on its own compositor layer', () => {
    const offenders: string[] = [];
    for (const file of SRC_CSS) {
      for (const { selector, body } of rules(readFileSync(file, 'utf8'))) {
        if (!matchesRestingHeroCard(selector)) continue;
        const flat = selector.replace(/\s+/g, ' ');
        if (/will-change\s*:/.test(body))
          offenders.push(`${relative(ROOT, file)}: ${flat} { will-change }`);
        if (/transform-style\s*:\s*preserve-3d/.test(body))
          offenders.push(`${relative(ROOT, file)}: ${flat} { transform-style: preserve-3d }`);
        if (/translateZ\(|translate3d\(/.test(body))
          offenders.push(`${relative(ROOT, file)}: ${flat} { translateZ/translate3d }`);
        if (/backface-visibility\s*:/.test(body))
          offenders.push(`${relative(ROOT, file)}: ${flat} { backface-visibility }`);
      }
    }
    expect(offenders, 'a resting hero card must not be promoted to a compositor layer').toEqual([]);
  });

  it('the mobile GPU-hint block no longer names the hero card', () => {
    const css = stripComments(readFileSync(join(ROOT, 'src/pages/TablePage.css'), 'utf8'));
    const start = css.indexOf('@media (max-width: 768px) and (pointer: coarse)');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).not.toContain('seat__card');
    // the hints nobody has measured are still left alone on purpose
    expect(block).toContain('.pot-display');
  });

  it('the hero card still animates - the fix removed a hint, not the deal', () => {
    const css = stripComments(
      readFileSync(join(ROOT, 'src/components/table/SeatSlot.css'), 'utf8')
    );
    const heroCard = rules(css).find(
      (r) => r.selector === '.seat__cards--hero .seat__card' && /animation\s*:/.test(r.body)
    );
    expect(heroCard, 'the heroCardDeal rule must still exist').toBeDefined();
    expect(heroCard!.body).toContain('heroCardDeal');
    expect(heroCard!.body).not.toContain('preserve-3d');
    expect(heroCard!.body).not.toContain('will-change');
  });

  it('the image itself is not forced onto a layer either (CardImage.css, 2026-08-21)', () => {
    const css = stripComments(
      readFileSync(join(ROOT, 'src/components/table/CardImage.css'), 'utf8')
    );
    const img = rules(css).find((r) => r.selector === '.card-image__img');
    expect(img).toBeDefined();
    expect(img!.body).not.toMatch(/translateZ|backface-visibility|will-change/);
    expect(img!.body).toContain('image-rendering: auto');
  });
});
