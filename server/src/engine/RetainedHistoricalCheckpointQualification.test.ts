import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Existing required server shards execute this exact historical-owner proof.
// The driver has one 120s total budget; the process gets 30s cleanup headroom,
// and this enclosing assertion gets another 30s to report a named failure.
// These isolated test bounds do not change any production cutover reserve.
it('qualifies the exact deployed EED owners before admitting the retained-original checkpoint', () => {
  const driver = fileURLToPath(
    new URL('../../scripts/qualification/retained-original-checkpoint/qualify.mjs', import.meta.url)
  );
  const result = spawnSync(process.execPath, [driver], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 150_000,
    maxBuffer: 128 * 1024,
    env: { ...process.env },
  });
  expect(result.error?.message ?? null, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({
    schema: 'exact-eed-checkpoint-qualification/v1',
    readOnlyProduction: true,
    historicalRevision: 'eed06fe51dea622069c661a6213d5b031ff3a9e3',
    status: 'passed',
    actualTests: 19,
    passedTests: 19,
  });
  expect(receipt.pins).toHaveLength(24);
  expect(new Set(receipt.pins.map((row: { path: string }) => row.path)).size).toBe(24);
  expect(receipt.guardSha256).toMatch(/^[0-9a-f]{64}$/);
}, 180_000);
