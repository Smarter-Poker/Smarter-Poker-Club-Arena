import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const RESOLVER = resolve(ROOT, 'scripts/ops/lib/resolve-staged-or-promoted-migration.sh');
const fixtures: string[] = [];
const zshAvailable = spawnSync('zsh', ['--version'], { stdio: 'ignore' }).status === 0;
const zshIt = zshAvailable ? it : it.skip;

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'migration-resolver-shell-'));
  fixtures.push(directory);
  writeFileSync(join(directory, '20260909190000_exact_release.sql.pending'), '-- held\n');
  return directory;
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

describe('the staged migration resolver is safe in every supported caller shell', () => {
  const expectExactResolution = (shell: 'bash' | 'zsh') => {
    const directory = fixture();
    const output = execFileSync(
      shell,
      [
        '-c',
        'source "$1"; resolve_staged_or_promoted_migration "$2" exact_release',
        'migration-resolver-test',
        RESOLVER,
        directory,
      ],
      { encoding: 'utf8' }
    ).trim();

    expect(output).toBe(join(directory, '20260909190000_exact_release.sql.pending'));
  };

  const expectAmbiguityRefusal = (shell: 'bash' | 'zsh') => {
    const directory = fixture();
    writeFileSync(join(directory, '20260909190001_exact_release.sql'), '-- promoted duplicate\n');

    expect(() =>
      execFileSync(
        shell,
        [
          '-c',
          'source "$1"; resolve_staged_or_promoted_migration "$2" exact_release',
          'migration-resolver-test',
          RESOLVER,
          directory,
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      )
    ).toThrow();
  };

  it('resolves the one exact file when sourced by bash', () => {
    expectExactResolution('bash');
  });

  zshIt('resolves the one exact file when sourced by zsh', () => {
    expectExactResolution('zsh');
  });

  it('refuses ambiguous staged and promoted copies when sourced by bash', () => {
    expectAmbiguityRefusal('bash');
  });

  zshIt('refuses ambiguous staged and promoted copies when sourced by zsh', () => {
    expectAmbiguityRefusal('zsh');
  });
});
