import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  join(process.cwd(), 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);
const HELPER_PATH = join(process.cwd(), 'server/scripts/prewarm-engine-image.sh');
const HELPER = readFileSync(HELPER_PATH, 'utf8');
const WORKFLOW = readFileSync(
  join(process.cwd(), '.github/workflows/auto-deploy-hetzner.yml'),
  'utf8'
);
const fn = HELPER.slice(
  HELPER.indexOf('prewarm_candidate_image() {'),
  HELPER.indexOf('# Standalone caller:')
);

function fixture(runFails = false, remaining = 600) {
  const sandbox = mkdtempSync(join(tmpdir(), 'engine-filesystem-warm-'));
  const bin = join(sandbox, 'bin');
  const app = join(sandbox, 'app');
  mkdirSync(bin);
  mkdirSync(join(app, 'dist'), { recursive: true });
  mkdirSync(join(app, 'node_modules/pkg'), { recursive: true });
  const entry = 'throw new Error("APPLICATION_CODE_MUST_NOT_EXECUTE");';
  const payload = Buffer.alloc(192 * 1024 + 3, 77);
  writeFileSync(join(app, 'dist/index.js'), entry);
  writeFileSync(join(app, 'node_modules/pkg/data.bin'), payload);
  writeFileSync(join(app, '.env'), 'PRIVATE_CONFIGURATION_MUST_NOT_BE_READ');
  chmodSync(join(app, '.env'), 0o000);
  writeFileSync(join(sandbox, 'outside-secret'), 'OUTSIDE_CANDIDATE');
  symlinkSync(join(sandbox, 'outside-secret'), join(app, 'linked-secret'));
  // This fixture qualifies filesystem hydration only. The native scale gate
  // has its own controller boundary tests and provider-only image evidence.
  const helper = join(sandbox, 'prewarm-engine-image.sh');
  writeFileSync(helper, HELPER);
  writeFileSync(
    join(sandbox, 'legacy-census-scale-preflight.py'),
    'import sys\nassert len(sys.argv) == 4\nprint("SCALE_BOUNDARY_FIXTURE_ONLY")\n'
  );
  const calls = join(sandbox, 'docker.calls');
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    '#!/usr/bin/env node\n' +
      'const fs=require("node:fs");const cp=require("node:child_process");\n' +
      'const args=process.argv.slice(2);fs.appendFileSync(' +
      JSON.stringify(calls) +
      ',JSON.stringify(args)+"\\n");\n' +
      'if(args[0]==="run") {\n' +
      (runFails
        ? 'process.exit(31);\n'
        : 'const i=args.indexOf("-e");cp.execFileSync(process.execPath,["-e",args[i+1],' +
          JSON.stringify(app) +
          '],{stdio:"inherit"});\n') +
      '}\n'
  );
  chmodSync(docker, 0o755);
  writeFileSync(
    join(bin, 'timeout'),
    '#!/usr/bin/env bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n'
  );
  chmodSync(join(bin, 'timeout'), 0o755);
  const image = 'sha256:' + 'a'.repeat(64);
  const script = join(sandbox, 'warm.sh');
  writeFileSync(
    script,
    'set -euo pipefail\nremaining_seconds() { echo ' +
      remaining +
      '; }\n' +
      'die() { echo "$*" >&2; exit 9; }\nRUN_ID=42-1\nIMAGE_REF=' +
      image +
      '\n' +
      fn +
      '\nprewarm_candidate_image\necho ANNOUNCEMENT_REACHED\n'
  );
  return {
    sandbox,
    app,
    calls,
    image,
    expectedBytes: Buffer.byteLength(entry) + payload.length,
    run: () =>
      spawnSync('bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: bin + ':' + process.env.PATH },
      }),
    runHelper: (args: string[]) =>
      spawnSync('bash', [helper, ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: bin + ':' + process.env.PATH },
      }),
    cleanup: () => {
      chmodSync(join(app, '.env'), 0o600);
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

describe('a candidate filesystem is warmed before maintenance can be announced', () => {
  it('places complete candidate preparation after the image build and before break work', () => {
    const build = SOURCE.indexOf("|| die 'bounded immutable engine image build failed'");
    const warm = SOURCE.indexOf('\nprewarm_candidate_image\n', build);
    expect(build).toBeGreaterThan(-1);
    expect(warm).toBeGreaterThan(build);
    expect(
      SOURCE.indexOf('bounded_break_command "$BREAK_CUTOVER_PROOF_SECONDS" env')
    ).toBeGreaterThan(warm);
  });

  it('uses one bound helper before intake and retains transaction preparation', () => {
    const prepared = WORKFLOW.indexOf('name: Prepare the scheduled immutable image');
    const warm = WORKFLOW.indexOf(
      '"$STAGE/server/scripts/prewarm-engine-image.sh" "$IMAGE_ID" "$RUN_KEY" "$NOT_AFTER_EPOCH"',
      prepared
    );
    const wait = WORKFLOW.indexOf('name: Wait for the immutable activation floor');
    const intake = WORKFLOW.indexOf('name: Dispatch the staged SHA');
    expect(warm).toBeGreaterThan(prepared);
    expect(wait).toBeGreaterThan(warm);
    expect(intake).toBeGreaterThan(wait);
    expect(WORKFLOW.slice(prepared, warm)).toContain(
      '"$CONTROL_SHA:server/scripts/prewarm-engine-image.sh"'
    );
    expect(WORKFLOW.slice(prepared, warm)).toContain('imageId');
    expect(SOURCE).toContain(`docker image inspect --format '{{.Id}}' "$IMAGE_REF"`);
    expect(SOURCE).toContain(
      '"$CONTROL_DIR/prewarm-engine-image.sh" "$image_id" "$RUN_ID" "$MUTATION_DEADLINE_EPOCH"'
    );
    expect(SOURCE).not.toContain('Buffer.alloc(64 * 1024)');
  });

  it('the actual helper refuses mutable images, unsafe names and expired deadlines before Docker', () => {
    const f = fixture();
    try {
      const deadline = String(Math.floor(Date.now() / 1000) + 600);
      for (const args of [
        ['mutable:tag', '42-1', deadline],
        [f.image, '../42', deadline],
        [f.image, '42-1', '1'],
      ]) {
        const result = f.runHelper(args);
        expect(result.status).not.toBe(0);
        expect(existsSync(f.calls)).toBe(false);
      }
      const result = f.runHelper([f.image, '42-1', deadline]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('ENGINE_IMAGE_PREWARM_FILES=2');
    } finally {
      f.cleanup();
    }
  });

  it('retains the ephemeral loopback run without production configuration, labels or application invocation', () => {
    expect(fn).toContain('docker run --rm --pull never');
    expect(fn).toContain('--restart no');
    expect(fn).toContain('--entrypoint node');
    expect(fn).toContain('--publish 127.0.0.1::8080');
    expect(fn.match(/--publish/g)).toHaveLength(1);
    expect(fn).not.toMatch(
      /--env-file|-p |--label|autoheal|sp\.role|127\.0\.0\.1:8080:|0\.0\.0\.0|--network host/
    );
    expect(fn).not.toContain('"$CONTAINER"');
    expect(fn).not.toContain('process.exit(0)');
  });

  it('reads all immutable application and dependency bytes with fixed memory while skipping configuration and links', () => {
    const f = fixture();
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('ENGINE_IMAGE_PREWARM_FILES=2');
      expect(result.stdout).toContain('ENGINE_IMAGE_PREWARM_BYTES=' + f.expectedBytes);
      expect(result.stdout).toContain('ANNOUNCEMENT_REACHED');
      expect(result.stdout).not.toContain('PRIVATE_CONFIGURATION');
      expect(result.stdout).not.toContain('OUTSIDE_CANDIDATE');
      expect(result.stderr).not.toContain('APPLICATION_CODE_MUST_NOT_EXECUTE');
      const commands = readFileSync(f.calls, 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x) as string[]);
      expect(commands[0]).toEqual(['rm', '-f', 'club-arena-engine-prewarm-42-1']);
      const run = commands[1];
      expect(run.slice(0, 12)).toEqual([
        'run',
        '--rm',
        '--pull',
        'never',
        '--name',
        'club-arena-engine-prewarm-42-1',
        '--restart',
        'no',
        '--network',
        'bridge',
        '--publish',
        '127.0.0.1::8080',
      ]);
      expect(run.slice(12, 16)).toEqual(['--entrypoint', 'node', f.image, '-e']);
      expect(run.at(-1)).toBe('/app');
      expect(run[16]).toContain('Buffer.alloc(64 * 1024)');
    } finally {
      f.cleanup();
    }
  });

  it('refuses a failed warm-up before announcing maintenance and retires only its own throwaway container', () => {
    const f = fixture(true);
    try {
      const result = f.run();
      expect(result.status).toBe(9);
      expect(result.stdout).not.toContain('ANNOUNCEMENT_REACHED');
      expect(result.stderr).toContain(
        'candidate filesystem warm-up did not finish before maintenance'
      );
      const commands = readFileSync(f.calls, 'utf8')
        .trim()
        .split('\n')
        .map((x) => JSON.parse(x) as string[]);
      expect(commands.at(-1)).toEqual(['rm', '-f', 'club-arena-engine-prewarm-42-1']);
    } finally {
      f.cleanup();
    }
  });

  it('refuses an incomplete candidate entrypoint before any maintenance announcement', () => {
    const f = fixture();
    try {
      rmSync(join(f.app, 'dist/index.js'));
      const result = f.run();
      expect(result.status).toBe(9);
      expect(result.stdout).not.toContain('ANNOUNCEMENT_REACHED');
    } finally {
      f.cleanup();
    }
  });

  it('refuses a linked entrypoint without reading outside the candidate', () => {
    const f = fixture();
    try {
      rmSync(join(f.app, 'dist/index.js'));
      symlinkSync(join(f.sandbox, 'outside-secret'), join(f.app, 'dist/index.js'));
      const result = f.run();
      expect(result.status).toBe(9);
      expect(result.stdout).not.toContain('ANNOUNCEMENT_REACHED');
    } finally {
      f.cleanup();
    }
  });

  it('refuses a deadline without a bounded preparation allowance before invoking Docker', () => {
    const f = fixture(false, 35);
    try {
      const result = f.run();
      expect(result.status).toBe(9);
      expect(result.stdout).not.toContain('ANNOUNCEMENT_REACHED');
      expect(existsSync(f.calls)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
