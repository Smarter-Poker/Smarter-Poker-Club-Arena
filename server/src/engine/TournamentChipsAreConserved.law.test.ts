/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tournament chips are not money, but they decide the winner. On 2026-08-31
 * fn_spin_chip_conservation_check found 114 of 1,206 completed spin/SNG games
 * holding more chips at the end than were ever issued (18,406 minted, worst
 * +1,000). Every sampled game broke BETWEEN two hands across an engine
 * restart, because the seat-credit path that funds a Spin's reservations
 * after the wheel also ran on resume() and handed a busted or losing seat a
 * fresh starting stack (docs/changelog/2026-09-02-chip-std-spin-chips.md).
 *
 * The law has four pins, each one a bug that shipped:
 *
 *   1. A seat credit never touches a game in progress. Play under way means a
 *      hand was recorded OR any seat holds more than the starting stack; once
 *      it is, nothing is funded - not a short seat, not a zero seat.
 *   2. The engine refuses to persist a tournament hand whose dealt players do
 *      not hold, after settlement, exactly what they were dealt. CRITICAL
 *      alert `Tournament.chip_conservation_broken`, and neither stack write
 *      runs.
 *   3. When the database refuses an accepted-hand write for a conservation
 *      violation, no per-seat fallback writes the refused total anyway.
 *   4. The database asserts the same identity for tournament tables inside
 *      fn_ca_settle_hand_stacks_absolute, and the detector counts rebuy /
 *      add-on games instead of looking away from them.
 *
 * Source pins are crude and deliberate (StaleContinuationSweep style): each
 * fails the exact edit that would reintroduce the bug. Negative-controlled on
 * 2026-09-02 by flipping every pin by hand and watching it go red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode, sliceEnclosingBlock, sliceMethod } from '../testHelpers/sourceWindow.js';
import { checkTournamentChipConservation } from './tournamentChipConservation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(HERE, f), 'utf-8');
const code = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('LAW 1: no runtime seat-credit authority exists', () => {
  it('the tournament manager cannot fund, defer, or repair a seat stack', () => {
    const src = code(read('../tournament/TournamentManagerBase.ts'));
    expect(src).not.toMatch(/creditSeatStacks|selectSeatsToFund|tournamentChipSupply/);
    expect(src).not.toMatch(/deferStacksForSpinReveal|stacksMayBeDeferred|seats_credited/);
    expect(src).not.toMatch(/\.update\(\{\s*stack:\s*target\s*\}\)/);
  });
});

