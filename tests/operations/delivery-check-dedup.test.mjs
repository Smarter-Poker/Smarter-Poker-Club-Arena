import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const hook = readFileSync(new URL('../../.husky/pre-push', import.meta.url), 'utf8');
const gate = hook.split('# BEGIN TARGETED CLIENT PREFLIGHT')[1].split('# END TARGETED CLIENT PREFLIGHT')[0];
for (const failure of [false, true]) {
  test(`already executed contracts are excluded only from the related pass; failure=${failure}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-dedup-'));
    try {
      for (const [file, body] of Object.entries({
        'tests/shared.test.ts': "// reads widget.ts and imports its implementation\n",
        'tests/other.test.ts': '// other source contract for widget.ts\n',
        'src/widget.ts': 'export const widget = 1;\n',
        'node_modules/.bin/vitest': `#!${process.execPath}\nimport('node:fs').then(fs => { fs.appendFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(process.env.FAIL_DIRECT === 'true' && process.argv[2] === 'run' ? 1 : 0); });\n`,
      })) {
        const target = join(dir, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body, { mode: file.endsWith('/vitest') ? 0o755 : 0o644 });
      }
      const result = spawnSync('bash', ['-c', `set -e\nFAIL=0\n${gate}\nexit "$FAIL"`], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, CA_TREE_TOP: dir, CLIENT_DEPENDENCY_MODE: 'local',
          FILES: 'tests/shared.test.ts src/widget.ts', TRACE: join(dir, 'trace'), FAIL_DIRECT: String(failure) },
      });
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      const [direct, related] = readFileSync(join(dir, 'trace'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(direct, ['run', 'tests/other.test.ts', 'tests/shared.test.ts']);
      assert.deepEqual(related, ['related', '--run', 'src/widget.ts', '--exclude', 'tests/other.test.ts', '--exclude', 'tests/shared.test.ts', '--passWithNoTests']);
      assert.ok(!related.includes('tests/'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('invalid cash qualification pins stop before expensive test execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-input-preflight-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/bash\necho yes\n', { mode: 0o755 });
    writeFileSync(join(bin, 'python3'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    const start = hook.indexOf('CASH_INPUT_CHANGED=');
    const end = hook.indexOf('# BEGIN TARGETED CLIENT PREFLIGHT', start);
    const result = spawnSync('bash', ['-c', 'set -e\nFAIL=0\n' + hook.slice(start, end) + '\necho EXPENSIVE_TESTS_STARTED'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, FILES: '.github/workflows/ci.yml' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /cash qualification input checks failed/);
    assert.doesNotMatch(result.stdout, /EXPENSIVE_TESTS_STARTED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const serverGate = hook.slice(hook.indexOf('SERVER_VITEST='), hook.indexOf('\nif [ "$FAIL" -ne 0 ]; then'));
for (const failure of [false, true]) {
  test(`workflow edits execute server readers once and propagate failure=${failure}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'server-workflow-reader-'));
    try {
      for (const [file, body] of Object.entries({
        'server/package.json': '{}',
        '.github/workflows/ci.yml': 'jobs: {}',
        'server/src/reader.test.ts': '// reads ci.yml and widget.ts\n',
        'server/src/unrelated.test.ts': '// unrelated fixture\n',
        'server/src/widget.ts': 'export const widget = 1;\n',
        'server/node_modules/.bin/vitest': `#!${process.execPath}\nimport('node:fs').then(fs => { fs.appendFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(process.env.FAIL_DIRECT === 'true' && process.argv[2] === 'run' ? 1 : 0); });\n`,
      })) {
        const target = join(dir, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body, { mode: file.endsWith('/vitest') ? 0o755 : 0o644 });
      }
      for (const files of ['.github/workflows/ci.yml', '.github/workflows/ci.yml server/src/reader.test.ts server/src/widget.ts']) {
        const trace = join(dir, 'trace');
        rmSync(trace, { force: true });
        const result = spawnSync('bash', ['-c', `set -e\nFAIL=0\n${serverGate}\nexit "$FAIL"`], {
          cwd: dir, encoding: 'utf8', env: { ...process.env, CA_TREE_TOP: dir, SERVER_DEPENDENCY_MODE: 'local', FILES: files, TRACE: trace, FAIL_DIRECT: String(failure) },
        });
        assert.equal(result.status, failure ? 1 : 0, result.stderr);
        const calls = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(calls[0], ['run', 'src/reader.test.ts']);
        assert.equal(calls.length, files.includes('widget.ts') ? 2 : 1);
        if (calls.length === 2) assert.deepEqual(calls[1], ['related', '--run', 'src/widget.ts', '--exclude', 'src/reader.test.ts', '--passWithNoTests']);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
