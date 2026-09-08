import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync('src/tournament/tournamentRecovery.ts', 'utf8');
const ast = ts.createSourceFile('recovery.ts', source, ts.ScriptTarget.Latest, true);
let initializer: ts.Expression | undefined;
function visit(n: ts.Node) {
  if (
    ts.isVariableDeclaration(n) &&
    n.name.getText(ast) === 'credit' &&
    n.initializer?.getText(ast).includes('settleTournamentObligation(')
  )
    initializer = n.initializer;
  ts.forEachChild(n, visit);
}
visit(ast);
if (!initializer) throw new Error('Actual recovery credit function missing');
const compiled = ts.transpileModule('return ' + initializer.getText(ast) + ';', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const build = new Function('settleTournamentObligation', 'supabase', 't', compiled);
function credit(receipt: Record<string, unknown>) {
  return build(async () => receipt, {}, { id: 'event' })('player', 100, 'test', {
    kind: 'place',
    place: 1,
  });
}
describe('recovery cannot finish a partially paid tournament', () => {
  it.each([
    { ok: true, paid: 40, amount_paid: 40, fully_settled: false },
    { ok: true, paid: 0, already_paid: 40 },
    { ok: true, paid: 0, amount_paid: 80, fully_settled: true },
    { ok: false, paid: 0, refused_reason: 'escrow_short' },
  ])('stops before completion for %j', async (receipt) => {
    await expect(credit(receipt)).rejects.toThrow();
  });
  it('returns moved status only after full payment is confirmed', async () => {
    await expect(
      credit({ ok: true, paid: 60, amount_paid: 100, fully_settled: true })
    ).resolves.toBe(true);
    await expect(
      credit({ ok: true, paid: 0, amount_paid: 100, fully_settled: true })
    ).resolves.toBe(false);
  });
});
