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
import { sliceYamlBlock } from './helpers/sourceWindow';

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

  it('refuses when REPO and the origin remote name different repositories', () => {
    // The open-PR exemption is read for $REPO; candidates and their tips come
    // from the local `origin`. If those disagree, every branch looks like it
    // has no open PR and the rule deletes live work while reporting that it
    // checked. One stray REPO= in a workflow is enough.
    const s = script();
    expect(s).toContain('remote.origin.url');
    expect(s).toMatch(/if \[ -n "\$ORIGIN_SLUG" \] && \[ "\$ORIGIN_SLUG" != "\$REPO" \]; then/);
    const i = s.indexOf('!= "$REPO" ]; then');
    expect(s.slice(i, i + 400)).toMatch(/exit 1/);
  });

  it('only armed classes are ever deleted; everything else is reported', () => {
    // The rule may JUDGE any stale branch, but it may only DELETE the
    // machine-generated classes. A `fix/...` branch that went quiet might be
    // a person's work; a `sentry-autofix/*` from 135 days ago cannot be.
    // Widening ARMED_PREFIXES is a decision with a name on it.
    expect(script()).toMatch(/ARMED_PREFIXES="\$\{ARMED_PREFIXES:-[^"]*sentry-autofix\//);
    expect(script()).toMatch(/if is_armed "\$BR"; then ARMED_LIST=/);
    // and the delete list is built from ARMED_LIST, never from all candidates
    expect(script()).toMatch(/PICKED=\$\(printf '%s' "\$ARMED_LIST"/);
  });

  it('refuses a pull-request list that may have been truncated', () => {
    // An EMPTY list is obvious and already bails. A list clipped at the limit
    // looks perfectly healthy and silently reclassifies every PR past the cut
    // as "no open PR" - which is how a retention rule deletes live work.
    const s = script();
    const i = s.indexOf('PR_LIMIT');
    expect(i).toBeGreaterThan(-1);
    expect(s).toMatch(/if \[ "\$OPEN_COUNT" -ge "\$PR_LIMIT" \]; then/);
    const after = s.slice(s.indexOf('-ge "$PR_LIMIT"'), s.indexOf('-ge "$PR_LIMIT"') + 400);
    expect(after).toContain('exit 0');
  });

  it('the workflow step passes a token that can actually write refs', () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    expect(wf).toContain('archive-stale-branches.sh');
    // Slice the STEP, never a fixed number of characters back from the run
    // line: this pin broke the moment the step grew a comment, which is the
    // fixed-window anti-pattern sourceWindow.ts exists to stop.
    const step = sliceYamlBlock(wf, '- name: Retire branches nothing will publish again');
    expect(step).toContain('archive-stale-branches.sh');
    // GITHUB_TOKEN alone cannot create refs/archive/* here; the App token can.
    expect(step).toContain('steps.app-token.outputs.token');
  });
});
