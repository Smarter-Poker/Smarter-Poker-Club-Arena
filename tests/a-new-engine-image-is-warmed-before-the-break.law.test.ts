import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A NEW ENGINE IMAGE IS WARMED BEFORE THE BREAK (2026-10-23).
 *
 * The first container ever run from a freshly built image spent 13-40 s
 * unpacking its snapshot and 18-52 s joining the bridge network on engine-01,
 * all inside the 75 s cutover budget while the engine was down. Rollback
 * restarts of an already-run image took 0.3 s for both. Run 39728449445-1
 * measured stop 12.9 + create 23.9 + join 44.7 = 81.5 s and was refused.
 * The transaction now runs one throwaway container from the exact candidate
 * right after the build, outside any break, so the cutover meets a warm image.
 */
const SOURCE = readFileSync(
  join(process.cwd(), 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);

describe('the release transaction warms a new image before entering a break', () => {
  const fn = SOURCE.slice(
    SOURCE.indexOf('prewarm_candidate_image() {'),
    SOURCE.indexOf('read_pending_owner() {')
  );

  it('runs the warm-up immediately after the build and before any break work', () => {
    const build = SOURCE.indexOf("|| die 'bounded immutable engine image build failed'");
    const warm = SOURCE.indexOf('\nprewarm_candidate_image\n', build);
    const cutover = SOURCE.indexOf('bounded_break_command 75 env');
    expect(build).toBeGreaterThan(-1);
    expect(warm).toBeGreaterThan(build);
    expect(warm - build).toBeLessThan(120);
    expect(cutover).toBeGreaterThan(warm);
  });

  it('never touches production: no engine name, labels, env file or published ports', () => {
    expect(fn).toContain('docker run --rm --pull never');
    expect(fn).toContain('--restart no');
    expect(fn).toContain('--entrypoint node');
    expect(fn).toContain('club-arena-engine-prewarm-$RUN_ID');
    expect(fn).not.toMatch(/--env-file|-p |--publish|--label|autoheal|sp\.role/);
    expect(fn).not.toContain('"$CONTAINER"');
  });

  it('is bounded by the run deadline and never fatal', () => {
    expect(fn).toContain('remaining_seconds');
    expect(fn).toMatch(/timeout --signal=TERM --kill-after=5s "\$\{warm_timeout\}s" docker run/);
    expect(fn).not.toContain('die ');
    expect(fn.trimEnd().endsWith('return 0\n}') || fn.includes('  return 0\n}')).toBe(true);
  });
});
