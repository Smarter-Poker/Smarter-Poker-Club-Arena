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

import { blankNonCode, sliceCall } from '../helpers/sourceWindow';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE RULE REACHES THE BOUNTY AND MYSTERY SURFACES (2026-09-20)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #4938 and #4685 gave the tournament PRIZE surfaces a unit: the lobby's
 * projected ladder, the sign-up dialog, the detail overview, the info panel and
 * the rewards ladder all price a place through `placePrize` with
 * `tournamentRowUnitCents`. The BOUNTY and MYSTERY surfaces were not in that
 * pass and every one of them still printed the chip contract:
 *
 *   - a seat's bounty badge printed two decimal places for any head carrying
 *     cents, which at a Diamond table is a fraction of a Diamond the bounty
 *     bank cannot pay (`a_diamond_bounty_is_paid_from_its_own_bank`);
 *   - the knockout float beside it used `formatChipAward`, the same contract;
 *   - every mystery chest figure went through `formatCents`, which had no unit
 *     at all, so a Diamond chest advertised cents it cannot hold
 *     (`a_diamond_mystery_chest_holds_whole_diamonds`);
 *   - the ranking card, the session summary, the results table and the
 *     celebration each printed a prize or a bounty with their own local chip
 *     formatter and, in several places, with NO NOUN, so a Diamond figure did
 *     not even say what it was.
 *
 * NOTHING WAS EVER SHOWN WRONG TO A PLAYER, and this says so rather than
 * implying otherwise: zero Diamond tournaments have ever existed and
 * `ca_arena_settings.tournaments_enabled` is false. Like
 * `aDiamondEventIsPricedInDiamonds`, this is the gap closing BEFORE the switch.
 *
 * ─── WHY A SOURCE PIN AND NOT ONLY A UNIT TEST ──────────────────────────────
 *
 * The arithmetic is covered by `aDiamondEventIsPricedInDiamonds`. What a unit
 * test cannot see is a SURFACE that never asks. Every defect above was a
 * correct formatter called by a component that had not read a club row, which
 * is the exact shape `a-tournament-prize-knows-its-unit.law.test.ts` was
 * written about one level down. So each file below is pinned two ways: it must
 * name a unit source, and the unitless expression it used to print money with
 * must be gone. The failure message names the replacement, so a red pin tells
 * the next agent what to do instead of only that something moved.
 *
 * `SeatKnockout.tsx` is on the list and carries NO assertion about a unit,
 * because it prints no money: it announces `<name> Knocked Out` and stamps the
 * seat, and the award that ships with it is TablePage's float. That is asserted
 * rather than assumed, so "it needed no change" stays a measured fact.
 */
/**
 * How many top-level arguments a sliced call carries. Brackets nest; commas
 * inside them do not count, so `Math.round(x * 100)` and `{ a, b }` are one
 * argument each.
 *
 * The same counter `a-tournament-prize-knows-its-unit.law.test.ts` uses, and
 * deliberately a second copy rather than a shared export: it is twenty lines of
 * test scaffolding, not a money rule, and moving it would edit a helper that
 * thirty other source pins in this repo read. If you change one, the other is
 * independent and stays correct on its own terms.
 */
function argumentCount(call: string): number {
  const code = blankNonCode(call);
  const open = code.indexOf('(');
  let depth = 0;
  let args = 1;
  let sawContent = false;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) args++;
    else if (depth >= 1 && ch.trim() !== '') sawContent = true;
  }
  return sawContent ? args : 0;
}

