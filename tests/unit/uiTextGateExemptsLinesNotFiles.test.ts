/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A WHOLE-FILE EXEMPTION IS A SWEEP WHERE A GUARD BELONGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-31. check-ui-text enforces Dan's rule that em dashes are banned from
 * anything a player can read. Four files were exempt from it ENTIRELY:
 *
 *   src/utils/titleCase.ts
 *   src/utils/popupStyle.ts
 *   src/components/bbj/BBJBasicPanel.tsx
 *   src/components/lobby/lobbyEntries.ts
 *
 * The reason was real. Each one holds a dash character class inside a
 * normalising regex, because each one is code that REMOVES the character, and
 * on its first --fix run the gate rewrote titleCase.ts's own class into `[--]`
 * and silently disabled the stripper.
 *
 * But two of those four render copy a player reads. `'Jackpot - You Got Paid'`
 * added to BBJBasicPanel.tsx would have been invisible to the gate forever.
 * The exemption was re-verified by hand, and a hand audit is exactly what
 * decays: it was true on the day somebody wrote it down.
 *
 * The exemption is now the LINE - a regex literal holding a dash - and these
 * pins are what stop it from widening back into a file list. They are
 * SOURCE-LEVEL: they read the gate's own text, so they stay true no matter how
 * the scan is refactored.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GATE = readFileSync(join(process.cwd(), 'scripts/ci/check-ui-text.mjs'), 'utf8');

const SKIP_BLOCK = (() => {
  const start = GATE.indexOf('const SKIP_FILES = new Set([');
  expect(start).toBeGreaterThan(-1);
  return GATE.slice(start, GATE.indexOf(']);', start));
})();

describe('check-ui-text exempts lines, not files', () => {
  it('does not skip the two files that render player-visible copy', () => {
    expect(SKIP_BLOCK).not.toContain('BBJBasicPanel.tsx');
    expect(SKIP_BLOCK).not.toContain('lobbyEntries.ts');
  });

  it('does not skip the two strippers either - their regexes are handled by line', () => {
    expect(SKIP_BLOCK).not.toContain('titleCase.ts');
    expect(SKIP_BLOCK).not.toContain('popupStyle.ts');
  });

  it('skips only itself, because its own pattern lists the characters', () => {
    // Only the quoted entries on their own lines are members of the Set; the
    // apostrophes inside the block's comments are not.
    const entries = SKIP_BLOCK.split('\n')
      .map((l) => l.trim())
      .filter((l) => /^'[^']+',?$/.test(l))
      .map((l) => l.replace(/^'|',?$/g, ''));
    expect(entries).toEqual(['scripts/ci/check-ui-text.mjs']);
  });

  it('blanks stripper regexes instead of filtering them out of the report', () => {
    // Blanking is what protects --fix: it takes its offsets from the same copy.
    // A gate that merely dropped these from the offender list would still let
    // --fix rewrite titleCase.ts's character class, which is the original bug.
    expect(GATE).toContain('REGEX_LITERAL');
    const stripFn = GATE.slice(GATE.indexOf('function stripComments'));
    expect(stripFn).toContain('REGEX_LITERAL');
    expect(stripFn).toMatch(/' '\.repeat\(body\.length\)/);
  });

  it('only blanks a regex that actually carries a dash', () => {
    const stripFn = GATE.slice(GATE.indexOf('function stripComments'));
    expect(stripFn).toMatch(/EM_DASHES\.test\(body\)/);
  });
});

describe('the strippers still hold the characters they strip', () => {
  // If one of these ever stops matching, the file has stopped being a stripper
  // and the gate should be reporting it, not blanking it.
  it('titleCase.ts still declares its dash classes', () => {
    const src = readFileSync(join(process.cwd(), 'src/utils/titleCase.ts'), 'utf8');
    expect(src).toMatch(/const EM_DASH_RUN = \//);
    expect(src).toMatch(/const OTHER_DASHES = \//);
  });

  it('popupStyle.ts still declares its dash classes', () => {
    const src = readFileSync(join(process.cwd(), 'src/utils/popupStyle.ts'), 'utf8');
    expect(src).toMatch(/const DASH_CLAUSE = \//);
    expect(src).toMatch(/const DASH_ANY = \//);
  });
});
