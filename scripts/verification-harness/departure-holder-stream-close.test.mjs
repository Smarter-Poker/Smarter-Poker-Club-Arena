// Deterministic process event-order proof; no database or money calls.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// The accounting job installs the server lockfile, not the client dependencies.
const ts = createRequire(new URL('../../server/package.json', import.meta.url))('typescript');

const source = readFileSync(
  new URL('../../server/src/engine/CashoutDeparturePostgres.test.ts', import.meta.url),
  'utf8'
);
const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
let declaration;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'holdingSql') {
    assert.equal(declaration, undefined);
    declaration = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(declaration);
const compiled = ts.transpileModule(`const helper=${declaration};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(text) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  const helper = new Function('spawn', 'sql', 'process', 'host', `${text}; return helper;`)(
    () => child,
    () => true,
    { env: { CA_DEPARTURE_PSQL: 'synthetic' } },
    'synthetic'
  );
  return { child, helper };
}

test('actual holder waits for stream close; original exit result loses trailing PostgreSQL refusal', async () => {
  const old = compiled.replace(
    "child.once('close', (code) => resolve({ code, error }))",
    "child.once('exit', (code) => resolve({ code, error }))"
  );
  assert.notEqual(old, compiled);
  for (const [text, expected] of [
    [old, ''],
    [compiled, 'CASH_PURCHASE_ONLY'],
  ]) {
    const { child, helper } = fixture(text);
    const pending = helper('SELECT synthetic');
    child.stdout.emit('data', 'SQL_LOCK_READY');
    const holder = await pending;
    const result = holder.finish(true, 'synthetic insert');
    child.emit('exit', 3);
    child.stderr.emit('data', 'CASH_PURCHASE_ONLY');
    child.emit('close', 3);
    assert.deepEqual(await result, { code: 3, error: expected });
  }
});

test('actual holder distinguishes spawn error and drains early-close readiness diagnostics', async () => {
  const { child, helper } = fixture(compiled);
  const pending = helper('SELECT synthetic');
  child.stdout.emit('data', 'SQL_LOCK_READY');
  const holder = await pending;
  child.emit('error', new Error('SYNTHETIC_SPAWN_FAILURE'));
  assert.deepEqual(await holder.finish(false), {
    code: null,
    error: 'Error: SYNTHETIC_SPAWN_FAILURE',
  });
  const early = fixture(compiled);
  const rejected = early.helper('SELECT synthetic');
  early.child.emit('exit', 3);
  early.child.stderr.emit('data', 'SYNTHETIC_REFUSAL');
  early.child.emit('close', 3);
  await assert.rejects(rejected, /Lock holder exited 3: SYNTHETIC_REFUSAL/);
});
