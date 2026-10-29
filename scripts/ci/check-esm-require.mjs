#!/usr/bin/env node
/**
 * CI GATE — CommonJS require() ban for the ESM server build
 *
 * 2026-08-15 incident: the A2 seating rework shipped four
 * `const { supabase } = require('../services/supabase.js')` lines.
 * The server ships as ESM, so each threw `ReferenceError: require is not
 * defined` AT RUNTIME — tsc cannot catch it because @types/node declares
 * `require`. Result: add-chips/withdraw hard-down and every cash hand's
 * settlement pipeline silently aborted for ~4 hours, invisible until the
 * E8 per-step guards surfaced it as CRITICAL financial alerts.
 *
 * This gate fails the build when unbound `require(` appears in server/src runtime
 * code (tests and sim excluded — vitest runs them in an environment where
 * interop can differ, and they never ship in the Docker image).
 * A same-block immediately preceding const binding to the imported Node
 * createRequire(import.meta.url) factory is proved by lexical symbols below.
 *
 * Escape hatch for a genuinely intentional use (there should be none):
 * append `// esm-require-allow: <reason>` on the same line.
 *
 * Exit codes: 0 clean · 1 violations found · 2 script error
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const nodeRequire = createRequire(import.meta.url);
let typescript;

const ROOT = join(process.cwd(), 'server/src');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'sim') continue;
      yield* walk(p);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.d.ts')
    ) {
      yield p;
    }
  }
}

/** Strip block comments, line comments, and string/template literals so a
 *  mention of require() in prose or a message can never false-positive. */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const skipped = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += skipped.replace(/[^\n]/g, ' ');
      i = end === -1 ? n : end + 2;
    } else if (two === '//') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end; // newline kept by fallthrough
      out += ' ';
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === quote) break;
        else j++;
      }
      out += quote + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + quote;
      i = j + 1;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/** Prove only an immediately preceding lexical Node createRequire binding.
 * No module resolution, filename exception or global @types/node declaration
 * can establish this proof. A shadowed factory/require has another symbol.
 */
function provenNodeRequireCalls(raw, file) {
  const ts = typescript ??= nodeRequire('typescript');
  const source = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) return new Map();
  const options = { noResolve: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === file ? source : undefined;
  const program = ts.createProgram([file], options, host);
  const checker = program.getTypeChecker();
  const nodes = [];
  function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
  visit(source);
  const contains = (parent, node) => node.pos >= parent.pos && node.end <= parent.end;
  function written(symbol) {
    return nodes.some(node => {
      if (!ts.isIdentifier(node)) return false;
      const binding = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      if (binding !== symbol) return false;
      for (let p = node.parent; p; p = p.parent) {
        if ((ts.isForInStatement(p) || ts.isForOfStatement(p)) && contains(p.initializer, node)) return true;
        if (ts.isStatement(p)) break;
        if (ts.isBinaryExpression(p) && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            p.operatorToken.kind <= ts.SyntaxKind.LastAssignment && contains(p.left, node)) return true;
        if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator)) return true;
      }
      return false;
    });
  }
  const approved = new Map();
  for (const call of nodes) {
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require') continue;
    const symbol = checker.getSymbolAtLocation(call.expression);
    const declarations = symbol?.declarations;
    if (declarations?.length !== 1 || !ts.isVariableDeclaration(declarations[0])) continue;
    const declaration = declarations[0], list = declaration.parent, statement = list.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1 ||
        !ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) continue;
    let callStatement = call;
    while (callStatement.parent && !ts.isStatement(callStatement)) callStatement = callStatement.parent;
    const statements = statement.parent.statements, index = statements.indexOf(statement);
    if (statements[index + 1] !== callStatement) continue;
    const factoryCall = declaration.initializer;
    if (!factoryCall || !ts.isCallExpression(factoryCall) || factoryCall.questionDotToken ||
        !ts.isIdentifier(factoryCall.expression) || factoryCall.arguments.length !== 1) continue;
    const arg = factoryCall.arguments[0];
    if (!ts.isPropertyAccessExpression(arg) || arg.name.text !== 'url' || !ts.isMetaProperty(arg.expression) ||
        arg.expression.keywordToken !== ts.SyntaxKind.ImportKeyword || arg.expression.name.text !== 'meta') continue;
    const factory = checker.getSymbolAtLocation(factoryCall.expression);
    const imported = factory?.declarations;
    if (imported?.length !== 1 || !ts.isImportSpecifier(imported[0])) continue;
    const specifier = imported[0], clause = specifier.parent.parent, importDeclaration = clause.parent;
    if (specifier.isTypeOnly || clause.isTypeOnly || (specifier.propertyName ?? specifier.name).text !== 'createRequire' ||
        !ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
        importDeclaration.moduleSpecifier.text !== 'node:module' || written(symbol) || written(factory)) continue;
    const line = source.getLineAndCharacterOfPosition(call.expression.getStart(source)).line;
    approved.set(line, (approved.get(line) ?? 0) + 1);
  }
  return approved;
}

export function sourceViolations(raw, file = 'runtime.ts') {
  const rawLines = raw.split('\n'), codeLines = stripNonCode(raw).split('\n');
  const candidates = codeLines.flatMap((line, idx) => {
    const count = [...line.matchAll(/\brequire\s*\(/g)].length;
    return count && !/esm-require-allow:/.test(rawLines[idx] || '') ? [{ idx, count }] : [];
  });
  if (!candidates.length) return [];
  const approved = provenNodeRequireCalls(raw, file);
  return candidates.filter(({idx, count}) => approved.get(idx) !== count).map(({idx}) => ({line: idx + 1, text: rawLines[idx]}));
}

function main() {
  let violations = 0;
  try {
    // The ordinary gate always executes its own focused regression suite.
    // Imports from that test do not enter main, so there is no recursive run.
    const tests = spawnSync(process.execPath, ['--test', fileURLToPath(new URL('./check-esm-require.test.mjs', import.meta.url))], {stdio: 'inherit'});
    if (tests.error || tests.status !== 0) throw new Error('lexical require regression suite failed');
  for (const file of walk(ROOT)) {
    const raw = readFileSync(file, 'utf8');
    for (const violation of sourceViolations(raw, file)) {
        violations++;
        console.error(`ESM-REQUIRE VIOLATION: ${file}:${violation.line}`);
        console.error(`  ${(violation.text || '').trim()}`);
    }
  }
} catch (err) {
  console.error(`check-esm-require: script error: ${err.message}`);
  process.exit(2);
}

if (violations > 0) {
  console.error(
    `\n${violations} CommonJS require() call(s) in server/src runtime code.` +
      `\nThe server ships as ESM — require throws ReferenceError at runtime` +
      `\nand tsc cannot catch it. Use a static import (or a dynamic import()).`
  );
  process.exit(1);
}
console.log('check-esm-require: clean — no CommonJS require() in server/src runtime code.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
