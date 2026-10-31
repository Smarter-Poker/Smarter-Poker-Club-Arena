import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const root = 'scripts/ci/fixtures/tournament-quality-bounded-evidence/';
const read = (name: string) => readFileSync(root + name, 'utf8');
type Owner = {
  definition: string;
  metadata: { proname: string; prosrc: string; [key: string]: unknown };
};

describe('the original tournament quality owner consumes bounded evidence', () => {
  it('preserves every owner property except the one intended body', () => {
    const before: Owner[] = JSON.parse(read('owners41-before.json'));
    const after: Owner[] = JSON.parse(read('owners41-after.json'));
    expect(before).toHaveLength(41);
    expect(after).toHaveLength(41);
    const changes = before.flatMap((owner, index) =>
      JSON.stringify(owner) === JSON.stringify(after[index]) ? [] : [[owner, after[index]]]
    );
    expect(changes).toHaveLength(1);
    const [oldOwner, newOwner] = changes[0];
    expect(oldOwner.metadata.proname).toBe('fn_accounting_tournament_week_quality');
    const { prosrc: oldBody, ...oldMetadata } = oldOwner.metadata;
    const { prosrc: newBody, ...newMetadata } = newOwner.metadata;
    expect(oldBody).not.toEqual(newBody);
    expect(newMetadata).toEqual(oldMetadata);
  });
  it('pins the independently canonicalized public candidate without a diagnostic GUC', () => {
    const candidate = read('candidate.sql');
    expect(createHash('md5').update(candidate).digest('hex')).toBe(
      'ba40f5f1f0aedf382134f246e8297e26'
    );
    expect(candidate).not.toContain('FIRST_ROW');
    expect(candidate).not.toContain('RAISE NOTICE');
    expect(candidate).toContain(
      'AND NOT (COALESCE(octet_length(pg_catalog.jsonb_send(r.metadata)),0)::bigint'
    );
  });
  it('runs the new atomic/permission qualification in the existing accounting floor', () => {
    const floor = readFileSync('scripts/ci/test_launch_reset_floor.py', 'utf8');
    expect(floor).toContain('test-tournament-quality-bounded-evidence-postgres.py');
    expect(floor).toContain('test-rake-record-bounded-cover-postgres.py');
    expect(floor).toContain('test-original-linked-cash-spgist-postgres.py');
  });
});
