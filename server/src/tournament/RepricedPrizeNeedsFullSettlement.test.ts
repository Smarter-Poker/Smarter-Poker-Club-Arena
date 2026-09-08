import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync('src/tournament/TournamentManagerEliminations.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
let branch: ts.IfStatement | undefined;
function visit(node: ts.Node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'recalculateEliminatedPrizes') {
    function find(child: ts.Node) {
      if (ts.isIfStatement(child) && child.expression.getText(ast).startsWith('adj.'))
        branch = child;
      ts.forEachChild(child, find);
    }
    find(node);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!branch) throw new Error('Actual repricing result branch missing');
const compiled = ts.transpileModule('return (async () => { ' + branch.getText(ast) + ' })();', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const execute = new Function(
  'adj',
  'supabase',
  'correctPrize',
  'player',
  'difference',
  'reportError',
  compiled
);
async function run(adj: Record<string, unknown>) {
  const update = vi.fn(() => ({ eq: () => ({ eq: async () => ({ error: null }) }) }));
  const report = vi.fn();
  await execute.call(
    { tournamentId: 'event' },
    adj,
    { from: () => ({ update }) },
    100,
    { user_id: 'player' },
    60,
    report
  );
  return { update, report };
}
describe('late-reg prize display requires confirmed full settlement', () => {
  it.each([
    { ok: true, paid: 40, already_paid: 40, amount_paid: 80, fully_settled: false },
    { ok: true, paid: 0, already_paid: 40 },
    { ok: false, paid: 0, refused_reason: 'escrow_short' },
    { ok: true, paid: 0, amount_paid: 80, fully_settled: true },
  ])('does not display an unpaid full prize for %j', async (receipt) => {
    const { update, report } = await run(receipt);
    expect(update).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalled();
  });
  it.each([100, 120])('records the prize when confirmed paid total is %s', async (amount_paid) => {
    const { update } = await run({ ok: true, amount_paid, fully_settled: true });
    expect(update).toHaveBeenCalledWith({ prize: 100 });
  });
});
