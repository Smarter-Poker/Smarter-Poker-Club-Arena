/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A TOURNAMENT PRIZE KNOWS ITS UNIT - NO MONEY RULE DEFAULTS TO A CENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 8 taught four tournament money rules that a Diamond does not divide:
 * `computePlacePrize`, `mysteryPoolCents`, `recoveryFeeCents` and
 * `unitFloorCents` each gained a `unitCents` parameter on 2026-09-12.
 *
 * EVERY ONE OF THEM DEFAULTED IT TO 1, AND EVERY CALLER OMITTED IT. Both
 * engine payout sites, the lobby's projected ladder, `PayoutEngine`,
 * `TournamentService`, the tournament detail tab and both mystery-bounty seed
 * sites passed three arguments to a four-argument rule and received a cent.
 * `mysteryBountyActivation.ts` said so in its own comment: "NO CALLER PASSES
 * THIS YET."
 *
 * That is CLAUDE.md 10.86 rule 1 written as a parameter default. "I could not
 * tell" was folded into a confident answer, and the answer was character for
 * character the one a caller that HAD read a chip club would get. The unit
 * work looked finished from every call site and was wired to nothing.
 *
 * So the unit is a REQUIRED argument in all four rules, and this law is the
 * census that keeps it required: it walks every caller of every one of them
 * and proves the unit is actually passed. `tsc` enforces the arity for as long
 * as nobody writes `= 1` back into a signature; this is what notices if they
 * do, and it is what notices a NEW call site added with a bare literal.
 *
 * ─── WHY THE CENSUS IS BOUNDED BY STRUCTURE AND NOT BY A COUNT ─────────────
 *
 * There is no expected number of call sites anywhere below. A census that
 * asserts "there are six" goes red the day somebody legitimately adds a
 * seventh, and - far worse - goes GREEN when the scanner's window drifts off
 * the call it was watching. tests/helpers/sourceWindow.ts was written about
 * exactly that failure and cost the estate a 39-minute publish outage.
 *
 * Every window here is bounded by the structure it is about: `sliceCall` takes
 * a call from its name to the paren that CLOSES it, however long the arguments
 * grow, and arguments are counted by matching brackets rather than by
 * splitting on commas - so `Number(p.place)` and `{ a, b }` are one argument
 * each. The file list is derived by walking the tree for importers, so a new
 * caller in a new file is scanned the day it is written without this file
 * being told about it.
 *
 * The only floors asserted are "the scanner found something" ones, which exist
 * so that a scanner that silently matches nothing cannot pass as a clean bill
 * of health. That is the same rule in its third form: a check must not report
 * success when it could not tell.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { blankNonCode, sliceCall, sliceSqlStatement } from './helpers/sourceWindow';
import {
  CHIP_UNIT_CENTS,
  DIAMOND_UNIT_CENTS,
  UNIT_CENTS_ASSET_NOT_READ,
  normalizeUnitCents,
  tournamentUnitCents,
} from '../server/src/tournament/tournamentUnit';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Every .ts/.tsx file under these roots that is not itself a test. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const SOURCE_ROOTS = ['src', 'server/src'];
const ALL_SOURCE = SOURCE_ROOTS.flatMap(sourceFiles);

/**
 * Each source file, read and blanked ONCE for the life of this module. The
 * census below asks the same 1,700-odd files about five rules from two tests,
 * and reading and tokenising them ten times over is what put this law past
 * vitest's 5-second budget on a busy machine while passing alone - the
 * coin-flip shape tests/helpers/migrationCorpus.ts was written against.
 */
const blankedSource = new Map<string, { src: string; code: string }>();
function sourceOf(file: string): { src: string; code: string } {
  let hit = blankedSource.get(file);
  if (!hit) {
    const src = read(file);
    hit = { src, code: blankNonCode(src) };
    blankedSource.set(file, hit);
  }
  return hit;
}

/**
 * Every call to `name` in `src`, each sliced from the name to its own closing
 * paren. `sliceCall` returns the FIRST code occurrence in whatever it is
 * handed, so the remainder is advanced past each hit and asked again.
 */
function eachCall(src: string, name: string): string[] {
  const needle = `${name}(`;
  const found: string[] = [];
  let rest = src;
  for (;;) {
    const at = blankNonCode(rest).indexOf(needle);
    if (at < 0) return found;
    found.push(sliceCall(rest, needle));
    rest = rest.slice(at + needle.length);
  }
}

/** How many top-level arguments a sliced call carries. Brackets nest; commas inside them do not count. */
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

/** A call site, with enough context to name it when it fails. */
interface Site {
  file: string;
  call: string;
  args: number;
}

/**
 * Every call to `name` across the tree, EXCLUDING the module that declares it.
 * A declaring module is recognised by holding `function <name>(`, which is
 * also what keeps the declaration itself out of the argument census.
 */
