import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readTournamentPrizePool } from './tournamentPrizeContract.js';
const source = readFileSync('src/tournament/TournamentManagerBase.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (n): n is ts.ClassDeclaration =>
    ts.isClassDeclaration(n) && n.name?.text === 'TournamentManagerBase'
);
const method = manager?.members.find(
  (n) => ts.isMethodDeclaration(n) && n.name.getText(ast) === 'applyPrizeGuarantee'
);
if (!method) throw new Error('Actual guarantee method missing');
const compiled = ts.transpileModule(
  'class Subject { ' + method.getText(ast) + ' } return Subject;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
async function run(prize_pool: unknown) {
  const report = vi.fn();
  const Subject = new Function(
    'supabase',
    'reportError',
    'console',
    'readTournamentPrizePool',
    compiled
  )(
    { rpc: async () => ({ data: { ok: true, prize_pool, overlay: 0 }, error: null }) },
    report,
    { log: vi.fn() },
    readTournamentPrizePool
  );
  const subject = Object.assign(new Subject(), {
    tournamentId: 'event',
    prizePoolFinalized: false,
    tournamentCache: { prize_pool: 60 },
  });
  const result = await subject.applyPrizeGuarantee('test');
  return { result, subject, report };
}
describe('a guarantee receipt needs an actual chip amount', () => {
  it.each([
    undefined,
    null,
    false,
    true,
    '',
    ' ',
    [],
    {},
    Infinity,
    NaN,
    -1,
    0.001,
    '0x64',
    '1e2',
    Number.MAX_VALUE,
  ])('rejects malformed pool %s without finalizing', async (value) => {
    const { result, subject, report } = await run(value);
    expect(result).toBeNull();
    expect(subject.prizePoolFinalized).toBe(false);
    expect(subject.tournamentCache.prize_pool).toBe(60);
    expect(report).toHaveBeenCalled();
  });
  it.each([0, 100, 100.25, '100.25'])('accepts the explicit chip amount %s', async (value) => {
    const { result, subject } = await run(value);
    expect(result).toBe(Number(value));
    expect(subject.prizePoolFinalized).toBe(true);
    expect(subject.tournamentCache.prize_pool).toBe(Number(value));
  });
});
