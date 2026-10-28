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
