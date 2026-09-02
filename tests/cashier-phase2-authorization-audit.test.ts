import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20260831235990_cashier_authorization_and_audit_contracts.sql'
  ),
  'utf8'
);

describe('cashier Phase 2 authorization and audit contracts', () => {
  it('removes every legacy broad roster, agent, and ticket policy', () => {
    expect(MIGRATION).toContain('drop policy if exists club_members_select');
    expect(MIGRATION).toContain('drop policy if exists agents_select');
    expect(MIGRATION).toContain('drop policy if exists "View tickets"');
    expect(MIGRATION).toContain('drop policy if exists tournament_tickets_read');
  });

  it('recreates self, staff, and cashier-downline visibility explicitly', () => {
    expect(MIGRATION).toContain('create policy "Members can read own club memberships"');
    expect(MIGRATION).toContain('create policy "Club staff can read club rosters"');
    expect(MIGRATION).toContain('create policy cashier_downline_read');
    expect(MIGRATION).toContain('create policy agents_cashier_scoped_read');
    expect(MIGRATION).toContain('fn_club_cashier_can_transact');
  });

  it('requires caller-owned retry keys before all three money cores', () => {
    expect(MIGRATION).toContain('A Retry Key Is Required For Every Send');
    expect(MIGRATION).toContain('A Retry Key Is Required For Every Claim Back');
    expect(MIGRATION).toContain('A Retry Key Is Required For Every Ticket');
    expect(MIGRATION).toMatch(
      /revoke all on function public\.fn_agent_wallet_send_phase2_core_20260831[\s\S]*from public, anon, authenticated/
    );
    expect(MIGRATION).toMatch(
      /revoke all on function public\.fn_agent_wallet_claim_back_phase2_core_20260831[\s\S]*from public, anon, authenticated/
    );
    expect(MIGRATION).toMatch(
      /revoke all on function public\.fn_issue_tournament_ticket_phase2_core_20260831[\s\S]*from public, anon, authenticated/
    );
  });

  it('gives both ticket closing legs distinct ticket-linked receipts', () => {
    expect(MIGRATION).toContain("transaction_type='tournament_ticket_cancel'");
    expect(MIGRATION).toContain("transaction_type='tournament_ticket_redeem'");
    expect(MIGRATION).toContain("'ticket_id',p_ticket_id");
    expect(MIGRATION).toContain('chip_transactions_ticket_cancel_receipt_uidx');
    expect(MIGRATION).toContain('chip_transactions_ticket_redeem_receipt_uidx');
  });

  it('makes cancel and redeem retries replay the original receipt', () => {
    expect(MIGRATION).toContain("if v_t.status='cancelled'");
    expect(MIGRATION).toContain("if v_t.status='redeemed'");
    expect(MIGRATION).toContain("'success',true,'replayed',true");
  });
});
