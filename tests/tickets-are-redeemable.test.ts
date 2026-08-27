/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TICKETS ARE REDEEMABLE — pins for the 2026-08-26 cashier audit
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Send Ticket escrows real chips off the issuer. Until this audit, NOTHING in
 * either repo called fn_redeem_tournament_ticket or
 * fn_cancel_tournament_ticket, so the escrowed value was unreachable forever.
 * These pins are source-text assertions in the house style of
 * cashier-ui-role-scoping.test.ts: cheap, and they fail loudly if the surface
 * is ever unwired again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const TRADE = read('src/pages/CashierTradePage.tsx');
const MIGRATION = read(
  'supabase/migrations/20260826_cashier_send_out_and_claim_back_audit_fixes.sql'
);

describe('a ticket can leave escrow again', () => {
  it('the holder has a Redeem control wired to the RPC', () => {
    expect(TRADE).toContain("'fn_redeem_tournament_ticket'");
    expect(TRADE).toMatch(/actOnTicket\(t, 'redeem'\)/);
  });

  it('the issuer has a Cancel control wired to the RPC', () => {
    expect(TRADE).toContain("'fn_cancel_tournament_ticket'");
    expect(TRADE).toMatch(/actOnTicket\(t, 'cancel'\)/);
  });

  it('players get the Tickets tab — it is where a sent ticket is redeemed', () => {
    expect(TRADE).toMatch(/key === 'record' \|\| key === 'request' \|\| key === 'tickets'/);
  });

  it('a held unredeemed ticket advertises itself on the tab', () => {
    expect(TRADE).toContain('heldTicketCount');
    expect(TRADE).toMatch(/key === 'tickets' && heldTicketCount > 0/);
  });
});

describe('the migration keeps the money conserved', () => {
  it('cancel refuses when the refund has nowhere to land', () => {
    expect(MIGRATION).toMatch(/nowhere to land/);
  });

  it('chip request approval delegates to the real send path', () => {
    expect(MIGRATION).toMatch(/fn_agent_wallet_send\(\s*v_req\.club_id/);
  });

  it('agents rows are minted with the NOT NULL rates supplied', () => {
    expect(MIGRATION).toMatch(/fn_ensure_agent_row/);
    expect(MIGRATION).toMatch(/commission_rate, player_rakeback_rate/);
  });

  it('ticket issue uses the same downline edge as the roster', () => {
    expect(MIGRATION).toMatch(/fn_club_cashier_can_transact\(p_club_id, v_me, p_holder_id\)/);
  });
});
