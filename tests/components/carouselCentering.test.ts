/**
 * THE CLUB CAROUSEL IS CENTRED ON THE PAGE.
 *
 * Dan, 2026-08-22: "THIS NEEDS TO BE CENTERED TO THE PAGE, RIGHT NOW ITS LEFT
 * JUSTIFIED. 'SHARK CLUB' SHOULD BE IN THE MIDDLE WITH CARDS ON BOTH SIDES OF
 * IT."
 *
 * What broke, and why it earns a test rather than a comment:
 *
 * `.carouselScrollFade` used the full-bleed escape hatch -
 * `width: 100vw; margin-left: 50%; transform: translateX(-50%)`. Those three
 * cancel out ONLY in block layout. Its parent `.mainContent` is
 * `display: flex; flex-direction: column; align-items: center`, where the cross
 * axis is horizontal and the item is placed by centring its MARGIN box. The
 * 464px margin plus a full-viewport strip made that margin box far wider than
 * the 928px container, so centring it hung the left edge off the start and the
 * -50% transform dragged the carousel a further half viewport left. On a 1201px
 * window the strip landed ~230px left of centre while every other section on the
 * page sat centred - precisely the screenshot.
 *
 * jsdom does no layout, so no rendering test can catch this: getBoundingClientRect
 * returns zeroes and broken centring reads identical to correct centring. What
 * CAN be pinned is the CSS contract - that this element is centred by ordinary
 * means and carries no viewport-width trick whose correctness depends on its
 * parent's display mode. Reintroduce the hack and this fails, and says why.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* Resolved from the repo root rather than from import.meta.url: vitest runs
   this file through the jsdom transform, where import.meta.url is not a file:
   URL and readFileSync rejects it. process.cwd() is the project root under
   both `vitest run` and the CI job. */
const CSS = readFileSync(resolve(process.cwd(), 'src/pages/HomePage.module.css'), 'utf8');

/** Every declaration block for a selector: base rule and media overrides alike. */
function blocksFor(selector: string): string[] {
  const re = new RegExp(`(?:^|[,\\s{}])\\.${selector}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) out.push(m[1]);
  return out;
}

describe('.carouselScrollFade - the carousel stage', () => {
  const blocks = blocksFor('carouselScrollFade');

  it('exists at all', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('never uses the margin-left:50% full-bleed trick', () => {
    // This is the whole bug. The trick is silently wrong inside a flex parent,
    // and .mainContent is a flex parent.
    for (const b of blocks) {
      expect(b).not.toMatch(/margin-left\s*:\s*50%/);
      expect(b).not.toMatch(/margin\s*:[^;]*\b50%/);
    }
  });

  it('never translates itself sideways', () => {
    // translateX(-50%) was the second half of the trick. It also makes this
    // element a containing block for the cards' absolute positioning, so it is
    // not a harmless leftover even once the margin is gone.
    for (const b of blocks) {
      expect(b).not.toMatch(/translateX\s*\(\s*-?\s*50%/);
    }
  });

  it('is not sized to the viewport', () => {
    // 100vw inside a 960px-capped, overflow-clipping column bought nothing: the
    // excess was cropped the moment it existed. It only ever supplied the
    // oversized margin box that broke the centring.
    for (const b of blocks) {
      expect(b).not.toMatch(/width\s*:\s*100vw/);
    }
  });

  it('is centred by ordinary means', () => {
    const base = blocks[0];
    expect(base).toMatch(/width\s*:\s*100%/);
    expect(base).toMatch(/margin-left\s*:\s*auto/);
    expect(base).toMatch(/margin-right\s*:\s*auto/);
  });

  it('cannot collapse beneath the action console and quick-action row', () => {
    /* The stage's child is ~500px tall on desktop. With the flex-item default
       `flex-shrink: 1`, a 720px-tall viewport reduced this wrapper to 0px,
       clipped every club card, and left the following tile row intercepting
       the cards' pointer targets. .mainContent already owns vertical scroll,
       so this item must retain its measured height. */
    expect(blocks[0]).toMatch(/flex\s*:\s*0\s+0\s+auto/);
  });
});

describe('.mainContent - the parent whose display mode caused it', () => {
  it('is still the centred flex column the fix assumes', () => {
    /* If this ever stops being a flex column the reasoning above changes, and
       whoever changes it should be told by a failing test rather than by a
       screenshot of a left-justified lobby. */
    const base = blocksFor('mainContent')[0];
    expect(base).toMatch(/display\s*:\s*flex/);
    expect(base).toMatch(/flex-direction\s*:\s*column/);
    expect(base).toMatch(/align-items\s*:\s*center/);
  });
});

describe('.carouselCardFeatured - one source of truth for card width', () => {
  it('never hard-codes a width at a breakpoint', () => {
    /* `.sp-carousel__item` owns the width and derives it from the measured
       track. A clamp() here at some breakpoint desynchronises the card from its
       own slot: wider and it overlaps its neighbour, narrower and it rattles
       around inside a gap. Three such overrides existed, and they are why the
       mobile layout disagreed with the desktop one. */
    const overrides = blocksFor('carouselCardFeatured').slice(1);
    for (const b of overrides) {
      expect(b).not.toMatch(/(^|[;\s])width\s*:/);
    }
  });

  it('fills its slot in the base rule', () => {
    expect(blocksFor('carouselCardFeatured')[0]).toMatch(/width\s*:\s*100%/);
  });
});
