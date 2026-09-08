import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync('src/tournament/TournamentManagerEliminations.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
let method: ts.MethodDeclaration | undefined;
function visit(n: ts.Node) {
  if (ts.isMethodDeclaration(n) && n.name.getText(ast) === 'settleFinalTableDeal') method = n;
  ts.forEachChild(n, visit);
}
visit(ast);
if (!method?.body) throw new Error('Actual deal method missing');
const compiled = ts.transpileModule('return async function(alive) ' + method.body.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const build = new Function('supabase', 'reportError', 'settleTournamentObligation', compiled);
async function run(receipt: Record<string, unknown>) {
  const updates: Array<{ table: string; value: any }> = [];
  const report = vi.fn();
  const settle = vi.fn(async (_db, input) =>
    input.userId === 'first'
      ? receipt
      : { ok: true, fully_settled: true, amount_paid: 100, paid: 100 }
  );
  const db = {
    from(table: string) {
      let update = false;
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        update(value: unknown) {
          update = true;
          updates.push({ table, value });
          return q;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          return Promise.resolve(
            update
              ? { error: null }
              : {
                  data: [
                    { user_id: 'first', amount: 100 },
                    { user_id: 'second', amount: 100 },
                  ],
                  error: null,
                }
          ).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const owner = {
    tournamentId: 'event',
    tournamentFinished: false,
    tournamentCache: {},
    tableEngines: new Map(),
    broadcast: vi.fn(),
    settleTournamentRake: vi.fn(),
    cleanupBroadcastChannel: vi.fn(),
    stop: vi.fn(),
  };
  await build(db, report, settle).call(owner, [
    { user_id: 'first', chips: 200 },
    { user_id: 'second', chips: 100 },
  ]);
  return { updates, owner, settle, report };
}
describe('a final table deal completes only after every share settles', () => {
  it.each([
    { ok: false, refused_reason: 'escrow_short', paid: 0 },
    { ok: true, fully_settled: false, amount_paid: 40, paid: 40 },
    { ok: true, fully_settled: true, amount_paid: 80, paid: 80 },
    { ok: true, paid: 0, already_paid: 40 },
  ])('does not complete or stop the manager on %j', async (receipt) => {
    const r = await run(receipt);
    expect(r.updates).toEqual([]);
    expect(r.owner.tournamentFinished).toBe(false);
    expect(r.owner.stop).not.toHaveBeenCalled();
    expect(r.report).toHaveBeenCalled();
    expect(r.settle).toHaveBeenCalledTimes(2);
  });
  it.each([0, 100])('completes a fully settled receipt with %s newly paid', async (paid) => {
    const r = await run({ ok: true, fully_settled: true, amount_paid: 100, paid });
    expect(r.updates.some((x) => x.table === 'tournaments' && x.value.status === 'COMPLETED')).toBe(
      true
    );
    expect(r.owner.stop).toHaveBeenCalledOnce();
  });
});
