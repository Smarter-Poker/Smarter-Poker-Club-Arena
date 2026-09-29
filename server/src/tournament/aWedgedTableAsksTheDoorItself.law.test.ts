/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A WEDGED TABLE ASKS THE DOOR ITSELF, AND AN ASK WITH NO ANSWER IS A NUMBER
 *  (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `abandonedGenerationDoor.ts` is the correct disposition for a reserved hand
 * permit whose generation is no longer the lease holder, and #5163 wired it
 * into the adoption. It was asked in exactly one place, and that place runs
 * exactly once: `resumeLifecycle` is the adoption, a manager on the adoption
 * path holds its event's lease for the rest of its life, and it never resumes
 * again. So every way that single ask could end without a decision left the
 * table blocked for the whole life of that manager.
 *
 * Measured on production after the 15:29 cutover to engine 778075b4:
 *
 *   reserved permits of a dead generation              526
 *   tables they wedged                                 526  (of 824 running)
 *   RUNNING events                                     388  (of 431)
 *   seated players behind them                       2,061  (2,060 horses, 1 human)
 *   tournament chips behind them                14,210,568
 *   leases acquired (i.e. events adopted)  15:42:08 - 15:44:33
 *   fn_f06_hand_number_state calls in that window    1,411  all HTTP 200
 *   fn_f06_abort_abandoned_generation calls              0
 *   poker_f06_abandoned_generation_closures_total        0  on every label
 *
 * Both numbers matter. The reads SUCCEEDED and returned a well-formed
 * `hand_permit_unresolved` naming a generation that was not the lease holder,
 * so the door had something to decide at every one of those 526 tables - and
 * the door, probed the same day in a rolled-back transaction, decided 7 of 8
 * sampled generations cleanly and credited nothing. Nothing was wrong with the
 * door. The ask never reached it, and the counter could not say so, because
 * the only exit from an ask that never reaches the door - the maintenance
 * freeze outlasting the wait - returned in silence. Zero on every label is
 * what a healthy fleet reads too (CLAUDE.md 10.86 rules 1 and 3).
 *
 * These pins are the two halves of the repair:
 *
 * 1. THE REFUSAL IS MET IN `startManagedTableEngine`, so that is where the
 *    door is asked. That method reads the same state and throws
 *    `f06_engine_admission_unproven` every ~15 s for as long as the table is
 *    wedged. It now asks the door first and still refuses the attempt: the
 *    next admission re-reads what the door left and proves itself normally.
 *    This is not a sweep, healer, backfill or repair job (CLAUDE.md 10.12) -
 *    it is this table's own live path, on the event already blocked, at the
 *    moment it is blocked.
 * 2. EVERY END OF AN ASK IS A NUMBER, including `frozen` (never reached the
 *    door) and `unreadable` (never read the table).
 *
 * And the refinement that keeps 1 from becoming a retry loop: a rule the door
 * NAMES is asked once per manager and never again, and an undecided answer
 * waits out a cooldown - the admission's 15 s cadence must not become the
 * door's.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceMethod, sliceBetween } from '../testHelpers/sourceWindow.js';

/**
 * Comments out, STRING LITERALS KEPT.
 *
 * `blankNonCode` blanks both, which is right for a pin that counts braces and
 * wrong for every pin here: the behaviour being pinned IS a set of literals -
 * `hand_permit_unresolved`, `f06_engine_admission_unproven`, `'frozen'`. And
 * this file's own commentary quotes each of them, so the comments have to go
 * or a paragraph could satisfy a pin on code. Neither window below contains a
 * slash inside a literal; a pin that needed one would need a real tokenizer.
 */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
import { TournamentManagerBase } from './TournamentManagerBase.js';
import {
  abandonedPermitGeneration,
  countAbandonedGenerationOutcome,
  type AbandonedGenerationCount,
} from './abandonedGenerationDoor.js';

const MANAGER = readFileSync(resolve(__dirname, './TournamentManagerBase.ts'), 'utf8');
const DOOR = readFileSync(resolve(__dirname, './abandonedGenerationDoor.ts'), 'utf8');
const INSTRUMENTS = readFileSync(
  resolve(__dirname, '../observability/engineInstruments.ts'),
  'utf8'
);
/**
 * THIS counter's own declaration and label seeding, not the whole file.
 * `poker_f06_drained_custody_outcomes_total` two declarations above is seeded
 * with ['refused', 'unreadable', 'malformed'], so a file-wide search for
 * "'unreadable'," passed while this counter had lost the label - a window
 * bounded by the wrong structure (testHelpers/sourceWindow.ts).
 */
const CLOSURES = sliceBetween(
  INSTRUMENTS,
  'export const f06AbandonedGenerationClosuresTotal',
  'f06AbandonedGenerationClosuresTotal.inc(0, { outcome });'
);
const ADMISSION = sliceMethod(MANAGER, 'protected startManagedTableEngine(');
const ADMISSION_CODE = codeOnly(ADMISSION);
const DECIDE_ONE = codeOnly(sliceMethod(MANAGER, 'private async decideAbandonedGeneration('));
const DECIDE_ALL = codeOnly(sliceMethod(MANAGER, 'private async decideAbandonedGenerations('));

describe('the table that is refused is the table that asks', () => {
  it('startManagedTableEngine asks the abandoned-generation door', () => {
    // The whole defect in one assertion: for three days the only caller of
    // this door was the adoption, and the adoption happens once.
    expect(ADMISSION_CODE).toContain('abandonedPermitGeneration(');
    expect(ADMISSION_CODE).toContain('this.decideAbandonedGeneration(');
  });

  it('it asks only on an exact hand_permit_unresolved answer about this table', () => {
    expect(ADMISSION_CODE).toContain("state.blocked_reason === 'hand_permit_unresolved'");
    expect(ADMISSION_CODE).toContain('state.can_reserve === false');
    expect(ADMISSION_CODE).toContain('state.table_id === tableId');
    expect(ADMISSION_CODE).toContain('state?.ok === true');
    // Never on an unread answer, and never outside this generation's own work.
    expect(ADMISSION_CODE).toContain('!error');
    expect(ADMISSION_CODE).toContain('current()');
  });

  it('it still refuses the attempt it asked during, and never deals on it', () => {
    // The ask comes BEFORE the unproven throw and does not replace it: a
    // projection that was unproven when it was read is unproven still.
    const ask = ADMISSION_CODE.indexOf('this.decideAbandonedGeneration(');
    const refuse = ADMISSION_CODE.indexOf("throw new Error('f06_engine_admission_unproven')");
    expect(ask).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(ask);
    // And nothing in the asking block installs an allocator or an admission.
    const block = ADMISSION_CODE.slice(ask, refuse);
    expect(block).not.toContain('installF06Allocator');
    expect(block).not.toContain('installF06HandAdmission');
  });

  it('a rule the door names is waited out, not asked every fifteen seconds', () => {
    // A definite refusal is the only thing that earns the longer wait.
    expect(DECIDE_ONE).toContain("refused?.refusal === 'definite' ? 'refused' : 'undecided'");
    expect(ADMISSION_CODE).toContain("last?.ask === 'refused'");
    expect(ADMISSION_CODE).toContain('ABANDONED_GENERATION_REFUSED_COOLDOWN_MS');
    expect(ADMISSION_CODE).toContain('this.abandonedGenerationAskedAt');
  });

  it('but a rule is never a life sentence: the refused wait is finite', () => {
    // A permanent memo was written here first. 44 of the 56 generations still
    // wedged on 2026-09-25 are refused F06_ABANDONED_ROSTER_CHANGED, whose
    // cause lives outside this table - so writing the generation off for the
    // manager's whole life would hold the table blocked after the repair.
    const refused = TournamentManagerBase.ABANDONED_GENERATION_REFUSED_COOLDOWN_MS;
    expect(Number.isSafeInteger(refused)).toBe(true);
    expect(refused).toBeGreaterThan(0);
    expect(Number.isFinite(refused)).toBe(true);
    expect(refused).toBeLessThanOrEqual(60 * 60_000);
    // Strictly longer than an undecided answer's wait: a rule needs more room
    // than a lane that was busy.
    expect(refused).toBeGreaterThan(
      TournamentManagerBase.ABANDONED_GENERATION_ADMISSION_COOLDOWN_MS
    );
  });

  it('an undecided answer waits out a cooldown longer than the admission cadence', () => {
    const cooldown = TournamentManagerBase.ABANDONED_GENERATION_ADMISSION_COOLDOWN_MS;
    expect(Number.isSafeInteger(cooldown)).toBe(true);
    // Longer than the retry ladder the door itself already walks, so the
    // admission never re-enters a door that is still working.
    expect(cooldown).toBeGreaterThan(
      TournamentManagerBase.ABANDONED_GENERATION_RETRY_MS *
        TournamentManagerBase.ABANDONED_GENERATION_ATTEMPTS
    );
    // And not so long that a wedged table waits out another engine release.
    expect(cooldown).toBeLessThanOrEqual(5 * 60_000);
    expect(ADMISSION_CODE).toContain('ABANDONED_GENERATION_ADMISSION_COOLDOWN_MS');
  });

  it('the adoption keeps asking exactly as it always has', () => {
    // The adoption is the door's caller of record. It consults no memo and
    // writes none, so a later adoption asks again - which is what
    // AbandonedGenerationAdoption.test.ts has always pinned.
    expect(DECIDE_ALL).not.toContain('abandonedGenerationAskedAt');
    expect(DECIDE_ALL).not.toContain('COOLDOWN');
  });
});

describe('an ask that reached no answer still produces a number', () => {
  it('the counter names frozen and unreadable, and pre-seeds every label', () => {
    for (const outcome of [
      'aborted',
      'replayed',
      'already_closed',
      'refused',
      'transient',
      'frozen',
      'unreadable',
    ] satisfies AbandonedGenerationCount[]) {
      expect(CLOSURES).toContain(`'${outcome}'`);
      // The type accepts it, so a new silent exit cannot be added without one.
      expect(() => countAbandonedGenerationOutcome(outcome)).not.toThrow();
    }
    // Seeded, so a label that never fires still reads 0 rather than being
    // absent - the difference between "nothing happened" and "nothing asked".
    expect(codeOnly(CLOSURES)).toContain('for (const outcome of [');
    expect(CLOSURES).toContain('|frozen|unreadable');
  });

  it('the maintenance-freeze give-up counts frozen before it returns', () => {
    const giveUp = DECIDE_ONE.indexOf("countAbandonedGenerationOutcome('frozen')");
    const ret = DECIDE_ONE.indexOf("return 'undecided'");
    expect(giveUp).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(giveUp);
  });

  it('a table state that could not be read counts unreadable, both ways', () => {
    // The awaited reply carrying an error, and the call throwing outright.
    const hits = DECIDE_ALL.split("countAbandonedGenerationOutcome('unreadable')").length - 1;
    expect(hits).toBe(2);
    // And an error is never coerced into an empty state (10.86 rule 2).
    expect(DECIDE_ALL).not.toContain('if (!error) state = data;');
  });

  it('closeAbandonedGeneration counts on every path it can leave by', () => {
    const close = codeOnly(sliceMethod(DOOR, 'export async function closeAbandonedGeneration('));
    // Each return and each throw is preceded by a count; the cheapest way to
    // pin that is that there are as many counts as there are exits.
    const exits = (close.match(/\n\s*(?:return|throw) /g) ?? []).length;
    const counts = (close.match(/count\(/g) ?? []).length;
    expect(exits).toBeGreaterThan(3);
    expect(counts).toBe(exits);
  });
});

describe('the ask is a decision, never a repair job', () => {
  it('the door is the only thing either caller invokes', () => {
    for (const window of [DECIDE_ONE, ADMISSION_CODE]) {
      expect(window).not.toMatch(/fn_[a-z0-9_]*(?:repair|backpay|redrive|sweep|catchup|heal)/i);
      expect(window).not.toContain('setInterval');
      expect(window).not.toContain('cron');
    }
    expect(DECIDE_ONE).toContain("supabase.rpc('fn_f06_abort_abandoned_generation'");
  });

  it('a well-formed unresolved permit of this generation is never the door business', () => {
    const tournamentId = '00e2074d-c002-4ef7-ae3a-8f069a5b1558';
    const tableId = '923b522a-17e9-456f-9703-feeb64eceba3';
    const live = '0b959869-e2de-4613-b4eb-b9c822da4594';
    const dead = '39551f78-f40d-4b8c-8bb4-8f782dd141f0';
    // Verbatim from production on 2026-09-25, rolled back:
    // fn_f06_hand_number_state(00e2074d..., 0b959869..., 923b522a...).
    const state = {
      ok: true,
      table_id: tableId,
      lifecycle: '326920',
      can_reserve: false,
      blocked_reason: 'hand_permit_unresolved',
      used_hand_number_max: '13637671',
      next_hand_number_candidate: null,
      unresolved_permit: {
        state: 'reserved',
        table_id: tableId,
        lifecycle: '326920',
        permit_id: 'bdf75859-4cb1-4003-be93-a9317655573a',
        custody_id: 'fc00d9e6-435d-453f-8f19-57107521404f',
        generation: dead,
        hand_number: '13637671',
        tournament_id: tournamentId,
      },
    };
    // This is the answer 526 tables gave, 1,411 times, at HTTP 200.
    expect(abandonedPermitGeneration(state, tournamentId, tableId, live)).toBe(dead);
    // The manager's own live hand is its own to finish, not the door's.
    expect(
      abandonedPermitGeneration(
        { ...state, unresolved_permit: { ...state.unresolved_permit, generation: live } },
        tournamentId,
        tableId,
        live
      )
    ).toBeNull();
  });
});
