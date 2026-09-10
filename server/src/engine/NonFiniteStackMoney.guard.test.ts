import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
  loadTable: vi.fn(),
  updateTableStatus: vi.fn(),
  autoRebuyHorse: vi.fn(),
  markSeatAsLeft: vi.fn(),
  processLeavePending: vi.fn(),
  logBBJCollection: vi.fn(),
  logInsuranceSettlement: vi.fn(),
  logHandHistory: vi.fn(),
  processBBJPayout: vi.fn(),
  completeHandSnapshot: vi.fn(),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const HERE = dirname(fileURLToPath(import.meta.url));
const settlement = readFileSync(resolve(HERE, 'ServerTableEngineSettlement.ts'), 'utf8');
const { ServerTableEngineSettlement } = await import('./ServerTableEngineSettlement.js');

describe('non-finite stack money is a terminal settlement refusal', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws and quarantines the engine for %s at runtime',
    (value) => {
      const killForRestart = vi.fn();
      const engine = Object.assign(Object.create(ServerTableEngineSettlement.prototype), {
        tableId: 'table',
        killForRestart,
      }) as unknown as {
        requireFiniteStackMoney: (value: number, operation: string, userId: string) => number;
      };

      expect(() => engine.requireFiniteStackMoney(value, 'test', 'player')).toThrow(
        /Non-finite stack money refused/
      );
      expect(killForRestart).toHaveBeenCalledOnce();
      expect(killForRestart).toHaveBeenCalledWith('non_finite_stack_money');
    }
  );

  it('quarantines the engine generation and throws on NaN or Infinity', () => {
    const boundary = sliceMethod(settlement, 'private requireFiniteStackMoney(');

    expect(boundary).toContain('Number.isFinite(value)');
    expect(boundary).toContain("this.killForRestart('non_finite_stack_money')");
    expect(boundary).toContain('throw new Error(');
  });

  it('validates final, initial, and computed stack values before batching', () => {
    const start = settlement.indexOf('// SETTLEMENT STEP 7: Update player stacks');
    const end = settlement.indexOf('// SETTLEMENT STEP 15 (partial)', start);
    const step = settlement.slice(start, end);
    const finalAt = step.indexOf("'hand_settlement_final_stack'");
    const initialAt = step.indexOf("'hand_settlement_initial_stack'");
    const deltaAt = step.indexOf("'hand_settlement_delta'");
    const batchAt = step.indexOf('this.atomicStackService.atomicSettle(');

    expect(finalAt).toBeGreaterThan(-1);
    expect(initialAt).toBeGreaterThan(finalAt);
    expect(deltaAt).toBeGreaterThan(initialAt);
    expect(batchAt).toBeGreaterThan(deltaAt);
    expect(step).toContain("this.killForRestart('atomic_stack_settlement_refused')");
    expect(step).toContain('throw refusal');
  });

  it('never turns a corrupt mini-jackpot stack into zero before crediting it', () => {
    const start = settlement.indexOf('const bump = (userId: string | undefined, amount: number)');
    const end = settlement.indexOf('bump(mini.loserUserId', start);
    const bump = settlement.slice(start, end);

    expect(bump).toContain("'mini_bbj_credit'");
    expect(bump).toContain("'mini_bbj_existing_stack'");
    expect(bump).toContain("'mini_bbj_resulting_stack'");
    expect(bump).not.toMatch(/seat\.stack\s*\|\|\s*0/);
  });
});
