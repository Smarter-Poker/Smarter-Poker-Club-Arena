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
async function run(overrides: Partial<Record<'alive' | 'records' | 'seats', Receipt>> = {}) {
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
        update(value: unknown) {
          update = value;
          updates.push(value);
          return query;
        },
        then(resolve: (value: unknown) => unknown, reject: (e: unknown) => unknown) {
          const result = update
            ? { error: null }
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