describe('the bounty and mystery surfaces state their unit', () => {
  /** A source that names a unit at all. Any of these is a read, not a guess. */
  const UNIT_SOURCES = [
    'unitCents',
    'tournamentRowUnitCents',
    'arenaAssetUnitCents',
    'UNIT_CENTS_ASSET_NOT_READ',
    'DIAMOND_UNIT_CENTS',
  ];

  /**
   * The surfaces, each with the unitless expression that must not come back.
   * `gone` is matched against code with comments and strings blanked, so the
   * explanatory notes beside each change cannot satisfy or break a pin.
   */
  const SURFACES: Array<{ file: string; gone: string[]; instead: string }> = [
    {
      file: 'src/components/table/SeatSlot.tsx',
      gone: ['maximumFractionDigits: 2,\n            })} Chips`'],
      instead:
        'the badge branches on bountyUnitCents and prints formatPrizeAtUnit at a Diamond table',
    },
    {
      file: 'src/pages/TablePage.tsx',
      gone: ['formatChipAward(amount)'],
      instead: 'formatAwardAtUnit(amount, feltUnitCentsRef.current)',
    },
    {
      file: 'src/components/tournament/TournamentRankingCard.tsx',
      gone: [
        'formatMoney(result.prize || 0)',
        'formatMoney(result.bountyWinnings)',
        'formatMoney(mysteryCents / 100)',
        'formatMoney(largestMysteryCents / 100)',
      ],
      instead: 'moneyAtUnit(<amount>, unitCents), with unitCents supplied by TournamentRankingHost',
    },
    {
      file: 'src/components/session/SessionSummaryHost.tsx',
      gone: [
        'formatChips(t.prize)',
        'formatChips(t.bountyWinnings)',
        'formatChips(mysteryCents / 100)',
        'formatChips(mysteryLargestCents / 100)',
      ],
      instead: 'chipsAtUnit(<amount>, unitCents) with moneySuffixAtUnit beside it',
    },
    {
      file: 'src/pages/tournament/TournamentResultsPage.tsx',
      gone: ['formatAmount(r.prize)', 'formatAmount(r.bounty_winnings)'],
      instead: "unitAmount(<amount>), built on the row's own arena embed",
    },
    {
      file: 'src/components/tournament/MysteryBountyPanel.tsx',
      gone: ['Chip Pool'],
      instead: 'moneyAdjectiveAtUnit(unitCents) before the word Pool',
    },
    {
      file: 'src/components/tournament/MysteryBountyCelebration.tsx',
      gone: ['Worth ${money(amount)}'],
      instead: 'a figure at unitCentsRef.current, with moneySuffixAtUnit naming it',
    },
    {
      file: 'src/services/MysteryBountyService.ts',
      gone: ['export function formatCents(cents: number | null | undefined): string'],
      instead: 'formatCents(cents, unitCents), whose unit is required and undefaulted',
    },
    {
      file: 'src/components/tournament/details/RewardsTab.tsx',
      gone: ['chips(bounty.total)', 'chips(bounty.claimed)', 'chips(bounty.perKnockout)'],
      instead: 'unitMoney(<amount>), which is chips() at a chip event and whole Diamonds otherwise',
    },
  ];

  it.each(SURFACES.map((s) => [s.file, s] as const))(
    '%s reads a unit before it prints tournament money',
    (_name, surface) => {
      const code = blankNonCode(read(surface.file));
      expect(
        UNIT_SOURCES.some((needle) => code.includes(needle)),
        `${surface.file} prints a tournament money figure and names no unit. It must read one - ` +
          `${surface.instead} - or a Diamond bounty, chest or prize is printed on the cent grid ` +
          `with no error anywhere, because "chips" is a well-formed answer.`
      ).toBe(true);
    }
  );

  it.each(SURFACES.map((s) => [s.file, s] as const))(
    '%s no longer carries its unitless money expression',
    (_name, surface) => {
      const code = blankNonCode(read(surface.file));
      for (const gone of surface.gone) {
        expect(
          code.includes(gone),
          `${surface.file} prints money through \`${gone}\` again. That expression has no unit, ` +
            `so it prints the chip contract at a Diamond event. Use ${surface.instead}.`
        ).toBe(false);
      }
    }
  );

  it('SeatKnockout prints no money, which is why it needed no unit', () => {
    // The floor assertion for this one: if the KO overlay ever starts printing
    // the bounty it is stamping, it joins the list above.
    const code = blankNonCode(read('src/components/table/SeatKnockout.tsx'));
    for (const formatter of [
      'formatChipAward',
      'formatTableChips',
      'formatPrizeAtUnit',
      'formatCents',
      'toLocaleString',
    ]) {
      expect(
        code,
        `SeatKnockout now prints a figure through ${formatter}. It is the seat's KO stamp and has ` +
          `never carried money - the award beside it is TablePage's float. If it is going to show ` +
          `an amount, it needs the table's unit and a row in the SURFACES list above.`
      ).not.toContain(formatter);
    }
  });

  /**
   * THE UNIT IS NEVER OMITTED AT A CALL SITE, which `tsc` enforces only while
   * nobody writes a default back into a signature. This is the census that
   * notices if they do, in the same shape and for the same reason as
   * `a-tournament-prize-knows-its-unit.law.test.ts`.
   */
  it('every unit-bearing money formatter is called with its unit', () => {
    const TWO_ARG_RULES = [
      'formatPrizeAtUnit',
      'formatPrizeCentsAtUnit',
      'formatAwardAtUnit',
      'formatCents',
    ];
    const ONE_ARG_RULES = ['moneyWordAtUnit', 'moneyAdjectiveAtUnit', 'moneySuffixAtUnit'];
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of productionFiles('src')) {
      const code = blankNonCode(read(file));
      for (const [fn, want] of [
        ...TWO_ARG_RULES.map((f) => [f, 2] as const),
        ...ONE_ARG_RULES.map((f) => [f, 1] as const),
      ]) {
        // The declaring module's own signature is not a call site.
        if (new RegExp(`(export const|export function)\\s+${fn}\\b`).test(code)) continue;
        let rest = code;
        for (;;) {
          const at = rest.indexOf(`${fn}(`);
          if (at < 0) break;
          const call = sliceCall(rest, `${fn}(`);
          scanned++;
          const args = argumentCount(call);
          if (args !== want) offenders.push(`${file}: ${fn} called with ${args} argument(s)`);
          rest = rest.slice(at + fn.length + 1);
        }
      }
    }

    // A scanner that matched nothing must not read as a clean bill of health.
    expect(
      scanned,
      'the unit-bearing money formatters have no call sites at all, so this census is watching ' +
        'names that moved. Rename them here in the same commit.'
    ).toBeGreaterThan(0);
    expect(
      offenders,
      `These call sites do not state a unit:\n\n  ${offenders.join('\n  ')}\n\n` +
        `Pass the tournament's unit - tournamentRowUnitCents(tournament) where the arena embed is ` +
        `in hand, arenaAssetUnitCents(arenaAsset) at a table, UNIT_CENTS_ASSET_NOT_READ where ` +
        `nothing has been read - never a bare literal.`
    ).toEqual([]);
  });
});
