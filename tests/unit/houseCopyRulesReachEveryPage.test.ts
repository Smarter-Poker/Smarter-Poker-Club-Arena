/**
 * DAN'S TWO COPY RULES MUST REACH EVERY SURFACE, INCLUDING THE ONES THAT DO NOT
 * GO THROUGH REACT.
 *
 *   1. "the first letter of every word is capitalized ... every page and subpage"
 *   2. "forbid the use of em bars" / "any and all m bars ... are banned"
 *
 * Both rules already had gates. Both gates had a surface they could not see, and
 * in each case the escape was real and shipped:
 *
 *   - `check-ui-text` says in its own header that it reads CSS `content:`
 *     values. It looked for the CHARACTER and for JavaScript's —, and CSS
 *     writes neither: CSS writes a backslash and bare hex. HandDetailView.css
 *     carried one, and it rendered an em dash on every run-2+ showdown row in
 *     production while the gate reported OK. Found by scanning the DEPLOYED
 *     BUNDLE, not the source.
 *
 *   - `check-title-case` covers JSX text, UI attributes, UI properties and
 *     render expressions. Native `confirm()`, `alert()` and `prompt()` dialogs
 *     are none of those, and they bypass the Toast layer that Title Cases every
 *     other popup. Three were live, in the copy a player reads in a browser
 *     dialog.
 *
 * These tests run the real gates against real fixtures, so they fail if either
 * blind spot is ever reopened.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripEmDashes } from '../../src/utils/titleCase';

const ROOT = resolve(__dirname, '../..');
const UI_TEXT = join(ROOT, 'scripts/ci/check-ui-text.mjs');
const TITLE_CASE = join(ROOT, 'scripts/ci/check-title-case.mjs');

/** Run check-title-case against a throwaway source tree and return its exit code. */
function titleCaseOn(files: Record<string, string>): number {
  const dir = mkdtempSync(join(tmpdir(), 'copy-rules-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  try {
    execFileSync(process.execPath, [TITLE_CASE], {
      stdio: 'pipe',
      env: { ...process.env, TITLE_CASE_SOURCE_DIR: dir },
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

describe('the em dash ban sees the form CSS actually uses', () => {
  const gate = readFileSync(UI_TEXT, 'utf8');

  it('matches the CSS escape, not only the character and the JS escape', () => {
    // \2014 with no `u`. This is the exact shape that shipped.
    expect(gate).toContain('CSS_ESCAPE');
    expect(gate).toMatch(/201\[2-5\]\(\?!\[0-9a-fA-F\]\)/);
  });

  it('still names CSS content values as covered, and now truthfully', () => {
    expect(gate).toContain('CSS `content:` values');
  });

  it('keeps the strippers exempt, because they hold the characters on purpose', () => {
    // Removing these re-runs the incident where --fix rewrote titleCase.ts's own
    // character class into a meaningless range and disabled the rule.
    for (const f of [
      'src/utils/titleCase.ts',
      'src/utils/popupStyle.ts',
      'src/components/lobby/lobbyEntries.ts',
      'src/components/bbj/BBJBasicPanel.tsx',
    ]) {
      expect(gate, `${f} must stay exempt`).toContain(f);
    }
  });

  it('exempts titleCase.ts because the stripper WORKS, proven by running it', () => {
    // Asserted by behaviour, not by grepping the file for a character:
    // report-source-grep-tests is right that a regex over source passes on a
    // line that is present and wrong. If stripEmDashes still removes them, the
    // module necessarily still holds them, and the exemption is still needed.
    expect(stripEmDashes('Connection lost \u2014 the server may fold')).not.toMatch(/[–—―‒−]/);
    expect(stripEmDashes('40\u201380 big blinds')).not.toMatch(/[–—―‒−]/);
    expect(stripEmDashes('minus \u2212 sign')).not.toMatch(/[–—―‒−]/);
  });
});

describe('title case reaches the popups React never renders', () => {
  it('flags a lowercase confirm() dialog', () => {
    expect(
      titleCaseOn({
        'Probe.tsx':
          'export const go = () => window.confirm("discard these changes and leave?");\n',
      })
    ).toBe(1);
  });

  it('flags a lowercase alert() and prompt() too', () => {
    expect(
      titleCaseOn({ 'Probe.tsx': 'export const a = () => alert("your seat was taken");\n' })
    ).toBe(1);
    expect(
      titleCaseOn({ 'Probe.tsx': 'export const p = () => prompt("amount to transfer?");\n' })
    ).toBe(1);
  });

  it('passes the same dialogs once they are Title Cased', () => {
    expect(
      titleCaseOn({
        'Probe.tsx':
          'export const go = () => window.confirm("Discard These Changes And Leave?");\n' +
          'export const a = () => alert("Your Seat Was Taken");\n' +
          'export const p = () => prompt("Amount To Transfer?");\n',
      })
    ).toBe(0);
  });

  it('does not fire on a same-named call that carries no copy', () => {
    // `confirm` is a common variable and method name. A non-string argument, or
    // a machine string, must not be dragged in.
    expect(
      titleCaseOn({
        'Probe.tsx':
          'declare const value: string;\nexport const go = () => window.confirm(value);\n',
      })
    ).toBe(0);
  });
});

/*
 * WHAT USED TO BE HERE, AND WHY IT IS NOT.
 *
 * Two tests that shelled out to run check-ui-text and check-title-case over the
 * whole of src/ and asserted exit 0. They duplicated ci.yml steps 247 and 257,
 * which are dedicated blocking checks and run the same two scripts on every PR,
 * so they added no coverage at all - and on 2026-08-31 one of them went red
 * inside a 766-file parallel run while passing on its own and while the gate it
 * shells out to exited 0.
 *
 * A false red here is not cheap. A red client suite stops build-for-world-hub
 * and therefore the publish for the whole estate (CLAUDE.md 5.8). A test whose
 * only contribution is a second opinion on a required check, bought with a
 * subprocess competing for CPU against 765 other files, is a liability.
 *
 * The tests above keep the part that is not duplicated: proof that the gates
 * catch the two blind spots that let a real defect ship, run against small
 * fixtures rather than the whole tree.
 */
