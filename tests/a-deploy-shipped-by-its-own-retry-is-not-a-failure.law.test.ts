import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A DEPLOY SHIPPED BY ITS OWN RETRY IS NOT A FAILED DEPLOY (2026-10-23).
 * Attempt row 1166 (run 39902613436-1) was a safe refusal that row 1167
 * (attempt 2, same SHA) shipped an hour later; the digest still reported
 * "1 engine deploy attempts did not ship".
 */
const SQL = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261023140557_a_deploy_shipped_by_its_own_retry_is_not_a_failed_deploy.sql'
  ),
  'utf8'
);

describe('the daily digest counts a refused attempt that its retry shipped as shipped', () => {
  it('is one transaction with a live proof', () => {
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL).toContain('@live-proof:');
  });

  it('matches only the same exact target that shipped later within twelve hours', () => {
    expect(SQL).toContain('z.target_sha = x.target_sha');
    expect(SQL).toContain('z.shipped');
    expect(SQL).toContain('z.at > x.at');
    expect(SQL).toContain("z.at <= x.at + interval '12 hours'");
    expect(SQL).toContain('a.shipped OR a.superseded OR a.retried');
  });

  it('refuses rather than guessing when the rewritten expression moved', () => {
    expect(SQL).toContain('RAISE EXCEPTION');
    expect(SQL).toContain("position('AS retried' IN v_def) > 0");
  });
});
