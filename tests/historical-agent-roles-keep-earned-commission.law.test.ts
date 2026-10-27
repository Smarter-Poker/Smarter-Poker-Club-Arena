import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const text = (p: string) => readFileSync(p, 'utf8');
const migration = text(
  'supabase/migrations/20261027070115_historical_agent_roles_keep_their_earned_commission.sql'
);
describe('historical earned roles preserve their original commission', () => {
  it('changes only weekly role constancy, never source identity or monetary routing', () => {
    const original = text(
      'supabase/migrations/20261027034254_existing_player_transfers_discharge_the_same_week_once.sql'
    );
    for (const name of [
      'fn_settle_accounting_commission_stage',
      'fn_settle_accounting_commission_stage_v3',
    ]) {
      const re = new RegExp(
        'CREATE OR REPLACE FUNCTION public\\.' + name + '\\(.*?END \\$function\\$;',
        's'
      );
      const before = original.match(re)![0];
      const after = migration.match(re)![0];
      expect(after).toBe(before.replace(' OR count(DISTINCT role)<>1', ''));
      expect(after).toContain('count(DISTINCT agent_id)<>1');
    }
    expect(migration).not.toContain("OR min(e->>'role_min') IS DISTINCT FROM max(e->>'role_max')");
    expect(migration).toContain("min(e->>'agent_min') IS DISTINCT FROM max(e->>'agent_max')");
    expect(migration).toContain("t.role NOT IN('super_agent','agent','sub_agent')");
  });
  it('requires exact installed owners, exact new bytes and atomic installation', () => {
    expect(migration).toMatch(/^BEGIN;/m);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('historical_agent_role_owner_preimage_changed');
    expect(migration).toContain('historical_agent_role_owner_postimage_changed');
  });
  it('runs real original cached/direct/v3 financial owners in the existing accounting shard', () => {
    expect(text('scripts/dev/test-agent-accounting-statements.sh')).toContain(
      'test-historical-agent-role-postgres.py'
    );
    const native = text('scripts/ci/test-historical-agent-role-postgres.py');
    for (const s of [
      'old-historical-promotion-',
      'changed-agent-identity-',
      'invalid-recorded-role-',
      'actual-R2-R3-discharge-conserved',
      'exact70115-rollback-install-postimages-replay-refusal',
    ])
      expect(native).toContain(s);
  });
});
