/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLIENT HAS ONE TOURNAMENT MONEY RULE, AND IT IS payoutMath
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/services/PayoutEngine.ts` contains TWO things that look alike and are
 * not. Its PAYOUT STRUCTURE half - `payoutsForChoice`, `normalizePayouts`,
 * `generateSmoothPayouts`, `generateTopPercentPayouts`, `autoSelectPayouts`,
 * `getTemplateOptions` - deals in PERCENTAGES, is live, and is correct: the
 * tournament creation path reaches it through `payoutsForChoice`.
 *
 * Its MONEY half does not deal in percentages. It multiplies and divides
 * amounts:
 *
 *     const bountyPool = totalAmount * bountyPercentage;
 *     const baseBounty = bountyPool / playerCount;
 *
 * No cents, no unit, no residual rule. That is character for character the
 * arithmetic `src/lib/payoutMath.ts` exists to replace, and its header records
 * what that arithmetic cost when it WAS wired up: across the pool and
 * structure combinations actually used in production, 13 of 78 showed the
 * player a different number from the one that reached their wallet.
 *
 * MEASURED 2026-09-15: the money half has ZERO callers in `src/`. Every one of
 * `calculateAmounts`, `calculateICM`, `calculateBountyPayouts`,
 * `getRemainingPayouts` and `getOverlayStatus` is reached only from its own
 * unit tests. The live path never touches it, so nothing is wrong today and no
 * player has ever been shown one of its numbers.
 *
 * ─── WHY A TEST AND NOT A DELETION ──────────────────────────────────────────
 *
 * Deleting it is probably the right end state and is explicitly NOT what this
 * commit does. The estate has forty-odd unmerged branches in flight and a
 * second agent working Phase 9 inside the tournament tree; removing public
 * methods from a shared service in that state is a conflict for everyone and
 * could delete something another branch has already wired. That is a decision
 * to take once the delivery path is live and the branches have landed.
 *
 * ─── AND WHY THIS IS NOT A DETECTOR STANDING IN FOR A FIX ───────────────────
 *
 * CLAUDE.md 10.11 and 10.12 forbid shipping a watcher INSTEAD of fixing a
 * defect. There is no defect here: nothing is broken, nothing was mispaid, no
 * repair is being deferred. This is a compile-time boundary - the same kind of
 * census as `a-tournament-prize-knows-its-unit.law.test.ts` - that makes a
 * FUTURE wiring mistake impossible to make silently. Its reader is CI, and the
 * failure message says what to do instead.
 *
 * If you are here because this test went red: you wired up a money method on
 * PayoutEngine. Do not pass it a bare amount. Price the place through
 * `computePlacePrize` from `src/lib/payoutMath.ts` with the tournament's unit
 * (`tournamentRowUnitCents(tournament)` when the arena embed is in hand), and
 * delete the method you were about to call.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/sourceWindow';

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = 'src/services/PayoutEngine.ts';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Every non-test .ts/.tsx under src/, which is what "production" means here. */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * The methods that turn a structure and a pool into AMOUNTS. Percentage-only
 * helpers are deliberately absent: they carry no money and `payoutsForChoice`
 * legitimately uses them.
 */
const MONEY_METHODS = [
  'calculateAmounts',
  'calculateICM',
  'calculateBountyPayouts',
  'getRemainingPayouts',
  'getOverlayStatus',
];

/** The one live method, kept here so the test states the boundary in both directions. */
const LIVE_STRUCTURE_METHOD = 'payoutsForChoice';

describe('the client has one tournament money rule', () => {
  it('still has the file and the methods this boundary is about', () => {
    // The floor assertion. Without it a rename turns every census below into a
    // clean bill of health over nothing at all - the "answered when it could
    // not tell" shape CLAUDE.md 10.86 rule 1 is about.
    const engine = blankNonCode(read(ENGINE));
    for (const method of [...MONEY_METHODS, LIVE_STRUCTURE_METHOD]) {
      expect(
        engine,
        `PayoutEngine no longer declares ${method}. If it was deleted, delete it from this ` +
          `test's list in the same commit; if it was renamed, rename it here too. This test is ` +
          `watching a method that moved.`
      ).toMatch(new RegExp(`\\b${method}\\s*\\(`));
    }
  });

  it('never lets production call the money half', () => {
    const offenders: string[] = [];
    for (const file of productionFiles('src')) {
      if (file === ENGINE) continue; // its own internals may call its own methods
      const code = blankNonCode(read(file));
      for (const method of MONEY_METHODS) {
        if (new RegExp(`\\.${method}\\s*\\(`).test(code)) offenders.push(`${file} -> ${method}`);
      }
    }

    expect(
      offenders,
      `These files call PayoutEngine's money arithmetic:\n\n  ${offenders.join('\n  ')}\n\n` +
        `That code multiplies and divides amounts as binary floats with no unit and no residual ` +
        `rule - a Diamond event priced through it shows fractions of a Diamond, and a chip event ` +
        `shows places that do not sum to the pool. Use computePlacePrize from ` +
        `src/lib/payoutMath.ts with the tournament's unit instead, and delete the method you ` +
        `reached for.`
    ).toEqual([]);
  });

  it('keeps the structure half reachable, so this is a boundary and not a ban', () => {
    // If NOTHING called payoutsForChoice either, PayoutEngine would be wholly
    // dead and the honest answer would be deletion rather than a boundary.
    // This asserts the distinction the header draws is still real.
    const callers = productionFiles('src').filter(
      (file) =>
        file !== ENGINE &&
        new RegExp(`\\.${LIVE_STRUCTURE_METHOD}\\s*\\(`).test(blankNonCode(read(file)))
    );
    expect(
      callers.length,
      `Nothing calls ${LIVE_STRUCTURE_METHOD} any more, so every half of PayoutEngine is now ` +
        `unreachable from production. This test's premise - that the file is half live and half ` +
        `dead - no longer holds: delete the file and this test together.`
    ).toBeGreaterThan(0);
  });

  it('pins that the money half is float arithmetic, which is why it is fenced off', () => {
    // Stated as an assertion rather than a comment so that somebody who FIXES
    // the arithmetic (routing it through payoutMath with a unit) is told to
    // retire this boundary rather than leaving a stale fence behind.
    const engine = blankNonCode(read(ENGINE));
    expect(
      engine,
      `PayoutEngine's bounty split no longer divides a raw amount. If its money half now prices ` +
        `through payoutMath with a stated unit, this boundary has done its job - delete this ` +
        `test and let the census in a-tournament-prize-knows-its-unit.law.test.ts cover it.`
    ).toMatch(/bountyPool\s*\/\s*playerCount/);
  });
});
