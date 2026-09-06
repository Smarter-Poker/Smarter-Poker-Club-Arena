import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = source(
  'supabase/migrations/20260906093024_cashier_rpc_idempotency_and_telemetry_boundary.sql'
);
const cashier = source('src/pages/CashierTradePage.tsx');
const telemetry = source('src/services/CashierOperationsTelemetry.ts');

describe('cashier RPC hardening laws', () => {
  it('requires a request operation id before the request can lock or write', () => {
    const guard = migration.indexOf('IF p_op_id IS NULL THEN');
    const lock = migration.indexOf("hashtextextended('chip-request:'");
    const insert = migration.indexOf('INSERT INTO public.chip_requests');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(lock);
    expect(guard).toBeLessThan(insert);
    expect(migration).toContain("'A Retry Key Is Required'");
    expect(migration).toContain('AND op_id = p_op_id');
    expect(migration).toContain('v_prior.amount IS DISTINCT FROM p_amount');
    expect(migration).toContain('length(v_note) > 500');
    expect(cashier).toContain('reserveCashierChipRequestOperation(');
    expect(cashier).toContain('const canonicalNote = askNote.trim() || null');
    expect(cashier).toContain('p_op_id: requestOpIdRef.current');
    expect(cashier).toContain('clearCashierChipRequestOperation(recovery)');
  });

  it('moves telemetry writes behind a server-owned identity and club-scope boundary', () => {
    expect(telemetry).toContain("supabase.rpc('fn_record_cashier_operation', args)");
    expect(telemetry).not.toContain("supabase.from('cashier_operations')");
    expect(migration).toContain('v_user_id uuid := auth.uid()');
    expect(migration).toContain('fn_club_cashier_scope(p_club_id, v_user_id)');
    expect(migration).toContain("COALESCE(v_scope, 'none') NOT IN ('all', 'downline')");
    expect(migration).toContain("action = 'cashier_operation'");
    expect(migration).toContain('CASE WHEN v_is_failure THEN 1 ELSE 10 END');
  });

  it('leaves authenticated with RPC execute only, never table or sequence write access', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS cashier_operations_insert_own');
    expect(migration).toContain(
      'REVOKE ALL ON public.cashier_operations FROM PUBLIC, anon, authenticated'
    );
    expect(migration).toContain(
      'REVOKE ALL ON SEQUENCE public.cashier_operations_id_seq FROM PUBLIC, anon, authenticated'
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_record_cashier_operation\([\s\S]+?\) TO authenticated, service_role;/
    );
    expect(migration).toContain(
      "has_table_privilege('authenticated', 'public.cashier_operations', 'INSERT')"
    );
  });

  it("prevents browsers from manufacturing another account's limiter rows", () => {
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Service can insert rate limit entries" ON public.rate_limits'
    );
    expect(migration).toContain(
      'REVOKE ALL ON public.rate_limits FROM PUBLIC, anon, authenticated'
    );
    expect(migration).toContain(
      "has_table_privilege('authenticated', 'public.rate_limits', 'INSERT')"
    );
    expect(migration).toContain("COALESCE(cm.status::text, 'active')");
  });
});
