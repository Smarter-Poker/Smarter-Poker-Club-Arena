import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the table's owning effect, replacing only the remote feed boundaries.
const source = readFileSync(join(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const ast = ts.createSourceFile(
  'TablePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let effect: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'useEffect' &&
    node.arguments[0]?.getText(ast).includes('stopPool = subscribeDiamondJackpot')
  )
    effect = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
if (!effect) throw new Error('Diamond table feed is not wired');
const executable = ts.transpileModule(`const effect = ${effect.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const snapshot = {
  main_balance: 900,
  pool_id: 'pool',
  stakes: [{ big_blind: 2, mini_payable: true, mini_amount: 100 }],
};
function start(asset: string, delayed = false, lookupFailure = false) {
  let answer!: () => void;
  const ready = delayed
    ? new Promise<void>((resolve) => {
        answer = resolve;
      })
    : Promise.resolve();
  let emit!: (s: typeof snapshot) => void;
  let fail!: () => void;
  const stop = vi.fn();
  const owner = { current: 'owned' };
  const context = {
    tableId: 'table',
    lightningClubId: null,
    userId: 'account',
    tableState: { arenaAsset: asset },
    diamondJackpotKey: 'owned',
    diamondJackpotOwner: owner,
    lightningRoomRef: { current: false },
    isMounted: { current: true },
    setBbjAmount: vi.fn(),
    setBbjPoolId: vi.fn(),
    setBbjMini: vi.fn(),
    setRecordedDiamondJackpot: vi.fn(),
    setDiamondJackpotFailureKey: vi.fn(),
    reportError: vi.fn(),
    watchBbjPool: vi.fn(() => stop),
    watchBbjMini: vi.fn(() => stop),
    watchBbjHits: vi.fn(),
    subscribeDiamondJackpot: vi.fn(
      (_club: string, onSnapshot: (s: typeof snapshot) => void, onError: () => void) => {
        emit = onSnapshot;
        fail = onError;
        return stop;
      }
    ),
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              await ready;
              return lookupFailure
                ? { data: null, error: new Error('table read failed') }
                : { data: { club_id: 'diamond-club' }, error: null };
            },
          }),
        }),
      }),
    },
  };
  const cleanup = new Function(...Object.keys(context), `${executable}; return effect();`)(
    ...Object.values(context)
  );
  return {
    context,
    cleanup,
    answer: () => answer(),
    emit: () => emit(snapshot),
    fail: () => fail(),
    stop,
    owner,
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
describe('the table observes its own Diamond jackpot', () => {
  it('reports an initial table lookup failure as unavailable for its current identity', async () => {
    const run = start('diamonds', false, true);
    await flush();
    expect(run.context.setDiamondJackpotFailureKey).toHaveBeenLastCalledWith('owned');
    expect(run.context.subscribeDiamondJackpot).not.toHaveBeenCalled();
    expect(run.context.reportError).toHaveBeenCalled();
    run.cleanup();
  });
  it('masks a prior identity failure immediately, before feed cleanup runs', () => {
    for (const [path, name, owner, failure] of [
      [
        'TablePage.tsx',
        'diamondJackpotUnavailable',
        'diamondJackpotKey',
        'diamondJackpotFailureKey',
      ],
      [
        'ClubHomePage.tsx',
        'diamondJackpotUnavailable',
        'diamondJackpotOwner',
        'diamondJackpotFailureOwner',
      ],
    ]) {
      const file = ts.createSourceFile(
        path,
        readFileSync(join(__dirname, '../../src/pages', path), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      let expression: ts.Expression | undefined;
      const find = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.name.getText(file) === name)
          expression = n.initializer;
        ts.forEachChild(n, find);
      };
      find(file);
      expect(expression).toBeTruthy();
      const renderFailure = new Function(owner, failure, 'return ' + expression!.getText(file));
      expect(renderFailure('new-account:new-table', 'old-account:old-table')).toBe(false);
      expect(renderFailure('current-account:current-table', 'current-account:current-table')).toBe(
        true
      );
      expect(renderFailure('current-account:current-table', null)).toBe(false);
    }
  });
  it('routes Diamond exclusively, clears failed amounts, and cleans up its feed', async () => {
    const run = start('diamonds');
    await flush();
    expect(run.context.subscribeDiamondJackpot).toHaveBeenCalledWith(
      'diamond-club',
      expect.any(Function),
      expect.any(Function)
    );
    expect(run.context.watchBbjPool).not.toHaveBeenCalled();
    expect(run.context.watchBbjMini).not.toHaveBeenCalled();
    expect(run.context.setDiamondJackpotFailureKey).toHaveBeenLastCalledWith(null);
    run.emit();
    expect(run.context.setDiamondJackpotFailureKey).toHaveBeenLastCalledWith(null);
    expect(run.context.setRecordedDiamondJackpot).toHaveBeenLastCalledWith({
      key: 'owned',
      snapshot,
    });
    expect(run.context.setBbjAmount).toHaveBeenLastCalledWith(900);
    run.fail();
    expect(run.context.setDiamondJackpotFailureKey).toHaveBeenLastCalledWith('owned');
    run.emit();
    expect(run.context.setDiamondJackpotFailureKey).toHaveBeenLastCalledWith(null);
    run.fail();
    expect(run.context.setRecordedDiamondJackpot).toHaveBeenLastCalledWith(null);
    expect(run.context.setBbjAmount).toHaveBeenLastCalledWith(0);
    expect(run.context.setBbjPoolId).toHaveBeenLastCalledWith(null);
    run.cleanup();
    expect(run.stop).toHaveBeenCalledOnce();
  });
  it('rejects old table/account answers before effects clean up and after unmount', async () => {
    const pending = start('diamonds', true);
    pending.owner.current = 'next-account';
    pending.answer();
    await flush();
    expect(pending.context.subscribeDiamondJackpot).not.toHaveBeenCalled();
    pending.cleanup();
    const run = start('diamonds');
    await flush();
    run.owner.current = 'next-table';
    run.emit();
    run.fail();
    expect(run.context.setDiamondJackpotFailureKey).toHaveBeenCalledTimes(1);
    expect(run.context.setRecordedDiamondJackpot).toHaveBeenCalledTimes(1); // initial reset only
    run.cleanup();
    run.owner.current = 'owned';
    run.emit();
    expect(run.context.setRecordedDiamondJackpot).toHaveBeenCalledTimes(1);
  });
  it('keeps chip feeds on their existing path', async () => {
    const run = start('chips');
    await flush();
    expect(run.context.subscribeDiamondJackpot).not.toHaveBeenCalled();
    expect(run.context.watchBbjPool).toHaveBeenCalledWith('diamond-club', expect.any(Function));
    expect(run.context.watchBbjMini).toHaveBeenCalledWith('diamond-club', expect.any(Function));
    run.cleanup();
  });
});
