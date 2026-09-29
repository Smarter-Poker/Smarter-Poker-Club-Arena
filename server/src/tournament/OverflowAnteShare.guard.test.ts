/**
 * THE OVERFLOW ANTE KEEPS ITS AUTHORED SHARE OF THE BIG BLIND — TypeScript
 *
 * The SQL resolver was repaired on 2026-09-20
 * (`the_overflow_ante_keeps_its_authored_share_of_the_big_blind`) and the
 * publisher was taught to refuse `ante > big_blind` on 2026-09-21
 * (`a_published_ante_never_exceeds_its_big_blind`). Neither of those is the
 * path a RUNNING tournament actually publishes from: the manager resolves its
 * own level through `resolveBlindLevel` -> `escalatedBlindLevel` ->
 * `enforcePlayableBlindLevel` in this repository, and only then calls
 * `fn_publish_tournament_blind_level` with the three numbers it computed.
 * `enforcePlayableBlindLevel` gained the SMALL BLIND's authored-share ceiling
 * on 2026-09-21 and did not gain the ANTE's, so the independent
 * `Math.min(rawAnte, MAX_BLIND_VALUE)` went on saturating the ante to the big
 * blind on a deep overflow. Equality is legal at the publisher (a big blind
 * ante), so nothing refused it.
 *
 * PRODUCTION, 2026-09-25. 158 live (non-closed) `tables` rows carried
 * `ante >= big_blind`; `ante > big_blind` was 0 everywhere, which is the
 * publisher's guard holding. 6 of the 158 are the single genuine big blind
 * ante on the board (Sunday $200 Deep Stack, authored share 1.0, source
 * `persisted`). The remaining 137 belong to 15 RUNNING events whose anchor
 * rows author 0.120, 0.125 or 0.1333 x bigBlind, and every one of them was
 * dealing ante = bigBlind:
 *
 *   Prime Time Free Buy (NLH)  65a4a06e  level 126  24,500/49,000  ante 49,000
 *   $100 Freeroll - 6:00 PM    31286c20  level 107  47,125/94,250  ante 94,250
 *   $100 Freeroll - 6:00 AM    7b4dc571  level  63  46,875/93,750  ante 93,750
 *
 * `public.fn_tournament_current_blinds` answered 6,125 / 11,781 / 11,718 for
 * those same three events at the same moment, which is what proves the
 * distortion belongs to this file and not to the resolver.
 *
 * The rule is the authored PROPORTION, read off the anchor row the level was
 * grown from, applied as a ceiling that can only ever lower an ante - and
 * never applied to a structure that authors ante = bigBlind, because
 * AnteMath.ts makes `ante >= bigBlind` the engine's TYPE TEST for a big blind
 * ante and shaving a chip off one would charge the table ante x seats.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_BLIND_VALUE,
  capLevelToChipsInPlay,
  enforcePlayableBlindLevel,
  escalatedBlindLevel,
} from './blindEscalation.js';

const ANTE_MATH = readFileSync(join(process.cwd(), 'src', 'engine', 'AnteMath.ts'), 'utf8');

/** "Prime Time Free Buy (NLH)" 65a4a06e, as production authored it. */
const PRIME_TIME_ANCHOR = { smallBlind: 40_000, bigBlind: 80_000, ante: 10_000 };
/** "DSS Friday $100 Turbo Freeroll" fd338d25, a 0.1333 share. */
const DSS_ANCHOR = { smallBlind: 750_000, bigBlind: 1_500_000, ante: 200_000 };
/** "Sunday $200 Deep Stack" 8da2c394, the one genuine big blind ante. */
const BIG_BLIND_ANTE_ANCHOR = { smallBlind: 60_000, bigBlind: 120_000, ante: 120_000 };

