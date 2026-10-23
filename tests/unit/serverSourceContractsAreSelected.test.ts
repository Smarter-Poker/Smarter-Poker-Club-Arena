import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// PR #7780 (2026-10-23): a horse engine change fired a new telemetry key and the
// local pre-push stayed green, because `vitest related` only finds tests that
// IMPORT a changed file and the Horse data ledger law reads server source as
// text. Hosted CI caught it 35 minutes later. The hook now selects such laws
// by what the changed file contains.
const ROOT = join(__dirname, '..', '..');
const select = (...files: string[]) =>
  execFileSync('bash', [join(ROOT, 'scripts/server-source-contracts.sh'), ...files], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

describe('server source-contract laws are selected before a push', () => {
  it('selects the Horse data ledger law for any changed file that fires horse telemetry', () => {
    expect(select('src/engine/ServerTableEngineTurns.ts')).toBe(
      'src/engine/HorseDataLedger.test.ts'
    );
    expect(select('src/engine/HorseLogic.ts', 'src/engine/ServerTableEngineTurns.ts')).toBe(
      'src/engine/HorseDataLedger.test.ts'
    );
  });

  it('selects nothing for a file no source-contract law governs, or a deleted file', () => {
    expect(select('src/engine/HorseRiverNuts.ts')).toBe('');
    expect(select('src/engine/this-file-does-not-exist.ts')).toBe('');
  });

  it('the ledger law still reads every fired telemetry key from source', () => {
    const law = readFileSync(join(ROOT, 'server/src/engine/HorseDataLedger.test.ts'), 'utf8');
    expect(law).toMatch(/noteFire/);
  });

  it('the pre-push hook runs the selected laws and blocks on failure', () => {
    const hook = readFileSync(join(ROOT, '.husky/pre-push'), 'utf8');
    expect(hook).toContain('scripts/server-source-contracts.sh" $SRV_SRC');
    expect(hook).toMatch(/"\$SERVER_VITEST" run \$SRV_CONTRACTS/);
    expect(hook).toContain('BLOCKED: a source-contract law over your server change failed.');
  });
});
