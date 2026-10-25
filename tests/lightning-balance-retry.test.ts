import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it('Retry reads the pool without marking a still-known engine balance superseded', async () => {
  const source = ts.createSourceFile(
    'TablePage.tsx',
    readFileSync('src/pages/TablePage.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let callback = '';
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'retryAccountBalance' &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    )
      callback = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(callback).not.toBe('');
  const read = vi.fn(async () => null);
  const refresh = vi.fn();
  const supersede = vi.fn();
  const writeWallet = vi.fn();
  const names = [
    'userId',
    'tableId',
    'lightningRoomRef',
    'setLightningBalanceReadVersion',
    'setLightningBalanceVersion',
    'readBalanceRevision',
    'readBustBalance',
    'setBalanceIfCurrent',
  ];
  const body = ts.transpile(`const retry = ${callback};`, { target: ts.ScriptTarget.ES2022 });
  const retry = new Function(...names, `${body}\nreturn retry;`)(
    'hero',
    'room',
    { current: {} },
    refresh,
    supersede,
    () => 7,
    read,
    writeWallet
  );
  retry();
  await Promise.resolve();
  expect(read).toHaveBeenCalledWith('hero', 'room');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(supersede).not.toHaveBeenCalled();
  expect(writeWallet).not.toHaveBeenCalled();
});
