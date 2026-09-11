import { readFileSync, readdirSync } from 'node:fs';
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
 * 3. (2026-09-11) THE NETS WERE A CRON AND A WATCHDOG. Dan: "i do not want
 *    any watch dogs, i want hard coded fixes". The 30-minute catch-up and the
 *    watchdog's re-dispatch existed for one case - a run that failed or was
 *    cancelled with nothing queued behind it. The publisher now hands itself
 *    on for exactly that case (its `hand-on` job), bounded so a broken build
 *    stops and reaches a person, and the watchdog only reports.
 *
 * THE ENGINE IS NOT INVOLVED. Dan's hypothesis was that the hourly engine
 * restarts blocked publishing. They cannot: the two workflows use different
 * concurrency groups and share no queue, no runner and no token. This law pins
 * that separation so a future "let's serialise deploys" change cannot quietly
 * make the hypothesis true.
 */

const repo = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const PUBLISHER = '.github/workflows/publish-club-arena.yml';
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
    // Each CA checkout must name the target ref. Since 2026-09-03 there are
    // two (client-tests, build-and-store): publish-needed has none and the
    // origin publish works on the downloaded artifact, so it has none either.
    // The World Hub checkout is gone with the World Hub sync.
    const checkouts = [...yml.matchAll(/uses: actions\/checkout@v4\n((?:\s{8,}.*\n)*)/g)].map(
      (m) => m[1]
    );
    expect(checkouts.length).toBeGreaterThanOrEqual(2);

    const clubArenaCheckouts = checkouts.filter((c) => !c.includes('Smarter-Poker-World-Hub'));
    expect(clubArenaCheckouts.length).toBe(checkouts.length);
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
    // The release directory on the origin is named for the same sha the
    // bundle was stamped with (2026-09-03): the publish step reads ca_sha
    // back OUT of dist/build-info.json and rsyncs to releases/<that sha>/.
    expect(yml).toMatch(/OURS_SHA=\$\(sed -n .*ca_sha.* dist\/build-info\.json\)/);
    expect(yml).toContain('releases/$SHA/');
  });

  it('the sync job can see the target, and the gate still holds', () => {
    const yml = repo(PUBLISHER);
    expect(yml).toContain('needs: [publish-needed, build-and-store, client-tests]');
    // A red test must still stop the bundle. `needs` on a matrix waits for
    // every shard, so this is the whole gate.
    expect(yml).toMatch(/fail-fast: true/);
    expect(yml).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/4/);
  });

  it('needs no catch-up schedule: a run that cannot finish hands itself on', () => {
    const yml = repo(PUBLISHER);
    expect(yml).not.toMatch(/^\s*- cron:/m);
    const job = yml.slice(yml.indexOf('\n  hand-on:'));
    expect(job).toMatch(
      /needs: \[publish-needed, build-and-store, client-tests, publish-to-origin\]/
    );
    expect(job).toMatch(
      /always\(\) &&\s*\n\s*\(contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\)\)/
    );
    // Not the self-hosted runner: it must run when that runner is what failed.
    expect(job).toMatch(/runs-on: ubuntu-latest/);
    expect(job).toMatch(/actions: write/);
    expect(job).toMatch(
      /gh workflow run publish-club-arena\.yml --repo "\$\{\{ github\.repository \}\}" --ref main -f handed_on=true/
    );
  });

  it('does not cancel a running publish', () => {
    // cancel-in-progress: true deadlocked publishing on 2026-08-21 - every
    // build was killed before its sync step and production froze for hours.
    //
    // The group NAME is deliberately not pinned any more. It was
    // `build-world-hub`, then `build-world-hub-g2` when a wedged group had to
    // be abandoned, and now `publish-club-arena` on the workflow that replaced
    // it. Pinning the name made this test fail on a rename that was itself the
    // remedy. What matters, and all that is pinned, is that a running publish
    // is never cancelled.
    expect(repo(PUBLISHER)).toMatch(
      /concurrency:\s*\n\s*group: [^\n]*\n\s*cancel-in-progress: false/
    );
  });

  it('is the ONLY publisher - a second one would not serialise with it', () => {
    /**
     * MEASURED 2026-09-02. For about ninety minutes build-for-world-hub.yml and
     * publish-club-arena.yml both existed and both fired on every push to main,
     * on SEPARATE concurrency groups. Nothing serialised them: two full builds
     * of the same commit, two pushes to the World Hub, and the older one still
     * on billed hosted runners.
     *
     * A second publisher is not a safety net, it is a race. The nets are the
     * catch-up cron, publish-watchdog's re-dispatch, and the tip-of-main
     * convergence - all of which live inside this one workflow.
     */
    const workflows = readdirSync(resolve(__dirname, '../.github/workflows'));
    const publishers = workflows.filter((f) => {
      if (!/\.ya?ml$/.test(f)) return false;
      const y = readFileSync(resolve(__dirname, '../.github/workflows', f), 'utf8');
      return /publish-to-origin:/.test(y) && /jobs:/.test(y);
    });
    expect(publishers, `expected exactly one publisher, found: ${publishers.join(', ')}`).toEqual([
      'publish-club-arena.yml',
    ]);
  });
});

