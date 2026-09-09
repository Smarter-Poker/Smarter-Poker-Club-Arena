import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const manager = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
const start = sliceMethod(manager, 'private async startLifecycle(');
const migration = readFileSync(
  join(
    here,
    '../../../supabase/migrations/20260909222044_paid_spin_launch_reads_owner_only_entitlements_through_one_door.sql'
  ),
  'utf8'
);
const lockableTransaction = readFileSync(
  join(
    here,
    '../../../supabase/migrations/20260909222347_paid_spin_entitlement_reader_uses_a_lockable_transaction.sql'
  ),
  'utf8'
);

function body(tag: string): string {
  const delimiter = `$${tag}$`;
  const first = migration.indexOf(delimiter);
  const second = migration.indexOf(delimiter, first + delimiter.length);
  expect(first, `opening ${delimiter}`).toBeGreaterThan(-1);
  expect(second, `closing ${delimiter}`).toBeGreaterThan(first);
  return migration.slice(first + delimiter.length, second);
}

describe('the paid Spin gate reads owner-only evidence through one narrow door', () => {
  it('uses the RPC without restoring a direct table read and still fails closed', () => {
    const paidGate = start.slice(start.indexOf('const regIds ='), start.indexOf('const paidBy ='));

    expect(paidGate).toContain("'fn_ca_paid_spin_launch_entitlements'");
    expect(paidGate).toContain('p_tournament_id: this.tournamentId');
    expect(paidGate).toContain('p_user_ids: regIds');
    expect(paidGate).not.toContain(".from('tournament_refund_entitlements')");
    expect(paidGate).toContain('if (entitlementErr)');
    expect(paidGate).toContain('Tournament.spin_paid_check_unreadable');
    expect(paidGate).toMatch(/this\.running = false;[\s\S]*?return;/);
    expect(start).toContain('.map((entry: { created_at?: string }) =>');
  });

  it('returns only the three fields and only the funded buy-in rows requested', () => {
    const reader = body('paid_spin_entitlements');

    expect(migration).toContain(
      'RETURNS TABLE(user_id uuid, gross numeric, created_at timestamptz)'
    );
    expect(reader).toContain('SELECT e.user_id, e.gross, e.created_at');
    expect(reader).toContain('FROM public.tournament_refund_entitlements e');
    expect(reader).toContain("e.entitlement_kind = 'wallet_charge'");
    expect(reader).toContain("e.charge_category = 'tournament_buyin'");
    expect(reader).toContain('e.user_id = ANY(p_user_ids)');
    expect(reader).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
  });

  it('binds definer privilege to the verified current manager and exact tournament', () => {
    const reader = body('paid_spin_entitlements');

    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path TO ''");
    expect(migration).toContain("SET row_security TO 'off'");
    expect(reader).toContain("auth.role() IS DISTINCT FROM 'service_role'");
    expect(reader).toContain("v_actor IS DISTINCT FROM 'tournament-manager'");
    expect(reader).toContain('v_context_tournament IS DISTINCT FROM p_tournament_id::text');
    expect(reader).toContain("USING ERRCODE = '28000'");
    expect(reader).toContain('pg_catalog.cardinality(p_user_ids) NOT BETWEEN 1 AND 3');
  });

  it('keeps the table private and exposes exactly one service-role RPC', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_paid_spin_launch_entitlements\(uuid, uuid\[\]\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_paid_spin_launch_entitlements\(uuid, uuid\[\]\)[\s\S]*?TO service_role;/
    );
    expect(migration).toMatch(
      /has_table_privilege\(\s*'service_role',\s*'public\.tournament_refund_entitlements',\s*'SELECT'/
    );
    expect(migration).toContain('pg_catalog.aclexplode(');
    expect(migration).toContain('privilege.grantee = 0');
    expect(migration).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(migration).toContain("has_function_privilege('authenticated', v_oid, 'EXECUTE')");
    expect(migration).toContain("NOT has_function_privilege('service_role', v_oid, 'EXECUTE')");
    expect(migration).not.toMatch(/cron\.schedule|pg_cron|CREATE TRIGGER/i);
  });

  it('runs in a transaction where the request fence can lock the current lease', () => {
    expect(lockableTransaction).toContain(
      'ALTER FUNCTION public.fn_ca_paid_spin_launch_entitlements(uuid, uuid[])'
    );
    expect(lockableTransaction).toContain('VOLATILE;');
    expect(lockableTransaction).toContain("p.provolatile = 's'");
    expect(lockableTransaction).toContain("v_volatility IS DISTINCT FROM 'v'");
    expect(lockableTransaction).toContain('v_security_definer IS DISTINCT FROM true');
    expect(lockableTransaction).toContain('pg_catalog.aclexplode(');
    expect(lockableTransaction).toContain('privilege.grantee = 0');
    expect(lockableTransaction).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(lockableTransaction).toContain(
      "NOT has_function_privilege('service_role', v_oid, 'EXECUTE')"
    );
    expect(lockableTransaction).not.toMatch(/cron\.schedule|pg_cron|CREATE TRIGGER/i);
  });
});
