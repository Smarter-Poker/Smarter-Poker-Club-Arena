import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cashierReceiptText } from '../src/services/CashierResilience';

const root = resolve(import.meta.dirname, '..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260906091809_cashier_trade_ledger_is_role_scoped.sql'),
  'utf8'
);
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');

describe('the Cashier trade ledger uses one server-owned visibility matrix', () => {
  it('admits only an active member and derives the viewer from auth.uid()', () => {
    expect(migration).toContain('v_viewer uuid := auth.uid()');
    expect(migration.match(/coalesce\(cm\.status::text, 'active'\)/g)).toHaveLength(2);
    expect(migration).toContain("v_role IN ('owner', 'co_owner', 'admin', 'super_agent')");
    expect(migration).toContain("v_role IN ('agent', 'sub_agent')");
    expect(migration).toContain('ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer');
  });

  it('returns wallet metadata and keeps the security-definer door off anon', () => {
    expect(migration).toMatch(/metadata jsonb[\s\S]*SECURITY DEFINER/);
    expect(migration).toContain('ct.notes, ct.metadata');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_club_trade_ledger\(uuid, integer, integer\)[\s\S]*FROM PUBLIC, anon/
    );
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]*TO authenticated, service_role/);
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("SET lock_timeout TO '5s'");
    expect(migration).toContain("p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]");
    expect(migration).toContain("p.proconfig @> ARRAY['lock_timeout=5s']::text[]");
    expect(migration).toContain("has_function_privilege('anon', v_function, 'EXECUTE')");
  });

  it("honors the UI's 250-row window plus its truthful sentinel row", () => {
    expect(migration).toContain('least(greatest(coalesce(p_limit, 50), 1), 251)');
    expect(page).toContain('p_limit: recordsLimit + 1');
    expect(page).toContain('Math.min(limit + 50, 250)');
    expect(migration.match(/ORDER BY ct\.created_at DESC, ct\.id DESC/g)).toHaveLength(3);
  });

  it('pins direct browser reads to own rows while preserving the scoped union arm', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS chip_transactions_select_own');
    expect(migration).toMatch(
      /CREATE POLICY chip_transactions_select_own[\s\S]*auth\.uid\(\) = from_user_id OR auth\.uid\(\) = to_user_id/
    );
    expect(migration).toContain(
      'REVOKE SELECT ON TABLE public.chip_transactions FROM PUBLIC, anon'
    );
    expect(migration).toContain('v_own.polroles <> ARRAY[v_authenticated]::oid[]');
    expect(migration).toContain("v_qual <> '((auth.uid()=from_user_id)or(auth.uid()=to_user_id))'");
    expect(migration).toContain("p.polname = 'union_overseer_read'");
    expect(migration).toContain("position('fn_is_any_union_overseer' IN v_qual) = 0");
    expect(migration).toContain("position('fn_union_oversees_club' IN v_qual) = 0");
    expect(migration).toContain(
      "p.polname NOT IN ('chip_transactions_select_own', 'union_overseer_read')"
    );
    expect(migration).toContain("pg_has_role(v_authenticated, scoped_role.role_oid, 'MEMBER')");
    expect(migration).toContain(
      'POST-APPLY: an unknown browser SELECT policy can broaden chip_transactions'
    );
  });

  it('calls the RPC and never re-imposes a self-only browser filter', () => {
    expect(page).toContain("supabase.rpc('fn_club_trade_ledger'");
    expect(page).not.toContain(".from('chip_transactions')");
    expect(page).not.toContain('from_user_id.eq.${user.id},to_user_id.eq.${user.id}');
  });

  it('prints a third-party managed transfer without pretending it was the viewer’s debit', () => {
    const receipt = cashierReceiptText(
      {
        id: 'managed-row',
        createdAt: '2026-09-06T09:00:00Z',
        type: 'agent_wallet_send',
        amount: 50,
        direction: 'managed',
        counterparty: 'Alice To Bob',
      },
      'Shark Club'
    );
    expect(receipt).toContain('Transfer: Alice To Bob');
    expect(receipt).toContain('Amount: 50.00 Chips');
    expect(receipt).not.toContain('Amount: -50.00 Chips');
  });
});
