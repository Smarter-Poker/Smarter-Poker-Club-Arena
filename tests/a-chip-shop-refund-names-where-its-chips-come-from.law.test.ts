/**
 * A CHIP SHOP REFUND NAMES WHERE ITS CHIPS COME FROM (2026-10-02).
 *
 * 20261002140203 guarded fn_credit_chips: an undeclared caller is refused by
 * name rather than journalled against settlement_suspense. The chip branch of
 * fn_refund_shop_purchase called it undeclared. A chip purchase retired its
 * price (chip_debit, no recipient), so the refund puts those chips back into
 * circulation: counterparty issuance_reserve, category refund, keyed by the
 * purchase. The caller's declaration is restored, and fn_credit_chips keeps a
 * category its caller declared.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const name = readdirSync(MIG).find((n) =>
  /^\d{14}_a_chip_shop_refund_names_where_its_chips_come_from\.sql$/.test(n)
);
const sql = name ? readFileSync(resolve(MIG, name), 'utf8') : '';

const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  return a >= 0 && b > a ? s.slice(a, b) : '';
};
const refund = between(sql, 'DO $refund$', 'END $refund$;');
const credit = between(sql, 'DO $credit$', 'END $credit$;');

describe('a chip shop refund names where its chips come from', () => {
  it('the migration exists, runs as one transaction and edits only reviewed pre-images', () => {
    expect(name, 'migration file').toBeTruthy();
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql).toMatch(/SET LOCAL lock_timeout/);
    expect(sql).toContain("IS DISTINCT FROM 'eaa3996bab8e8d4b6fa6a20b79f326f3' THEN");
    expect(sql).toContain("IS DISTINCT FROM 'abf4bf54c469a4fe019d540d4fd11923' THEN");
    expect(sql).not.toMatch(/DROP\s+(TRIGGER|POLICY|FUNCTION|TABLE|COLUMN)/i);
    expect(sql).toMatch(/^-- @live-proof: /m);
  });

  it('the refund declares issuance_reserve, category refund, under its purchase key, and restores the caller', () => {
    expect(refund).toContain('v_saved := public.fn_ca_ledger_declaration_save(NULL);');
    expect(refund).toContain(
      "PERFORM public.fn_ca_declare_ledger(''refund'', ''issuance_reserve'', NULL, NULL,"
    );
    expect(refund).toContain("''ca-shop-refund-'' || p_purchase_id::text, NULL);");
    expect(refund).toContain('PERFORM public.fn_ca_ledger_declaration_restore(v_saved);');
    // the declaration comes before the credit, the restore after its success check
    expect(refund.indexOf('fn_ca_declare_ledger')).toBeLessThan(
      refund.lastIndexOf("E'    v_credit := public.fn_credit_chips(\\n';")
    );
    expect(refund).toMatch(/IF md5\(replace\(replace\(replace\(pg_get_functiondef\(v_oid\)/);
  });

  it('fn_credit_chips keeps a declared category and is still refused undeclared', () => {
    expect(credit).toContain(
      "COALESCE(NULLIF(current_setting(''app.ledger_category'', true), ''''), ''player_funding'')"
    );
    expect(credit).toMatch(/IF md5\(replace\(pg_get_functiondef\(v_oid\), v_new, v_old\)\)/);
    // the guard itself is not touched: only the category line is replaced
    expect(credit).not.toContain('requires_a_declared_counterparty');
  });

  it('the grants stay closed to clients', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_refund_shop_purchase(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_credit_chips(uuid,uuid,numeric,text,jsonb) FROM PUBLIC, anon, authenticated;'
    );
  });
});
