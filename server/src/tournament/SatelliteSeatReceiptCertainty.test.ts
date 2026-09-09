/**
 * Satellite seat/cash decisions no longer cross the application boundary one
 * winner at a time. fn_settle_satellite_finish_atomic owns every seat, cash
 * fallback, prize stamp, immutable receipt, and COMPLETED transition in one
 * transaction. These tests execute the actual TypeScript methods and pin the
 * only application-side decisions that remain: accept an exact atomic receipt,
 * or prove a lost receipt from durable COMPLETED truth.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function method(path: string, name: string) {
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let body: ts.Block | undefined;
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === name) body = node.body;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!body) throw new Error(`Missing actual method ${name}`);
  return { ast, body: body as ts.Block };
}

function compileMethod(
  path: string,
  name: string,
  parameters: string,
  dependencies: string[] = []
) {
  const actual = method(path, name);
  const code = ts.transpileModule(
    `return async function(${parameters}) ${actual.body.getText(actual.ast)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText;
  return (...values: unknown[]) => new Function(...dependencies, code)(...values);
}

const buildAtomicAward = compileMethod(
  'src/tournament/TournamentManager.ts',
  'processSatelliteAwards',
  '_tournament',
  ['supabase', 'reportError']
);

function atomicAwardFixture(data: unknown, error: unknown = null, throws?: unknown) {
  const reportError = vi.fn();
  const rpc = vi.fn(async () => {
    if (throws !== undefined) throw throws;
    return { data, error };
  });
  const run = buildAtomicAward({ rpc }, reportError) as (
    this: unknown,
    tournament: unknown
  ) => Promise<boolean>;
  return {
    reportError,
    rpc,
    run: () => run.call({ tournamentId: 'satellite' }, {}),
  };
}

describe('only an exact atomic satellite receipt confirms every seat and cash outcome', () => {
  it.each([
    [null, { message: 'timeout after commit' }],
    [{ ok: true, settled: true }, { message: 'transport response error' }],
    [null, null],
    [{}, null],
    [{ ok: 'true', settled: true }, null],
    [{ ok: true, settled: 'true' }, null],
    [{ ok: true, settled: false }, null],
  ])('refuses an ambiguous atomic receipt %j / %j', async (data, error) => {
    const fixture = atomicAwardFixture(data, error);

    await expect(fixture.run()).resolves.toBe(false);
    expect(fixture.reportError).toHaveBeenCalledOnce();
    expect(fixture.reportError.mock.calls[0]?.[1]).toBe(
      'Tournament.atomic_satellite_finish_failed'
    );
    expect(fixture.rpc).toHaveBeenCalledWith('fn_settle_satellite_finish_atomic', {
      p_tournament_id: 'satellite',
      p_source: 'engine.finishTournament',
    });
  });

  it('accepts a new or replayed transaction only with exact settled proof', async () => {
    const fixture = atomicAwardFixture({
      ok: true,
      settled: true,
      already_settled: true,
      award_depth: 2,
      amount_settled: 20,
    });

    await expect(fixture.run()).resolves.toBe(true);
    expect(fixture.reportError).not.toHaveBeenCalled();
    expect(fixture.rpc).toHaveBeenCalledOnce();
  });

  it('fails closed when the transport throws before a receipt is available', async () => {
    const fixture = atomicAwardFixture(null, null, new Error('socket closed'));

    await expect(fixture.run()).resolves.toBe(false);
    expect(fixture.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'socket closed' }),
      'Tournament.atomic_satellite_finish_threw'
    );
  });
});

const buildAtomicHandoff = compileMethod(
  'src/tournament/TournamentManagerEliminations.ts',
  'settleSatelliteFinishAtomically',
  'tournament'
);

describe('a lost atomic response is resolved only from durable terminal truth', () => {
  it('does not perform a status read after an exact success receipt', async () => {
    const processSatelliteAwards = vi.fn(async () => true);
    const readDurableTournamentStatus = vi.fn(async () => ({ status: 'COMPLETING', error: null }));
    const run = buildAtomicHandoff() as (this: unknown, tournament: unknown) => Promise<boolean>;

    await expect(
      run.call(
        { tournamentId: 'satellite', processSatelliteAwards, readDurableTournamentStatus },
        {}
      )
    ).resolves.toBe(true);
    expect(readDurableTournamentStatus).not.toHaveBeenCalled();
  });

  it('accepts a lost response only when the durable row is COMPLETED', async () => {
    const run = buildAtomicHandoff() as (this: unknown, tournament: unknown) => Promise<boolean>;
    const base = { tournamentId: 'satellite', processSatelliteAwards: async () => false };

    await expect(
      run.call(
        {
          ...base,
          readDurableTournamentStatus: async () => ({ status: 'COMPLETED', error: null }),
        },
        {}
      )
    ).resolves.toBe(true);
    for (const durable of [
      { status: 'COMPLETING', error: null },
      { status: null, error: 'read timeout' },
    ]) {
      await expect(
        run.call({ ...base, readDurableTournamentStatus: async () => durable }, {})
      ).resolves.toBe(false);
    }
  });
});

const finish = method('src/tournament/TournamentManagerEliminations.ts', 'finishTournament');
const satelliteBranch = finish.body.statements.find(
  (node) => ts.isIfStatement(node) && node.expression.getText(finish.ast) === 'isSatelliteFinish'
);
if (!satelliteBranch) throw new Error('Missing actual satellite finish handoff');
const handoffCode = ts.transpileModule(
  `return async function(tournament) { const isSatelliteFinish = true; ${satelliteBranch.getText(
    finish.ast
  )}; return 'completed'; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
const finishHandoff = new Function('TournamentManagerBase', handoffCode)({
  UNRESOLVED_BUST_RETRY_MS: 250,
}) as (this: unknown, tournament: unknown) => Promise<string | undefined>;

describe('the finish path cannot clean up after an unconfirmed satellite transaction', () => {
  it('keeps the manager retryable when atomic settlement is not proven', async () => {
    const requestUrgentEliminationSweepAfter = vi.fn();
    const context = {
      tournamentFinished: true,
      settleSatelliteFinishAtomically: async () => false,
      requestUrgentEliminationSweepAfter,
    };

    await expect(finishHandoff.call(context, {})).resolves.toBeUndefined();
    expect(context.tournamentFinished).toBe(false);
    expect(requestUrgentEliminationSweepAfter).toHaveBeenCalledWith(250);
  });

  it('continues only after the atomic handoff is confirmed', async () => {
    await expect(
      finishHandoff.call({ settleSatelliteFinishAtomically: async () => true }, {})
    ).resolves.toBe('completed');
  });
});
