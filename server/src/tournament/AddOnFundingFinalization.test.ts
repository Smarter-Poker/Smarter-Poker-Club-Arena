import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { readTournamentPrizePool } from './tournamentPrizeContract.js';

// Execute the production close method with only its infrastructure dependencies
// replaced. Funding, finalization and the durable receipt now belong to the one
// atomic database close, so this harness deliberately has no local update path.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TournamentManagerBase'
);
if (!manager) throw new Error('TournamentManagerBase class missing');
const method = manager.members.find(
  (node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && node.name.getText(ast) === 'finalizeAfterAddOn'
);
if (!method) throw new Error('Production finalizeAfterAddOn method missing');
const compiled = ts.transpileModule(`class Subject { ${method.getText(ast)} }\nreturn Subject;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(failFirst = false) {
  let finalized = false;
  let pool = 60;
  const from = vi.fn(() => {
    throw new Error('add-on finalization must not have an application-side update path');
  });
  const rpc = vi.fn(async (name: string) => {
    if (name !== 'fn_close_tournament_addon_period') {
      throw new Error(`unexpected RPC ${name}`);
    }
    if (failFirst) {
      failFirst = false;
      return { data: { ok: false, reason: 'temporary_funding_failure' }, error: null };
    }
    finalized = true;
    pool = 100;
    return {
      data: {
        ok: true,
        prize_pool: pool,
        payout_structure: [{ place: 1, percentage: 100 }],
      },
      error: null,
    };
  });
  const reportError = vi.fn();
  const Subject = new Function(
    'supabase',
    'reportError',
    'isMaintenanceFrozen',
    'console',
    'readTournamentPrizePool',
    compiled
  )({ from, rpc }, reportError, () => false, { log: vi.fn() }, readTournamentPrizePool);
  const lifecycle = {};
  const subject = Object.assign(new Subject(), {
    tournamentId: 'addon-test',
    currentLevel: 9,
    prizePoolFinalized: false,
    addOnPeriodFinalizing: false,
    tournamentCache: { prize_pool: 60, prize_pool_finalized: false },
    captureLifecycleToken: vi.fn(() => lifecycle),
    lifecycleIsCurrent: vi.fn((candidate: unknown) => candidate === lifecycle),
    reconcileTournamentEntryWindow: vi.fn(async () => true),
    finishAddOnTail: vi.fn(async () => undefined),
    scheduleAddOnPeriodEnd: vi.fn(),
    requestAddOnDeadlineRetry: vi.fn(),
    scheduleFinalizedAddOnTailReplay: vi.fn(),
  });
  return { subject, from, rpc, reportError, database: () => ({ finalized, pool }) };
}

describe('add-on completion funds before finalizing', () => {
  it.each([null, false, '', ' ', -1, 0.001, '0x64', '1e2', Number.MAX_VALUE])(
    'does not resume the add-on tail from malformed pool %s',
    async (prize_pool) => {
      const f = fixture();
      f.rpc.mockResolvedValueOnce({ data: { ok: true, prize_pool } as any, error: null });
      await expect(f.subject.finalizeAfterAddOn()).resolves.toBe(false);
      expect(f.subject.prizePoolFinalized).toBe(false);
      expect(f.subject.tournamentCache.prize_pool).toBe(60);
      expect(f.subject.reconcileTournamentEntryWindow).not.toHaveBeenCalled();
      expect(f.subject.finishAddOnTail).not.toHaveBeenCalled();
      expect(f.subject.requestAddOnDeadlineRetry).toHaveBeenCalledWith(5000);
    }
  );

  it('adopts only the atomic close receipt before running the idempotent tail', async () => {
    const f = fixture();

    await expect(f.subject.finalizeAfterAddOn()).resolves.toBe(true);

    expect(f.database()).toEqual({ finalized: true, pool: 100 });
    expect(f.rpc).toHaveBeenCalledWith('fn_close_tournament_addon_period', {
      p_tournament_id: 'addon-test',
      p_source: 'engine.addon_period_end',
    });
    expect(f.from).not.toHaveBeenCalled();
    expect(f.subject.tournamentCache).toMatchObject({
      prize_pool: 100,
      prize_pool_finalized: true,
      payout_structure: [{ place: 1, percentage: 100 }],
    });
    expect(f.subject.reconcileTournamentEntryWindow).toHaveBeenCalledWith(
      'engine.addon_period_reprice'
    );
    expect(f.subject.finishAddOnTail).toHaveBeenCalledWith(100, true);
    expect(f.subject.addOnPeriodFinalizing).toBe(false);
  });

  it('does not finalize or run the tail when the atomic close refuses', async () => {
    const f = fixture(true);

    await expect(f.subject.finalizeAfterAddOn()).resolves.toBe(false);

    expect(f.database()).toEqual({ finalized: false, pool: 60 });
    expect(f.subject.prizePoolFinalized).toBe(false);
    expect(f.subject.reconcileTournamentEntryWindow).not.toHaveBeenCalled();
    expect(f.subject.finishAddOnTail).not.toHaveBeenCalled();
    expect(f.subject.requestAddOnDeadlineRetry).toHaveBeenCalledWith(5_000);
    expect(f.reportError).toHaveBeenCalled();
    expect(f.subject.addOnPeriodFinalizing).toBe(false);
  });

  it('releases the in-process gate so a temporary refusal can be retried', async () => {
    const f = fixture(true);

    await expect(f.subject.finalizeAfterAddOn()).resolves.toBe(false);
    await expect(f.subject.finalizeAfterAddOn()).resolves.toBe(true);

    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.database()).toEqual({ finalized: true, pool: 100 });
    expect(f.subject.finishAddOnTail).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the atomic close after adopting its successful receipt', async () => {
    const f = fixture();

    await f.subject.finalizeAfterAddOn();
    await f.subject.finalizeAfterAddOn();

    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.subject.finishAddOnTail).toHaveBeenCalledTimes(1);
  });
});
