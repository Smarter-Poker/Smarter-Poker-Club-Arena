import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const custody = read(
  'supabase/migrations/20261006140948_cashout_escrow_balances_with_its_own_ledger_leg.sql'
);
const supply = read(
  'supabase/migrations/20261006141326_the_supply_meter_includes_held_cashouts.sql'
);
describe('cashout custody is part of the existing conservation contract', () => {
  it('keeps the ticket classifier and correction/suspense treatment intact', () => {
    expect(custody).not.toContain('CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_key');
    for (const side of ['to', 'from']) {
      expect(custody).toContain(
        `NEW.${side}_type = 'escrow' AND NEW.category IN ('escrow_hold', 'escrow_release')`
      );
      expect(custody).toContain(
        `'cashout_escrow:' || COALESCE(NEW.${side}_entity_id::text, 'null')`
      );
      expect(custody).toContain(
        `ELSE public.fn_ca_ledger_tally_key(NEW.${side}_type, NEW.${side}_entity_id, NEW.club_id) END`
      );
    }
    expect(custody).toContain("NEW.metadata ->> 'posted_via' = 'fn_ca_post_correction'");
    expect(custody).toContain(
      "fn_ca_ledger_tally_add('settlement_suspense', 's', abs(NEW.amount))"
    );
  });
  it('counts held rows and queues the existing deferred refusal on every write', () => {
    expect(custody).toContain("WHEN 'chip_escrow' THEN");
    expect(custody).toContain("CASE WHEN o ->> 'released_at' IS NULL");
    expect(custody).toContain("CASE WHEN n ->> 'released_at' IS NULL");
    expect(custody.match(/AFTER INSERT OR UPDATE OR DELETE ON public.chip_escrow/g)).toHaveLength(
      2
    );
    expect(custody).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(custody).toContain("('cashout_escrow','refuse'");
    expect(custody).not.toMatch(
      /DISABLE TRIGGER|session_replication_role|DELETE FROM public.chip_escrow/
    );
  });
  it('executes the cashout and ticket regressions in the required native suite', () => {
    const runner = read('scripts/dev/test-ledger-invariant.sh');
    expect(runner).toContain('20261006140948_cashout_escrow_balances_with_its_own_ledger_leg.sql');
    expect(runner).toContain('cashout-regression.sql');
    const native = read('tests/fixtures/ledger-invariant/cashout-regression.sql');
    for (const scenario of [
      'without its leg',
      'without custody',
      'amount mismatch',
      'another escrow',
      'cannot vanish',
      'release leg',
      'ticket leg cannot',
      'ticket custody still',
    ])
      expect(native).toContain(scenario);
  });
  it('uses a new supply basis, preserves historical rows, and counts held cashouts once', () => {
    expect(supply).toContain("v_basis CONSTANT text := 'cashout-escrow-v5'");
    expect(supply).toContain("OR COALESCE(prev.basis_version,'') <> v_basis THEN NULL");
    expect(supply).toContain('ADD COLUMN cashout_escrow numeric;');
    expect(supply).not.toContain('cashout_escrow numeric DEFAULT');
    expect(supply.match(/FROM public.chip_escrow WHERE released_at IS NULL/g)).toHaveLength(1);
    expect(supply).toContain('+ s.ticket_escrow + s.cashout_escrow');
    expect(supply).toContain('ticket_escrow, cashout_escrow, total,');
    expect(supply).toContain('s.ticket_escrow, s.cashout_escrow, v_total,');
    expect(supply).toContain('public.fn_ca_ticket_escrow_float()');
    expect(supply).toContain('WITH c AS MATERIALIZED');
  });
  it('keeps charts and escalation on the same cashout basis', () => {
    expect(read('scripts/ci/check-chip-conservation.mjs')).toContain(
      'AND basis_version IS NOT DISTINCT FROM'
    );
    expect(supply).toContain('AND basis_version = v_basis');
    expect(supply).toContain('s0.basis_version IS DISTINCT FROM s1.basis_version');
    expect(supply).toContain('AND s.basis_version IS NOT DISTINCT FROM');
    expect(supply).toContain("('cashout_escrow',        ARRAY['cashout_escrow']");
    expect(supply).toContain('s1.cashout_escrow - s0.cashout_escrow');
    for (const side of ['from', 'to'])
      expect(supply).toContain(
        `l.${side}_type = 'escrow' AND l.category IN ('escrow_hold', 'escrow_release')`
      );
    expect(read('scripts/dev/test-ledger-invariant.sh')).toContain(
      'scripts/dev/cashout-reader-sql.py'
    );
  });
});