describe('No commit left behind: the publish closes its own loop', () => {
  it('chains another publish when main moved while this one built', () => {
    const yml = repo(PUBLISHER);
    // Resolving the tip at the START stops a commit being SKIPPED. It does not
    // stop one WAITING - main keeps moving during the ~7 minute build, and
    // over the last 100 runs the worst gap between two successful publishes
    // was 154 minutes. The chain is what removes the wait.
    expect(yml).toMatch(/- name: Converge - chain another publish if main moved/);
    expect(yml).toMatch(/gh workflow run "publish-club-arena\.yml"/);
    // It must dispatch on the CONDITION that main is ahead, never blindly.
    expect(yml).toMatch(/if \[ "\$TIP" = "\$PUBLISHED" \]/);
    expect(yml).toMatch(/CONVERGED/);
  });

  it('the chain can actually dispatch - the job declares actions: write', () => {
    // Comments are stripped first. The permissions block is introduced by a
    // comment that contains the words "actions: write", and matching that
    // made this pin pass with the permission REMOVED - caught by mutating the
    // sync job and watching the law stay green. A grant is a line of YAML,
    // never a sentence about one.
    const yml = repo(PUBLISHER);
    const sync = yml.slice(yml.indexOf('  publish-to-origin:'));
    const perms = sync
      .slice(sync.indexOf('permissions:'), sync.indexOf('steps:'))
      .split('\n')
      .filter((line) => !/^\s*#/.test(line));
    expect(perms.some((line) => /^\s+actions: write\s*$/.test(line))).toBe(true);
    // contents: READ since 2026-09-03. The publish no longer commits anywhere;
    // it rsyncs to the origin. A job that cannot write contents cannot
    // quietly grow a second sync path.
    expect(perms.some((line) => /^\s+contents: read\s*$/.test(line))).toBe(true);
    expect(perms.some((line) => /^\s+contents: write\s*$/.test(line))).toBe(false);
  });

  it('a failed chain never fails a publish that already succeeded', () => {
    // The bundle is live at this point. Marking the run red because the
    // follow-up dispatch could not be sent would turn a success into a false
    // alarm. With no cron behind it (2026-09-11) the failure is an error
    // annotation - loud - but the run stays green.
    const yml = repo(PUBLISHER);
    const step = yml.slice(
      yml.indexOf('- name: Converge - chain another publish'),
      yml.indexOf('\n  hand-on:')
    );
    expect(step).toMatch(/::error title=PUBLISH TRAIN STOPPED::chain dispatch failed/);
    expect(step).not.toMatch(/exit 1/);
    // And the chain is a handed-on run, which asks production first.
    expect(step).toMatch(/--ref main -f handed_on=true/);
  });
});

describe('No commit left behind: the publisher heals itself, and the watchdog only reports', () => {
  const HAND_ON = () => {
    const yml = repo(PUBLISHER);
    return yml.slice(yml.indexOf('\n  hand-on:'));
  };

  it('retries more than once', () => {
    expect(Number(HAND_ON().match(/RETRY_LIMIT: '(\d+)'/)![1])).toBeGreaterThanOrEqual(3);
  });

  it('does not spend a retry on a cancelled attempt', () => {
    // A cancellation means a newer push superseded the run. It is the
    // publisher working, not evidence of a fault.
    const job = HAND_ON();
    expect(job).toContain('select(.conclusion != "cancelled" and .conclusion != "skipped")');
  });

  it('still stops eventually, so a genuinely broken build reaches a human', () => {
    const job = HAND_ON();
    expect(job).toMatch(
      /if \[ "\$STREAK" -ge "\$RETRY_LIMIT" \]; then\s*\n\s*echo "::error title=PUBLISH GAVE UP::/
    );
    // A streak nobody can count stops too, rather than retrying forever.
    expect(job).toMatch(/could not count earlier failed publishes/);
  });

  it('the watchdog never re-dispatches the publisher', () => {
    const code = repo(WATCHDOG)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/gh workflow run/);
  });

  it('escalates in-app when the publisher has given up, because it must not auto-ship a broken bundle', () => {
    // The honest limit of automation: a bundle that does not build must not be
    // published anyway. So the guarantee is "never silently forgotten", and
    // that requires the alarm to reach a person, not just a repository.
    const sh = repo(WATCHDOG);
    expect(sh).toMatch(/escalate_in_app\(\)/);
    expect(sh).toMatch(/fn_raise_notification/);
    const gaveUp = sh.slice(sh.indexOf('if [ "$GAVE_UP" = "true" ]; then'));
    expect(gaveUp).toMatch(/^if \[ "\$GAVE_UP" = "true" \]; then[\s\S]{0,600}?escalate_in_app "/);
  });

  it('a missing credential degrades the escalation, never fails the watchdog', () => {
    const sh = repo(WATCHDOG);
    const fn = sh.slice(sh.indexOf('escalate_in_app() {'), sh.indexOf('# ── DID THE MERGE'));
    expect(fn).toMatch(/skipping the in-app escalation/);
    expect(fn).toMatch(/return 0/);
  });

  it('the workflow actually supplies what the escalation needs', () => {
    const yml = repo('.github/workflows/publish-watchdog.yml');
    expect(yml).toMatch(/SUPABASE_URL:/);
    expect(yml).toMatch(
      /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/
    );
  });
});

describe('No commit left behind: a commit cannot suppress its own publish', () => {
  it('the skip-marker guard exists and covers every form GitHub honours', () => {
    const guard = repo('scripts/ci/check-no-skip-markers.mjs');
    for (const form of ['skip[ _-]ci', 'ci[ _-]skip', 'skip[ _-]actions', 'no[ _-]ci', 'NO_CI']) {
      expect(guard).toContain(form);
    }
  });

  it('the pre-push hook actually runs it', () => {
    // A guard nothing invokes is a comment. Every other check in this repo
    // that mattered was wired into the hook, and this one is the only thing
    // that PREVENTS the gap rather than recovering from it.
    const hook = repo('.husky/pre-push');
    expect(hook).toContain('scripts/ci/check-no-skip-markers.mjs');
    expect(hook).toMatch(/BLOCKED: a commit would suppress its own publish/);
  });

  it('fails open on an unreadable range, and keeps a deliberate override', () => {
    const guard = repo('scripts/ci/check-no-skip-markers.mjs');
    expect(guard).toMatch(/could not read.*skipping/s);
    expect(guard).toContain('CA_ALLOW_SKIP_MARKER');
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
