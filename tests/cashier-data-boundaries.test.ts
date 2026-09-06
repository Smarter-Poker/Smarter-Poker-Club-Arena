import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  __dirname,
  '../supabase/migrations/20260906091646_cashier_requests_and_membership_deletes_are_server_owned.sql'
);
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8');
const SQL = MIGRATION.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/--[^\n]*/g, '')
  .toLowerCase();

const policyStart = SQL.indexOf('create policy cashier_chip_requests_read');
const policyEnd = SQL.indexOf('revoke all privileges on table public.chip_requests', policyStart);
const CHIP_REQUEST_POLICY = SQL.slice(policyStart, policyEnd);
const MEMBERSHIP_SERVICE = readFileSync(
  resolve(__dirname, '../src/services/MembershipService.ts'),
  'utf8'
);
const MEMBER_ADMIN = readFileSync(
  resolve(__dirname, '../src/components/admin/ClubMemberManagement.tsx'),
  'utf8'
);
const CLUBS_SERVICE = readFileSync(resolve(__dirname, '../src/services/ClubsService.ts'), 'utf8');
const SETTINGS_PAGE = readFileSync(resolve(__dirname, '../src/pages/ClubSettingsPage.tsx'), 'utf8');

const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

const sqlFunctionBody = (name: string) => {
  const start = SQL.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThan(-1);
  const open = SQL.indexOf('as $function$', start);
  const close = SQL.indexOf('$function$;', open + 'as $function$'.length);
  expect(open).toBeGreaterThan(start);
  expect(close).toBeGreaterThan(open);
  return SQL.slice(open, close);
};

