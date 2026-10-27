/** Transport/source-boundary controls. Real worker/hand acceptance lives in
 * v56Counterfactual.test.ts; these controls do not certify production captures. */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exactReplayChildEnv,
  v56GitEnv,
  v56ExecutingSource,
  v56CasesAreBounded,
  replayV56InFreshProcess,
  writeV56Output,
} from '../../../../scripts/phase15-exact-replay.mjs';
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/phase15-exact-replay.mjs'
);
const owned = [];
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
const caseInput = { decisionSha256: 'a'.repeat(64), records: [] };
const fixtureResult = () => ({
  version: 'horse-v56-private-counterfactual-v1',
  reason: 'case_unbound',
  decisionSha256: null,
  readFrameSha256: null,
  onActionSha256: null,
  offActionSha256: null,
  originalExact: false,
  originalAccepted: false,
  v56Observed: false,
  offComputed: false,
  sameAdmissions: false,
  actionChanged: false,
  offAccepted: false,
  activationAllowed: false,
});
const wire = () => ({
  version: 'horse-v56-private-process-v1',
  status: 'computed',
  result: fixtureResult(),
  isolation: { pid: 123, networkAttempts: { fetch: 0, socket: 0 } },
});
function fakeSpawn(effect) {
  return (_node, argv, options) => {
    const proc = new EventEmitter();
    Object.assign(proc, {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => effect(proc, argv, options));
    return proc;
  };
}
describe('existing P15 private V56 adapter boundary', () => {
  it('keeps the closed case/record/byte limits', () => {
    expect(v56CasesAreBounded({ version: 1, cases: [caseInput] })).toBe(true);
    expect(v56CasesAreBounded({ version: 1, cases: Array(7).fill(caseInput) })).toBe(false);
    expect(
      v56CasesAreBounded({ version: 1, cases: [{ ...caseInput, records: Array(257).fill({}) }] })
    ).toBe(false);
    expect(
      v56CasesAreBounded({
        version: 1,
        cases: [{ ...caseInput, records: ['x'.repeat(8 * 1024 * 1024)] }],
      })
    ).toBe(false);
    expect(v56CasesAreBounded({ version: 1, cases: [caseInput], run: 'arbitrary' })).toBe(false);
  });
  it('binds a clean physical repository despite inherited Git-local/config spoofing', () => {
    const root = mkdtempSync(join(tmpdir(), 'v56-source-'));
    owned.push(root);
    mkdirSync(join(root, 'server'));
    const env = v56GitEnv();
    const git = (args) =>
      execFileSync('git', args, {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init']);
    writeFileSync(join(root, 'server', 'source.txt'), 'synthetic clean-source control\n');
    git(['add', 'server']);
    git([
      '-c',
      'user.name=V56 Test',
      '-c',
      'user.email=v56@example.invalid',
      'commit',
      '-m',
      'synthetic adapter source control',
    ]);
    const sha = git(['rev-parse', 'HEAD']);
    expect(
      v56ExecutingSource(root, {
        ...process.env,
        GIT_DIR: '/does/not/exist',
        GIT_WORK_TREE: '/wrong',
        GIT_INDEX_FILE: '/wrong',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'alias.status',
        GIT_CONFIG_VALUE_0: '!echo forged',
      })
    ).toBe(sha);
    writeFileSync(join(root, 'README-untracked.txt'), 'dirty outside server');
    expect(() => v56ExecutingSource(root)).toThrow('v56_source_unavailable');
    rmSync(join(root, 'README-untracked.txt'));
    expect(v56ExecutingSource(root)).toBe(sha);
    writeFileSync(join(root, 'server', 'source.txt'), 'dirty');
    expect(() => v56ExecutingSource(root)).toThrow('v56_source_unavailable');
  });
  it('runs a fresh scrubbed child command and validates its entire sanitized envelope', async () => {
    const spawn = fakeSpawn((proc, argv, options) => {
      expect(argv).toContain('--v56-child');
      expect(argv).toContain('--v56-cases');
      expect(options.env).toEqual(exactReplayChildEnv(process.env));
      expect(options.env).not.toHaveProperty('NODE_OPTIONS');
      expect(options.env).not.toHaveProperty('GIT_DIR');
      proc.stdout.end(JSON.stringify(wire()));
      proc.emit('close', 0);
    });
    expect(
      (await replayV56InFreshProcess({ caseInput, runningSource: '5'.repeat(40) }, { spawn }))
        .status
    ).toBe('computed');
  });
  it.each([
    'extra_output',
    'stdout_overflow',
    'stderr_overflow',
    'timeout',
    'raw_error',
    'network_attempt',
    'mismatched_pid',
  ])('fails closed without child data: %s', async (fault) => {
    const spawn = fakeSpawn((proc) => {
      if (fault === 'timeout') return;
      if (fault === 'stdout_overflow') proc.stdout.write('private'.repeat(10000));
      else if (fault === 'stderr_overflow') proc.stderr.write('private'.repeat(10000));
      else if (fault === 'raw_error') {
        proc.stderr.write('PRIVATE_RECORD_MUST_NOT_ESCAPE');
        proc.emit('close', 1);
        return;
      } else {
        const value = wire();
        if (fault === 'extra_output') value.privateCards = ['secret'];
        else if (fault === 'mismatched_pid') value.isolation.pid = 124;
        else value.isolation.networkAttempts.fetch = 1;
        proc.stdout.write(JSON.stringify(value));
      }
      proc.emit('close', 0);
    });
    const out = await replayV56InFreshProcess(
      { caseInput, runningSource: '5'.repeat(40) },
      { spawn, deadlineMs: 20 }
    );
    expect(out.status).toBe('unavailable');
    expect(Object.keys(out).sort()).toEqual(['reason', 'status', 'version']);
    expect(JSON.stringify(out)).not.toMatch(/PRIVATE_RECORD_MUST_NOT_ESCAPE|secret|privateCards/);
    expect(out.reason).toBe(
      fault.endsWith('overflow')
        ? 'child_output_bounds'
        : fault === 'timeout'
          ? 'child_deadline'
          : 'child_unavailable'
    );
  });
  it('preserves the actual legacy exact child and its network refusal boundary', () => {
    const run = spawnSync(
      process.execPath,
      [script, '--child', '--running-source', '5'.repeat(40)],
      {
        input: JSON.stringify({ record: null }),
        encoding: 'utf8',
        env: exactReplayChildEnv(),
        timeout: 30000,
      }
    );
    expect(run.status, run.stderr).toBe(0);
    const value = JSON.parse(run.stdout.trim().split('\n').pop());
    expect(value.outcome).toBe('non_replayable:record');
    expect(value).not.toHaveProperty('v56PressureRangeFires');
    expect(value.isolation.networkAttempts).toEqual({ fetch: 0, socket: 0 });
  });
  it('does not exit before a receipt larger than one pipe write is acknowledged', () => {
    const exits = [];
    let callback;
    let line;
    writeV56Output(
      { results: [wire(), wire()] },
      0,
      {
        write: (value, done) => {
          line = value;
          callback = done;
        },
      },
      (code) => exits.push(code)
    );
    expect(Buffer.byteLength(line)).toBeGreaterThan(512);
    expect(exits).toEqual([]);
    callback();
    expect(exits).toEqual([0]);
    writeV56Output(
      { status: 'unavailable' },
      0,
      { write: (_value, done) => done(Error('synthetic pipe error')) },
      (code) => exits.push(code)
    );
    expect(exits).toEqual([0, 1]);
  });
  it('actual CLI emits only closed errors for malformed/forbidden input', () => {
    for (const [args, input, reason] of [
      [
        ['--v56-cases', '--full-verdicts', '/must-not-write'],
        JSON.stringify({ version: 1, cases: [caseInput] }),
        'arguments',
      ],
      [['--v56-cases'], '{"raw_cards":"do_not_print"', 'input_bounds'],
      [['--v56-cases', '--unknown'], '{}', 'unavailable'],
    ]) {
      const run = spawnSync(process.execPath, [script, ...args], {
        input,
        encoding: 'utf8',
        env: exactReplayChildEnv(),
        timeout: 10000,
      });
      expect(run.stderr).toBe('');
      const value = JSON.parse(run.stdout);
      expect(value.status).toBe('unavailable');
      expect(run.status).toBe(1);
      expect(run.status).toBe(1);
      expect(value.reason).toBe(reason);
      expect(run.stdout).not.toContain('do_not_print');
    }
  });
});
