/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A WATCHDOG THAT CANNOT LOOK MUST NOT SAY THE COAST IS CLEAR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `check-main-is-green.mjs` exited **0** on every unreadable answer - no token,
 * an API error, an empty run list - reasoning that "a watchdog that cannot ask
 * is not a failure". Sound about paging, wrong about everything else, because
 * exit 0 is not silence here. `publish-watchdog.yml` reads it:
 *
 *     - name: Close it when main is green again
 *       if: always() && steps.main-green.outputs.code == '0'
 *
 * So one HTTP 502 from `/actions/runs` would CLOSE a standing issue about a
 * workflow that was still red, with the comment "Every workflow's latest run on
 * main is green again."
 *
 * 10.86 rule 1: "I could not tell" is a distinct outcome and must have its own
 * name. These cases pin that it is 3 - never 0, never 1 - and that the
 * workflow's closing step cannot see it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '..');
const CHECKER = resolve(REPO_ROOT, 'scripts/ci/check-main-is-green.mjs');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/publish-watchdog.yml');

describe('check-main-is-green has three outcomes', () => {
  it('exits 3 - not 0 - when it has no token to ask with', () => {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;

    const run = spawnSync(process.execPath, [CHECKER], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(run.status).toBe(3);
    // And it says which of the three it is, in words, not only in a code.
    expect(`${run.stdout}${run.stderr}`).toMatch(/COULD NOT TELL/);
  });

  it('names every unreadable answer as unknown rather than as skipped', () => {
    const src = readFileSync(CHECKER, 'utf8');
    // The three places that used to `process.exit(0)` on an answer they could
    // not read: no token, a failed run listing, an empty run listing.
    expect(src).toContain('const UNKNOWN = 3');
    const unknownExits = src.match(/process\.exit\(UNKNOWN\)/g) || [];
    expect(unknownExits.length).toBeGreaterThanOrEqual(3);
    // The old wording is what taught the next reader that this was fine.
    expect(src).not.toContain('a watchdog that cannot ask is not a failure');
    expect(src).not.toMatch(/skipping\.'\);\s*\n\s*process\.exit\(0\)/);
  });

  it('still exits 0 only for a genuinely green read, and 1 for a silent red', () => {
    const src = readFileSync(CHECKER, 'utf8');
    // Two green exits (nothing red; nothing silent past the threshold) and the
    // single alarm exit. If a fourth exit(0) appears, something unreadable has
    // probably been folded back into "green".
    const greenExits = src.match(/process\.exit\(0\)/g) || [];
    expect(greenExits.length).toBe(2);
    expect(src).toContain('process.exit(1)');
  });
});

describe('the workflow cannot close an alarm on an answer it did not get', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');

  it('closes the issue only on an exact 0', () => {
    expect(yml).toContain("steps.main-green.outputs.code == '0'");
    // Never a truthiness test or a "not 1" test, either of which lets 3 through.
    expect(yml).not.toMatch(/main-green\.outputs\.code\s*!=\s*'1'/);
  });

  it('raises the alarm only on an exact 1', () => {
    expect(yml).toContain("steps.main-green.outputs.code == '1'");
  });

  it('says out loud when it could not tell', () => {
    expect(yml).toMatch(/code" = "3"|code" == "3"|\$code" = "3/);
    expect(yml).toMatch(/COULD NOT TELL/);
  });
});
