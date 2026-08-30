import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
const home = readFileSync(resolve(root, 'src/pages/HomePage.tsx'), 'utf8');
const union = readFileSync(resolve(root, 'src/pages/UnionDashboardPage.tsx'), 'utf8');
const modal = readFileSync(resolve(root, 'src/components/wallet/WalletCashierModal.tsx'), 'utf8');
const sql = readFileSync(
  resolve(root, 'supabase/migrations/20260830010000_cashier_integrity_and_wallet_launcher.sql'),
  'utf8'
);
const sendGuard = readFileSync(
  resolve(root, 'supabase/migrations/20260830013000_agent_wallet_send_intent_guard.sql'),
  'utf8'
);

describe('cashier integrity and wallet launcher', () => {
  it('waits for the resolved role before redirecting a player off the first tab', () => {
    expect(page).toContain("const [tab, setTab] = useState<TabKey>('trade')");
    expect(page).toContain("roleResolved && myRole === 'player' && tab === 'trade'");
    expect(page).toMatch(
      /useEffect\(\(\) => \{[\s\S]+?setTab\('trade'\);\s+setRoleResolved\(false\)/
    );
  });

  it('opens owned unions at their wallet tab from the Cashier launcher', () => {
    expect(home).toContain('eligibleCashierWallets(userClubs)');
    expect(home).toContain('/operations?tab=wallet');
    expect(union).toContain("requestedUnionTab(searchParams.get('tab'))");
    expect(home).toMatch(
      /case '4':[\s\S]+resolveCashierWallet\(eligibleCashierWallets\(userClubs\)/
    );
  });

  it('keeps retry ids for claim and reverse operations', () => {
    expect(modal).toContain('claimOpIdsRef.current.get(row.transaction_id) || newOpId()');
    expect(modal).toContain('reverseOpIdsRef.current.get(row.id) || newOpId()');
    expect(modal).not.toContain('p_op_id: newOpId()');
  });

  it('serialises request quotas and binds request replays to their intent', () => {
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('chip-request:'");
    expect(sql).toContain('v_prior.amount is distinct from p_amount');
    expect(sql).toContain('chip_requests_requester_op_uidx');
    expect(page).toContain('p_op_id: requestOpIdRef.current');
  });

  it('locks both memberships and conditionally debits before issuing a ticket', () => {
    expect(sql).toContain('rename column issuer_id to issued_by');
    expect(sql).toContain('drop column issuer_id');
    expect(sql).toContain("'cashier-hierarchy:'||p_club_id::text");
    expect(sql).toMatch(/user_id=v_first for update[\s\S]+user_id=v_second for update/);
    expect(sql).toMatch(/coalesce\(chip_balance,0\)>=p_value returning chip_balance into v_after/);
    expect(sql).toContain("'ticket_id',v_ticket_id");
    expect(sql).toContain("'tournament_ticket_issue'");
    expect(sql).toContain("check (status in ('issued','redeemed','cancelled'))");
  });

  it('guards agent balances from direct authenticated updates', () => {
    expect(sql).toContain("current_user in ('authenticated','anon')");
    expect(sql).toContain('guard_agent_wallet_direct_update');
    expect(sql).toContain('new.player_balance is distinct from old.player_balance');
    expect(sql).toContain('new.promo_balance is distinct from old.promo_balance');
    expect(sql).toContain('revoke insert, update, delete on public.agents');
    expect(sql).toContain('lock_cashier_hierarchy_update');
  });

  it('locks send authority and binds agent wallet replays to target and amount', () => {
    expect(sendGuard).toContain("'agent-wallet-send:'");
    expect(sendGuard).toContain("'cashier-hierarchy:'");
    expect(sendGuard).toContain('v_prior.to_user_id is distinct from p_to_user_id');
    expect(sendGuard).toContain('v_prior.amount is distinct from p_amount');
    expect(sendGuard).toMatch(/clubs where id=p_club_id for update/);
    expect(sendGuard).toContain('Your Cashier Authority Is No Longer Active');
    expect(sendGuard).toContain('revoke all on function public.fn_agent_wallet_send_core_20260830');
    expect(sendGuard).toContain('v_replay_destination');
  });

  it('invalidates all club-scoped async state and resets cashier pagination', () => {
    expect(page).toMatch(/\+\+pendingCountVersion\.current;[\s\S]+\+\+reqSeqRef\.current/);
    expect(page).toContain('setVisibleCount(25)');
    expect(page).toContain('version !== pendingCountVersion.current');
    expect(page).toContain('version !== heldTicketCountVersion.current');
  });

  it('uses accessible tab patterns for club and union cashier workspaces', () => {
    expect(union).toContain('role="tablist"');
    expect(union).toContain('role="tabpanel"');
    expect(union).toContain('aria-selected={tab === t.id}');
  });

  it('loads roster horse flags in the scoped RPC response', () => {
    expect(page).toMatch(/supabase\s*\.rpc\(\s*'fn_club_cashier_members_v2'/);
    expect(page).not.toContain(".select('id, is_horse')");
    expect(sql).toContain('coalesce(p.is_horse, false)');
    expect(sql).toContain('order by m.role_rank desc, m.user_id');
    expect(page).toContain('.range(offset, offset + rosterPageSize - 1)');
  });

  it('blocks money submissions while role and roster authority are refreshing', () => {
    expect(page).toContain('if (loading || !roleResolved || loadError)');
    expect(page).toContain('busy || loading || !roleResolved || !!loadError');
  });
});
