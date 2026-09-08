import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Execute both production methods. The RPC stub models the database's
// already-finalized short circuit; it does not replace either manager method.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TournamentManagerBase'
);
if (!manager) throw new Error('TournamentManagerBase class missing');
const methods = ['finalizeAfterAddOn', 'applyPrizeGuarantee'].map((name) => {
  const method = manager.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === name
  );
  if (!method) throw new Error('Production method missing: ' + name);
  return method.getText(ast);
});
const compiled = ts.transpileModule(
  'class Subject { ' + methods.join('\n') + ' }\nreturn Subject;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

function fixture(failFirst = false) {
  let finalized = false;
  let pool = 60;
  const update = vi.fn((patch) => ({
    eq: vi.fn(async () => {
      finalized = patch.prize_pool_finalized;
      return { error: null };
    }),
  }));
  const rpc = vi.fn(async () => {
    if (failFirst) {
      failFirst = false;
      return { data: null, error: { message: 'temporary funding failure' } };
    }
    if (finalized) return { data: { ok: true, reason: 'already_finalized', prize_pool: pool } };
    pool = 100;
    finalized = true;
    return { data: { ok: true, prize_pool: pool, overlay: 40, treasury_after: 960 } };
  });
  const reportError = vi.fn();
  const Subject = new Function('supabase', 'reportError', 'console', compiled)(
    { from: vi.fn(() => ({ update })), rpc },
    reportError,
    { log: vi.fn() }
  );
  const subject = Object.assign(new Subject(), {
    tournamentId: 'addon-test',
    currentLevel: 9,
    prizePoolFinalized: false,
    tournamentCache: { prize_pool: 60 },
    recalculateEliminatedPrizes: vi.fn(async () => {}),
    broadcast: vi.fn(async () => {}),
  });
  return { subject, update, rpc, reportError, database: () => ({ finalized, pool }) };
}

describe('add-on completion funds before finalizing', () => {
  it('funds the missing guarantee before repricing eliminated players', async () => {
    const f = fixture();
    await f.subject.finalizeAfterAddOn();
    expect(f.database()).toEqual({ finalized: true, pool: 100 });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.subject.tournamentCache.prize_pool).toBe(100);
    expect(f.subject.recalculateEliminatedPrizes).toHaveBeenCalledWith(100);
    expect(f.subject.prizePoolFinalized).toBe(true);
    expect(f.subject.broadcast).toHaveBeenCalledWith('ADDON_PERIOD_END', {});
  });

  it('does not finalize or invent a pool when funding fails', async () => {
    const f = fixture(true);
    await f.subject.finalizeAfterAddOn();
    expect(f.database()).toEqual({ finalized: false, pool: 60 });
    expect(f.subject.prizePoolFinalized).toBe(false);
    expect(f.subject.recalculateEliminatedPrizes).not.toHaveBeenCalled();
    expect(f.reportError).toHaveBeenCalled();
    // The time window has ended even when its guarantee could not be funded.
    expect(f.subject.broadcast).toHaveBeenCalledWith('ADDON_PERIOD_END', {});
  });

  it('allows a later invocation to fund after a temporary failure', async () => {
    const f = fixture(true);
    await f.subject.finalizeAfterAddOn();
    await f.subject.finalizeAfterAddOn();
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(f.database()).toEqual({ finalized: true, pool: 100 });
    expect(f.subject.recalculateEliminatedPrizes).toHaveBeenCalledTimes(1);
    expect(f.subject.recalculateEliminatedPrizes).toHaveBeenCalledWith(100);
  });

  it('does not repeat funding after successful finalization', async () => {
    const f = fixture();
    await f.subject.finalizeAfterAddOn();
    await f.subject.finalizeAfterAddOn();
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.subject.broadcast).toHaveBeenCalledTimes(1);
  });
});
