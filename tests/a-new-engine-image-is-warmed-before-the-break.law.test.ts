import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

  it('warms published networking only on an ephemeral loopback port without production input', () => {
    expect(fn).toContain('docker run --rm --pull never');
    expect(fn).toContain('--restart no');
    expect(fn).toContain('--entrypoint node');
    expect(fn).toContain('club-arena-engine-prewarm-$RUN_ID');
    expect(fn).toContain('--publish 127.0.0.1::8080');
    expect(fn.match(/--publish/g)).toHaveLength(1);
    expect(fn).not.toMatch(/--env-file|-p |--label|autoheal|sp\.role/);
    expect(fn).not.toMatch(/127\.0\.0\.1:8080:|0\.0\.0\.0|--network host/);
    expect(fn).not.toContain('"$CONTAINER"');
  });

  it('executes the port-mapper warm-up with the engine command replaced and no production configuration', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'horse-release-warm-'));
    try {
      const bin = join(sandbox, 'bin');
      mkdirSync(bin);
      const calls = join(sandbox, 'docker.calls');
      const docker = join(bin, 'docker');
      writeFileSync(docker, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${calls}'\n`);
      chmodSync(docker, 0o755);
      const timeout = join(bin, 'timeout');
      writeFileSync(
        timeout,
        '#!/usr/bin/env bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n'
      );
      chmodSync(timeout, 0o755);
      const image = `sha256:${'a'.repeat(64)}`;
      const script = join(sandbox, 'warm.sh');
      writeFileSync(
        script,
        `set -euo pipefail\nremaining_seconds() { echo 600; }\nRUN_ID=42-1\nIMAGE_REF=${image}\n${fn}\nprewarm_candidate_image\n`
      );
      const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status, result.stderr).toBe(0);
      const commands = readFileSync(calls, 'utf8').trim().split('\n');
      expect(commands).toEqual([
        'rm -f club-arena-engine-prewarm-42-1',
        `run --rm --pull never --name club-arena-engine-prewarm-42-1 --restart no --network bridge --publish 127.0.0.1::8080 --entrypoint node ${image} -e process.exit(0)`,
      ]);
      expect(result.stdout).toContain('ENGINE_IMAGE_PREWARM_SECONDS=');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('is bounded by the run deadline and never fatal', () => {
    expect(fn).toContain('remaining_seconds');
    expect(fn).toMatch(/timeout --signal=TERM --kill-after=5s "\$\{warm_timeout\}s" docker run/);
    expect(fn).not.toContain('die ');
    expect(fn.trimEnd().endsWith('return 0\n}') || fn.includes('  return 0\n}')).toBe(true);
  });
});