describe('the overflow ante keeps its authored share of the big blind', () => {
  it('holds a saturated ante to the anchor share instead of the big blind', () => {
    const saturated = {
      smallBlind: 40_000 * 1e6,
      bigBlind: 80_000 * 1e6,
      ante: 10_000 * 1e6,
    };
    const playable = enforcePlayableBlindLevel(saturated, PRIME_TIME_ANCHOR);
    expect(playable.bigBlind).toBe(MAX_BLIND_VALUE);
    expect(playable.smallBlind).toBe(MAX_BLIND_VALUE / 2);
    // 0.125 x 10,000,000, not 10,000,000.
    expect(playable.ante).toBe(1_250_000);
    expect(playable.ante).toBeLessThan(playable.bigBlind);
  });

  it('reproduces the exact production level, end to end', () => {
    // 65a4a06e at level 126 on a 30-row structure, against the 980,000 chips
    // its chip clamp measured (bb = total / 20 = 49,000).
    const level = escalatedBlindLevel(PRIME_TIME_ANCHOR, 126, 30, 2, 1.4);
    const capped = capLevelToChipsInPlay(level, 980_000);
    expect(capped.smallBlind).toBe(24_500);
    expect(capped.bigBlind).toBe(49_000);
    // What production was dealing: 49,000. What the SQL resolver answers: 6,125.
    expect(capped.ante).toBe(6_125);
    expect(capped.capped).toBe(true);
  });

  it('keeps the 0.1333 share of a different structure, not a fixed eighth', () => {
    const level = escalatedBlindLevel(DSS_ANCHOR, 70, 24, 2, 1.4);
    const capped = capLevelToChipsInPlay(level, 180_000);
    expect(capped.bigBlind).toBe(9_000);
    /* 1,199, not the resolver's 1,200. The ceiling is applied where the share
       can still be READ - on the saturated level, before the chip clamp - so
       it is floored twice: floor(10,000,000 x 200,000 / 1,500,000) = 1,333,333
       and then floor(1,333,333 x 9,000 / 10,000,000) = 1,199. The SQL resolver
       clamps first and takes the share afterwards, so it lands one chip
       higher. Both are the authored share or below, which is the whole of the
       contract: this is a CEILING, and a level one chip under it is not more
       expensive than the structure asked for. Threading the anchor through
       capLevelToChipsInPlay to recover that chip would change
       capLevelToTournamentChips' signature in TournamentManagerBase for one
       chip on an overflow ante, and the next publication re-stakes every table
       from this same answer anyway. */
    expect(capped.ante).toBe(1_199);
    expect(capped.ante).toBeLessThanOrEqual(
      Math.floor((capped.bigBlind * DSS_ANCHOR.ante) / DSS_ANCHOR.bigBlind)
    );
  });

  it('leaves a genuine big blind ante at its big blind, because the engine types on it', () => {
    expect(ANTE_MATH).toContain('ante >= bigBlind');
    expect(ANTE_MATH).toContain('authoredAsTotal');
    const saturated = {
      smallBlind: 60_000 * 1e6,
      bigBlind: 120_000 * 1e6,
      ante: 120_000 * 1e6,
    };
    const playable = enforcePlayableBlindLevel(saturated, BIG_BLIND_ANTE_ANCHOR);
    expect(playable.ante).toBe(playable.bigBlind);
    // And it survives the chip clamp as an equality, so the type test holds.
    const capped = capLevelToChipsInPlay(
      escalatedBlindLevel(BIG_BLIND_ANTE_ANCHOR, 200, 32, 2, 1.4),
      1_000_000
    );
    expect(capped.ante).toBe(capped.bigBlind);
  });

  it('is a ceiling and never a floor, and never invents an ante', () => {
    // Below the ceiling nothing moves: whole chips (2026-09-11) is not this
    // defect wearing its clothes.
    const modest = enforcePlayableBlindLevel(
      { smallBlind: 256, bigBlind: 511, ante: 64 },
      { smallBlind: 200, bigBlind: 400, ante: 50 }
    );
    expect(modest.ante).toBe(64);
    // An ante already at or under its authored share is left alone.
    const atShare = enforcePlayableBlindLevel(
      { smallBlind: 40_000 * 1e6, bigBlind: 80_000 * 1e6, ante: 900_000 },
      PRIME_TIME_ANCHOR
    );
    expect(atShare.ante).toBe(900_000);
    // A structure with no ante never acquires one.
    const anteless = capLevelToChipsInPlay(
      escalatedBlindLevel({ smallBlind: 40_000, bigBlind: 80_000, ante: 0 }, 126, 30, 2, 1.4),
      980_000
    );
    expect(anteless.ante).toBe(0);
  });

  it('never publishes an ante above its big blind on any structure or level', () => {
    const anchors = [
      PRIME_TIME_ANCHOR,
      DSS_ANCHOR,
      BIG_BLIND_ANTE_ANCHOR,
      { smallBlind: 2_000_000, bigBlind: 4_000_000, ante: 500_000 },
      { smallBlind: 250_000, bigBlind: 500_000, ante: 60_000 },
      { smallBlind: 25, bigBlind: 50, ante: 6 },
    ];
    for (const anchor of anchors) {
      for (let index = 10; index <= 500; index += 7) {
        for (const chips of [null, 180_000, 980_000, 50_000_000]) {
          const level = capLevelToChipsInPlay(
            escalatedBlindLevel(anchor, index, 24, 2, 1.4),
            chips
          );
          expect(level.ante).toBeLessThanOrEqual(level.bigBlind);
          expect(level.smallBlind).toBeLessThan(level.bigBlind);
          const authoredShare = anchor.ante / anchor.bigBlind;
          // Never above the authored share, allowing one whole chip of rounding.
          expect(level.ante).toBeLessThanOrEqual(
            Math.max(1, Math.floor(level.bigBlind * authoredShare) + 1)
          );
        }
      }
    }
  });
});
