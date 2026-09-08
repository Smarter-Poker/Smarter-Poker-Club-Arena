import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the actual recovery function with a query boundary, without starting an engine.
const source = readFileSync('src/tournament/tournamentRecovery.ts', 'utf8');
const ast = ts.createSourceFile('recovery.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(
  (n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && n.name?.text === 'recoverStuckCompletingTournaments'
);
if (!fn) throw new Error('Actual recovery function missing');
const compiled = ts.transpileModule(
  fn.getText(ast).replace(/^export /, '') + '\nreturn recoverStuckCompletingTournaments;',
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }
).outputText;
const build = new Function('supabase', 'reportError', 'raiseFinancialAlert', compiled);
type Receipt = { count: unknown; error: { message: string } | null };
async function run(
  overrides: Partial<Record<'alive' | 'records' | 'seats', Receipt>> = {},
  writeReceipt: Receipt = { count: 1, error: null }
) {
  const counts = {
    alive: { count: 1, error: null },
    records: { count: 0, error: null },
    seats: { count: 0, error: null },
    ...overrides,
  };
  const updates: unknown[] = [];
  const report = vi.fn();
  const alert = vi.fn();
  const db = {
    from(table: string) {
      let sourceSeat = false;
      let update: unknown;
      let exact = false;
      const query = {
        select() {
          return query;
        },
        eq(column: string) {
          if (column === 'source_satellite_id') sourceSeat = true;
          return query;
        },
        in() {
          return query;
        },
        update(value: unknown, options?: { count?: string }) {
          exact = options?.count === 'exact';
          update = value;
          updates.push(value);
          return query;
        },
        then(resolve: (value: unknown) => unknown, reject: (e: unknown) => unknown) {
          const result = update
            ? { error: writeReceipt.error, count: exact ? writeReceipt.count : null }
            : table === 'tournaments'
              ? {
                  data: [{ id: 'satellite-event', name: 'Satellite', variant: 'satellite' }],
                  error: null,
                }
              : table === 'tournament_payouts'
                ? counts.records
                : sourceSeat
                  ? counts.seats
                  : counts.alive;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
  await build(db, report, alert)('audit');
  return { updates, report, alert };
}
describe('satellite recovery requires readable counts before status transitions', () => {
  for (const role of ['alive', 'records', 'seats'] as const) {
    it.each([
      { count: 0, error: { message: 'read timeout' } },
      { count: null, error: null },
      { count: -1, error: null },
      { count: 0.5, error: null },
    ])(`does not revive or close on unknown ${role}: %j`, async (receipt) => {
      const result = await run({ [role]: receipt });
      expect(result.updates).toEqual([]);
      expect(result.report).toHaveBeenCalled();
      expect(result.alert).not.toHaveBeenCalled();
    });
  }
  it('retains lone-survivor recovery after confirmed zero awards', async () => {
    expect((await run()).updates).toEqual([{ status: 'RUNNING' }]);
  });
  it('retains undecided recovery with a confirmed live field', async () => {
    expect((await run({ alive: { count: 2, error: null } })).updates).toEqual([
      { status: 'RUNNING' },
    ]);
  });
});

describe('satellite recovery only reports confirmed status transitions', () => {
  for (const scenario of [
    {
      name: 'undecided',
      counts: { alive: { count: 2, error: null } },
      context: 'GameServer.recoverStuckCompleting_satellite_revived',
    },
    {
      name: 'decided',
      counts: {},
      context: 'GameServer.recoverStuckCompleting_satellite_revived_decided',
    },
    {
      name: 'awarded',
      counts: { records: { count: 1, error: null } },
      context: 'GameServer.recoverStuckCompleting_satellite_closed',
    },
  ]) {
    it.each([
      { count: 0, error: null },
      { count: null, error: null },
      { count: 2, error: null },
      { count: 1, error: { message: 'write timeout' } },
    ])(
      `${scenario.name}: reports failure instead of a confirmed transition for %j`,
      async (receipt) => {
        const result = await run(scenario.counts, receipt);
        expect(result.updates).toHaveLength(1);
        expect(result.report).toHaveBeenCalledWith(
          expect.any(Error),
          'GameServer.recoverStuckCompleting_per_tournament'
        );
        expect(result.report).not.toHaveBeenCalledWith(expect.any(Error), scenario.context);
      }
    );
    it(`${scenario.name}: retains a confirmed successful transition`, async () => {
      const result = await run(scenario.counts);
      expect(result.updates).toHaveLength(1);
      expect(result.report).toHaveBeenCalledWith(expect.any(Error), scenario.context);
      expect(result.report).not.toHaveBeenCalledWith(
        expect.any(Error),
        'GameServer.recoverStuckCompleting_per_tournament'
      );
    });
  }
});
