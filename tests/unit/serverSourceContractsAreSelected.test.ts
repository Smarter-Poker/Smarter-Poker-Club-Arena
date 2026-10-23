import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// PR #7780 (2026-10-23): a horse engine change fired a new telemetry key and the
// local pre-push stayed green, because `vitest related` only finds tests that
// IMPORT a changed file and the Horse data ledger law reads server source as
// text. Hosted CI caught it 35 minutes later. The hook now selects such laws by
// what the changed file contains. This runs the hook's real server gate.
const ROOT = join(__dirname, '..', '..');
const hook = readFileSync(join(ROOT, '.husky/pre-push'), 'utf8');
const marker = '\nSERVER_VITEST="$CA_TREE_TOP/server/node_modules/.bin/vitest"';
const serverGate = hook.slice(hook.indexOf(marker));

function gate(files: Record<string, string>, runnerExit = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ca-source-contracts-')));
  try {
    writeFileSync(join(dir, 'server-package'), '');
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'server/package.json'), '{}');
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), body);
    }
    const runner = join(dir, 'server/node_modules/.bin/vitest');
    mkdirSync(dirname(runner), { recursive: true });
    writeFileSync(
      runner,
      '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE"\n' +
        'case "$*" in *HorseDataLedger*) exit "$CONTRACT_EXIT";; esac\nexit 0\n',
      { mode: 0o755 }
    );
    const trace = join(dir, 'trace');
    const result = spawnSync('bash', ['-c', 'set -e\nFAIL=0\n' + serverGate], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        CA_TREE_TOP: dir,
        FILES: Object.keys(files).join('\n'),
        SERVER_DEPENDENCY_MODE: 'local',
        TRACE: trace,
        CONTRACT_EXIT: String(runnerExit),
      },
    });
    let calls = '';
    try {
      calls = readFileSync(trace, 'utf8');
    } catch {
      calls = '';
    }
    return { status: result.status, output: result.stdout + result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('server source-contract laws are selected before a push', () => {
  it('runs the Horse data ledger law for a changed file that fires horse telemetry', () => {
    const r = gate({ 'server/src/engine/Turns.ts': "noteFire('a_new_key');\n" });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('run src/engine/HorseDataLedger.test.ts');
    expect(r.calls).toContain('related --run src/engine/Turns.ts');
  });

  it('blocks the push when that law fails', () => {
    const r = gate({ 'server/src/engine/Turns.ts': "noteFire('a_new_key');\n" }, 1);
    expect(r.status).toBe(1);
    expect(r.output).toContain('BLOCKED: a source-contract law over your server change failed.');
  });

  it('adds nothing for a server file that fires no telemetry', () => {
    const r = gate({ 'server/src/engine/Rules.ts': 'export const x = 1;\n' });
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain('HorseDataLedger');
  });

  it('the ledger law still reads every fired telemetry key from source', () => {
    const law = readFileSync(join(ROOT, 'server/src/engine/HorseDataLedger.test.ts'), 'utf8');
    expect(law).toMatch(/noteFire/);
  });
});
