/**
 * STRUCTURAL GUARD — every fire-and-forget promise must have a rejection handler.
 *
 * WHY THIS FILE EXISTS
 *
 * `void somePromise.then(handler)` looks safe and is not. `.then()` with one
 * argument handles only FULFILMENT; if the promise rejects there is no handler
 * anywhere and Node reports an unhandled rejection. Wrapping the statement in
 * `try { ... } catch {}` does not help either — the try/catch guards the
 * synchronous call that builds the chain, and the rejection arrives long after
 * that returned.
 *
 * This bit twice over:
 *
 *   1. supabase-js returns most failures as a RESOLVED `{ error }`, which the
 *      existing `.then(({ error }) => ...)` handles. Transport failures (DNS,
 *      socket reset, abort) REJECT instead, and those escaped.
 *   2. Under Vitest an unhandled rejection is attributed to whichever test is
 *      executing when it lands. That is what made
 *      `CryptoRandom > is uniform over a range that does not divide 2^32` fail
 *      intermittently in full-suite runs while passing in isolation. The
 *      generator was never at fault — 160 trials / 11.2M draws produced a max
 *      chi-square of 15.07 against a 22.46 threshold with zero exceedances.
 *      The test was simply the unlucky bystander, and the real fault was a
 *      telemetry insert rejecting three files away.
 *
 * This source guard follows the actual promise chain. Callback length,
 * comments and nested catches must not hide a missing outer rejection handler.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SRC = new URL('../', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find `void <expr>` statements that contain a `.then(` but no `.catch(`.
 *
 * Walk the outer call chain from its last operation toward its receiver.
 * Every then must have a later catch; a catch inside its callback does not
 * guard this chain. The former 60-line window missed real handlers after
 * adding another phase's execution receipts.
 */
function unguardedVoidThens(source: string): number[] {
  const file = ts.createSourceFile('guard.ts', source, ts.ScriptTarget.Latest, true);
  const hits: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVoidExpression(node)) {
      let expression: ts.Expression = node.expression;
      let guarded = false;
      while (true) {
        if (ts.isParenthesizedExpression(expression)) {
          expression = expression.expression;
          continue;
        }
        if (
          !ts.isCallExpression(expression) ||
          !ts.isPropertyAccessExpression(expression.expression)
        )
          break;
        const operation = expression.expression.name.text;
        if (operation === 'catch' && expression.arguments.length > 0) guarded = true;
        if (operation === 'then' && !guarded) {
          hits.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
          break;
        }
        expression = expression.expression.expression;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return hits;
}

describe('no fire-and-forget promise may be left without a .catch()', () => {
  it('every `void ....then(...)` in src/ also has a .catch()', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const line of unguardedVoidThens(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.slice(SRC.length)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the detector actually detects - it is not vacuously green', () => {
    const bad = `
      void supabase
        .from('t')
        .insert({ a: 1 })
        .then(({ error }) => {
          if (error) console.warn(error.message);
        });
    `;
    const good = `
      void supabase
        .from('t')
        .insert({ a: 1 })
        .then(({ error }) => {
          if (error) console.warn(error.message);
        })
        .catch(() => {});
    `;
    expect(unguardedVoidThens(bad)).toHaveLength(1);
    expect(unguardedVoidThens(good)).toHaveLength(0);
  });

  it('reads a complete long chain and ignores nested or quoted catches', () => {
    const longBody = 'doWork();\n'.repeat(100);
    expect(unguardedVoidThens(`void job.then(() => { ${longBody} }).catch(report);`)).toEqual([]);
    expect(unguardedVoidThens(`void job.then(() => { ${longBody} });`)).toEqual([1]);
    expect(unguardedVoidThens('void job.then(() => other.catch(report));')).toEqual([1]);
    expect(unguardedVoidThens('void job.then(() => ".catch(fake)");')).toEqual([1]);
    expect(unguardedVoidThens('void job.then(work); // .catch(fake)')).toEqual([1]);
    expect(unguardedVoidThens('void job.catch(report).then(work);')).toEqual([1]);
    expect(unguardedVoidThens('void (job.then(work).catch(report));')).toEqual([]);
  });
});
