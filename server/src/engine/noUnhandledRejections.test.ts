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
 * A grep-style test is the right shape here: the defect is "someone writes the
 * pattern again", which no behavioural test can catch, and it costs
 * milliseconds.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
 * Deliberately simple: it reads forward from each `void` until brace/paren
 * depth returns to zero, which is the end of the statement. Anything cleverer
 * would need a parser, and the pattern this guards against is textual.
 */
function unguardedVoidThens(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*void\s/.test(lines[i])) continue;
    let depth = 0;
    let statement = '';
    for (let j = i; j < Math.min(i + 60, lines.length); j++) {
      statement += lines[j] + '\n';
      for (const ch of lines[j]) {
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
      }
      if (depth <= 0 && /;\s*$/.test(lines[j])) break;
    }
    if (statement.includes('.then(') && !statement.includes('.catch(')) {
      hits.push(i + 1);
    }
  }
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
});
