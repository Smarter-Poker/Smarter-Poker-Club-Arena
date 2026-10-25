/** Actual finite entrypoints: no dependency mocks, live services or inherited
 * credentials. Natural exit is part of the command contract. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const server = fileURLToPath(new URL('../../../', import.meta.url));
const scripts = [
  'horseAcceptedWindow',
  'horseCorrectiveKernelIssue',
  'horseCorrectiveKernelReview',
  'horsePrivateJournalExport',
  'horseRiverAcceptedOracle',
  'horseRiverReference',
] as const;
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function scratch() {
  const path = mkdtempSync(
    join(
      process.platform === 'darwin' ? resolve(server, '../../tmp') : tmpdir(),
      'horse-cli-lifecycle-'
    )
  );
  directories.push(path);
  return path;
}
function execute(args: string[], input = '', extra: Record<string, string> = {}) {
  const directory = scratch();
  return spawnSync(process.execPath, ['--import', 'tsx', ...args], {
    cwd: server,
    input,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 512 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: directory,
      TMPDIR: directory,
      LANG: 'C',
      TZ: 'UTC',
      NODE_ENV: 'test',
      TSX_DISABLE_CACHE: '1',
      EQUITY_GOVERNOR: 'off',
      SUPABASE_URL: 'https://supabase.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'cli-offline-placeholder',
      ...extra,
    },
  });
}
describe('finite Phase14 operator subprocess lifecycle', () => {
  it.each(scripts)('%s invalid arguments terminate naturally with exit 64', (script) => {
    const result = execute(['src/scripts/' + script + '.ts', 'invalid']);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(64);
    if (script !== 'horsePrivateJournalExport') expect(result.stdout).toMatch(/Usage:/);
    else expect(result.stdout).toBe('');
  });
  it('terminates unavailable private export without querying an unconfigured source', () => {
    const result = execute(
      ['src/scripts/horsePrivateJournalExport.ts'],
      JSON.stringify({ version: 1, handKeys: [] })
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
  });
  it('flushes the complete metadata-only export and exits without a journal read', () => {
    const directory = scratch();
    const result = execute(
      ['src/scripts/horsePrivateJournalExport.ts'],
      JSON.stringify({ version: 1, handKeys: [] }),
      { HORSE_DECISION_JOURNAL_DIR: directory, GIT_COMMIT_SHA: 'a'.repeat(40) }
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      status: 'canonical_journal_export',
      sourceRelease: 'a'.repeat(40),
      recordsByHand: [],
    });
  });
  it('preserves the existing referenced hub interval when helpers are imported', () => {
    const code = `import assert from 'node:assert/strict';
      const {channelHub}=await import('./src/hub/ChannelHub.ts');
      const before=Reflect.get(channelHub,'lobbyInterval');
      assert.ok(before?.hasRef());
      for(const script of ${JSON.stringify(scripts)}) await import('./src/scripts/'+script+'.ts');
      assert.equal(Reflect.get(channelHub,'lobbyInterval'),before);
      assert.equal(before.hasRef(),true);
      channelHub.close();
      process.stdout.write('engine-import-interval-preserved\\n');`;
    const result = execute(['--input-type=module', '--eval', code]);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('engine-import-interval-preserved');
  });
});
