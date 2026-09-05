/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TAG IS ABSOLUTE (Dan, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `stable_hand_membership_tags` says which variants a horse plays, at which
 * blinds, on which rest day, and how many tables it may sit. Four checks in
 * HorseFleetManager read it, and all four used to yield to `humanNeedsRescue`
 * - a human waiting at a short table outranked the tag.
 *
 * Dan overruled that: "THERE ARE LIKE 4 HUMAN PLAYERS CURRENTLY... NOTHING
 * REALLY MATTERS EXCEPT GETTING THIS RIGHT, SO WHEN HUMAN PLAYERS DO COME,
 * THEY DON'T SLAUGHTER THE HORSES AND WIN ALL THE CHIPS!"
 *
 * The bypass was measured on 2026-09-05 against live seats, club-scoped,
 * counting only seats taken AFTER the horse was tagged:
 *
 *   327 seats governed by a tag
 *   124 (38%) at a big blind the tag forbids
 *    79 (24%) playing a variant the tag forbids
 *   107 horses over their tagged table limit, one on 6 against a max of 4
 *
 * A rule followed 62% of the time is a preference. And the failure shape is
 * exactly the one a human notices - a 10/25 regular in a 0.50/1 game.
 *
 * THE LAW. The variant, stake, rest-day and daily-cap checks are unconditional.
 * `humanNeedsRescue` may still decide how MANY horses a table wants and which
 * pool to draw from; it may not decide WHETHER a horse is allowed in the game.
 *
 * Registry: docs/laws.d/the-tag-is-absolute.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, 'HorseFleetManager.ts'), 'utf8');

/** Source with comments stripped - the law is about code, and the note
 *  explaining the retired bypass necessarily names it. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the tag is absolute', () => {
  it('the variant check does not yield to a waiting human', () => {
    expect(CODE).toMatch(/if\s*\(variantOk === false\)\s*\{/);
    expect(CODE).not.toMatch(/variantOk === false && !humanNeedsRescue/);
  });

  it('the stake check does not yield to a waiting human', () => {
    expect(CODE).toMatch(/if\s*\(stakeOk === false\)\s*\{/);
    expect(CODE).not.toMatch(/stakeOk === false && !humanNeedsRescue/);
  });

  it('the rest day and the daily cap do not yield either', () => {
    expect(CODE).toMatch(/if\s*\(isRestDayFor\(/);
    expect(CODE).toMatch(/if\s*\(dailyCapReached\(/);
    expect(CODE).not.toMatch(/!humanNeedsRescue && isRestDayFor/);
    expect(CODE).not.toMatch(/!humanNeedsRescue && dailyCapReached/);
  });

  it('no tag gate anywhere is conditioned on humanNeedsRescue', () => {
    // The general form, so a fifth gate cannot be added with the old shape.
    // humanNeedsRescue is still allowed to size the fill and widen the pool -
    // it just cannot decide whether a horse may be in this game at all.
    const offenders = CODE.split('\n').filter(
      (l) =>
        l.includes('humanNeedsRescue') &&
        /(variantOk|stakeOk|isRestDayFor|dailyCapReached|tagAllows)/.test(l)
    );
    expect(
      offenders,
      `a tag gate is still conditioned on a waiting human:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('humanNeedsRescue still does the job it legitimately has', () => {
    // Sizing the fill and widening the candidate pool are not tag gates, and
    // deleting them would strand a short table with a person sitting at it.
    expect(CODE).toMatch(/fill !== 'full' && !humanNeedsRescue/);
    expect(CODE).toMatch(/pool\.length < emptySeats\.length && humanNeedsRescue/);
  });
});
