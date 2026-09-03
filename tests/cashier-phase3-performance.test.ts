import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
const sql = readFileSync(
  resolve(root, 'supabase/migrations/20260831235991_cashier_roster_ledger_batch_performance.sql'),
  'utf8'
);

describe('cashier phase 3 performance contracts', () => {
  it('pages the authorized roster with a stable keyset and publishes progressively', () => {
    expect(sql).toContain('fn_club_cashier_members_page_v3');
    expect(sql).toContain('m.role_rank < p_after_role_rank');
    expect(sql).toContain('m.user_id > p_after_user_id');
    expect(sql).toContain('limit greatest(1, least(coalesce(p_limit, 500), 500))');
    expect(page).toContain("'fn_club_cashier_members_page_v3'");
    expect(page).toContain('setDownline(mapCashierRoster(dl, user.id))');
    expect(page).toContain('setRosterLoadingMore(page.length === rosterPageSize)');
  });

  it('builds club-scoped party indexes without stopping ledger writes', () => {
    expect(sql).toContain('create index concurrently if not exists');
    expect(sql).toContain('chip_transactions_club_from_created_idx');
    expect(sql).toContain('chip_transactions_club_to_created_idx');
    expect(sql).toContain('(club_id, from_user_id, created_at desc)');
    expect(sql).toContain('(club_id, to_user_id, created_at desc)');
  });

  it('moves bounded idempotent chunks and returns an explicit result per recipient', () => {
    expect(sql).toContain('jsonb_array_length(p_items) > 25');
    expect(sql).toContain('Every Send Needs Its Own Retry Key');
    expect(sql).toContain('Every Ticket Needs Its Own Retry Key');
    expect(sql).toContain('public.fn_agent_wallet_send(');
    expect(sql).toContain('public.fn_issue_tournament_ticket(');
    expect(sql).toContain("jsonb_build_object('user_id',v_user_id)");
    expect(page).toContain('const batchSize = 25');
    expect(page).toContain("supabase.rpc('fn_cashier_batch_transfer'");
  });

  it('announces progress and reports one aggregate failure instead of one event per target', () => {
    expect(page).toContain('setBatchProgress({ processed: 0, total: targets.length })');
    expect(page).toContain('role="status" aria-live="polite"');
    expect(page).toContain('CashierTradePage.${kind}Batch');
    expect(page).not.toContain("reportError(e, 'CashierTradePage.' + kind)");
  });
});
