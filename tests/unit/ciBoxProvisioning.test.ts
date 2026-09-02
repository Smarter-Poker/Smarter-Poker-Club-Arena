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

  it('is idempotent by construction - every install is guarded', () => {
    const sh = repo(PROVISION);
    expect(sh).toMatch(/swapon --show --noheadings \| grep -q/);
    expect(sh).toMatch(/grep -v ci-gc\.sh/);
    expect(sh).toMatch(/grep -v ci-restart-idle/);
    expect(sh).toMatch(/command -v node >\/dev\/null/);
    expect(sh).toMatch(/command -v gh >\/dev\/null/);
  });

  it('the runner setup script sends you here', () => {
    expect(repo('scripts/ci/setup-selfhosted-runner.sh')).toContain('provision-ci-box.sh');
  });
});
