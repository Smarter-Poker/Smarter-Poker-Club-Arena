/**
 * The avatar constant and the CSS box that draws it must be the same number.
 *
 * This has now gone wrong twice in a week - 96 in the component against a 76px
 * box, then 76 against a 60px box - and neither TypeScript nor any renderer
 * test can see it, because one number lives in a .tsx and the other in a .css.
 * The consequences are real both ways: the value is passed to
 * getAvatarWithFallback (so a too-large number over-fetches the image on a
 * phone) AND written as the intrinsic width/height attributes (so a wrong one
 * misreports the layout size to the browser before the stylesheet loads).
 *
 * The size itself is Dan's, 2026-08-27: "double the size of the current
 * avatar". It was 48. Double is 96. It shipped at 60 for a week, which is why
 * the expected value is asserted here and not merely cross-checked - a future
 * "tidy-up" that shrinks the box would otherwise pass by shrinking both.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const TSX = readFileSync(join(ROOT, 'src/components/bbj/BBJRecentHits.tsx'), 'utf8');
const CSS = readFileSync(join(ROOT, 'src/components/bbj/BBJRecentHits.css'), 'utf8');

/**
 * Every width any `.bbj-hits__avatar` rule declares, in source order.
 *
 * Not "the first rule": the selector appears more than once on purpose - an
 * early grid-area assignment carries no width at all, then the sizing rule,
 * then the narrow-phone override. Reading only the first block found nothing
 * and reported a missing width, which is a test failing for its own reason
 * rather than the code's.
 */
function avatarWidths(): number[] {
  const widths = [...CSS.matchAll(/\.bbj-hits__avatar \{[^}]*?width:\s*(\d+)px/gs)].map((m) =>
    Number(m[1])
  );
  expect(widths.length, '.bbj-hits__avatar declares no width anywhere').toBeGreaterThan(0);
  return widths;
}

/** The base size, i.e. the one outside any media query. */
function baseAvatarWidth(): number {
  return avatarWidths()[0];
}

describe('BBJ winner avatar sizing', () => {
  it('the component constant equals the CSS box', () => {
    const m = TSX.match(/const BBJ_AVATAR_PX = (\d+);/);
    expect(m, 'BBJ_AVATAR_PX is missing').not.toBeNull();
    expect(Number(m![1])).toBe(baseAvatarWidth());
  });

  it('is double the 48px it replaced, as asked', () => {
    expect(baseAvatarWidth()).toBe(96);
  });

  it('the avatar column is at least as wide as the avatar', () => {
    // A 96px image in a 60px track is squeezed by the grid, which reads as a
    // different (smaller) avatar no matter what the width attribute says.
    const m = CSS.match(/grid-template-columns:\s*(\d+)px minmax/);
    expect(m, '.bbj-hits__row has no explicit avatar track').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(baseAvatarWidth());
  });

  it('the narrow-phone breakpoint never shrinks below the original 48', () => {
    // The breakpoint used to drop it back TO 48, undoing the instruction
    // entirely on exactly the phones this product is mostly read on.
    const widths = avatarWidths();
    expect(widths.length).toBeGreaterThan(1);
    for (const w of widths) expect(w).toBeGreaterThan(48);
  });
});
