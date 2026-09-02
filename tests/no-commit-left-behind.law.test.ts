import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO COMMIT LEFT BEHIND (Dan, 2026-09-02, binding)
 *
 * Dan, verbatim: "IMPROVE THIS SO IT NEVER FAILS TO PICK UP A PENDING COMMIT
 * TO PUSH AND PUBLISH DURING THE ENGINE SHUT DOWN."
 *
 * The report from agents was "my last 3 pushes have not published". Nothing
 * was ever lost - main is durable and every commit stayed on it - but
 * production lagged, sometimes indefinitely, and a lag nobody can predict is
 * indistinguishable from a loss to the person waiting on it.
 *
 * There were exactly two mechanisms, and this law pins the fix for both.
 *
 * 1. THE PUBLISHER PUBLISHED ITS TRIGGER COMMIT, NOT MAIN.
 *    `actions/checkout` with no `ref` checks out `github.sha`. So a run was
 *    "deliver commit X", not "make production equal main". When a wave of
 *    pushes arrived, `cancel-in-progress: false` cancelled the older PENDING
 *    runs (correct - they are superseded), and the survivor shipped only its
 *    own sha. The backlog therefore drained only if that one run succeeded.
 *    One failure, one badly-timed cancellation, one runner outage, and the
 *    commits behind it were never re-attempted.
 *
 *    Fixed by resolving the tip of main in `publish-needed` and checking THAT
 *    out everywhere. Every run is now a convergence step: any single success
 *    drains the whole backlog.
 *
 * 2. THE WATCHDOG GAVE UP AFTER ONE RETRY, AND COUNTED CANCELLATIONS AS ONE.
 *    A cancelled retry says nothing about brokenness - it means a newer push
 *    superseded it - but it burned the single retry, after which the watchdog
 *    only filed an issue and waited for a human.
 *
 * THE ENGINE IS NOT INVOLVED. Dan's hypothesis was that the hourly engine
 * restarts blocked publishing. They cannot: the two workflows use different
 * concurrency groups and share no queue, no runner and no token. This law pins
 * that separation so a future "let's serialise deploys" change cannot quietly
 * make the hypothesis true.
 */

const repo = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const PUBLISHER = '.github/workflows/build-for-world-hub.yml';
const ENGINE = '.github/workflows/auto-deploy-hetzner.yml';
const WATCHDOG = '.github/scripts/publish-watchdog.sh';

const TARGET = '${{ needs.publish-needed.outputs.target_sha }}';

describe('No commit left behind: the publisher converges on main', () => {
  it('resolves the tip of main and exposes it as a job output', () => {
    const yml = repo(PUBLISHER);
    expect(yml).toContain('target_sha: ${{ steps.target.outputs.sha }}');
    // The resolution itself: ask the API for main, never assume the trigger.
    expect(yml).toMatch(/gh api "repos\/\$\{\{ github\.repository \}\}\/commits\/main"/);
  });

  it('fails OPEN - an unreadable tip falls back to the trigger sha, never to publishing nothing', () => {
    const yml = repo(PUBLISHER);
    const step = yml.slice(yml.indexOf('- name: Resolve the tip of main'));
    expect(step).toMatch(/if \[ -z "\$TIP" \]/);
    expect(step).toContain('TIP="${{ github.sha }}"');
  });

  it('every Club Arena checkout builds the publish target, not the trigger commit', () => {
    const yml = repo(PUBLISHER);
    // Each CA checkout must name the target ref. The World Hub checkout is
    // exempt: it is a different repository and correctly takes its own main.
    const checkouts = [...yml.matchAll(/uses: actions\/checkout@v4\n((?:\s{8,}.*\n)*)/g)].map(
      (m) => m[1]
    );
    expect(checkouts.length).toBeGreaterThanOrEqual(4);

    const clubArenaCheckouts = checkouts.filter((c) => !c.includes('Smarter-Poker-World-Hub'));
    expect(clubArenaCheckouts.length).toBeGreaterThanOrEqual(3);
    for (const block of clubArenaCheckouts) {
      expect(block).toContain(`ref: ${TARGET}`);
    }
  });

  it('the bundle tells the truth about which commit it is', () => {
    const yml = repo(PUBLISHER);
    // Provenance, artifact identity and the World Hub commit message must all
    // name the sha that was actually built. On 2026-08-19 three syncs shipped
    // a stale tree while naming the current sha; that is what build-info is for.
    expect(yml).toContain(`"ca_sha": "${TARGET}"`);
    expect(yml).toContain(`name: club-arena-dist-${TARGET}`);
    expect(yml).toContain(`VITE_APP_VERSION: ${TARGET}`);
    expect(yml).toContain(`sync build ${TARGET} [skip actions]`);
  });

  it('the sync job can see the target, and the gate still holds', () => {
    const yml = repo(PUBLISHER);
    expect(yml).toContain('needs: [publish-needed, build-and-store, client-tests]');
    // A red test must still stop the bundle. `needs` on a matrix waits for
    // every shard, so this is the whole gate.
    expect(yml).toMatch(/fail-fast: true/);
    expect(yml).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/4/);
  });

  it('keeps a catch-up schedule, because push alone is not a guarantee', () => {
    expect(repo(PUBLISHER)).toMatch(/- cron: '\*\/\d+ \* \* \* \*'/);
  });

  it('does not cancel a running publish', () => {
    // cancel-in-progress: true deadlocked publishing on 2026-08-21 - every
    // build was killed before its sync step and production froze for hours.
    expect(repo(PUBLISHER)).toMatch(
      /concurrency:\s*\n\s*group: build-world-hub[^\n]*\n\s*cancel-in-progress: false/
    );
  });
});

