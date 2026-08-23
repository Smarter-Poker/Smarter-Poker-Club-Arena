import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cardBackImageUrl, normalizeCardBack, CARD_BACK_IDS } from '@/components/table/CardImage';
import { MEDIA_BASE } from '@/utils/mediaBase';

/**
 * Dan 2026-08-23: "if a player has cards, and is active in the hand... their
 * card backs should be visible until they fold. they must be visible and not
 * dimmed at all."
 *
 * Nothing was dimming them. The ART WAS 404ing. CardImage.css set
 * `--cb-image: url('/cards/backs/table/<id>.webp')` on each of the twelve
 * designs — a ROOT-relative URL, while Club Arena is served from
 * `/hub/club-arena/`. Verified against production at the time of the fix:
 *
 *   https://smarter.poker/cards/backs/table/classic_blue.webp          -> 404
 *   https://smarter.poker/hub/club-arena/cards/backs/table/...webp     -> 200
 *
 * So every seat drew the fallback gradient with no picture on it: a dark navy
 * box that on dark felt reads as an empty outline. It was silent because a
 * missing background-image logs nothing and the fallback still paints.
 *
 * The Hub root DOES have a /cards/ directory holding unrelated files, which is
 * why this never looked obviously wrong in a directory listing either.
 */
describe('card back artwork resolves under the Club Arena base', () => {
  // NOTE ON THE ASSERTION SHAPE: an earlier draft asserted the literal string
  // '/hub/club-arena/...'. That passes or fails on the ENVIRONMENT, not the
  // code — under vitest `import.meta.env.BASE_URL` is '/', so the correct
  // implementation produced '/cards/...' and the test called it a bug. What
  // matters is that the URL is BUILT FROM MEDIA_BASE rather than hardcoded, so
  // that is what is pinned.
  it('builds every card back URL from MEDIA_BASE', () => {
    for (const id of CARD_BACK_IDS) {
      expect(cardBackImageUrl(id), `${id}`).toBe(`${MEDIA_BASE}cards/backs/table/${id}.webp`);
    }
  });

  it('falls back to a real design for an unknown id, never to a 404', () => {
    expect(cardBackImageUrl('a-design-that-does-not-exist')).toBe(
      cardBackImageUrl(normalizeCardBack('a-design-that-does-not-exist'))
    );
  });

  /**
   * The stylesheet must not reintroduce the hardcoded URLs. This is the
   * mechanical half: the rule is not "remember to use mediaUrl", it is "a
   * root-relative media URL cannot exist in this file".
   */
  it('leaves no root-relative media url in CardImage.css', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/components/table/CardImage.css'),
      'utf8'
    );
    // Strip comments first — the note explaining this fix quotes the very URL
    // it is warning about, and a scanner that reads its own documentation as a
    // violation is a scanner nobody keeps.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = code.match(/url\(['"]?\/(?!hub\/club-arena\/)[^'")]+['"]?\)/g) ?? [];
    expect(
      offenders,
      'Root-relative url() cannot work: Club Arena is served from a sub-path and ' +
        'its media may be served from another origin entirely. Set the custom ' +
        'property from TS via MEDIA_BASE instead:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});
