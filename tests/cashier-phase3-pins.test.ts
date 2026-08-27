/**
 * Pins for the 2026-08-27 cashier phase-3 audit: the classic cashier's
 * Distribute surfaces spend the pools they display, through the canonical
 * RPCs, and the hot-path indexes stay declared.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const PANEL = read('src/components/agent/AgentPromoPanel.tsx');
const PAGE = read('src/pages/CashierPage.tsx');
const MIGRATION = read(
  'supabase/migrations/20260827_cashier_phase3_mint_status_and_hot_indexes.sql'
);

describe('the promo panel spends the pool it displays', () => {
  it('reads agents.promo_wallet_balance and sends through fn_promo_wallet_send', () => {
    expect(PANEL).toContain('promo_wallet_balance');
    expect(PANEL).toContain("supabase.rpc('fn_promo_wallet_send'");
  });

  it('never routes through the dead distribute-promo path again', () => {
    // The comment explaining WHY still names the old route; only the CALL
    // is forbidden.
    expect(PANEL).not.toContain('callClubArenaApi');
  });

  it('holds its op id across a failed attempt', () => {
    expect(PANEL).toMatch(/if \(!opIdRef\.current\) opIdRef\.current = newOpId\(\)/);
  });
});

describe('the Distribute tab does what its copy says', () => {
  it('routes bank roles onto fn_club_bank_send and agents onto fn_agent_wallet_send', () => {
    expect(PAGE).toMatch(/viaClubBank \? 'fn_club_bank_send' : 'fn_agent_wallet_send'/);
  });

  it('never calls the dead distribute-promo route', () => {
    expect(PAGE).not.toContain('callClubArenaApi');
  });
});

describe('the phase-3 migration keeps its guarantees', () => {
  it('declares both hot-path indexes', () => {
    expect(MIGRATION).toContain('idx_chip_tx_club_created');
    expect(MIGRATION).toContain('tournament_tickets_issuer_idx');
  });

  it('lets legacy-approved staff mint', () => {
    expect(MIGRATION).toMatch(/coalesce\(cm\.status, 'active'\) in \('active', 'approved'\)/);
  });
});
