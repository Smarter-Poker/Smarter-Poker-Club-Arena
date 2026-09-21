/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  `current_level` IS A 0-BASED INDEX, AND FOUR FILES HAVE NOW GOT IT WRONG
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE CONVENTION, established by the engine and not negotiable from the client:
 *
 *   server/src/tournament/TournamentManagerBase.ts
 *     blindStructure[this.currentLevel]              <- it INDEXES with it
 *     .update({ current_level: this.currentLevel })  <- it STORES what it indexed
 *
 * and the stored structures number their own `level` field from 1, so element 0
 * reads `level: 1`.
 *
 * Therefore: to INDEX a structure, use the COLUMN as-is. To DISPLAY a level
 * number, add one. `tournamentLevel()` in components/lobby/tournamentFigures.ts
 * is the canonical converter and carries the production evidence.
 *
 * ── THE BUS PAYLOAD IS THE OTHER UNIT (corrected 2026-08-29) ─────────────────
 *
 * This header used to end the paragraph above with "`BLIND_LEVEL_CHANGE.level`
 * is the SAME number — TournamentTimerService writes one variable to both the
 * column and the payload." IT DOES NOT, and that sentence is the reason the bug
 * spread: `handleLevelChange` computes `const displayLevel = newLevel + 1`,
 * writes the raw 0-based `newLevel` to the column and emits `displayLevel` on
 * the bus. Two units, one name.
 *
 * All three consumers had guessed, and all three had guessed wrong the same
 * way — each carrying a comment repeating the claim above:
 *
 *   TournamentDetails  wrote the payload straight into `current_level`,
 *                      corrupting the object every tab on the page reads
 *   TournamentClock    added one to an already-1-based number, so the 2026-08-26
 *                      fix below turned a projector clock that flashed one level
 *                      BACKWARDS into one that flashed one level FORWARD
 *   BlindsTab          indexed the structure with it and showed the NEXT level's
 *                      blinds from the instant the engine advanced
 *
 * The contract now lives on the payload type in src/core/MasterBus.ts, where a
 * reader will find it without having to trace the emitter.
 *
 * THE INCIDENTS. This has now been fixed four separate times, in four files,
 * for the same reason each time — someone read `current_level` and assumed the
 * name meant what it says:
 *
 *   2026-08-25  tournamentFilters   late-reg window compared against the index
 *   2026-08-25  TournamentInfoPanel blind_structure[current_level].level
 *   2026-08-25  tournamentFigures   the lobby card sat one level behind
 *   2026-08-26  BlindsTab           printed Level 5 while Overview printed 6,
 *                                   off the same row, one tap apart
 *   2026-08-26  RankingTab          every BB count inflated 40-60%
 *   2026-08-26  TournamentClock     the projector clock flashed BACKWARDS one
 *                                   level on every level-up
 *
 * Dan reported the visible half of this on 2026-08-25 — "blind levels on the
 * screen are never increasing, still says Level 1 even though it's clearly
 * Level 2." Fixing the HUD did not fix the other three surfaces, because
 * nothing said they were the same bug.
 *
 * WHAT THIS ASSERTS. The one syntactic shape every offender shared: clamping
 * `current_level` to a MINIMUM OF 1, which is only ever correct for a level
 * NUMBER and is therefore proof the value has been misread. A file that indexes
 * correctly clamps to 0; a file that displays correctly adds 1 first.
 *
 * This is a lint rule, not a proof — a new file could still get it wrong in some
 * other shape. It catches the shape that has actually happened six times.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Comments in these files quote the very shapes the rule bans. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const sourceFiles = (): string[] =>
  execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { cwd: ROOT, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((file) => Boolean(file) && existsSync(resolve(ROOT, file)));

// Subprocess contract suite: it runs real child processes, so its wall time
// scales with machine load, not with the code under test. Slowest test here
// measured 499ms solo; vitest's 5s default is a unit-test budget and times
// out under the pre-push hook's 90-file parallel run. 90s is 180x measured,
// well above the worst contention amplification observed (7.1x).
describe(
  'current_level is treated as an index, never as a level number',
  { timeout: 90_000 },
  () => {
    /**
     * The offending shapes, both of which force a floor of 1 onto an index:
     *
     *   Number(x.current_level) || 1        <- default of 1 where 0 is meant
     *   Math.max(1, …current_level…)        <- clamped to 1 without converting
     *
     * The second needs care. `tournamentLevel` — the CANONICAL converter — reads
     * `Math.max(1, (Number(t.current_level) || 0) + 1)`, and that is correct: it
     * adds the one FIRST and then clamps, so a registering row (0 or null) reads
     * Level 1. My first draft of this rule flagged it, which is worth recording:
     * a lint rule that condemns the reference implementation is wrong about the
     * property, not about the file. The distinguishing feature is the `+ 1`.
     */
    const isOffender = (line: string): boolean => {
      if (!line.includes('current_level')) return false;
      // A default of 1 on the raw column. The correct default is 0.
      if (/current_level\s*\)?\s*\|\|\s*1\b/.test(line)) return true;
      // Clamped to a floor of 1 without ever converting index -> number.
      if (/Math\.max\(\s*1\s*,[^\n]*current_level/.test(line) && !/\+\s*1/.test(line)) return true;
      return false;
    };

    it('no file clamps current_level to a minimum of 1', () => {
      const offenders: string[] = [];
      for (const file of sourceFiles()) {
        const src = stripComments(read(file));
        if (!src.includes('current_level')) continue;
        src.split('\n').forEach((line, i) => {
          if (isOffender(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        });
      }
      expect(
        offenders,
        'current_level is a 0-BASED INDEX into blind_structure. Clamping it to a ' +
          'minimum of 1 is only correct for a level NUMBER, so this is the signature ' +
          'of reading the index as a number — the bug fixed six times across four ' +
          'files. Index with it as-is, or convert for display with tournamentLevel() ' +
          'from components/lobby/tournamentFigures.ts:\n' +
          offenders.join('\n')
      ).toEqual([]);
    });

    it('the rule actually matches the code it was written against', () => {
      // A lint rule whose pattern matches nothing passes vacuously forever. These
      // are the exact lines that shipped, quoted from the pre-fix files.
      const shipped = [
        'const rowLevelNumber = Math.max(1, Number(row.current_level) || 1);',
        'const level = Math.max(1, Number(tournament?.current_level) || 1);',
        'const lateRegLevels = t?.late_reg_levels || t?.current_level || 1;',
      ];
      for (const line of shipped) {
        expect(isOffender(line), `should have caught: ${line}`).toBe(true);
      }
      // ...and must not fire on the correct shapes, the canonical converter first.
      for (const ok of [
        'const idx = Math.max(0, Number(tournament?.current_level) || 0);',
        'return Math.max(1, (Number(t.current_level) || 0) + 1);',
        'index: Math.max(0, Number(tournament?.current_level) || 0),',
        'const level = num(t?.current_level) + 1;',
        'if (lateLevels > 0 && Number(t.current_level || 0) < lateLevels) return true;',
      ]) {
        expect(isOffender(ok), `false positive on: ${ok}`).toBe(false);
      }
    });
  }
);

describe('the canonical converter still says what the fixes rely on', () => {
  const figures = read('src/components/lobby/tournamentFigures.ts');

  it('tournamentLevel adds one to the stored index', () => {
    // Every fix above defers to this function's contract. If someone "simplifies"
    // it back to returning the raw column, six surfaces regress at once and
    // nothing else in the suite would notice.
    expect(figures).toMatch(
      /return Math\.max\(1,\s*\(Number\(t\.current_level\)\s*\|\|\s*0\)\s*\+\s*1\)/
    );
  });
});

describe('the display path of the projector clock and the HUD agree', () => {
  it('TournamentClock converts the bus payload the same way it converts the row', () => {
    const src = stripComments(read('src/components/tournament/TournamentClock.tsx'));
    // The DB path holds an INDEX, so it converts.
    expect(src).toMatch(/currentLevel:\s*levelState\.levelIndex\s*\+\s*1/);
    /*
     * The bus path holds a DISPLAY LEVEL already, so it must NOT (corrected
     * 2026-08-29). This assertion used to require the `+ 1`, and it was wrong:
     * it was written on 2026-08-26 from the header's claim that the payload and
     * the column carry the same number, which they do not. Requiring the
     * conversion pinned the clock one level AHEAD on every level-up — the same
     * flash the 2026-08-26 fix was chasing, in the opposite direction, which is
     * exactly why that fix looked like it had worked.
     *
     * Both lines land on the same convention now: whatever `clock.currentLevel`
     * holds is what gets rendered as `LEVEL {n}`.
     */
    expect(src).toMatch(/currentLevel:\s*Math\.max\(1,\s*Number\(payload\.level\)\s*\|\|\s*1\)/);
    expect(src).not.toMatch(/Number\(payload\.level\)\s*\|\|\s*0\)\s*\+\s*1/);
  });

  it('TournamentDetails stores the bus payload as the index the column expects', () => {
    // The third consumer, and the one that did damage beyond its own render:
    // `current_level` is read by every tab off the shared tournament object.
    const src = stripComments(read('src/pages/tournament/TournamentDetails.tsx'));
    expect(src).toMatch(/current_level:\s*displayLevel - 1/);
  });

  it('TablePage converts the engine level_up index for display', () => {
    const src = stripComments(read('src/pages/TablePage.tsx'));
    expect(src).toMatch(/currentLevel:\s*lvlIdx\s*\+\s*1/);
  });
});
