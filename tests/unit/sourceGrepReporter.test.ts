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
// @ts-expect-error - plain .mjs CI script, no type declarations by design
import { classify } from '../../scripts/ci/report-source-grep-tests.mjs';

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

describe('importing the reporter does not run the reporter', () => {
  it('printed nothing and exited nothing when this file imported it', () => {
    /* Everything in that script used to execute at import time: importing
       `classify` would scan the entire suite, print a report, and on a repo
       over the ratchet call process.exit(1) inside somebody's test run. The
       proof it no longer does is that this suite is still alive to assert. */
    expect(typeof classify).toBe('function');
  });
});
