import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = readFileSync('server/scripts/legacy-engine-checkpoint.sh', 'utf8');
const guard = helper.slice(
  helper.indexOf("|| die 'invalid run key'\n") + "|| die 'invalid run key'\n".length,
  helper.indexOf('\nflock -n 9')
);

function probe(kind: 'alias' | 'canonical' | 'foreign' | 'closed' | 'missing') {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-lock-'));
  try {
    const real = join(directory, 'run-lock');
    const alias = join(directory, 'var-lock');
    mkdirSync(real);
    symlinkSync(real, alias);
    const lock = join(real, 'engine.lock');
    const foreign = join(real, 'foreign.lock');
    writeFileSync(lock, '');
    writeFileSync(foreign, '');
    const target = kind === 'foreign' ? foreign : lock;
    const descriptor = join(directory, 'descriptor-9');
    if (kind !== 'closed') symlinkSync(target, descriptor);
    // Linux exercises the actual inherited descriptor. Darwin has no procfs;
    // use a real filesystem link for its descriptor path and GNU readlink -e.
    const source =
      process.platform === 'linux'
        ? guard
        : guard.replace(/\/proc\/(?:self|\$\$)\/fd\/9/g, descriptor);
    const portableReadlink =
      process.platform === 'linux'
        ? ''
        : `
readlink() { "$CHECKPOINT_TEST_NODE" -e 'try { console.log(require("node:fs").realpathSync(process.argv[1])); } catch { process.exit(1); }' "$2"; }
`;
    return spawnSync(
      'bash',
      [
        '-c',
        `
set -euo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
${portableReadlink}
${kind === 'closed' ? 'exec 9<&-' : 'exec 9<"$CHECKPOINT_TEST_TARGET"'}
${source}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          ...process.env,
          CHECKPOINT_TEST_NODE: process.execPath,
          CHECKPOINT_TEST_TARGET: target,
          ENGINE_LOCK_FILE:
            kind === 'missing'
              ? join(real, 'absent.lock')
              : kind === 'canonical'
                ? realpathSync(lock)
                : join(alias, 'engine.lock'),
        },
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the checkpoint recognizes the same inherited engine lock', () => {
  it.each(['alias', 'canonical'] as const)('accepts its actual lock through a %s path', (kind) => {
    const result = probe(kind);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['foreign', 'closed', 'missing'] as const)(
    'refuses a %s lock before native invocation',
    (kind) => {
      const result = probe(kind);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('owning engine lock descriptor missing');
    }
  );
});
