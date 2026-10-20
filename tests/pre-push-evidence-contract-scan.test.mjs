import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Execute the maintained selector against real files; no publisher is invoked.
test('repeated shard filenames retain direct, deleted-path and Node contracts with bounded scans', () => {
  assert.ok(process.env.TMPDIR, 'an owned external TMPDIR is required');
  const dir = mkdtempSync(join(process.env.TMPDIR, 'contract-scan-'));
  try {
    for (const path of ['tests', 'server/src', 'bin'])
      mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, 'tests/manifest.test.ts'), "const input = 'manifest.json';\n");
    writeFileSync(join(dir, 'tests/removed.test.ts'), "const input = 'removed.json';\n");
    writeFileSync(join(dir, 'tests/direct.test.ts'), '// changed test\n');
    writeFileSync(
      join(dir, 'tests/runner.test.mjs'),
      "import 'node:test'; const input = 'runner.json';\n"
    );
    writeFileSync(join(dir, 'server/src/sample.ts'), 'export const sample = 1;\n');
    const log = join(dir, 'scans');
    writeFileSync(
      join(dir, 'bin/grep'),
      '#!/bin/sh\nif [ "$1" = "-rl" ]; then printf "scan\\n" >> "$TEST_SCAN_LOG"; fi\nexec /usr/bin/grep "$@"\n',
      { mode: 0o755 }
    );
    const hook = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8');
    const start = hook.indexOf('CHANGED_TESTS=""');
    const end = hook.indexOf('if [ -n "$CHANGED_TESTS$CHANGED_SRC$NODE_TESTS" ]; then', start);
    assert.ok(start >= 0 && end > start);
    const files = Array.from(
      { length: 400 },
      (_, i) => `evidence/shard-${i}/manifest.json evidence/shard-${i}/runner.json`
    );
    files.push('deleted/removed.json', 'server/src/sample.ts', 'tests/direct.test.ts');
    const output = execFileSync(
      'bash',
      [
        '-c',
        hook.slice(start, end) +
          '\nprintf "TS=%s\\nSRC=%s\\nNODE=%s\\n" "$CHANGED_TESTS" "$CHANGED_SRC" "$NODE_TESTS"',
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          FILES: files.join(' '),
          TEST_SCAN_LOG: log,
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        },
        encoding: 'utf8',
      }
    );
    assert.match(output, /tests\/direct\.test\.ts/);
    assert.match(output, /tests\/manifest\.test\.ts/);
    assert.match(output, /tests\/removed\.test\.ts/);
    assert.match(output, /SRC= server\/src\/sample\.ts/);
    assert.match(output, /NODE=tests\/runner\.test\.mjs/);
    assert.equal(
      readFileSync(log, 'utf8').trim().split('\n').length,
      10,
      'two scans for each of five distinct basenames'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