function callSites(name: string): Site[] {
  const sites: Site[] = [];
  for (const file of ALL_SOURCE) {
    const { src, code } = sourceOf(file);
    if (!code.includes(`${name}(`)) continue;
    if (new RegExp(`function\\s+${name}\\s*\\(`).test(code)) continue;
    for (const call of eachCall(src, name)) sites.push({ file, call, args: argumentCount(call) });
  }
  return sites;
}

/**
 * The four rules, with the position their unit occupies. `mysteryPoolCents`
 * takes the already-paid cap before it, which is why its unit is fifth.
 */
const UNIT_BEARING_RULES: Array<{ fn: string; declaredIn: string; arity: number }> = [
  { fn: 'computePlacePrize', declaredIn: 'server/src/tournament/payoutMath.ts', arity: 4 },
  {
    fn: 'mysteryPoolCents',
    declaredIn: 'server/src/tournament/mysteryBountyActivation.ts',
    arity: 5,
  },
  { fn: 'recoveryFeeCents', declaredIn: 'server/src/tournament/recoveryFee.ts', arity: 3 },
  { fn: 'unitFloorCents', declaredIn: 'server/src/tournament/recoveryFee.ts', arity: 2 },
  /**
   * ─── AND THE WRAPPER, BECAUSE A CENSUS WITH A HOLE IN IT IS THE DEFECT ────
   *
   * `placePrize` is every browser display's door to `computePlacePrize`. Until
   * 2026-09-15 it answered `UNIT_CENTS_ASSET_NOT_READ` on its callers' behalf,
   * which satisfied the census below - the wrapper passed a unit, so the rule
   * underneath it was called correctly - while all five displays remained
   * unable to say what unit they meant.
   *
   * Now it takes the unit from its callers, and it is censused HERE rather
   * than left to `tsc` alone. CLAUDE.md 10.86 rule 4 is the reason: a fix that
   * leaves the same trap one level up has not landed. Arity is enforced by the
   * compiler, but "never a bare literal" is not, and a sixth display added
   * next month with `placePrize(pool, places, 1, 1)` would compile, print
   * cents at a Diamond event, and be indistinguishable from the default this
   * law was written to delete.
   */
  { fn: 'placePrize', declaredIn: 'src/components/tournament/details/types.ts', arity: 4 },
];

