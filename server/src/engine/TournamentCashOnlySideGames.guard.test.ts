import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InsuranceEngine } from './InsuranceEngine.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'f2000000-0000-4000-8000-000000000001';
const PLAYER = 'f2000000-0000-4000-8000-000000000002';

describe('cash-only settlement features cannot contaminate tournament chips', () => {
  it.each(['accepted', 'cashed_out'] as const)(
    'drops a stale %s insurance offer before settlement, mutation, event or ledger input',
    (status) => {
      const event = vi.fn();
      const scheduler = {
        start: vi.fn(),
        schedule: vi.fn(),
        cancel: vi.fn(),
      };
      const insurance = new InsuranceEngine(event, scheduler as never);
      insurance.configure(TABLE, { enabled: true });
      (insurance as any).activeOffers.set(TABLE, [
        {
          tableId: TABLE,
          handId: 'hand-1',
          playerId: PLAYER,
          status,
          premium: 1.25,
          insuredAmount: 4.5,
          cashoutAmount: 3.75,
        },
      ]);
      const settle = vi.spyOn(insurance, 'settle');
      const applyStackDeltas = vi.fn();
      const seat = { user_id: PLAYER, stack: 100 };
      const engine = new ServerTableEngine(TABLE) as any;
      engine.tableInfo = {
        tournament_id: 'f2000000-0000-4000-8000-000000000003',
        game_type: 'tournament',
        insurance_enabled: true,
      };
      engine.insuranceEngine = insurance;
      engine.seatedPlayers = [seat];
      engine.handController = { applyStackDeltas };
      engine.currentHandInsuranceSettlements = [{ playerId: 'stale-ledger-input' }];

      expect(engine.settleInsuranceCashOnly([PLAYER])).toEqual([]);
      expect(settle).not.toHaveBeenCalled();
      expect(insurance.getOffers(TABLE)).toEqual([]);
      expect(engine.currentHandInsuranceSettlements).toEqual([]);
      expect(seat.stack).toBe(100);
      expect(applyStackDeltas).not.toHaveBeenCalled();
      expect(event).not.toHaveBeenCalled();
    }
  );

  it('disabling insurance itself clears stale contracts and settle fails closed', () => {
    const event = vi.fn();
    const insurance = new InsuranceEngine(event, {
      start: vi.fn(),
      schedule: vi.fn(),
      cancel: vi.fn(),
    } as never);
    insurance.configure(TABLE, { enabled: true });
    (insurance as any).activeOffers.set(TABLE, [
      { tableId: TABLE, playerId: PLAYER, status: 'accepted' },
    ]);
    insurance.configure(TABLE, { enabled: false });
    expect(insurance.getOffers(TABLE)).toEqual([]);
    expect(insurance.settle(TABLE, [PLAYER])).toEqual([]);
    expect(event).not.toHaveBeenCalled();
  });

  it('treats a copied tournament 7-2 flag and fractional amount as inert', () => {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.tableInfo = {
      tournament_id: 'f2000000-0000-4000-8000-000000000003',
      game_type: 'tournament',
      seven_deuce_enabled: true,
      seven_deuce_amount: 2.25,
    };
    expect(engine.sevenDeuceCashAllowed()).toBe(false);

    engine.tableInfo = {
      tournament_id: null,
      game_type: 'cash',
      seven_deuce_enabled: true,
      seven_deuce_amount: 2.25,
    };
    expect(engine.sevenDeuceCashAllowed()).toBe(true);
  });

  it('disabling run-it-twice drops a stale accepted cash offer', () => {
    const scheduler = {
      start: vi.fn(),
      schedule: vi.fn(),
      cancel: vi.fn(),
    };
    const rit = new RunItTwiceEngine(vi.fn(), scheduler as never);
    rit.configure(TABLE, { enabled: true, maxRuns: 3, autoDeclineTimeout: 25 });
    rit.offer(TABLE, 'hand-1', PLAYER, [PLAYER, 'villain'], 20);
    rit.chooserDecides(TABLE, PLAYER, 2);
    rit.accept(TABLE, 'villain');
    expect(rit.isActive(TABLE)).toBe(true);

    rit.configure(TABLE, { enabled: false, maxRuns: 3, autoDeclineTimeout: 25 });
    expect(rit.isEnabled(TABLE)).toBe(false);
    expect(rit.hasPendingOffer(TABLE)).toBe(false);
    expect(rit.isActive(TABLE)).toBe(false);
    expect(scheduler.cancel).toHaveBeenCalledWith(TABLE, 'rit_offer');
  });
});

describe('cash-only gates precede every production side effect', () => {
  const source = readFileSync(join(__dirname, 'ServerTableEngineSettlement.ts'), 'utf8');

  it('gates 7-2 before calculation, seat mutation, event and durable row', () => {
    const start = source.indexOf('// SEVEN-DEUCE BOUNTY');
    const end = source.indexOf('// BBJ HIT DETECTION', start);
    const section = source.slice(start, end);
    const gate = section.indexOf('this.sevenDeuceCashAllowed()');
    expect(gate).toBeGreaterThan(-1);
    for (const effect of [
      'computeSevenDeuceBounties(',
      'seatedPayer.stack =',
      "type: 'seven_deuce_bounty'",
      "supabase.from('seven_deuce_bounties')",
      'applyStackDeltas(bountyDeltas)',
      'broadcastCurrentState()',
    ]) {
      expect(section.indexOf(effect), effect).toBeGreaterThan(gate);
    }
  });

  it('gates insurance before settle/mutation and the ledger consumes only the empty snapshot', () => {
    const settle = source.indexOf('this.settleInsuranceCashOnly(this.currentHandWinnerIds)');
    const assign = source.indexOf(
      'this.currentHandInsuranceSettlements = this.insuranceEngine.settle',
      source.indexOf('protected settleInsuranceCashOnly(')
    );
    const mutation = source.indexOf(
      'seatedPlayer.stack = cents(seatedPlayer.stack + settlement.payout)',
      settle
    );
    const snapshot = source.indexOf(
      'insuranceSettlements: [...this.currentHandInsuranceSettlements]',
      mutation
    );
    const ledger = source.indexOf('snap.insuranceSettlements.length > 0', snapshot);
    expect(settle).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(settle);
    expect(snapshot).toBeGreaterThan(mutation);
    expect(ledger).toBeGreaterThan(snapshot);
  });

  it('refuses tournament RIT before any board, pot or stack mutation and contains no rounding fallback', () => {
    const runout = readFileSync(join(__dirname, 'ServerTableEngineRunout.ts'), 'utf8');
    const start = runout.indexOf('private async dealAndResolveRITUnchecked(');
    const end = runout.indexOf('private emitRitSingleRun(', start);
    const section = runout.slice(start, end);
    const gate = section.indexOf('if (this.isTournamentTable())');
    expect(gate).toBeGreaterThan(-1);
    for (const effect of [
      'this.currentHandRitBoards =',
      'this.currentHandCommunityCards =',
      'controller.computeLivePots()',
      'controller.creditRunoutWinnings(totalDistribution)',
    ]) {
      expect(section.indexOf(effect), effect).toBeGreaterThan(gate);
    }
    expect(section).not.toContain('ritIsTournamentHand');
    expect(section).not.toMatch(/Math\.floor\(amt/);
  });
});
