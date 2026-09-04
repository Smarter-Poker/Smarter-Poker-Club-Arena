/**
 * Dan 2026-09-03: "All club owners and co owners should have a player wallet.
 * add player wallets now to all those roles for clubs only, not for unions.
 * admin's should never have a player wallet. add this in for all current
 * clubs, and new clubs that haven't been created yet."
 *
 * A player wallet IS club_members.chip_balance on the member's own row, so
 * "has a player wallet" means "has an active, non-admin membership row in a
 * club that is not a union house row". The client half of the rule lives in
 * walletRows.ts (which rows render); the data half lives in the migration
 * pinned below (who gets a row, and who may never hold chips in one).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clubWalletRows, clubLobbyWalletRows } from '../src/components/wallet/walletRows';

const root = resolve(__dirname, '..');
const sql = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260903200000_owners_and_co_owners_hold_a_player_wallet_admins_never.sql'
  ),
  'utf8'
);

describe('player wallets: owners and co-owners always, admins never, clubs only', () => {
  it('renders the Player Wallet row for an owner and a co-owner, never for an admin', () => {
    for (const standalone of [true, false]) {
      for (const role of ['owner', 'co_owner'] as const) {
        expect(clubWalletRows(role, { standalone })).toContain('player_wallet');
      }
      expect(clubWalletRows('admin', { standalone })).not.toContain('player_wallet');
    }
    expect(clubLobbyWalletRows('owner')).toContain('player_wallet');
    expect(clubLobbyWalletRows('co_owner')).toContain('player_wallet');
    expect(clubLobbyWalletRows('admin')).not.toContain('player_wallet');
  });

  it('has one predicate for "holds a player wallet", and it excludes admins and unions', () => {
    expect(sql).toContain('FUNCTION public.fn_has_player_wallet(p_club_id uuid, p_user_id uuid)');
    // an active membership row, not an admin, not a union house row
    expect(sql).toMatch(/COALESCE\(cm\.status, 'active'\) IN \('active', 'approved'\)/);
    expect(sql).toMatch(/COALESCE\(cm\.role, 'player'\) <> 'admin'/);
    expect(sql).toMatch(/NOT COALESCE\(c\.is_union, false\)/);
  });

  it('guarantees the wallet for every club owner, present and future', () => {
    expect(sql).toContain('fn_club_owner_has_a_player_wallet');
    expect(sql).toContain('trg_club_owner_has_a_player_wallet');
    expect(sql).toContain('AFTER INSERT OR UPDATE ON public.clubs');
    // Deferred on purpose: fn_create_club_atomic_membership_impl inserts the
    // owner row with a bare INSERT, so an immediate trigger would collide with
    // it and break club creation for everybody.
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    // The wallet is created empty. Opening chips belong to the Club Bank.
    expect(sql).toMatch(/VALUES \(NEW\.id, NEW\.owner_id, 'owner', 'active', 0\)/);
    expect(sql).toContain('ON CONFLICT (club_id, user_id) DO NOTHING');
  });

  it('refuses to let an admin hold chips in a player wallet', () => {
    expect(sql).toContain('fn_admin_holds_no_player_wallet');
    expect(sql).toContain('trg_admin_holds_no_player_wallet');
    expect(sql).toContain('An Admin Does Not Hold A Player Wallet');
    expect(sql).toContain('Cash Out The Player Wallet Before Making This Member An Admin');
    // Popup law: Title Case, and never an em dash.
    expect(sql).not.toMatch(/RAISE EXCEPTION '[^']*—/);
  });

  it('never touches unions', () => {
    // Both guards return early for a union house row, and no union table is written.
    expect(sql).toMatch(/IF COALESCE\(v_is_union, false\) THEN RETURN NEW; END IF;/);
    expect(sql).toMatch(
      /IF NEW\.owner_id IS NULL OR COALESCE\(NEW\.is_union, false\) THEN RETURN NULL; END IF;/
    );
    const code = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/union_wallets|union_members/);
  });

  it('backfills every existing club and proves it', () => {
    expect(sql).toContain('club owners still have no player wallet');
    expect(sql).toContain('admins still hold chips in a player wallet');
    expect(sql).toContain('player wallet guards are not attached');
  });
});
