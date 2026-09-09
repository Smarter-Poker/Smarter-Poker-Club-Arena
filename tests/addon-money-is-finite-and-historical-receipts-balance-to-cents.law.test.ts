/**
 * The post-062006 add-on money contract is a forward definition, not a data
 * rewrite. PostgreSQL numeric NaN and infinities must be refused explicitly,
 * and a settled historical float-dust amount is reconciled only through its
 * finite cent receipt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const predecessorVersion = '20260909062006';
const migrationVersion = '20260909072626';
const migrationPath =
  'supabase/migrations/20260909072626_addon_money_is_finite_and_historical_receipts_balance_to_cents.sql';
const sql = readFileSync(resolve(__dirname, '..', migrationPath), 'utf8');

describe('add-on money is finite cents without rewriting settled history', () => {
  it('is a forward correction with exact before and after function anchors', () => {
    expect(Number(migrationVersion)).toBeGreaterThan(Number(predecessorVersion));

    for (const hash of [
      '40209effcdc068771dba81813157f286',
      '5369d22b611fc0a527b4439a21a3f178',
      '0f9656e8ece4172db2988376c287d10c',
      'a98dd67a40c077abb1b9937a955b086c',
      'b227e791ae7c17544c8ba02943fe53dc',
      '17c09aa5a76599032467d32740ec5b99',
    ]) {
      expect(sql, hash).toContain(hash);
    }
    expect(sql).toContain("SET LOCAL lock_timeout = '3s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
  });

  it('refuses every nonfinite spelling and fractional cents before receipt claim', () => {
    expect(sql).toContain("p_amount::text IN ('NaN', 'Infinity', '-Infinity')");
    expect(sql).toContain('p_amount <> round(p_amount, 2)');
    expect(sql).toContain("position('fn_claim_entry_purchase_receipt' IN v_definition)");
    expect(sql).toContain('<= position(v_old IN v_definition)');

    for (const signature of [
      'public.atomic_table_addon(uuid,uuid,numeric,boolean,text)',
      'public.atomic_table_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)',
    ]) {
      expect(sql, signature).toContain(signature);
    }
  });

  it('replaces all four predecessor checks with NOT VALID finite-cent checks', () => {
    const constraints = [
      'table_pending_addons_amount_is_cents',
      'table_pending_addons_applied_is_cents',
      'table_pending_addons_refunded_is_cents',
      'table_addon_idempotency_amount_is_cents',
    ];
    for (const constraint of constraints) {
      expect(sql, constraint).toMatch(
        new RegExp(`DROP CONSTRAINT ${constraint};[\\s\\S]*ADD CONSTRAINT ${constraint}`)
      );
    }
    expect((sql.match(/\) NOT VALID;/g) ?? []).length).toBe(4);
    expect((sql.match(/::text NOT IN \('NaN', 'Infinity', '-Infinity'\)/g) ?? []).length).toBe(4);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?table_pending_addons/i);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?table_addon_idempotency/i);
  });

  it('accepts only finite cent receipt legs that equal the rounded historical amount', () => {
    for (const leg of ['applied', 'refunded']) {
      expect(sql).toContain(`v_addon_result.${leg}::text IN ('NaN', 'Infinity', '-Infinity')`);
      expect(sql).toContain(`v_addon_result.${leg} <> round(v_addon_result.${leg}, 2)`);
    }
    expect(sql).toContain('IS DISTINCT FROM round(v_addon.amount, 2)');
    expect(sql).toContain(
      "'fn_ca_process_hand_post_commit_obligations changed after 20260908175113; re-audit before applying'"
    );
  });

  it('installs hard runtime definitions only', () => {
    expect(sql).not.toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.[a-z_]*(?:watch|reconcil)/i
    );
    expect(sql).not.toMatch(/cron\.|pg_cron|CREATE\s+TRIGGER/i);
    expect(sql).toContain('COMMIT;');
  });
});
