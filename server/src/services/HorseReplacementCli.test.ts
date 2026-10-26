import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
vi.mock('./HorseReplacementBatch.js', () => ({ replacePatternedHorses: vi.fn() }));
vi.mock('../hub/ChannelHub.js', () => ({ channelHub: { close: vi.fn() } }));
import {
  replacementExecutionMode,
  replacementLogSummary,
} from '../scripts/replaceRetiredHorses.js';
describe('finite replacement CLI modes', () => {
  it('keeps the original reservation identities out of public provider summaries', () => {
    const privateMap = [{ retiredHorseId: 'private-original', horseId: 'private-replacement' }];
    const result = {
      batch: 'patterned-retirement-20261006',
      mode: 'inspect',
      reserved: 62,
      replacements: privateMap,
      onboarded: 0,
      seated: false,
      club_funded: false,
    };
    const summary = replacementLogSummary(result);
    expect(summary).toEqual({
      batch: result.batch,
      mode: 'inspect',
      reserved: 62,
      onboarded: 0,
      seated: false,
      club_funded: false,
    });
    expect(JSON.stringify(summary)).not.toContain('private-');
    expect(result.replacements).toBe(privateMap);
  });
  it('defaults to a read-only inspection', () => {
    expect(replacementExecutionMode([])).toBe(false);
    expect(replacementExecutionMode(['--inspect'])).toBe(false);
  });
  it('only the exact one-shot execution argument creates the original reserved cohort', () => {
    expect(replacementExecutionMode(['--execute'])).toBe(true);
    for (const args of [
      ['--execute', '--execute'],
      ['--count', '1000'],
      ['--watch'],
      ['--loop'],
      ['--execute=true'],
    ])
      expect(() => replacementExecutionMode(args)).toThrow();
  });
});

/** Real entry point and imports, isolated service environment and local RPC only. */
async function runFiniteCli(url: string, args: string[], configured = true) {
  const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: '/dev/null',
    SUPABASE_URL: url,
    ...(configured ? { SUPABASE_SERVICE_ROLE_KEY: 'isolated-not-a-real-key' } : {}),
  };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/scripts/replaceRetiredHorses.ts', ...args],
    {
      cwd: serverRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }
  );
  let stdout = '',
    stderr = '',
    timedOut = false;
  child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s));
  child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s));
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  }, 5000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { exitCode, timedOut, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe('actual finite replacement process lifecycle', () => {
  it('exits after a rejected mode without any service call', async () => {
    const result = await runFiniteCli('http://127.0.0.1:1', ['--invalid']);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Use --inspect or --execute');
  });

  it('exits after a missing service environment without creating an identity', async () => {
    const result = await runFiniteCli('http://127.0.0.1:1', ['--inspect'], false);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('SUPABASE_SERVICE_ROLE_KEY is not set');
  });

  it('drains its successful private inspection and exits with the count-only result', async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(request.url ?? '');
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          batch: 'patterned-retirement-20261006',
          replacements: Array.from({ length: 62 }, (_, i) => ({
            retiredHorseId: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
            horseId: null,
          })),
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Local service address unavailable');
      const result = await runFiniteCli(`http://127.0.0.1:${address.port}`, ['--inspect']);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        batch: 'patterned-retirement-20261006',
        mode: 'inspect',
        reserved: 0,
        onboarded: 0,
        seated: false,
        club_funded: false,
      });
      expect(calls).toEqual(['/rest/v1/rpc/fn_reserve_patterned_horse_replacements']);
      expect(result.stdout).not.toContain('00000000-');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
