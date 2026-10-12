import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const original = readFileSync(
  join(root, 'supabase/migrations/20260902010000_return_inactive_spin_seed_principal.sql'),
  'utf8'
);
const correction = readFileSync(
  join(root, 'supabase/migrations/20261002201605_spin_deactivation_names_the_reserve_row.sql'),
  'utf8'
);

describe('Spin deactivation reserve identity', () => {
  it('replaces the owner alias with the exact reserve row on the canonical ledger leg', () => {
    const stale = "(v_actor, 'spin_reserve', v_owner, 'spin_bonus_pools.balance',";
    const fixed = "(v_actor, 'spin_reserve', v_pool.id, 'spin_bonus_pools.balance',";

    expect(original.split(stale)).toHaveLength(2);
    expect(correction).toContain(`v_old text := $old$${stale}$old$`);
    expect(correction).toContain(`v_new text := $new$${fixed}$new$`);
    expect(correction).toContain('v_count <> 1');
    expect(correction).toContain('REVERSE_SUBSTITUTION_FAILED');
  });

  it('changes only the function definition and carries a durable production proof', () => {
    expect(correction).toMatch(
      /^-- @live-proof: .*v_pool\.id, 'spin_bonus_pools\.balance'.*fn_spin_deactivate/m
    );
    expect(correction).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:clubs|spin_bonus_pools|chip_ledger|spin_reserve_ledger)\b/i
    );
    expect(correction).toMatch(/^BEGIN;/m);
    expect(correction.trim()).toMatch(/COMMIT;$/);
  });
});
