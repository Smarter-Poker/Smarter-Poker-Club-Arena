/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TOOL THAT JUDGES TESTS IS ITSELF JUDGED BY RUNNING IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scripts/ci/report-source-grep-tests.mjs` fails CI when a test pins a pure
 * `src/utils` module by TEXT instead of importing it. A tool that says "assert
 * what it DOES" and was itself pinned by a regex over its own source would be a
 * joke told with a straight face, so this imports its classifier and feeds it
 * real file bodies.
 *
 * IT ALSO EXISTS BECAUSE THE CLASSIFIER SHIPPED WRONG (found 2026-08-31, before
 * it ever fired). It recognised `from '../../src/x'` but not `from '@/utils/x'`
 * - and this repo aliases `@/` to `src/`, with tests already using it. A test
 * importing its unit PROPERLY through the alias while also reading some file as
 * text would have been filed text-only, and if it read a `src/utils/*` path it
 * would have tripped the ratchet and failed CI on a test doing exactly the
 * right thing. Nothing was miscounted in practice - none of the five current
 * violations uses the alias - but the accusation was available, and the third
 * case below is the pin that keeps it closed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error - plain .mjs CI script, no type declarations by design
import { classify } from '../../scripts/ci/report-source-grep-tests.mjs';

const SCRIPT = resolve(__dirname, '../../scripts/ci/report-source-grep-tests.mjs');
const REPO = resolve(__dirname, '../..');

/** Run the CLI, returning its exit code and combined output. */
function runCli(scriptPath: string, cwd: string, args: string[] = ['--ratchet']) {
  try {
    const out = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Bodies in the shapes this repo's tests actually take. */
const textOnlyPin = `
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'node:fs';
  const SRC = readFileSync('src/utils/memberCount.ts', 'utf8');
  it('pins', () => { expect(SRC).toMatch(/countMembers/); });
`;

const relativeImport = `
  import { describe, it, expect } from 'vitest';
  import { isFreeSlot } from '../../src/utils/tabSlots';
  it('runs it', () => { expect(isFreeSlot({ id: 'x' })).toBe(true); });
`;

const aliasImport = `
  import { describe, it, expect } from 'vitest';
  import { readFileSync } from 'node:fs';
  import { mapEngineSnapshot } from '@/utils/mapEngineSnapshot';
  const FIXTURE = readFileSync('src/utils/mapEngineSnapshot.ts', 'utf8');
  it('runs it', () => { expect(mapEngineSnapshot({})).toBeDefined(); });
`;

const rendersComponent = `
  import { render } from '@testing-library/react';
  import { readFileSync } from 'node:fs';
  const CSS = readFileSync('src/pages/TablePage.css', 'utf8');
  it('renders', () => { render(Thing); });
`;

describe('classify — which tests can only tell you a line exists', () => {
  it('flags a body that reads source and never imports it', () => {
    const { textOnly, pins } = classify(textOnlyPin);
    expect(textOnly).toBe(true);
    expect(pins).toContain('src/utils/memberCount.ts');
  });

  it('clears a body that imports the unit relatively', () => {
    expect(classify(relativeImport).textOnly).toBe(false);
  });

  it('clears a body that imports through the @/ alias — the shipped bug', () => {
    /* The regression this file was written for. This body imports its unit
       properly AND reads a src/utils path as text. Before the fix it was filed
       text-only, which would have counted as a sixth violation and failed CI
       on a well-written test. */
    const { textOnly, pins } = classify(aliasImport);
    expect(textOnly).toBe(false);
    expect(pins).toEqual([]);
  });

  it('clears a body that renders a component even though it also reads CSS', () => {
    // The legitimate case for a text pin: the CSS text IS the artefact.
    expect(classify(rendersComponent).textOnly).toBe(false);
  });

  it('reports no pins for a body it did not flag', () => {
    // `pins` is only meaningful for a flagged file; a cleared one must not
    // carry paths a later caller could count as violations.
    expect(classify(relativeImport).pins).toEqual([]);
  });

  it('ignores a file that never reads source at all', () => {
    expect(classify(`import { it } from 'vitest'; it('x', () => {});`).textOnly).toBe(false);
  });
});

describe('the gate cannot disable itself in silence', () => {
  /**
   * A required check that passes by doing NOTHING is the precise failure this
   * script exists to catch, so it must not be the way this script fails. Both
   * cases below produced a silent exit 0 before they were fixed.
   */
  it('still runs when invoked through a symlinked absolute path', () => {
    /* `import.meta.url` is always the REAL path; `process.argv[1]` is whatever
       the caller typed. Compared as raw strings they differ the moment a
       symlink is involved - and on macOS /tmp IS a symlink to /private/tmp, so
       every scratch worktree on this machine reaches the repo that way.
       Verified inert before the fix: no output, exit 0. */
    const dir = mkdtempSync(join(tmpdir(), 'sgr-link-'));
    const link = join(dir, 'repo');
    try {
      symlinkSync(REPO, link);
      const { code, out } = runCli(join(link, 'scripts/ci/report-source-grep-tests.mjs'), REPO);
      expect(out).toContain('[source-grep-tests]');
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when it scans zero test files instead of reporting all clear', () => {
    /* Zero findings from zero inputs is the oldest silent pass there is. A
       missing tests/ already throws ENOENT; this is the case where it exists
       and yields nothing - a moved directory, a renamed suffix, a ROOT that
       resolved somewhere unexpected. */
    const dir = mkdtempSync(join(tmpdir(), 'sgr-empty-'));
    try {
      mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
      mkdirSync(join(dir, 'tests'), { recursive: true });
      copyFileSync(SCRIPT, join(dir, 'scripts/ci/report-source-grep-tests.mjs'));
      const { code, out } = runCli(join(dir, 'scripts/ci/report-source-grep-tests.mjs'), dir);
      expect(code).toBe(1);
      expect(out).toContain('scanned 0 test files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the real inventory and passes on this repo', () => {
    // The end-to-end shape CI actually runs, so a break in wiring shows here.
    const { code, out } = runCli(SCRIPT, REPO);
    expect(out).toMatch(/\d+ of \d+ test files/);
    expect(out).toContain('ratchet OK');
    expect(code).toBe(0);
  });
});

describe('importing the reporter does not run the reporter', () => {
  it('printed nothing and exited nothing when this file imported it', () => {
    /* Everything in that script used to execute at import time: importing
       `classify` would scan the entire suite, print a report, and on a repo
       over the ratchet call process.exit(1) inside somebody's test run. The
       proof it no longer does is that this suite is still alive to assert. */
    expect(typeof classify).toBe('function');
  });
});
