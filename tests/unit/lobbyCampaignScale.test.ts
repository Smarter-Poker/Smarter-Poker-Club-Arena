/**
 * THE LOBBY AD IS NEVER CROPPED (Dan 2026-09-01)
 *
 * "the 'dynamic ad image' is cut off, and it needs to scale to size. because
 * when you 'shrink the page' it fits perfectly."
 *
 * The bug was a 3:1 image (`shark-club-championship-ad-v2.png`, 2172 x 724)
 * shown with `object-fit: cover` inside a bay that is roughly 11:1 on desktop.
 * Cover kept the middle 28% of the artwork's height and threw away the top of
 * the trophy and the entire buy-in line. Below 900px the same ad was already
 * served from the tight 2172 x 302 crop into a bay of that exact aspect ratio,
 * which is the "shrink the page and it fits perfectly" Dan was describing.
 *
 * These pins are the two halves of the fix. If either goes red, the ad is
 * being cropped again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const TOP_CSS = readFileSync(resolve(ROOT, 'src/components/lobby/ClubLobbyCommandTop.css'), 'utf8');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/ClubHomePage.tsx'), 'utf8');

/**
 * The desktop block that owns the campaign bay, found by its own header
 * comment rather than by being the last `@media (min-width: 901px)` in the
 * file. Slicing on `lastIndexOf` is exactly what made
 * `lobbyUnionCreateControls.test.ts` go red when this block was appended
 * beneath the deck lock - `display: contents` had not moved a character - and
 * this file would have inherited the same fragility the moment anyone appended
 * a desktop block below it. `.club-lobby-command-top__campaign` alone is not
 * an anchor: eighteen blocks declare it.
 */
/**
 * Every `@media (max-width: ...)` body in the sheet, concatenated.
 *
 * Written as a brace matcher rather than a `split` because this stylesheet
 * interleaves its breakpoints - `min-width: 901px` appears at four separate
 * points, the first of them BEFORE any of the mobile campaign rules - so
 * slicing on the desktop query would silently examine an empty string and
 * pass. It also carries three copies of the mobile campaign bay, and the
 * cascade between them has been reordered before, so the pins below are
 * deliberately stated against all of them at once.
 */
function mobileMediaBodies(css: string): string {
  const bodies: string[] = [];
  const opener = /@media ([^{]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(css))) {
    if (!/max-width/.test(match[1])) continue;
    let depth = 1;
    let i = opener.lastIndex;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    bodies.push(css.slice(opener.lastIndex, i));
  }
  return bodies.join('\n');
}

const MOBILE = mobileMediaBodies(TOP_CSS);

const bayAnchor = TOP_CSS.indexOf('DESKTOP CAMPAIGN BAY');
const bayOpen = TOP_CSS.indexOf('@media (min-width: 901px)', bayAnchor);
const bayEnd = TOP_CSS.indexOf('@media', bayOpen + 1);
const finalDesktop = TOP_CSS.slice(bayOpen, bayEnd === -1 ? undefined : bayEnd);

describe('desktop lobby campaign bay', () => {
  it('sizes the bay to the artwork it serves rather than a fixed pixel height', () => {
    expect(finalDesktop).toMatch(
      /\.club-lobby-command-top__campaign\s*\{[^}]*aspect-ratio:\s*2172 \/ 302/s
    );
  });

  it('never crops the ad: contain, never cover', () => {
    expect(finalDesktop).toMatch(
      /\.club-lobby-command-top__campaign-button img\s*\{[^}]*object-fit:\s*contain/s
    );
    expect(finalDesktop).not.toMatch(
      /\.club-lobby-command-top__campaign-button img\s*\{[^}]*object-fit:\s*cover/s
    );
  });

  it('never lets a phone bay put the ratio on a padded box again', () => {
    /*
     * Dan, 2026-09-02: "THE LIVE DYNAMIC ADD IS CUT OFF ON THE BOTTOM, MAKE
     * SURE THE FRAME ALLOWS THE ENTIRE FRAME AND ADD TO BE DISPLAYED."
     *
     * The pins above did not cover the phone, which cropped for a different
     * reason. `aspect-ratio` sizes the BORDER box, so a well carrying
     * `padding: 5px 10px 7px` offered its child a content box 13px shorter
     * and 20px narrower than 2172/302 - about 10px less height than the
     * artwork needs at that width. The ratio belongs on the button, the
     * element that draws the frame around the art, so frame and artwork are
     * the same shape by construction.
     */
    expect(MOBILE).not.toMatch(
      /\.club-lobby-command-top__campaign\s*\{[^}]*aspect-ratio:\s*2172 \/ 302/s
    );
    expect(MOBILE).toMatch(
      /\.club-lobby-command-top__campaign-button\s*\{[^}]*aspect-ratio:\s*2172 \/ 302/s
    );
  });

  it('gives the phone bay a block <picture>, so contain has a height to work with', () => {
    /*
     * An inline <picture> ignores `height: 100%`, so the img fell back to its
     * intrinsic height and overflowed the bay. `object-fit: contain` cannot
     * crop - but the well's `overflow: hidden` can, and that is what did it.
     */
    expect(MOBILE).toMatch(/\.club-lobby-command-top__campaign-picture\s*\{[^}]*display:\s*block/s);
  });

  it('never distorts the ad either: no object-fit: fill anywhere', () => {
    // Stretching the artwork to the bay is the same defect as cropping it,
    // wearing a different word.
    expect(TOP_CSS).not.toMatch(/object-fit:\s*fill/);
  });

  it('serves the tight crop at every width, not only below 900px', () => {
    expect(PAGE).toContain('shark-club-championship-ad-mobile-v4.png');
    // The tall 3:1 file is the one that could not fit this bay. It is still a
    // real asset used by the tournament surfaces, but the club lobby must not
    // reach for it again.
    expect(PAGE).not.toContain('shark-club-championship-ad-v2.png');
    // And no breakpoint-scoped <source> may reintroduce a second crop for the
    // house ad without this pin being reconsidered.
    expect(PAGE).not.toMatch(/<source media="\(max-width: 900px\)"/);
  });
});
