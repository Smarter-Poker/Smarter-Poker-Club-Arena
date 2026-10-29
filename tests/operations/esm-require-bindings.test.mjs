import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {sourceViolations} from '../../scripts/ci/check-esm-require.mjs';

const factory = "import {createRequire} from 'node:module';\n";
const body = "function workerNative(){\n const require=createRequire(import.meta.url);\n return require('node:path');\n}";
const refused = source => assert.ok(sourceViolations(source).length, source);

test('accepts only the actual lexical imported Node factory and immediate const binding', () => {
  assert.deepEqual(sourceViolations(factory+body), []);
  assert.deepEqual(sourceViolations("import {createRequire as nodeFactory} from 'node:module';\n"+body.replace('=createRequire(', '=nodeFactory(')), []);
  const actual=readFileSync(new URL('../../server/src/engine/GtoPublicHist215Features.ts',import.meta.url),'utf8');
  assert.deepEqual(sourceViolations(actual,'features.ts'), []);
});

test('refuses bare CommonJS, local fake factories, other modules and shadowed imports', () => {
  for(const source of [
    "const x=require('node:path');",
    "function createRequire(){return x=>x;}\n"+body,
    factory+body.replace('function workerNative()', 'function workerNative(createRequire)'),
    factory+body.replace(' const require=', ' const createRequire=()=>()=>null;\n const require='),
    factory.replace('node:module','another-module')+body,
    factory.replace('import {','import type {')+body,
    factory+body.replace('return require(', 'return object.require('),
    factory+body.replace('const require=', 'const {require}='),
  ]) refused(source);
});

test('refuses TDZ, cross-scope, late or nonconst bindings and altered factory arguments', () => {
  for(const source of [
    factory+"function f(){return require('x');const require=createRequire(import.meta.url);}",
    factory+"const require=createRequire(import.meta.url);function f(){return require('x');}",
    factory+body.replace('return require(', 'function nested(){return require(').replace("'node:path');", "'node:path');}"),
    factory+body.replace(' const require=', ' let require='),
    factory+body.replace(' const require=createRequire(import.meta.url);', ' let require;require=createRequire(import.meta.url);'),
    factory+body.replace(' return require(', ' const unrelated=1;\n return require('),
    factory+body.replace('import.meta.url', "'file:///caller.mjs'"),
    factory+body.replace('return require(', 'return ((require)=>require(').replace("'node:path');", "'node:path'))(null);"),
  ]) refused(source);
});

test('refuses reassignment and updates to either lexical require or imported factory', () => {
  for(const statement of ['require=()=>null;', 'require??=()=>null;', 'require++;', '({require}=x);', 'for(require of xs){}', 'for([require] of xs){}', 'createRequire=()=>null;']) {
    refused(factory+body.replace("return require('node:path');", "const x=require('node:path');\n"+statement+'return x;'));
  }
});

test('preserves comments, strings and existing explicit same-line escape behavior', () => {
  assert.deepEqual(sourceViolations("// require('x')\nconst s=\"require('x')\";/*require('x')*/"), []);
  assert.deepEqual(sourceViolations("require('x'); // esm-require-allow: existing deliberate boundary"), []);
  refused(factory+body.replace("return require('node:path');", "return require('node:path') + unbound.require('bad');"));
});

test('the proven binding executes in an actual ESM worker', {timeout:10000}, async () => {
  const folder=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'.esm-require-worker-'));
  try {
    const file=join(folder,'worker.mjs');
    const source=factory+"import {parentPort} from 'node:worker_threads';\n"+body+"\nparentPort.postMessage(workerNative().basename('/actual/worker'))";
    assert.deepEqual(sourceViolations(source), []);writeFileSync(file,source);
    const worker=new Worker(pathToFileURL(file));
    const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>reject(new Error('worker exited before proof '+code)));});
    assert.equal(result,'worker');
  } finally {rmSync(folder,{recursive:true,force:true});}
});
