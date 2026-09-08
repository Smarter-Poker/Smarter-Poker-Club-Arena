import { execFileSync } from 'node:child_process';
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
    const files = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
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
