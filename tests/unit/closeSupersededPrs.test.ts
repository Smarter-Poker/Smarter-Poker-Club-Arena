/**
 * A SCRIPT THAT CLOSES PULL REQUESTS MUST NOT LOSE WORK.
 * ============================================================================
 * `.github/scripts/close-superseded-prs.sh` closes pull requests automatically.
 * Everything it closes is recoverable — closing is one click to undo and the
 * branch is never deleted — but "recoverable" is only true while somebody is
 * still watching, and the whole reason this script exists is that for a day and
 * a half nobody was.
 *
 * So its refusals are pinned here. Each one below is a category where the line
 * test alone would reach the wrong verdict:
 *
 *   MIGRATIONS   a schema change main does not have is the one thing here that
 *                is not one click to undo.
 *   DELETIONS    a pull request whose whole value is removing code adds no
 *                lines at all, so "adds nothing new" is exactly what a real,
 *                unshipped deletion looks like.
 *   RENAMES      git records a rename as delete + add, and the add side can
 *                match main's existing copy line for line.
 *   EXIT CODE    the first draft asked `git merge-tree | grep '^CONFLICT'`.
 *                The pipe masks merge-tree's status and it reports conflicts as
 *                stage-numbered index entries, not that word — so it found zero
 *                conflicts in a queue of 118 and would have been a guard that
 *                could never fire. That is the bug class this whole workflow
 *                was written to catch, so it is pinned hardest.
 *   FILTER       the line test strips blanks and pure punctuation and NOTHING
 *                else. Every additional thing it strips is a line that can no
 *                longer object to a pull request being closed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../.github/scripts/close-superseded-prs.sh');
const WORKFLOW = resolve(__dirname, '../../.github/workflows/close-superseded-prs.yml');

const script = existsSync(SCRIPT) ? readFileSync(SCRIPT, 'utf8') : '';
const workflow = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8') : '';

describe('close-superseded-prs: the script exists and is wired', () => {
  it('the script is present', () => {
    expect(script, `${SCRIPT} is missing`).not.toBe('');
  });

  it('a workflow actually calls it — an uninvoked guard guards nothing', () => {
    expect(workflow).toContain('close-superseded-prs.sh');
  });

  it('the workflow can write pull requests, or every close would 403', () => {
    expect(workflow).toMatch(/pull-requests:\s*write/);
  });
});

describe('close-superseded-prs: refusals that prevent losing work', () => {
  it('refuses a pull request carrying a migration the base lacks', () => {
    expect(script).toMatch(/PENDING_MIGR/);
    expect(script).toMatch(/migrations/);
    // The refusal must CONTINUE, never fall through to the line test.
    expect(script).toMatch(/PENDING_MIGR" \]; then[\s\S]{0,220}continue/);
  });

  it('refuses a pull request whose deletions the base has not applied', () => {
    expect(script).toMatch(/PENDING_DEL/);
    expect(script).toMatch(/PENDING_DEL" \]; then[\s\S]{0,220}continue/);
  });

  it('refuses a pull request whose renames the base has not applied', () => {
    expect(script).toMatch(/PENDING_REN/);
    expect(script).toMatch(/PENDING_REN" \]; then[\s\S]{0,220}continue/);
  });

  it('detects renames at all — without -M a rename is an unrelated delete+add', () => {
    expect(script).toMatch(/git diff --name-status -M/);
  });

  it('closes only on ZERO unmatched added lines, never on a threshold', () => {
    // A percentage threshold here would close work over time as main grew.
    expect(script).toMatch(/MISSING:-1\}" -ne 0/);
    expect(script).not.toMatch(/-lt\s+\$?\{?(THRESHOLD|PCT|PERCENT)/);
  });

  it('keeps a pull request when it cannot tell, rather than closing it', () => {
    expect(script).toMatch(/exiting without closing anything/);
  });
});

describe('close-superseded-prs: conflict detection reads the exit code', () => {
  it('uses git merge-tree exit status, not a grep for CONFLICT', () => {
    expect(script).toMatch(/git merge-tree --write-tree[^\n]*>\/dev\/null 2>&1/);
    expect(script).toMatch(/MT=\$\?/);
    // The masked form that found zero conflicts in a queue of 118.
    expect(script).not.toMatch(/merge-tree[^\n]*\|\s*grep[^\n]*CONFLICT/);
  });

  it('treats any status other than 1 as "could not tell" and keeps', () => {
    expect(script).toMatch(/"\$MT" -ne 1/);
  });
});

describe('close-superseded-prs: it only touches cold, unheld pull requests', () => {
  it('has an age floor of at least 24h by default', () => {
    const m = script.match(/MIN_AGE_H:-(\d+)/);
    expect(m, 'MIN_AGE_H needs a default').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(24);
  });

  it('skips drafts', () => {
    expect(script).toMatch(/isDraft == false/);
  });

  it('honours hold labels and offers superseded-keep as the escape hatch', () => {
    for (const label of ['do-not-merge', 'hold', 'wip', 'superseded-keep']) {
      expect(script, `label ${label} must be honoured`).toContain(label);
    }
  });

  it('never deletes the branch it closes', () => {
    expect(script).not.toMatch(/gh pr close[^\n]*--delete-branch/);
    expect(script).not.toMatch(/git push[^\n]*--delete/);
  });

  it('says why in a comment rather than closing silently', () => {
    expect(script).toMatch(/gh pr close[\s\S]{0,80}--comment/);
  });
});

describe('close-superseded-prs: the line filter stays blunt', () => {
  it('strips only blank and punctuation-only lines', () => {
    expect(script).toMatch(/STRIP_NOISE=/);
    // Stripping these made the "already in main" number look better and the
    // verdict less trustworthy. See the header note.
    const filter = script.slice(
      script.indexOf('STRIP_NOISE='),
      script.indexOf('STRIP_NOISE=') + 200
    );
    expect(filter).not.toMatch(/import|\/\/|export/);
  });
});
