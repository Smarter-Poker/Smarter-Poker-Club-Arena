/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SPIN LEVEL IS STORED IN SECONDS, AND THE SERVICE READ IT AS MINUTES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `blind_structure` spells a level's length three ways.
 * `durationMinutes` / `duration_minutes` are minutes; `duration` is SECONDS,
 * and every Spin is written that way — `createSpin` stores `duration: 180` for
 * a three-minute level and no minutes key at all.
 *
 * `TournamentService.getCurrentLevelState` read `.durationMinutes` directly at
 * four sites, so for a Spin it produced:
 *
 *   pre-start clock   `undefined * 60`         -> NaN
 *   running clock     `(undefined || 10) * 60` -> 600s for a 180s level
 *   wall-clock walk   `undefined * 60 * 1000`  -> NaN, so the loop that walks
 *                                                 the structure never matches
 *                                                 and falls off the end
 *
 * The 600 is the one a player sees. `DetailOverviewTab`'s hero meter computes
 * `(1 - remaining / duration) * 100` against a `duration` the PAGE normalised
 * correctly to 180 — so `(1 - 600/180) * 100` is **-233%**, clamps to 0, and
 * the meter sits visibly empty for the first seven minutes of a three-minute
 * level before snapping full. The clock beside it counts down from 10:00 on a
 * level that ends at 3:00.
 *
 * `blindLevelMinutes` is the canonical reader and gets the precedence right.
 * The service goes through it now.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blindLevelMinutes } from '../../src/components/lobby/tournamentFigures';
import { sliceMethod } from '../helpers/sourceWindow';

const SERVICE = readFileSync(
  join(__dirname, '..', '..', 'src/services/TournamentService.ts'),
  'utf8'
);
const code = SERVICE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * The method, via the repo's own extractor.
 *
 * A hand-rolled "first `{` after the signature, then balance" grabbed the
 * INLINE RETURN TYPE instead of the body — this method's signature is
 * `getCurrentLevelState(t: Tournament): { currentLevel: BlindLevel; ... } {`,
 * so the first brace group is the type annotation and the assertions ran
 * against 127 characters of interface. `sliceMethod` already handles exactly
 * this; its own comment describes the trap. Use the extractor that fits
 * (tests/unit/noFixedSizeSourceWindows.test.ts says the same thing).
 *
 * The anchor follows the signature (2026-09-22): the method gained an optional
 * `nowMs` so the table HUD can measure the level against the engine's clock,
 * and Prettier now breaks the parameter list across lines. Every assertion
 * below still runs against the same body.
 */
function levelStateBody(src: string): string {
  return sliceMethod(src, 'getCurrentLevelState(\n    tournament: Tournament,');
}

describe('the canonical reader understands all three spellings', () => {
  const at = (row: Record<string, unknown>) =>
    blindLevelMinutes([row] as Parameters<typeof blindLevelMinutes>[0], 1);

  it('reads the canonical minutes keys', () => {
    expect(at({ level: 1, durationMinutes: 15 })).toBe(15);
    expect(at({ level: 1, duration_minutes: 12 })).toBe(12);
  });

  it('reads a Spin`s seconds key as SECONDS, not minutes', () => {
    // The whole bug in one line: 180 means three minutes, not three hours.
    expect(at({ level: 1, duration: 180 })).toBe(3);
  });

  it('prefers a canonical key when a row carries both', () => {
    expect(at({ level: 1, durationMinutes: 20, duration: 180 })).toBe(20);
  });

  it('returns 0 for a row that does not say, rather than guessing', () => {
    expect(at({ level: 1 })).toBe(0);
    expect(at({ level: 1, duration: 0 })).toBe(0);
  });

  it('resolves a single-row array whatever level number the row carries', () => {
    // getCurrentLevelState hands it `[level]` and asks for level 1. The
    // `find` on the row's own `level` field misses when the row says 7, and
    // the positional fallback then returns the same element.
    expect(at({ level: 7, duration: 180 })).toBe(3);
  });
});

describe('getCurrentLevelState no longer reads durationMinutes raw', () => {
  /* Sliced from the RAW source so the extractor sees real indentation, then
     stripped, because the explanatory comment inside quotes the old code. */
  const body = levelStateBody(SERVICE)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  it('found the method body', () => {
    expect(body.length).toBeGreaterThan(400);
  });

  it('routes every level length through the canonical reader', () => {
    expect(body).toMatch(/const levelMinutes =/);
    expect(body).toMatch(/blindLevelMinutes\(/);
  });

  it('has no raw `.durationMinutes` arithmetic left', () => {
    // The four sites that produced NaN and the hardcoded 10. Object LITERALS
    // that set `durationMinutes:` on a synthesized default are fine and stay —
    // they write the canonical key rather than reading an unknown one.
    const reads = body.match(/\.durationMinutes/g) || [];
    expect(reads).toEqual([]);
  });

  it('still falls back to 10 minutes for a structure that genuinely cannot say', () => {
    // Behaviour preserved for the only case the old `|| 10` was right about.
    expect(body).toMatch(/DEFAULT_LEVEL_MINUTES = 10/);
  });

  it('imports the canonical reader rather than re-implementing it', () => {
    expect(code).toMatch(
      /import \{ blindLevelMinutes \} from '\.\.\/components\/lobby\/tournamentFigures'/
    );
  });
});

describe('the hero meter arithmetic that this feeds', () => {
  /**
   * DetailOverviewTab: `levelProgress = (1 - remaining / duration) * 100`,
   * clamped to 0..100. `duration` is the page's normalised minutes*60;
   * `remaining` is what the service returns. Reproduced here so the
   * relationship is pinned, not just the service's internals.
   */
  const progress = (remainingSec: number, durationSec: number) =>
    durationSec > 0 ? Math.min(100, Math.max(0, (1 - remainingSec / durationSec) * 100)) : 0;

  it('was pinned at empty for most of a Spin level', () => {
    // The old reading: 600s remaining on a 180s level.
    expect(progress(600, 180)).toBe(0);
    // Still 0 seven minutes later, at 180s remaining of a 180s level.
    expect(progress(180, 180)).toBe(0);
  });

  it('now moves across the level', () => {
    // The corrected reading: remaining counts down from 180 on a 180s level.
    expect(progress(180, 180)).toBe(0);
    expect(Math.round(progress(90, 180))).toBe(50);
    expect(progress(0, 180)).toBe(100);
  });
});
