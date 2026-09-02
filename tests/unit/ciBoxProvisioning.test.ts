import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The estate CI box (Hetzner cpx41, 8 runners on 8 cores) is tuned by
 * scripts/ci/provision-ci-box.sh. These pins exist because the first cut of
 * that tuning was a silent no-op: it set VITEST_MAX_THREADS, which vitest 4
 * does not read, so eight concurrent vitest runs kept forking a worker per
 * core and the box sat at load 69-75 while every job starved. It was caught
 * by grepping the installed vitest for the variables it actually contains
 * and then counting a live vitest process's children (8 uncapped, 3 capped).
 */
const repo = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
const PROVISION = 'scripts/ci/provision-ci-box.sh';

describe('CI box provisioning', () => {
  it('caps vitest with the variable vitest 4 actually reads', () => {
    const sh = repo(PROVISION);
    expect(sh).toMatch(/Environment=VITEST_MAX_WORKERS=/);
    // The no-op names must not come back.
    expect(sh).not.toMatch(/Environment=VITEST_MAX_THREADS/);
    expect(sh).not.toMatch(/Environment=VITEST_MAX_FORKS/);
  });

  it('the installed vitest agrees - VITEST_MAX_WORKERS is a name it knows', () => {
    // Read the package, not the docs. If a vitest upgrade renames this, the
    // provisioner is wrong again and this is what says so.
    // Chunk names vary between minor versions, so scan the whole dist.
    const dir = resolve(__dirname, '..', '..', 'node_modules', 'vitest', 'dist', 'chunks');
    const dist = readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(resolve(dir, f), 'utf8'))
      .join('\n');
    expect(dist).toContain('VITEST_MAX_WORKERS');
  });

  it('exports RUNNER_ENVIRONMENT, because this runner build never does', () => {
    // Three test files relax their wall clock with
    //   10_000 * (process.env.RUNNER_ENVIRONMENT === 'self-hosted' ? 3 : 1)
    // and all three were silent no-ops: the string RUNNER_ENVIRONMENT appears
    // ZERO times in Runner.Worker.dll and Runner.Common.dll of the installed
    // runner (checked 2026-09-02). GitHub documents the variable, so it keeps
    // getting reached for; this box simply never set it, and the ternary took
    // the hosted branch ON the self-hosted box every time. The evidence is a
    // failure reading "Test timed out in 10000ms" where a working multiplier
    // would have said 30000ms - it turned main red and stopped the publisher.
    //
    // Setting it in the drop-in is not a lie, this IS self-hosted, and nothing
    // overrides it because the runner never writes the name. Remove this line
    // and those three timeouts silently tighten back to 10s.
    expect(repo(PROVISION)).toMatch(/Environment=RUNNER_ENVIRONMENT=self-hosted/);
  });

  it('bounds the heap but leaves tsc enough room', () => {
    const m = repo(PROVISION).match(/NODE_HEAP_MB="\$\{NODE_HEAP_MB:-(\d+)\}"/);
    expect(m).not.toBeNull();
    const mb = Number(m![1]);
    expect(mb).toBeGreaterThanOrEqual(3072); // tsc --noEmit on this tree needs it
    expect(mb).toBeLessThanOrEqual(4096); // 8 x this must fit RAM + swap
  });

  it('installs the GC, the swap and the idle sweeper - the three things a hosted runner never needs', () => {
    const sh = repo(PROVISION);
    expect(sh).toContain('/usr/local/bin/ci-gc.sh');
    expect(sh).toMatch(/17 4 \* \* \* \/usr\/local\/bin\/ci-gc\.sh/);
    expect(sh).toContain('/swapfile none swap sw 0 0');
    expect(sh).toContain('/usr/local/bin/ci-restart-idle-runners.sh');
    // The sweeper must never restart a runner that is mid-job.
    expect(sh).toMatch(/pgrep -f "\$d\/bin\/Runner\.Worker"/);
  });

  it('the idle sweeper cannot restart a runner that has just accepted a job', () => {
    // 2026-09-02: two CI jobs died with "The runner has received a shutdown
    // signal", which reads like an infrastructure blip and was this script.
    // The sweeper decided "idle" from `pgrep Runner.Worker` alone, and between
    // the Listener ACCEPTING a job and the Worker appearing there is a window
    // where a committed runner shows no Worker. The sweeper looked in exactly
    // that window and restarted it. A sweeper whose entire promise is "never
    // kills a job" must not have a window.
    const sh = repo(PROVISION);
    // A runner that accepted a job has already written into its own _work
    // tree, before any Worker exists. That is the signal that closes it.
    expect(sh).toMatch(/_work.*-newermt/);
    // The Worker check stays - it is the fast path, not the only path.
    expect(sh).toMatch(/pgrep -f "\$d\/bin\/Runner\.Worker"/);
    // Checked twice, so a job accepted mid-decision is still caught.
    expect(sh).toMatch(/runner_busy "\$d"[\s\S]{0,400}?sleep[\s\S]{0,200}?runner_busy "\$d"/);
    // And only one sweeper may run: the provisioner invokes it directly AND
    // installs it on cron, and the two raced.
    expect(sh).toMatch(/flock -n 9/);
  });

  it('can never wipe the crontab - every cron edit goes through cron_set and is read back', () => {
    // Second run of this script on the box emptied root's crontab: under
    // `set -e -o pipefail`, `( crontab -l | grep -v KEY; echo LINE ) | crontab -`
    // aborts inside the subshell when grep matches nothing (KEY was the only
    // entry), the echo never runs, and crontab receives an empty document. The
    // nightly GC vanished. Read-modify-write through a variable, then read back.
    const sh = repo(PROVISION);
    expect(sh).toMatch(/^cron_set\(\) \{/m);
    expect(sh).toMatch(/grep -v -- "\$key" \|\| true/);
    expect(sh).toMatch(/crontab -l \| grep -qF -- "\$line" \|\| \{ echo " {3}FATAL/);
    // The dangerous idiom must not appear in the top-level script's CODE.
    // Comments are stripped first: the helper's own header quotes the idiom
    // to explain why it is banned, and a pin that matched the explanation
    // would fail on the fix itself (the actions:write pin made that mistake).
    const topLevel = sh
      .replace(/cat > \/usr\/local\/bin\/[^\n]*<<'EOF'[\s\S]*?\nEOF\n/g, '')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(topLevel).not.toMatch(/\( crontab -l[^\n]*; echo[^\n]*\) \| crontab -/);
    // Both cron installs use the helper.
    expect(sh).toMatch(/cron_set ci-gc\.sh /);
    expect(sh).toMatch(/cron_set ci-restart-idle /);
  });

  it('is idempotent by construction - every install is guarded', () => {
    const sh = repo(PROVISION);
    expect(sh).toMatch(/swapon --show --noheadings \| grep -q/);
    expect(sh).toMatch(/cron_set ci-gc\.sh /);
    expect(sh).toMatch(/cron_set ci-restart-idle /);
    expect(sh).toMatch(/command -v node >\/dev\/null/);
    expect(sh).toMatch(/command -v gh >\/dev\/null/);
  });

  it('the runner setup script sends you here', () => {
    expect(repo('scripts/ci/setup-selfhosted-runner.sh')).toContain('provision-ci-box.sh');
  });

  it('installs every CLI a routed workflow shells out to', () => {
    // The first post-deploy-e2e run on the box failed on a step that had never
    // failed on hosted: "psql: command not found". A hosted image ships
    // hundreds of tools; this box ships what the provisioner installs, so the
    // provisioner has to know what the workflows call. Scan them and check.
    const workflows = [
      '.github/workflows/ci.yml',
      '.github/workflows/build-for-world-hub.yml',
      '.github/workflows/post-deploy-e2e.yml',
    ]
      .map(repo)
      .join('\n');
    const provision = repo(PROVISION);
    // Tools that are not on a bare Ubuntu image and that workflows invoke.
    for (const tool of ['psql', 'gh', 'jq']) {
      if (new RegExp(`(^|[ |;(\`])${tool}( |$)`, 'm').test(workflows)) {
        expect(provision, `${tool} is called by a workflow but not installed`).toMatch(
          new RegExp(
            `(apt-get install[^\\n]*\\b${tool === 'psql' ? 'postgresql-client' : tool}\\b|install -y -qq ${tool})`
          )
        );
      }
    }
    // and the provisioner audits itself at the end
    expect(provision).toMatch(/routed-workflow tool audit/);
  });

  it('derives the vitest cap from the box instead of hardcoding it', () => {
    // THIS PIN MOVED, 2026-09-02, and the constant it used to guard is the
    // reason. It read `VITEST_WORKERS:-4`, measured honestly - one job, idle
    // box, 12.9 min down to 3.1 - and its own comment reasoned that "8 x 4 =
    // 32 threads is 4x oversubscribed at the absolute worst moment and
    // typical concurrency is 2-4 jobs". The worst moment arrived: nine
    // concurrent jobs, 26 vitest processes, load 44 on 8 cores. A 150-hand
    // simulation that runs in 967 ms measured 12342 ms, blew its ceiling and
    // turned main red, which stopped the publisher for the whole estate.
    //
    // A queued job waits harmlessly. A STARVED job times out. So the cap is
    // no longer a number someone measured once on an idle box - it follows
    // the hardware and the runner count, and a resize corrects it with no
    // edit here.
    const sh = repo(PROVISION);
    expect(sh, 'no bare constant may come back').not.toMatch(
      /VITEST_WORKERS="\$\{VITEST_WORKERS:-[0-9]+\}"/
    );
    // Total concurrency is bounded against the cores actually present.
    expect(sh).toMatch(/DERIVED=\$\(\(\s*\$\(nproc\)\s*\*\s*2\s*\/\s*UNIT_N\s*\)\)/);
    // Floor 2 (1 makes a lone job pointlessly serial), ceiling 4 (the knee).
    expect(sh).toMatch(/DERIVED"?\s*-lt 2 \] && DERIVED=2/);
    expect(sh).toMatch(/DERIVED"?\s*-gt 4 \] && DERIVED=4/);
    // An operator override must still win, or the box cannot be tuned by hand.
    expect(sh).toMatch(/VITEST_WORKERS="\$\{VITEST_WORKERS:-\$DERIVED\}"/);
    // And the run must SAY what it chose - the previous cap was wrong for
    // months partly because nothing ever printed the peak it implied.
    expect(sh).toMatch(/peak/);
  });
});
