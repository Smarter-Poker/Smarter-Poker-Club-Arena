import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const native = read('scripts/dev/test-midway-union-cash-host.sh');
const migration = read(
  'supabase/migrations/20261024053530_midway_union_owns_member_cash_launches.sql'
);

describe('Midway union cash authority qualification', () => {
  it('executes the original PostgreSQL authority and custody suite in the maintained native chain', () => {
    expect(read('scripts/dev/test-lightning-phase6-matcher.sh')).toContain(
      'bash "$root/scripts/dev/test-lightning-canonical-admission.sh"'
    );
    expect(read('scripts/dev/test-lightning-canonical-admission.sh')).toContain(
      'bash "$root/scripts/dev/test-midway-union-cash-host.sh"'
    );
    expect(native).toContain('20261024053530_midway_union_owns_member_cash_launches.sql');
    expect(native).toContain('midway-union-cash-preimages.sql');
    expect(native).toContain('midway-union-cash-assert.sql');
    expect(native).toContain('RED reproduced: original ensure admits the member-hosted game');
    expect(native).toContain('partial function DDL survived refusal');
  });

  it('keeps the finite catalog relocation away from player and financial row writes', () => {
    expect(migration).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:table_seats|club_members|wallets|hand_history|cash_player_session|lightning_pool_session)\b/i
    );
    expect(migration).not.toContain('break_window_migration_override');
    expect(migration).not.toContain('LOCK TABLE');
    expect(migration).toContain("SET LOCAL lock_timeout='1s'");
    expect(migration).toContain("SET LOCAL statement_timeout='5s'");
  });
});
