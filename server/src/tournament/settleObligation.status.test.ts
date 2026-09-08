import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn(async () => {}) }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { settleTournamentObligation } from './settleObligation.js';

const input = {
  tournamentId: 'event',
  kind: 'bubble_protection' as const,
  userId: 'player',
  amount: 100,
  source: 'engine.test',
};
const settle = (data: unknown) =>
  settleTournamentObligation({ rpc: async () => ({ data, error: null }) }, input, {
    maxAttempts: 1,
  });
const partial = {
  ok: true,
  paid: 99.99,
  already_paid: 0,
  amount_owed: 100,
  amount_paid: 99.99,
  remaining: 0.01,
  fully_settled: false,
  obligation_id: 'obligation',
};
const full = {
  ...partial,
  paid: 0.01,
  already_paid: 99.99,
  amount_paid: 100,
  remaining: 0,
  fully_settled: true,
};

describe('recorded tournament payment completion', () => {
  it('distinguishes a successful partial credit from the final cent and full replay', async () => {
    expect(await settle(partial)).toMatchObject({
      ok: true,
      fully_settled: false,
      remaining: 0.01,
    });
    expect(await settle(full)).toMatchObject({
      fully_settled: true,
      remaining: 0,
      amount_paid: 100,
    });
    expect(await settle({ ...full, paid: 0, already_paid: 100 })).toMatchObject({
      fully_settled: true,
      paid: 0,
    });
  });
  it('retains debt on a replay of an older smaller request', async () => {
    expect(await settle({ ...partial, paid: 0, already_paid: 99.99 })).toMatchObject({
      fully_settled: false,
      remaining: 0.01,
      amount_owed: 100,
    });
  });
  it('does not certify missing, nonfinite or contradictory response totals', async () => {
    expect((await settle({ ok: true, paid: 100, already_paid: 0 })).fully_settled).toBe(false);
    for (const patch of [
      { remaining: null },
      { remaining: 1 },
      { paid: Infinity },
      { amount_paid: 'NaN' },
      { amount_owed: '100.001' },
      { amount_paid: 90 },
    ]) {
      expect(await settle({ ...full, ...patch })).toMatchObject({
        fully_settled: false,
        remaining: null,
      });
    }
    expect((await settle(JSON.stringify(full))).fully_settled).toBe(true);
  });
  it('the terminal atomic batch owns Bubble Protection and rolls back a partial leg', () => {
    const eliminations = readFileSync(
      join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
      'utf8'
    );
    const eliminate = sliceMethod(
      eliminations,
      'eliminatePlayer(\n    userId: string,\n    position: number,\n    allowCompletingClaim = false\n  ): Promise<boolean>'
    );
    const migration = readFileSync(
      join(
        process.cwd(),
        '../supabase/migrations/20260908042400_tournament_places_settle_and_complete_atomically.sql'
      ),
      'utf8'
    );
    const functionStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places_atomic('
    );
    const bodyStart = migration.indexOf('AS $function$', functionStart);
    const functionEnd = migration.indexOf('$function$;', bodyStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(bodyStart).toBeGreaterThan(functionStart);
    expect(functionEnd).toBeGreaterThan(bodyStart);
    const atomic = migration.slice(functionStart, functionEnd + '$function$;'.length);

    // Elimination records the entitlement; it cannot make an independently
    // committed Bubble payment that survives a later place-settlement failure.
    expect(blankNonCode(eliminate)).not.toMatch(
      /settleTournamentObligation|fn_settle_tournament_obligation/
    );

    const transaction = atomic.indexOf('\n  BEGIN');
    const bubble = atomic.indexOf(
      'IF v_batch.bubble_contract_required AND v_bubble_required_unpaid > 0.005 THEN',
      transaction
    );
    const payment = atomic.indexOf(
      'fn_settle_tournament_obligation_before_atomic_batch_gate(',
      bubble
    );
    const fullProof = atomic.indexOf('Bubble Protection remains open after settlement', payment);
    const complete = atomic.indexOf("SET status = 'COMPLETED'", fullProof);
    const rollback = atomic.indexOf('EXCEPTION WHEN OTHERS', complete);

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(bubble).toBeGreaterThan(transaction);
    expect(payment).toBeGreaterThan(bubble);
    expect(fullProof).toBeGreaterThan(payment);
    expect(complete).toBeGreaterThan(fullProof);
    expect(rollback).toBeGreaterThan(complete);
    expect(atomic.slice(rollback)).toContain("'paid', 0");
  });
});
