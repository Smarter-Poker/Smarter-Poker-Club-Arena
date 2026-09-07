import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    '../../supabase/migrations/20260907054510_lifetime_vip_unlimited_digital_benefits.sql'
  ),
  'utf8'
);

function functionBody(name: string, nextName?: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is missing`).toBeGreaterThan(-1);
  const end = nextName
    ? migration.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}(`, start + 1)
    : migration.indexOf('DO $assertions$', start + 1);
  expect(end, `${name} has no bounded body`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('Lifetime VIP unlimited digital benefits migration', () => {
  it('keeps keyed digital purchase receipts private and account scoped', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.digital_purchase_receipts');
    expect(migration).toContain('PRIMARY KEY (user_id, request_id)');
    expect(migration).toContain('request_payload jsonb NOT NULL');
    expect(migration).toContain('result jsonb NOT NULL');
    expect(migration).toContain("purchase_kind IN ('rabbit_hunt', 'time_bank', 'feature')");
    expect(migration).toContain(
      'ALTER TABLE public.digital_purchase_receipts ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain('REVOKE ALL ON TABLE public.digital_purchase_receipts');
    expect(migration).toContain('REVOKE ALL ON TABLE public.throwable_use_receipts');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE public.digital_purchase_receipts TO service_role'
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE public.throwable_use_receipts TO service_role'
    );
    expect(migration).toContain('CREATE POLICY digital_purchase_receipts_deny_browser');
    expect(migration).toContain('CREATE POLICY throwable_use_receipts_deny_browser');
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(2);
    expect(migration.match(/USING \(false\)/g)).toHaveLength(2);
    expect(migration.match(/WITH CHECK \(false\)/g)).toHaveLength(2);
    expect(migration).toContain("p.polname = 'digital_purchase_receipts_deny_browser'");
    expect(migration).toContain("p.polname = 'throwable_use_receipts_deny_browser'");
    expect(migration.match(/AND NOT p\.polpermissive/g)).toHaveLength(2);
    expect(migration.match(/AND p\.polcmd = '\*'/g)).toHaveLength(2);
    expect(migration.match(/AND p\.polroles = ARRAY\[0\]::oid\[\]/g)).toHaveLength(2);
    expect(migration.match(/AND pg_get_expr\(p\.polqual, p\.polrelid\) = 'false'/g)).toHaveLength(
      2
    );
    expect(
      migration.match(/AND pg_get_expr\(p\.polwithcheck, p\.polrelid\) = 'false'/g)
    ).toHaveLength(2);
    expect(migration).toContain(
      "has_table_privilege('authenticated', 'public.digital_purchase_receipts', 'UPDATE')"
    );
    expect(migration).toContain(
      "has_table_privilege('authenticated', 'public.digital_purchase_receipts', 'DELETE')"
    );
    expect(migration).toContain(
      "has_table_privilege('service_role', 'public.digital_purchase_receipts', 'UPDATE')"
    );
    expect(migration).toContain(
      "has_table_privilege('service_role', 'public.digital_purchase_receipts', 'DELETE')"
    );
    expect(migration).toContain(
      "has_table_privilege('authenticated', 'public.throwable_use_receipts', 'UPDATE')"
    );
    expect(migration).toContain(
      "has_table_privilege('authenticated', 'public.throwable_use_receipts', 'DELETE')"
    );
    expect(migration).toContain(
      "has_table_privilege('service_role', 'public.throwable_use_receipts', 'UPDATE')"
    );
    expect(migration).toContain(
      "has_table_privilege('service_role', 'public.throwable_use_receipts', 'DELETE')"
    );
  });

  it('keeps the legacy Time Bank reader scoped to self or the game service', () => {
    const body = functionBody('fn_time_bank_allowance', 'sp_is_lifetime_vip');
    expect(body).toContain("auth.role() = 'service_role' OR p.id = auth.uid()");
    expect(body).toContain(
      "p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()"
    );
    expect(body).toContain('m.user_id IN (SELECT vip.id FROM vip)');
    expect(body).toContain('fp.user_id IN (SELECT vip.id FROM vip)');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_time_bank_allowance(uuid[]) FROM PUBLIC'
    );
  });

  it('recognizes only an enabled exact Lifetime membership and ignores its expiry', () => {
    const helper = functionBody('sp_is_lifetime_vip', 'fn_use_throwable_v2');
    expect(helper).toContain("COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'");
    expect(helper).not.toContain('vip_expires_at');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.sp_is_lifetime_vip(uuid) FROM authenticated'
    );
  });

  it('audits every Lifetime throw before all finite or paid branches', () => {
    const body = functionBody('fn_use_throwable_v2', 'fn_use_throwable');
    const lifetime = body.indexOf('IF v_lifetime THEN');
    const audit = body.indexOf('INSERT INTO public.throw_usage', lifetime);
    const finite = body.indexOf('IF v_used < v_free THEN');
    const pack = body.indexOf('FROM public.feature_purchases');
    const debit = body.indexOf('public.deduct_diamonds');

    expect(lifetime).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(lifetime);
    expect(finite).toBeGreaterThan(audit);
    expect(pack).toBeGreaterThan(finite);
    expect(debit).toBeGreaterThan(pack);
    expect(body).toContain("'source', 'lifetime_vip'");
    expect(body).toContain("'unlimited', true");
    expect(body).toContain('v_free        constant integer := 500');
    expect(body).toContain("interval '1500 milliseconds'");
    expect(body).toContain("'code', 'RATE_LIMITED'");
    expect(body).toContain('p_request_id uuid');
    expect(body).toContain('throwable_use_receipts');
    expect(body).toContain("'idempotent', true");
    expect(body).toContain("'consumed', false");
    expect(body).toContain("v_cached->>'original_diamonds_spent'");
    expect(body).toContain("'diamonds_spent', 0");
    expect(body.indexOf('throwable_use_receipts')).toBeLessThan(body.indexOf('IF v_lifetime THEN'));
  });

  it('audits every Lifetime Rabbit Hunt before all finite or paid branches', () => {
    const body = functionBody('fn_consume_rabbit_hunt_v2', 'fn_consume_rabbit_hunt');
    const receiptRead = body.indexOf('FROM public.digital_purchase_receipts');
    const lifetime = body.indexOf('IF v_is_lifetime THEN');
    const audit = body.indexOf('INSERT INTO public.vip_feature_usage_monthly', lifetime);
    const finite = body.indexOf('IF v_used < v_vip_monthly_cap THEN');
    const pack = body.indexOf('FROM public.feature_purchases');
    const debit = body.indexOf('public.deduct_diamonds');

    expect(receiptRead).toBeGreaterThan(-1);
    expect(lifetime).toBeGreaterThan(receiptRead);
    expect(audit).toBeGreaterThan(lifetime);
    expect(finite).toBeGreaterThan(audit);
    expect(pack).toBeGreaterThan(finite);
    expect(debit).toBeGreaterThan(pack);
    expect(body).toContain('v_vip_monthly_cap CONSTANT int := 100');
    expect(body).toContain("'diamonds_spent', 0");
    expect(body).toContain('p_request_id uuid');
    expect(body).toContain("'digital_purchase_request:'");
    expect(body).toContain("v_cached_kind IS DISTINCT FROM 'rabbit_hunt'");
    expect(body).toContain('v_cached_payload IS DISTINCT FROM v_request_payload');
    expect(body).toContain("'idempotent', true");
    expect(body).toContain("'consumed', false");
    expect(body).toContain('INSERT INTO public.digital_purchase_receipts');
    expect(body).toContain("p_reference_id     => 'rabbit_use_'");
    expect(body).toContain('IF v_cost < 0 THEN');
    expect(body).toContain('IF v_cost > 0 THEN');

    const bridge = functionBody('fn_consume_rabbit_hunt', 'fn_time_bank_allowance_v2');
    expect(bridge).toContain(
      'RETURN public.fn_consume_rabbit_hunt_v2(p_user_id, gen_random_uuid())'
    );
  });

  it('exposes explicit unlimited Time Bank state without inventing a giant balance', () => {
    const body = functionBody('fn_time_bank_allowance_v2', 'fn_consume_time_bank');
    expect(body).toContain('unlimited_activations boolean');
    expect(body).toContain('WHEN v.is_lifetime THEN NULL');
    expect(body).toContain('WHEN v.is_lifetime THEN 0');
    expect(body).toContain("auth.role() = 'service_role' OR p.id = auth.uid()");
    expect(body).toContain('m.user_id IN (SELECT vip.id FROM vip)');
    expect(body).toContain('fp.user_id IN (SELECT vip.id FROM vip)');
    expect(body).not.toContain('m.user_id = ANY(p_user_ids)');
    expect(body).not.toContain('fp.user_id = ANY(p_user_ids)');
    expect(body).not.toMatch(/2147483647|999999|Infinity/);
  });

  it('records Lifetime Time Bank use without decrementing purchased credits', () => {
    const body = functionBody('fn_consume_time_bank', 'fn_purchase_time_banks_v2');
    const lifetime = body.indexOf('IF v_is_lifetime THEN');
    const audit = body.indexOf('INSERT INTO public.vip_feature_usage_monthly', lifetime);
    const returned = body.indexOf("'source', 'lifetime_vip'", audit);
    const purchased = body.indexOf('FROM public.feature_purchases');

    expect(lifetime).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(lifetime);
    expect(returned).toBeGreaterThan(audit);
    expect(purchased).toBeGreaterThan(returned);
    expect(body).toContain("'shortfall_seconds', 0");
    expect(body).toContain("feature = 'time_bank_seconds'");
    expect(body).toContain('GREATEST(0, 120 - v_used)');
    expect(body).toContain("auth.role() IS DISTINCT FROM 'service_role'");
    expect(body).not.toContain("COALESCE(auth.role(), 'service_role')");
  });

  it('makes a direct Lifetime Time Bank purchase a zero-cost no-op', () => {
    const body = functionBody('fn_purchase_time_banks_v2', 'fn_purchase_time_banks');
    const guard = body.indexOf('IF public.sp_is_lifetime_vip(v_caller) THEN');
    const returnIncluded = body.indexOf("'included', true", guard);
    const price = body.indexOf('SELECT diamond_cost INTO v_unit_cost');
    const debit = body.indexOf('public.deduct_diamonds');
    const grant = body.indexOf('INSERT INTO public.feature_purchases');

    expect(guard).toBeGreaterThan(-1);
    expect(returnIncluded).toBeGreaterThan(guard);
    expect(price).toBeGreaterThan(returnIncluded);
    expect(debit).toBeGreaterThan(price);
    expect(grant).toBeGreaterThan(debit);
    expect(body).toContain("'total_cost', 0");
    expect(body).toContain("'diamonds_remaining', v_balance");
    expect(body).toContain('p_request_id uuid');
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain(
      "'digital_purchase_request:' || v_caller::text || ':' || p_request_id::text"
    );
    expect(body).toContain(
      "v_reference := 'tbank_' || v_caller::text || '_' || p_request_id::text"
    );
    expect(body).not.toContain('clock_timestamp');
    expect(body.indexOf('FROM public.digital_purchase_receipts')).toBeLessThan(guard);
    expect(body).toContain("v_cached_kind IS DISTINCT FROM 'time_bank'");
    expect(body).toContain('v_cached_payload IS DISTINCT FROM v_request_payload');
    expect(body).toContain('INSERT INTO public.digital_purchase_receipts');
    expect(body).toContain('IF v_unit_cost < 0 THEN');
    expect(body).toContain('IF v_total_cost > 0 THEN');
    expect(body).toContain("v_cached_result->>'original_total_cost'");
    const walletReplay = body.slice(body.indexOf("v_deduct->>'idempotent'"));
    expect(walletReplay).toContain('INSERT INTO public.digital_purchase_receipts');
  });

  it('guards every safe generic digital purchase route without granting club creation', () => {
    const body = functionBody('fn_purchase_feature_v2', 'fn_purchase_feature');
    const included = body.indexOf('IF v_lifetime_included THEN');
    const debit = body.indexOf('public.deduct_diamonds');
    const idempotent = body.indexOf("v_deduct->>'idempotent'", debit);
    const grant = body.indexOf('INSERT INTO public.feature_purchases');

    expect(included).toBeGreaterThan(-1);
    expect(debit).toBeGreaterThan(included);
    expect(idempotent).toBeGreaterThan(debit);
    expect(grant).toBeGreaterThan(idempotent);
    for (const feature of [
      'rabbit_hunt',
      'time_bank_seconds',
      'throwable',
      'emoji_pack',
      'tag_pack',
      'show_stack_bb',
      'offline_protection',
      'auto_time_bank',
    ]) {
      expect(body).toContain(`'${feature}'`);
    }
    expect(body).not.toContain("'theme_unlock'");
    expect(body).not.toContain("'club_creation'");
    expect(body).toContain("'cost', 0");
    expect(body).toContain("'source', 'lifetime_vip'");
    expect(body).toContain("'granted', false");
    expect(body).toContain('p_request_id uuid');
    expect(body).toContain("'digital_purchase_request:'");
    expect(body).toContain("'feat_' || v_caller::text || '_' || p_request_id::text");
    expect(body).not.toContain('date_trunc');
    expect(body.indexOf('FROM public.digital_purchase_receipts')).toBeLessThan(included);
    expect(body).toContain("v_cached_kind IS DISTINCT FROM 'feature'");
    expect(body).toContain('v_cached_payload IS DISTINCT FROM v_request_payload');
    expect(body).toContain('INSERT INTO public.digital_purchase_receipts');
    expect(body).toContain('IF v_price.diamond_cost < 0 THEN');
    expect(body).toContain('IF v_price.diamond_cost > 0 THEN');
    expect(body).toContain("v_cached_result->>'original_cost'");
    const walletReplay = body.slice(body.indexOf("v_deduct->>'idempotent'"));
    expect(walletReplay).toContain('INSERT INTO public.digital_purchase_receipts');
  });

  it('keeps writer privileges and the one-transaction migration boundary pinned', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt(uuid) FROM authenticated'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt_v2(uuid, uuid) FROM authenticated'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_consume_time_bank(uuid, integer) FROM authenticated'
    );
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.fn_use_throwable_v2(text, uuid)');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_consume_rabbit_hunt_v2(uuid, uuid) TO service_role'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_consume_rabbit_hunt(uuid) TO service_role'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_purchase_time_banks_v2(integer, uuid)'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_purchase_feature_v2(uuid, text, uuid)'
    );
  });
});
