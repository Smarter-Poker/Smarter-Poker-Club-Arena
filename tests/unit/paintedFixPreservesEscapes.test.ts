/**
 * --fix MUST NOT REWRITE A STRING THAT CARRIES AN ESCAPE SEQUENCE.
 *
 * check-painted-text-case reads `lit.text` - the COOKED value, escapes already
 * resolved - and splices it back into the RAW span between the quotes. Those
 * are the same string only when the literal has no escapes. With `\n` in it the
 * fixer writes a REAL NEWLINE into a single-line string literal:
 *
 *     'you have unread messages\ncheck the inbox'
 *  -> 'You Have Unread Messages
 *     Check The Inbox'          <- TS1002: Unterminated string literal.
 *
 * Found while porting this gate to the World Hub, where it corrupted
 * pages/USRobots.js on the first --fix run. Club Arena carries 78 literals with
 * a real escape and has never hit one only because none is currently an
 * offender.
 *
 * These tests run the REAL script against a temp fixture, because the bug was
 * in the splice arithmetic and a mock of the splice would have passed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// process.cwd() and not import.meta.url: vitest serves this file through Vite,
// which prefixes the module path with /@fs, and a path built from it does not
// exist on disk. vitest runs with the repo root as its cwd.
const REPO = process.cwd();
const GATE = join(REPO, 'scripts/ci/check-painted-text-case.mjs');
const PROBE_DIR = mkdtempSync(join(tmpdir(), 'painted-text-escape-'));
const PROBE = join(PROBE_DIR, 'Probe.tsx');

const WITH_ESCAPE =
  'export const P = ({ n }: { n: number }) => (\n' +
  "  <div>{n > 0 ? 'you have unread messages\\ncheck the inbox' : 'no unread messages here'}</div>\n" +
  ');\n';

function runGate(fix: boolean): string {
  try {
    return execFileSync('node', fix ? [GATE, '--fix'] : [GATE], {
      encoding: 'utf8',
      cwd: REPO,
      env: { ...process.env, PAINTED_TEXT_SOURCE_DIR: PROBE_DIR },
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

describe('check-painted-text-case never corrupts an escape sequence', () => {
  beforeAll(() => {
    writeFileSync(PROBE, WITH_ESCAPE, 'utf8');
  });
  afterAll(() => rmSync(PROBE_DIR, { recursive: true, force: true }));

  it('reports the escape-carrying string instead of rewriting it', () => {
    const out = runGate(false);
    expect(out).toMatch(/contain an ESCAPE/);
    expect(out).toMatch(/check the inbox/);
  });

  it('--fix leaves that string byte for byte identical', () => {
    runGate(true);
    const after = readFileSync(PROBE, 'utf8');
    expect(after).toContain("'you have unread messages\\ncheck the inbox'");
    // and it did not smuggle a real newline in
    expect(after.split('\n').length).toBe(WITH_ESCAPE.split('\n').length);
  });

  it('but still fixes the clean literal beside it, so the guard is narrow', () => {
    const after = readFileSync(PROBE, 'utf8');
    expect(after).toContain("'No Unread Messages Here'");
  });

  it('the guard compares raw source to cooked text rather than sniffing for backslashes', () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src).toContain('process.env.PAINTED_TEXT_SOURCE_DIR');
    expect(src).toMatch(/function rawMatchesCooked/);
    expect(src).toMatch(
      /text\.slice\(lit\.getStart\(sf\) \+ 1, lit\.getEnd\(\) - 1\) === lit\.text/
    );
  });
});
