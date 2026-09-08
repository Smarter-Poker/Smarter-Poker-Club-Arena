import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SECRET = /sb_secret_[A-Za-z0-9_-]+/g;
const SYNTHETIC =
  /^sb_secret_(?:test|example|placeholder|current|certification)(?:[_-][A-Za-z0-9_-]+)?$/;

describe('a Supabase server credential is never source code', () => {
  it('distinguishes explicit test fixtures from production-shaped literals', () => {
    expect(SYNTHETIC.test('sb_secret_certification')).toBe(true);
    expect(SYNTHETIC.test('sb_secret_current')).toBe(true);
    expect(SYNTHETIC.test(`sb_secret_${'A'.repeat(40)}`)).toBe(false);
  });

  it('contains no literal production-shaped sb_secret key in a tracked file', () => {
    const root = resolve(process.cwd());
    // Ask Git to identify the tiny candidate set instead of decoding every
    // tracked binary and source file in every Vitest shard. The full-tree
    // scan used to cross the test timeout under CI contention and turn a
    // security law into a nondeterministic collection failure.
    const scan = spawnSync(
      'git',
      ['grep', '-I', '-l', '-z', '-E', 'sb_secret_[A-Za-z0-9_-]+', '--'],
      {
        cwd: root,
        encoding: 'utf8',
      }
    );
    if (scan.status !== 0 && scan.status !== 1) {
      throw new Error(`git grep could not inspect tracked sources (status ${String(scan.status)})`);
    }
    const files = (scan.stdout ?? '').split('\0').filter(Boolean);
    const violations: string[] = [];

    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(resolve(root, file), 'utf8');
      } catch {
        continue;
      }
      for (const match of source.matchAll(SECRET)) {
        if (!SYNTHETIC.test(match[0])) violations.push(file);
      }
    }

    expect([...new Set(violations)]).toEqual([]);
  });
});
