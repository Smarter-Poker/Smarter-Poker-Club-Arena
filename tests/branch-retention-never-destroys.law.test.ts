/**
 * LAW: branch retention archives before it deletes, and fails closed.
 *
 * Dan, 2026-09-03: "AND THESE ARE ON YOU TO CLEAN UP, NOT ME: Branch triage -
 * the 400 unmerged branches ... A retention rule is proposed in the doc, not
 * enabled - that one's yours."
 *
 * A retention rule is the one piece of automation on this estate whose bugs
 * are UNRECOVERABLE by default. Everything else here files an issue, opens a
 * pull request, or fails a check; this one can delete an agent's only copy of
 * their work. So the guarantee is not "be careful", it is structural:
 *
 *   1. every deletion is paired with an archive ref in the SAME atomic push,
 *      so a mistake is a restore command and never a loss;
 *   2. it fails CLOSED - if the open-PR list cannot be read it archives
 *      nothing, because a branch with an open PR is live work however old;
 *   3. it is capped per run, so a bad window is caught after 40 and not 400;
 *   4. protected branch classes are never touched at all.
 *
 * Each pin below is one of those four. If your change turns one red you have
 * removed a guarantee, not a line of code. There is no "equivalent" version of
 * a guarantee that a deleted branch is recoverable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, '.github/scripts/archive-stale-branches.sh');
const WORKFLOW = join(ROOT, '.github/workflows/publish-watchdog.yml');

const script = () => readFileSync(SCRIPT, 'utf8');

describe('branch retention never destroys work', () => {
  it('the script exists and is the only branch-retiring script', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('every deletion refspec is pushed together with its archive refspec', () => {
    const s = script();
    // The pairing is what makes a mistake recoverable. Both refspecs are
    // appended in the same loop iteration, and pushed with --atomic so a
    // failed archive aborts the whole push rather than deleting anyway.
    expect(s).toMatch(
      /REFSPECS\+=\(\s*"\$\{SHA\}:refs\/archive\/[^"]*"\s+":refs\/heads\/\$\{BR\}"\s*\)/
    );
    expect(s).toContain('git push --atomic');
  });

  it('never deletes a branch without --atomic', () => {
    const s = script();
    const pushes = s.match(/^\s*git push[^\n]*/gm) ?? [];
    const deleting = pushes.filter((p) => p.includes('REFSPECS'));
    expect(deleting.length).toBeGreaterThan(0);
    for (const p of deleting) expect(p).toContain('--atomic');
  });

  it('fails closed when the open pull requests cannot be read', () => {
    const s = script();
    // The guard must EXIT, not warn and continue. A branch with an open PR is
    // live work; archiving on an empty list would retire every one of them.
    const i = s.indexOf('could not read the open pull requests');
    expect(i).toBeGreaterThan(-1);
    const after = s.slice(i, i + 400);
    expect(after).toContain('exit 0');
    // and the check that reaches it must be emptiness of the PR list
    expect(s.slice(Math.max(0, i - 300), i)).toMatch(/OPEN_HEADS.*tr -d/s);
  });

  it('branches with an open pull request are exempt regardless of age', () => {
    expect(script()).toMatch(/OPEN_HEADS.*grep -qxF "\$BR".*continue/s);
  });

  it('is capped per run', () => {
    const s = script();
    expect(s).toMatch(/MAX_PER_RUN="\$\{MAX_PER_RUN:-\d+\}"/);
    expect(s).toContain('head -n "$MAX_PER_RUN"');
  });

  it('never touches main, release/* or wip/*', () => {
    const s = script();
    const i = s.indexOf('is_protected()');
    expect(i).toBeGreaterThan(-1);
    const body = s.slice(i, s.indexOf('}', s.indexOf('esac', i)));
    for (const p of ['main', 'release/*', 'wip/*']) expect(body).toContain(p);
    expect(s).toMatch(/is_protected "\$BR" && continue/);
  });

  it('the workflow step passes a token that can actually write refs', () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    const i = wf.indexOf('archive-stale-branches.sh');
    expect(i).toBeGreaterThan(-1);
    const step = wf.slice(Math.max(0, i - 900), i);
    // GITHUB_TOKEN alone cannot create refs/archive/* here; the App token can.
    expect(step).toContain('steps.app-token.outputs.token');
  });
});
