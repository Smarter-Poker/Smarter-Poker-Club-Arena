import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Ubuntu browser dependency mirror', () => {
  it('changes only active Azure Ubuntu URIs, preserves trust and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ca-apt-mirror-'));
    try {
      mkdirSync(join(root, 'sources.list.d'));
      const legacy = join(root, 'sources.list');
      const modern = join(root, 'sources.list.d', 'ubuntu.sources');
      const unrelated = join(root, 'sources.list.d', 'other.list');
      writeFileSync(
        legacy,
        '# http://azure.archive.ubuntu.com/ubuntu\ndeb [signed-by=/key] http://azure.archive.ubuntu.com/ubuntu/ noble main\n'
      );
      writeFileSync(
        modern,
        'Types: deb\nURIs: https://azure.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
      );
      const other =
        'deb https://example.com/ubuntu noble main\ndeb https://azure.archive.ubuntu.com/ubuntu-extra noble main\n';
      writeFileSync(unrelated, other);
      const run = () =>
        execFileSync('python3', ['scripts/ci/ubuntu-apt-mirror.py', '--root', root], {
          encoding: 'utf8',
        });
      expect(run()).toContain('updated 2 source files');
      expect(readFileSync(legacy, 'utf8')).toBe(
        '# http://azure.archive.ubuntu.com/ubuntu\ndeb [signed-by=/key] https://archive.ubuntu.com/ubuntu/ noble main\n'
      );
      expect(readFileSync(modern, 'utf8')).toBe(
        'Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
      );
      expect(readFileSync(unrelated, 'utf8')).toBe(other);
      expect(run()).toContain('updated 0 source files');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing source directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ca-apt-mirror-'));
    try {
      expect(() =>
        execFileSync('python3', ['scripts/ci/ubuntu-apt-mirror.py', '--root', root], {
          stdio: 'pipe',
        })
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
