/**
 * THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER.
 *
 * Dan, 2026-09-13, twice in one hour, after I proposed an "arena chips" plate
 * and a diamonds-to-chips conversion flow for the wallet: "NO ARENA CHIPS,
 * DIAMOND ARENA IS DIAMONDS ONLY NO CHIPS EVER."
 *
 * The database already refuses it at the root (poker_arena_membership_guard,
 * 20260908152855: a diamonds-club membership with any chip balance raises
 * "Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy").
 * This law keeps the WALLET from ever drawing one: the summary read, the
 * ledger labels and the wallet page carry no chip figure for the arena, and
 * the guard that makes it impossible stays in the migrations.
 *
 * Measured 2026-09-13 before this law: the arena club had 0 members with a
 * chip balance, 0 chip_ledger rows, 0 chip stacks across its 17 tables.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the Diamond Arena is diamonds only', () => {
  it('the summary read reports diamonds and no chip figure', () => {
    const service = read('src/services/DiamondService.ts');
    const summary = service.slice(
      service.indexOf('export interface DiamondArenaInfo'),
      service.indexOf('export interface DiamondLifetimeStats')
    );
    expect(summary.length).toBeGreaterThan(100);
    expect(summary).not.toMatch(/chip/i);
    expect(summary).toContain('inArena: number;');
    expect(summary).toContain('cashGamesEnabled: boolean;');
  });

  it('the summary RPC reads custody and the arena flags, never a chip balance', () => {
    const migration = read(
      'supabase/migrations/20260914015457_the_wallet_learns_the_diamond_arena.sql'
    );
    const body = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary'),
      migration.indexOf('COMMENT ON FUNCTION public.fn_diamond_wallet_summary')
    );
    expect(body).toContain('FROM public.poker_diamond_custody');
    expect(body).toContain("c.asset = 'diamonds'");
    expect(body).not.toMatch(/chip_balance|club_members|chip_ledger/);
    // Own-user only: a player cannot read another player's figures.
    expect(body).toContain("RAISE EXCEPTION 'wallet_summary_is_own_only'");
  });

  it('the arena ledger kinds are labelled as diamonds, not chips', () => {
    const modal = read('src/components/wallet/DiamondWalletModal.tsx');
    expect(modal).toMatch(/arena_deposit: \{[^}]*label: 'Diamond Arena Buy-In'/);
    expect(modal).toMatch(/arena_withdraw: \{[^}]*label: 'Diamond Arena Cash-Out'/);
    // The ENTRY lines, not the comment above them that explains the rule.
    const arenaLines = modal.split('\n').filter((l) => /^\s+arena_(deposit|withdraw):/.test(l));
    expect(arenaLines).toHaveLength(2);
    for (const line of arenaLines) expect(line).not.toMatch(/chip/i);
  });

  it('no wallet surface pairs the arena with chips', () => {
    const files = [
      'src/pages/PlayerWalletPage.tsx',
      'src/services/DiamondService.ts',
      'src/hooks/useDiamondLedger.ts',
      'src/components/wallet/DiamondWalletModal.tsx',
    ];
    for (const f of files) {
      const src = read(f);
      // "arena chips", "chips for the arena", "convert ... to chips": none of it.
      expect(src, f).not.toMatch(/arena[ _-]?chips?/i);
      expect(src, f).not.toMatch(/chips? (for|in|at|into) the (diamond )?arena/i);
      expect(src, f).not.toMatch(/diamonds? (to|into) (arena )?chips/i);
    }
  });

  it('the database guard that refuses a chip wallet on the diamonds club is still in the migrations', () => {
    const dir = resolve(process.cwd(), 'supabase/migrations');
    const carriers = readdirSync(dir).filter((f) =>
      readFileSync(resolve(dir, f), 'utf8').includes(
        'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy'
      )
    );
    expect(carriers).toContain('20260908152822_poker_arena_identity_and_access.sql');
  });
});