describe('LAW: a tournament prize knows its unit', () => {
  it('no unit-bearing money rule gives its unit a default', () => {
    // A default is the defect this law is about, in the one place it can be
    // reintroduced. The client copy of payoutMath is checked too: it is
    // byte-identical to the engine's by another law, and a default restored in
    // either would be copied to the other by the instruction that law prints.
    for (const file of [
      'server/src/tournament/payoutMath.ts',
      'src/lib/payoutMath.ts',
      'server/src/tournament/recoveryFee.ts',
      'server/src/tournament/mysteryBountyActivation.ts',
      // The wrapper every display goes through. A default restored here would
      // put the cent back in front of all five of them at once, and none of
      // their call sites would change by a character.
      'src/components/tournament/details/types.ts',
    ]) {
      const code = blankNonCode(read(file));
      expect(code, `${file} gave a unit parameter a default again`).not.toMatch(
        /unitCents\s*(?::\s*number\s*)?=/
      );
      expect(code, `${file} no longer declares a unit parameter at all`).toMatch(/unitCents/);
    }
  });

  /* THIS IS A TREE SCAN, NOT A UNIT TEST (2026-09-21). It reads every .ts/.tsx
     under src/ and server/src/ and blanks each one per call site, which is
     seven seconds beside the rest of the pre-push run on a loaded Mac and was
     failing there with "Test timed out in 5000ms" - a message that names no
     cause (CLAUDE.md 10.86). The budget is the scan's, well above the ceiling
     it was measured at, never equal to it (10.86 rule 4). */
  it('every caller of every unit-bearing rule passes a unit', { timeout: 60_000 }, () => {
    const scanned: string[] = [];
    for (const { fn, declaredIn, arity } of UNIT_BEARING_RULES) {
      expect(
        blankNonCode(read(declaredIn)),
        `${declaredIn} no longer declares ${fn}; this law is watching a function that moved`
      ).toMatch(new RegExp(`function\\s+${fn}\\s*\\(`));

      for (const site of callSites(fn)) {
        scanned.push(`${fn} @ ${site.file}`);
        expect(
          site.args,
          `${site.file} calls ${fn} with ${site.args} arguments and it needs ${arity} - the ` +
            `last one is the tournament's unit. Pass tournamentUnitCents(club) when a club row ` +
            `is in hand, or the named UNIT_CENTS_ASSET_NOT_READ when it is not. Never a bare ` +
            `literal, and never nothing.\n\n${site.call}`
        ).toBe(arity);
      }
    }

    // The scanner must have found work to do. Without this an import rename, a
    // broken walker or a bad regex reports a clean census over zero call sites
    // - the "answered when it could not tell" shape this law exists to forbid.
    expect(scanned.length, 'the call-site scanner matched nothing at all').toBeGreaterThan(0);
    for (const { fn } of UNIT_BEARING_RULES) {
      expect(
        scanned.some((s) => s.startsWith(`${fn} @`)),
        `the scanner found no caller of ${fn}. Either every caller was deleted, or the walker ` +
          `stopped seeing the files that hold them - check before assuming the former.`
      ).toBe(true);
    }
  });

  it('a caller that did not read the club says so by name, never with a bare 1', () => {
    // The two things a caller may legitimately pass, and the thing it may not.
    // A bare literal is indistinguishable from the default this law removed, so
    // the census above would accept it and nobody would ever find it again.
    for (const { fn } of UNIT_BEARING_RULES) {
      for (const site of callSites(fn)) {
        const unit = site.call.slice(site.call.lastIndexOf(',') + 1).replace(/\)\s*$/, '');
        expect(
          unit,
          `${site.file} passes a bare literal as ${fn}'s unit. Say which of the two things it ` +
            `means: tournamentUnitCents(club) if the club was read, UNIT_CENTS_ASSET_NOT_READ ` +
            `if it was not.\n\n${site.call}`
        ).not.toMatch(/^\s*\d+\s*$/);
      }
    }
  });

  it('the TypeScript unit derivation is the SQL one, condition for condition', () => {
    // All three conditions, and the same strictness on each.
    expect(tournamentUnitCents({ asset: 'diamonds', is_platform: true, union_id: null })).toBe(
      DIAMOND_UNIT_CENTS
    );
    expect(tournamentUnitCents({ asset: 'chips', is_platform: true, union_id: null })).toBe(
      CHIP_UNIT_CENTS
    );
    // is_platform IS TRUE: false, absent and NULL are all not-true in SQL.
    expect(tournamentUnitCents({ asset: 'diamonds', is_platform: false, union_id: null })).toBe(
      CHIP_UNIT_CENTS
    );
    expect(tournamentUnitCents({ asset: 'diamonds', is_platform: null, union_id: null })).toBe(
      CHIP_UNIT_CENTS
    );
    expect(tournamentUnitCents({ asset: 'diamonds', union_id: null })).toBe(CHIP_UNIT_CENTS);
    // union_id IS NULL: a Diamond game cannot belong to a union.
    expect(tournamentUnitCents({ asset: 'diamonds', is_platform: true, union_id: 'u' })).toBe(
      CHIP_UNIT_CENTS
    );
    // The join found nothing: the tournament has no club, or none exists.
    expect(tournamentUnitCents(null)).toBe(CHIP_UNIT_CENTS);
  });

  it('the migration that owns the SQL half still spells those same conditions', () => {
    /**
     * The bond across the language boundary, in the only form available to a
     * test that may not touch the database: the migration that CREATED
     * `fn_ca_tournament_unit_cents` is read, and its predicate is required to
     * be the one mirrored above.
     *
     * ITS LIMIT, STATED RATHER THAN LEFT TO BE FOUND. This reads one applied
     * migration, so a LATER migration that redefines the function would leave
     * this green while the two languages disagreed. It is a pin on the
     * intention of record, not a live read. A migration that changes the unit
     * rule must move this expectation in the same commit - which is what the
     * message below tells whoever breaks it.
     */
    const sql = read(
      'supabase/migrations/20260912090000_one_prize_ladder_and_it_knows_its_unit.sql'
    );
    const fn = sliceSqlStatement(
      sql,
      'CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unit_cents'
    );
    for (const condition of [
      "c.asset = 'diamonds'",
      'c.is_platform IS TRUE',
      'c.union_id IS NULL',
      'THEN 100 ELSE 1 END',
    ]) {
      expect(
        fn,
        `fn_ca_tournament_unit_cents no longer reads "${condition}". If a later migration ` +
          `changed the unit rule, change tournamentUnitCents and this law together - two ` +
          `languages disagreeing about what a Diamond is worth is what Phase 8 exists to stop.`
      ).toContain(condition);
    }
  });

  it('a unit read off a wire is normalised, and nonsense is a cent rather than a grid', () => {
    expect(normalizeUnitCents(100)).toBe(DIAMOND_UNIT_CENTS);
    expect(normalizeUnitCents(1)).toBe(CHIP_UNIT_CENTS);
    for (const junk of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 'x']) {
      expect(normalizeUnitCents(junk), `${String(junk)} was accepted as a unit`).toBe(
        CHIP_UNIT_CENTS
      );
    }
    // The named admission is a cent today because every tournament that can
    // currently exist is a chip tournament. It is a separate NAME so that the
    // Diamond tournament work can find the surfaces that have to learn better.
    expect(UNIT_CENTS_ASSET_NOT_READ).toBe(CHIP_UNIT_CENTS);
  });
});
