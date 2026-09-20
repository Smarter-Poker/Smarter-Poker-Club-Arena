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

  it('where the diamonds go buckets the arena as diamonds and the panel has no chip vocabulary (phase 5)', () => {
    /* The LIVE map is the one 20260914114052 (the_diamond_kind_map_names_every
       writer) defines; it superseded the first draft in 20260914110559 the
       same day. Pin the version production runs. */
    const migration = read(
      'supabase/migrations/20260914114052_the_diamond_kind_map_names_every_writer.sql'
    );
    const map = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket'),
      migration.indexOf('COMMENT ON FUNCTION public.fn_diamond_kind_bucket')
    );
    expect(map.length).toBeGreaterThan(100);
    // The arena kinds have their own buckets, named as diamonds.
    expect(map).toMatch(/k IN \('arena_deposit', 'tournament_fee'\)\s+THEN 'arena'/);
    expect(map).toMatch(/k IN \('arena_withdraw', 'arena'\)\s+THEN 'arena_cash_outs'/);
    expect(map).toMatch(/WHEN 'arena'\s+THEN 'Diamond Arena Seats'/);
    expect(map).toMatch(/WHEN 'arena_cash_outs'\s+THEN 'Diamond Arena Cash-Outs'/);
    // Nothing that says "arena" ever lands in the club-chips bucket, and the
    // only chip bucket is a member-club purchase, named so.
    const chipLines = map.split('\n').filter((l) => /THEN 'club_chips'/.test(l));
    expect(chipLines.length).toBeGreaterThan(0);
    for (const line of chipLines) {
      expect(line).not.toMatch(/arena/i);
    }
    expect(map).toMatch(/WHEN 'club_chips'\s+THEN 'Club Chip Purchases'/);
    // Every label a player reads: Title Case words, no em dash.
    for (const [, label] of map.matchAll(/THEN '([A-Z][^']*)'/g)) {
      expect(label).not.toContain('\u2014');
      for (const word of label.split(/[\s-]+/)) {
        if (word) expect(word[0], `${label}: ${word}`).toMatch(/[A-Z]/);
      }
    }
    // The panel prints diamonds and nothing else.
    const panel = read('src/components/wallet/DiamondFlowPanel.tsx');
    const math = read('src/components/wallet/diamondFlowMath.ts');
    for (const [name, src] of [
      ['DiamondFlowPanel', panel],
      ['diamondFlowMath', math],
    ] as const) {
      const code = src.slice(src.indexOf('import '));
      expect(code, name).not.toMatch(/chip/i);
    }
    expect(panel).toContain('{fmt(total)} Diamonds');
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
