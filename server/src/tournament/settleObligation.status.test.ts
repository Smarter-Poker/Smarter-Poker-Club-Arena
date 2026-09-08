import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transpileModule, ScriptTarget } from 'typescript';
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
  it('the actual bubble caller keeps partial and unacknowledged payments pending', async () => {
    const source = readFileSync(
      fileURLToPath(new URL('./TournamentManagerEliminations.ts', import.meta.url)),
      'utf8'
    );
    const start = source.indexOf('    // ── BUBBLE PROTECTION');
    const end = source.indexOf('    // ── BOUNTY / PKO / MYSTERY BOUNTY COLLECTION', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // Execute the original source block with its surrounding engine services
    // replaced. This tests emitted events and state rather than text presence.
    const code = transpileModule(`async function exercise() {\n${source.slice(start, end)}\n}`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction(
      'settleTournamentObligation',
      'tournament',
      'supabase',
      'reportError',
      'resolvePayoutStructure',
      'isSatellite',
      'prize',
      'position',
      'userId',
      code + '\nreturn exercise.call(this);'
    );
    for (const raw of [
      partial,
      full,
      { ok: false, paid: 0, already_paid: 0, refused_reason: 'transport', obligation_id: null },
    ]) {
      const result = await settle(raw);
      const host = {
        tournamentId: 'event',
        bubbleProtectionPaid: false,
        finalFieldSize: async () => 4,
        broadcast: vi.fn(async () => {}),
      };
      await run.call(
        host,
        async () => result,
        { bubble_protection: true, buy_in_amount: 100 },
        {},
        () => {},
        () => [{}],
        false,
        0,
        2,
        'player'
      );
      expect(host.bubbleProtectionPaid).toBe(result.fully_settled === true);
      expect(host.broadcast).toHaveBeenCalledWith(
        result.fully_settled ? 'bubble_protection_paid' : 'bubble_protection_pending',
        expect.objectContaining({ userId: 'player', amount: 100 })
      );
      if (raw === partial)
        expect(host.broadcast).toHaveBeenCalledWith(
          'bubble_protection_pending',
          expect.objectContaining({ remaining: 0.01, paid: 99.99 })
        );
    }
  });
});