describe('Cashier request, membership departure, and club retirement boundaries', () => {
  it('ships as one lock-bounded transaction', () => {
    expect(SQL.match(/\bbegin\s*;/g)).toHaveLength(1);
    expect(SQL.match(/\bcommit\s*;/g)).toHaveLength(1);
    expect(SQL).toContain("set local lock_timeout = '5s'");
  });

  it('removes both permissive chip-request policy names before replacing them', () => {
    const legacyDrop = SQL.indexOf('drop policy if exists chip_requests_read');
    const canonicalDrop = SQL.indexOf('drop policy if exists cashier_chip_requests_read');

    expect(legacyDrop).toBeGreaterThan(-1);
    expect(canonicalDrop).toBeGreaterThan(legacyDrop);
    expect(policyStart).toBeGreaterThan(canonicalDrop);
  });

  it('allows only the requester, named approver, or full-club cashier scope to read', () => {
    expect(CHIP_REQUEST_POLICY).toContain('for select');
    expect(CHIP_REQUEST_POLICY).toContain('to authenticated');
    expect(CHIP_REQUEST_POLICY).toContain('requester_id = (select auth.uid())');
    expect(CHIP_REQUEST_POLICY).toContain('approver_id = (select auth.uid())');
    expect(CHIP_REQUEST_POLICY).toContain(
      "public.fn_club_cashier_scope(club_id, (select auth.uid())) = 'all'"
    );
    expect(CHIP_REQUEST_POLICY).not.toContain('club_members');
    expect(CHIP_REQUEST_POLICY).not.toMatch(/\b(super_agent|agent|sub_agent)\b/);
  });

  it('leaves authenticated with read-only access and no anonymous access', () => {
    expect(SQL).toContain(
      'revoke all privileges on table public.chip_requests from public, anon, authenticated'
    );
    expect(SQL).toContain('grant select on table public.chip_requests to authenticated');
    expect(SQL).toContain(
      'grant select, insert, update, delete on table public.chip_requests to service_role'
    );
    expect(SQL).toContain("has_table_privilege('anon', 'public.chip_requests', 'select')");
    for (const operation of ['insert', 'update', 'delete', 'truncate']) {
      expect(SQL).toContain(
        `has_table_privilege('authenticated', 'public.chip_requests', '${operation}')`
      );
      expect(SQL).toContain(`has_table_privilege('anon', 'public.chip_requests', '${operation}')`);
    }
  });

  it('closes direct browser club-membership deletion at policy and grant gates', () => {
    expect(SQL).toContain('drop policy if exists club_members_delete on public.club_members');
    expect(SQL).toContain(
      'revoke delete on table public.club_members from public, anon, authenticated'
    );
    expect(SQL).toContain('grant delete on table public.club_members to service_role');
    expect(SQL).not.toMatch(/create\s+policy\s+club_members_delete/);
  });

  it('routes every browser membership-removal caller through the settled server workflow', () => {
    expect(MEMBERSHIP_SERVICE).toContain("rpc('fn_remove_settled_club_member'");
    expect(MEMBER_ADMIN).toContain('MembershipService.removeMember(resolvedId, member.id)');

    for (const source of [MEMBERSHIP_SERVICE, MEMBER_ADMIN, CLUBS_SERVICE]) {
      expect(codeOnly(source)).not.toMatch(
        /from\(['"]club_members['"]\)[\s\S]{0,180}?\.delete\s*\(/
      );
    }
  });

  it('locks authorization and refuses every unsettled membership dependency before departure', () => {
    expect(SQL).toContain('create or replace function public.fn_remove_settled_club_member');
    expect(SQL).toContain("pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'");
    expect(SQL).toContain('cm.user_id in (v_me, p_user_id)');
    expect(SQL).toContain('order by cm.user_id');
    expect(SQL).toContain("set lock_timeout to '5s'");
    for (const dependency of [
      'v_target.chip_balance',
      'v_target.held_chips',
      'v_target.locked_chips',
      'v_target.promo_balance',
      'v_target.credit_used',
      'v_target.diamonds',
      'public.agents',
      'public.table_seats',
      'public.tournament_players',
      'public.cashout_requests',
      'public.chip_escrow',
      'public.chip_escrow_holds',
      'public.tournament_tickets',
      'public.chip_requests',
    ]) {
      expect(SQL).toContain(dependency);
    }
    const body = sqlFunctionBody('fn_remove_settled_club_member');
    expect(body).toContain("membership_lifecycle_status = 'departed'");
    expect(body).toContain("status = 'suspended'");
    expect(body).toContain('is_active = false');
    expect(body).toContain("'depart_club_member'");
    expect(body).toContain("'records_retained', true");
    expect(body).not.toContain('delete from public.club_members');
    expect(SQL).toContain('create or replace function public.fn_guard_membership_lifecycle_write');
    expect(SQL).toContain("current_setting('app.club_membership_lifecycle_write'");
    expect(SQL).toContain("'rejoin'");
  });

  it('keeps direct club deletion closed and exposes only record-preserving retirement', () => {
    expect(SQL).toContain('revoke delete on table public.clubs from public, anon, authenticated');
    expect(SQL).toContain('drop function if exists public.fn_delete_settled_club(uuid, text)');
    expect(SQL).toContain('create or replace function public.fn_retire_settled_club');
    expect(SQL).toContain("'club_record_retained: real club records cannot be deleted'");
    expect(SQL).toContain("old.name like 'crest cert %'");
    expect(SQL).toContain("current_setting('app.game_management_retention'");
    expect(SQL).toContain('v_impact := public.fn_club_retirement_impact(p_club_id)');
    expect(SQL).toContain("v_impact ->> 'wallet_chips'");
    expect(SQL).toContain("v_impact ->> 'diamonds'");
    expect(SQL).toContain("v_impact ->> 'inventory_items'");
    expect(SQL).toContain("v_impact ->> 'open_obligations'");
    expect(CLUBS_SERVICE).toContain("rpc('fn_retire_settled_club'");
    expect(CLUBS_SERVICE).toContain('p_confirm_name: confirmedName');
    expect(SETTINGS_PAGE).toContain('ClubsService.retire(clubId, confirmText.trim())');
    expect(SETTINGS_PAGE).toMatch(/Records Stay Retained And\s+Read-Only/);
    expect(codeOnly(CLUBS_SERVICE)).not.toMatch(/from\(['"]clubs['"]\)[\s\S]{0,180}?\.delete\s*\(/);

    const body = sqlFunctionBody('fn_retire_settled_club');
    expect(body).toContain("lifecycle_status = 'retired'");
    expect(body).toContain("'records_retained', true");
    expect(body).toContain("'retire_club'");
    expect(body).toContain('fn_emit_game_management_event');
    expect(body).toContain("length(coalesce(p_reason, '')) > 500");
    expect(body).not.toContain('delete from public.clubs');
    expect(body).not.toContain('delete from public.club_members');
  });

  it('uses canonical union resolution and every retained value class', () => {
    for (const account of [
      'c.chip_treasury',
      'cm.chip_balance',
      'a.agent_wallet_balance',
      'w.chip_balance',
      'b.main_balance',
      's.balance',
      'ts.stack',
      'h.amount',
      'ce.amount',
      'tt.value',
      'te.prize_balance',
      'te.bounty_balance',
      'te.fee_balance',
      'leaderboard_seed_remaining',
      'public.club_diamond_wallets',
      'cm.diamonds',
      'public.promo_vault_inventory',
      'public.credit_invoices',
      'public.settlement_periods',
    ]) {
      expect(SQL).toContain(account);
    }
    expect(SQL).toContain('exists (select 1 from public.unions u where u.id = p_club_id)');
    expect(SQL).toContain('exists (select 1 from public.union_clubs uc');
    expect(SQL).toContain('c.union_id is not null');
    expect(SQL).toContain("to_jsonb(c) ->> 'is_union'");
    expect(SQL).toContain("to_jsonb(v_club) ->> 'is_union'");
    expect(SQL).not.toContain('v_club.is_union');
  });

  it('makes lifecycle columns replay-safe and blocks stale writers after retirement', () => {
    for (const column of [
      'lifecycle_status text not null default',
      'retired_at timestamptz',
      'retired_by uuid',
      'retirement_reason text',
    ]) {
      expect(SQL).toContain(`add column if not exists ${column}`);
    }
    expect(SQL).toContain('create or replace function public.fn_guard_club_lifecycle_write');
    expect(SQL).toContain('create or replace function public.fn_guard_retired_club_mutation');
    expect(SQL).toContain("'club_members', 'agents', 'club_wallets', 'club_diamond_wallets'");
    expect(SQL).toContain("'union_clubs', 'unions'");
    expect(SQL).toContain("set lock_timeout to '5s'");
  });

  it('aborts if a broad policy, browser mutation grant, or lost server grant survives', () => {
    expect(SQL).toContain("p.cmd in ('select', 'all')");
    expect(SQL).toContain("p.roles && array['public', 'anon', 'authenticated']::name[]");
    expect(SQL).toContain('if v_policy_count <> 1 then');
    expect(SQL).toContain("v_roles is distinct from array['authenticated']::name[]");
    expect(SQL).toContain('a browser role can still mutate chip_requests directly');
    expect(SQL).toContain('a browser-applicable club_members delete/all policy survived');
    expect(SQL).toContain('service_role lost the server-owned club_members delete grant');
    expect(SQL).toContain('a browser role can still delete clubs directly');
    expect(SQL).toContain('anon can execute a server-owned removal/retirement workflow');
    expect(SQL).toContain('obsolete owner-facing hard-delete function survived');
    expect(SQL).toContain('club retirement lifecycle boundary is incomplete');
    expect(SQL).toContain('membership lifecycle trigger is missing');
    expect(SQL).toContain('retired-club mutation triggers are missing');
    expect(SQL).toContain('a lifecycle function lost security definer or its fixed search_path');
    expect(SQL).toContain('a lifecycle mutation function lost its runtime lock timeout');
    expect(SQL).toContain('physical club deletion guard lost its certification-fixture boundary');
  });
});
