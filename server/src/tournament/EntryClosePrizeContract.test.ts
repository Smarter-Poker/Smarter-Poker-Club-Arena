import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parsePayoutStructure } from './payoutStructure.js';
import { readTournamentPrizePool } from './tournamentPrizeContract.js';

const source = readFileSync('src/tournament/TournamentManagerBase.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TournamentManagerBase'
);
const method = manager?.members.find(
  (node) =>
    ts.isMethodDeclaration(node) && node.name.getText(ast) === 'reconcileTournamentEntryWindowOnce'
);
if (!method) throw new Error('Production entry-close receipt consumer missing');
const compiled = ts.transpileModule(`class Subject { ${method.getText(ast)} } return Subject;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function run(
  prize_pool: unknown,
  payout_structure: unknown = [{ place: 1, percentage: 100 }]
) {
  const report = vi.fn();
  const rpc = vi.fn(async () => ({
    data: {
      ok: true,
      entry_closed: true,
      finalized: true,
      prize_pool,
      payout_structure,
      reprice_pending: true,
    },
    error: null,
  }));
  const Subject = new Function(
    'supabase',
    'reportError',
    'TournamentManagerBase',
    'readTournamentPrizePool',
    'parsePayoutStructure',
    compiled
  )(
    { rpc },
    report,
    { UNRESOLVED_BUST_RETRY_MS: 1000 },
    readTournamentPrizePool,
    parsePayoutStructure
  );
  const lifecycle = {};
  const subject = Object.assign(new Subject(), {
    tournamentId: 'event',
    tournamentEntryCloseAnnounced: true,
    prizePoolFinalized: false,
    tournamentCache: { prize_pool: 60, prize_pool_finalized: false },
    captureLifecycleToken: () => lifecycle,
    lifecycleIsCurrent: (candidate: unknown) => candidate === lifecycle,
    clearTournamentEntryCloseTimer: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
    recalculateEliminatedPrizes: vi.fn(async () => false),
  });
  const result = await subject.reconcileTournamentEntryWindowOnce('test');
  return { result, subject, rpc, report };
}

describe('entry close adopts a readable financial contract before repricing', () => {
  it.each([
    undefined,
    null,
    false,
    true,
    '',
    ' ',
    [],
    {},
    -1,
    0.001,
    Infinity,
    NaN,
    '0x64',
    '1e2',
    Number.MAX_VALUE,
  ])('retains the unpaid receipt when the returned prize pool is %s', async (value) => {
    const f = await run(value);
    expect(f.result).toBe(false);
    expect(f.subject.prizePoolFinalized).toBe(false);
    expect(f.subject.tournamentCache.prize_pool).toBe(60);
    expect(f.subject.recalculateEliminatedPrizes).not.toHaveBeenCalled();
    expect(f.subject.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(1000);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.report).toHaveBeenCalled();
  });

  it.each(
    [[], null, [{}], [{ place: 2, percentage: 100 }], [{ place: 1, percentage: -1 }]].map(
      (ladder) => ({ ladder })
    )
  )('retains the receipt when its final ladder is unreadable: %j', async ({ ladder }) => {
    const f = await run(100, ladder);
    expect(f.subject.prizePoolFinalized).toBe(false);
    expect(f.subject.recalculateEliminatedPrizes).not.toHaveBeenCalled();
    expect(f.subject.requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(1000);
  });

  it.each([0, 100, 100.25, '100.25'])(
    'accepts an explicit whole-cent pool %s and retains unfinished repricing',
    async (value) => {
      const f = await run(value);
      expect(f.subject.prizePoolFinalized).toBe(true);
      expect(f.subject.recalculateEliminatedPrizes).toHaveBeenCalledWith(Number(value));
      expect(f.result).toBe(false);
      expect(f.rpc).toHaveBeenCalledTimes(1);
    }
  );
});
