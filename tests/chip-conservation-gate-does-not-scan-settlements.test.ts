import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('scripts/ci/check-chip-conservation.mjs', 'utf8');

describe('the live conservation gate stays off the settlement hot path', () => {
  it('proves the legal state set from the validated database constraint', () => {
    expect(source).toContain("c.conrelid = 'public.ca_settlements'::regclass");
    expect(source).toContain("c.conname = 'ca_settlements_state_check'");
    expect(source).toContain('stateRow.validated !== true');
    expect(source).toContain('constrainedStates.every');
    expect(source).not.toMatch(/SELECT\s+count\(\*\)\s+AS\s+n\s+FROM\s+public\.ca_settlements/i);
  });
});
