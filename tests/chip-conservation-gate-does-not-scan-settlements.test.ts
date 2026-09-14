import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('scripts/ci/check-chip-conservation.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/production-integrity-audit.yml', 'utf8');

describe('the live conservation gate stays off the settlement hot path', () => {
  it('proves the legal state set from the validated database constraint', () => {
    expect(source).toContain("c.conrelid = 'public.ca_settlements'::regclass");
    expect(source).toContain("c.conname = 'ca_settlements_state_check'");
    expect(source).toContain('stateRow.validated !== true');
    expect(source).toContain('constrainedStates.every');
    expect(source).not.toMatch(/SELECT\s+count\(\*\)\s+AS\s+n\s+FROM\s+public\.ca_settlements/i);
  });

  it('has an automated production reader that fails closed when live proof is unavailable', () => {
    expect(workflow).toContain('node scripts/ci/check-chip-conservation.mjs');
    expect(workflow).toContain("REQUIRE_LIVE: '1'");
    expect(workflow).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(source).toContain("process.env.REQUIRE_LIVE === '1'");
    expect(source).toContain('if (requireLive) bad(');
  });
});