describe('No commit left behind: the watchdog keeps healing', () => {
  it('retries more than once', () => {
    const sh = repo(WATCHDOG);
    expect(sh).toMatch(/MAX_RETRIES="\$\{MAX_RETRIES:-([3-9]|\d{2,})\}"/);
    expect(sh).toMatch(/\$\{ALREADY_RETRIED:-0\}" -lt "\$MAX_RETRIES"/);
  });

  it('does not spend a retry on a cancelled attempt', () => {
    // A cancellation means a newer push superseded the run. It is the
    // publisher working, not evidence of a fault, and counting it was how a
    // healthy repo talked itself out of healing.
    const sh = repo(WATCHDOG);
    expect(sh).toContain('select(.conclusion != \\"cancelled\\")');
    expect(sh).toContain('select(.conclusion != \\"skipped\\")');
  });

  it('still stops eventually, so a genuinely broken build reaches a human', () => {
    const sh = repo(WATCHDOG);
    expect(sh).toMatch(/-ge "\$MAX_RETRIES"/);
    expect(sh).toMatch(/not transient/);
  });
});

describe('No commit left behind: the engine cannot block a publish', () => {
  it('the publisher and the engine deploy do not share a concurrency group', () => {
    const publisher = repo(PUBLISHER)
      .match(/^concurrency:\n\s*group: (.+)$/m)?.[1]
      ?.trim();
    const engine = repo(ENGINE)
      .match(/^concurrency:\n\s*group: (.+)$/m)?.[1]
      ?.trim();
    expect(publisher).toBeTruthy();
    expect(engine).toBeTruthy();
    expect(publisher).not.toEqual(engine);
  });

  it('the engine deploy does not gate the bundle', () => {
    // Nothing in the publisher may WAIT on the engine. An engine drain can
    // legitimately defer for a long time while hands are in flight; letting
    // that hold the client bundle would make Dan's hypothesis true.
    //
    // Comments are stripped first, deliberately. The publisher cites
    // auto-deploy-hetzner.yml in prose (its catch-up cron was copied from it),
    // and VITE_ENGINE_URL is the client's API base - neither is a dependency.
    // This law is about executable structure, not about forbidding the word.
    const code = repo(PUBLISHER)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/auto-deploy-hetzner/);
    expect(code).not.toMatch(/engine\.smarter\.poker\/health/);
    // and no job may declare a dependency on anything engine-shaped
    expect(code).not.toMatch(/needs:.*hetzner/i);
  });
});
