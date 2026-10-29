import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const script = resolve(__dirname, '../../scripts/ci/inspect-tournament-refill.py');
const table = '12345678-abcd-4321-abcd-123456789abc',
  lease = '22345678-abcd-4321-abcd-123456789abc';
const input = {
  version: 5,
  sourceRelease: 'a'.repeat(40),
  probe: 'cash_turn_fold',
  cases: [
    {
      handKey: createHash('sha256').update(`${table}:123:${lease}`).digest('hex'),
      tableId: table,
      handId: '32345678-abcd-4321-abcd-123456789abc',
      handNumber: 123,
      leaseGeneration: lease,
      decisionRecordSha256: null,
      actorId: '20000000-0000-4000-8000-000000000001',
      seat: 1,
      actionOrdinal: 14,
    },
  ],
};
it('admits only the closed original cash-turn-fold selector, preserving its full-list ordinal', () => {
  const run = (value: unknown) =>
    spawnSync('python3', ['-B', script, '--encode-reference-cases', input.sourceRelease], {
      input: JSON.stringify(value),
      encoding: 'utf8',
      timeout: 5000,
    });
  const good = run(input);
  expect(good.status, good.stderr).toBe(0);
  expect(JSON.parse(Buffer.from(good.stdout.trim(), 'base64').toString())).toEqual(input);
  for (const bad of [
    { ...input, sourceRelease: 'b'.repeat(40) },
    { ...input, probe: 'private-secret' },
    { ...input, cases: [{ ...input.cases[0], seat: 0 }] },
    { ...input, cases: [{ ...input.cases[0], actorId: 'private-secret' }] },
    { ...input, cases: [{ ...input.cases[0], actionOrdinal: -1 }] },
    { ...input, cases: [{ ...input.cases[0], handKey: '0'.repeat(64) }] },
    { ...input, cases: [{ ...input.cases[0], cards: ['private-secret'] }] },
    { ...input, cases: Array(7).fill(input.cases[0]) },
  ]) {
    const r = run(bad);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('private-secret');
  }
});