describe('LAW 2: the engine refuses to persist a tournament hand that does not conserve', () => {
  it('the assertion is exact: +1 chip is a refusal', () => {
    const v = checkTournamentChipConservation({
      dealt: new Map([
        ['a', 1000],
        ['b', 1000],
      ]),
      settled: [
        { user_id: 'a', stack: 1001 },
        { user_id: 'b', stack: 1000 },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.delta).toBe(1);
  });

  it('postHandTasks gates the one accepted-hand transaction on the verdict and raises the CRITICAL alert', () => {
    const src = read('./ServerTableEngineSettlement.ts');
    const raw = sliceMethod(src, 'protected async postHandTasks(');
    const fn = code(raw);
    const gate = fn.indexOf('checkTournamentChipConservation(');
    const refusal = fn.indexOf('if (!tournamentHandConserved)');
    const commit = fn.indexOf('atomicCommit: {');
    expect(gate).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(gate);
    expect(commit).toBeGreaterThan(refusal);
    // the verdict is taken from the synchronous snapshot, never the live field
    expect(fn.slice(gate - 400, gate + 400)).toMatch(/dealt:\s*snap\.dealtStacks/);
    // the alert names the law and is critical
    expect(fn.slice(gate, refusal)).toMatch(
      /raiseFinancialAlert\(\s*'critical',\s*'Tournament\.chip_conservation_broken'/
    );
    // A refusal parks the live table behind the settlement barrier and then
    // returns on explicit stop; it cannot reach the accepted-hand RPC.
    const refusalBody = sliceEnclosingBlock(raw, 'if (!tournamentHandConserved)');
    expect(refusalBody).toContain("this.setLoopPhase('settlement_fault_conservation')");
    expect(refusalBody).toMatch(/while \(this\.running\)[\s\S]*?return;/);
    expect(blankNonCode(raw)).not.toMatch(/\bsyncStacks\s*\(/);
    expect(blankNonCode(raw)).not.toMatch(/\bsyncTournamentChips\s*\(/);
  });

  it('the dealt stacks are captured when the HandController is built and carried in the snapshot', () => {
    // The method that builds the HandController, bounded by its own braces
    // (a byte-count window drifts off the code it guards; see
    // tests/helpers/sourceWindow.ts). The capture must sit in that method,
    // after the construction it snapshots.
    const dealing = code(read('./ServerTableEngineDealing.ts'));
    const dealHand = sliceMethod(dealing, 'protected async dealHand(');
    const ctor = dealHand.indexOf('this.handController = new HandController(');
    expect(ctor, 'dealHand builds the HandController').toBeGreaterThan(-1);
    const capture = dealHand.indexOf('this.currentHandDealtStacks = new Map(');
    expect(capture, 'dealHand captures the dealt stacks').toBeGreaterThan(-1);
    expect(capture, 'the capture follows the construction it snapshots').toBeGreaterThan(ctor);
    const settle = code(read('./ServerTableEngineSettlement.ts'));
    const snap = settle.indexOf('const snap = {');
    expect(settle.slice(snap, settle.indexOf('};', snap))).toMatch(
      /dealtStacks:\s*new Map\(this\.currentHandDealtStacks\)/
    );
  });
});

describe('LAW 3: a conservation refusal from the database is never written around', () => {
  it('the runtime has no rolling stack-only door or per-seat fallback', () => {
    const tables = code(read('../services/supabase/tables.ts'));
    const history = code(read('../services/supabase/handHistory.ts'));
    expect(tables).not.toMatch(/\bsyncStacks\b/);
    expect(tables).not.toContain('fn_ca_settle_hand_stacks_absolute');
    expect(tables).not.toMatch(/\.update\(\s*\{\s*stack/);
    expect(history).toContain("supabase.rpc('fn_ca_commit_hand_settlement', payload)");
  });
});

describe('LAW 4: the database asserts the same identity', () => {
  const migrationsDir = resolve(HERE, '../../../supabase/migrations');
  const file = readdirSync(migrationsDir).find((f) =>
    /^\d{14}_tournament_chips_are_conserved_hand_by_hand\.sql$/.test(f)
  );
  const sql = file ? readFileSync(resolve(migrationsDir, file), 'utf-8') : '';

  it('the migration exists and is one transaction', () => {
    expect(
      file,
      'migration 2026090..._tournament_chips_are_conserved_hand_by_hand.sql'
    ).toBeTruthy();
    expect(
      sql
        .trim()
        .split('\n')
        .filter((l) => /^BEGIN;$/.test(l.trim())).length
    ).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('fn_ca_settle_hand_stacks_absolute refuses a tournament write whose seats no longer sum', () => {
    const fn = sql.slice(sql.indexOf('FUNCTION public.fn_ca_settle_hand_stacks_absolute('));
    expect(fn).toMatch(/SELECT tb\.tournament_id INTO v_tournament_id/);
    expect(fn).toMatch(/IF v_tournament_id IS NOT NULL AND round\(v_delta_sum, 2\) <> 0 THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'conservation violation \(tournament %\)/);
    // a grant the engine dealt without is re-added, never used to wave the write through
    expect(fn).toMatch(/IF v_explained > 0 AND round\(v_delta_sum \+ v_explained, 2\) = 0 THEN/);
    // the original body survives untouched
    expect(fn).toMatch(/seat missing or left for % - hand write rejected whole/);
    expect(fn).toMatch(/fn_ca_raise_drift_incident/);
  });

  it('fn_spin_chip_conservation_check counts rebuy/add-on grants instead of excluding the game', () => {
    const start = sql.indexOf('FUNCTION public.fn_spin_chip_conservation_check(');
    const fn = sql.slice(start, sql.indexOf('$function$;', start));
    expect(fn).not.toMatch(/addon_refund/);
    expect(fn).toMatch(/NULLIF\(t\.rebuy_chips, 0\), t\.starting_chips/);
    expect(fn).toMatch(/NULLIF\(t\.addon_chips, 0\), t\.starting_chips/);
    // horses are players (CLAUDE.md 10.5): neither function body filters them
    const settleStart = sql.indexOf('FUNCTION public.fn_ca_settle_hand_stacks_absolute(');
    const settleFn = sql.slice(settleStart, sql.indexOf('$function$;', settleStart));
    expect(fn).not.toMatch(/is_horse/);
    expect(settleFn).not.toMatch(/is_horse/);
  });
});
