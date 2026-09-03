/**
 * LAW: no archiver force-pushes onto an archive ref, and every archive is dated.
 *
 * `scripts/archive-dead-branches.sh` wrote `refs/archive/<name>` with
 * `--force`. That is a way to destroy work inside the one tool whose entire
 * promise is that it does not.
 *
 * Branch names get reused on this estate - `fix/table-freeze-and-dead-actions`
 * was already sitting in `refs/archive` from August when this was found. Archive
 * that name a second time and the force silently replaced the first archive,
 * making the August commits unreachable with no message, no trace, and no way
 * for anyone to know an archive had ever existed.
 *
 * There are two archivers here: this hand-run one and the automated
 * `.github/scripts/archive-stale-branches.sh` in the hourly watchdog. Two tools
 * with two conventions is how the next agent ends up looking in the wrong place
 * for work that was archived by the other one, so both now write exactly:
 *
 *     refs/archive/<name>@<YYYY-MM-DD>
 *
 * and restoring from either is the same single command:
 *
 *     git push origin refs/archive/<name>@<date>:refs/heads/<name>
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const HAND = join(ROOT, 'scripts/archive-dead-branches.sh');

describe('an archive ref is never overwritten', () => {
  it('the hand-run archiver still exists', () => {
    expect(existsSync(HAND)).toBe(true);
  });

  it('it dates every archive, so a reused branch name cannot clobber an older one', () => {
    const o = readFileSync(HAND, 'utf8');
    expect(o).toMatch(/ARCHIVE_REF="refs\/archive\/\$\{branch\}@\$\(date -u \+%Y-%m-%d\)"/);
  });

  it('it never force-pushes the archive', () => {
    const o = readFileSync(HAND, 'utf8');
    const pushLine = o.split('\n').find((l) => l.includes('$REMOTE/$branch:$ARCHIVE_REF')) ?? '';
    expect(pushLine).not.toBe('');
    expect(pushLine).not.toContain('--force');
    // and no other push in the file may force anything into refs/archive
    for (const l of o.split('\n')) {
      if (l.includes('refs/archive') && l.includes('git push')) expect(l).not.toContain('--force');
    }
  });

  it('a failed archive never proceeds to the delete', () => {
    // The whole safety property is archive-THEN-delete. If the archive fails
    // and the delete still runs, the branch is simply gone.
    const o = readFileSync(HAND, 'utf8');
    const i = o.indexOf('$REMOTE/$branch:$ARCHIVE_REF');
    expect(i).toBeGreaterThan(-1);
    const between = o.slice(i, o.indexOf('--delete', i));
    expect(between).toMatch(/ARCHIVE FAILED/);
    expect(between).toMatch(/continue/);
  });
});
