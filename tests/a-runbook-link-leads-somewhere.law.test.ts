/**
 * THE RUNBOOK IS THE FIRST THING READ BY WHOEVER THE PAGE WAKES UP.
 *
 * check-monitoring-drift.mjs has checked repo-relative runbook targets since
 * 2026-09-11, for the good reason that 23 alerts had pointed at three
 * changelog files nobody ever wrote. It deliberately skipped http(s) targets,
 * for an equally good reason: a build has no business reaching somebody
 * else's server. Nothing then checked those, and the summary line went on
 * saying "every runbook resolves".
 *
 * Measured 2026-09-18: 19 alerts point at https://monitor.smarter.poker/...
 * and every one answers 404 DEPLOYMENT_NOT_FOUND from Vercel. *.smarter.poker
 * is a wildcard to Vercel and no record sends `monitor` to cron-01, where
 * infra/monitoring/Caddyfile has always expected to serve it.
 *
 * This law holds the half that needs no network:
 *   - a runbook link into THIS repository must name a file that exists, and
 *   - the summary must not claim more than it checked.
 * The live fetch is check-alert-rules-match.mjs, which runs on the box.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownRepoPath, declaredRunbookUrls } from '../scripts/ci/check-runbook-links.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MON = join(ROOT, 'infra', 'monitoring');

describe('a runbook link leads somewhere', () => {
  it('resolves a link into this repository as a file, because a private repo 404s anonymously', () => {
    expect(
      ownRepoPath(
        'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/main/docs/runbooks/x.md'
      )
    ).toBe('docs/runbooks/x.md');
    expect(ownRepoPath('https://monitor.smarter.poker/runbooks/engine-down')).toBeNull();
    expect(ownRepoPath('https://example.com/whatever')).toBeNull();
  });

  it('strips an anchor, so a deep link still names the file', () => {
    expect(
      ownRepoPath(
        'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/blob/main/docs/a.md#section'
      )
    ).toBe('docs/a.md');
  });

  it('every runbook link into this repository names a file that exists', () => {
    const missing: string[] = [];
    for (const [url, owners] of declaredRunbookUrls()) {
      const rel = ownRepoPath(url);
      if (!rel) continue;
      if (!existsSync(join(ROOT, rel))) missing.push(`${rel} <- ${owners.join(', ')}`);
    }
    expect(missing, `runbook documents named by a rule but absent:\n${missing.join('\n')}`).toEqual(
      []
    );
  });

  it('finds the rule files it is supposed to be reading', () => {
    // A parser that silently matches nothing would make every assertion above
    // vacuous - the failure mode this repository has been bitten by twice.
    const urls = declaredRunbookUrls();
    expect(urls.size).toBeGreaterThan(5);
    expect(readdirSync(MON).filter((n) => /\.ya?ml$/.test(n)).length).toBeGreaterThan(3);
  });

  it('the drift check states what it did not fetch, rather than claiming every runbook resolves', () => {
    // Asserted on what the script PRINTS, not on its source: the source also
    // contains that phrase inside the comment explaining why it was wrong.
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/ci/check-monitoring-drift.mjs')],
      {
        encoding: 'utf8',
        cwd: ROOT,
      }
    );
    expect(out).toMatch(/every repo-relative runbook resolves/);
    expect(out).not.toMatch(/non-empty; every metric[^\n]*; every runbook resolves/);
    expect(out).toMatch(/runbook URL\(s\) on \d+ rule\(s\) are http\(s\) and were NOT fetched/);
  });
});
