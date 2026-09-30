/**
 * THE ARENA PLATE AGREES WITH THE SWITCH (2026-09-30).
 *
 * fn_diamond_wallet_summary used to compute open_cash_tables, min_cash_buy_in
 * and cheapest_table without ever consulting cash_games_enabled, so one read
 * contradicted itself:
 *
 *   { "cash_games_enabled": false, "tournaments_enabled": false,
 *     "open_cash_tables": 17, "min_cash_buy_in": 80,
 *     "cheapest_table": { "name": "NLH 1/2", ... } }
 *
 * The switch is the authority. It is the admission flag fn_poker_diamond_buyin
 * and fn_poker_diamond_top_up enforce, and they are the only doors that fund a
 * Diamond seat, so while it is false every one of those 17 tables refuses a
 * buy-in by name. A table nobody can sit at is not an open table.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

function latestDeclaring(needle: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const body = read(`${MIGRATIONS_DIR}/${files[i]}`);
    if (body.includes(needle)) return body;
  }
  throw new Error(`no migration declares ${needle}`);
}

describe('the arena plate agrees with the switch', () => {
  const body = latestDeclaring('CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary(');
  const decl = body.slice(
    body.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary(')
  );

  it('the cheapest-seat scan runs only while cash games are switched on', () => {
    expect(decl).toContain(
      'IF v_arena.id IS NOT NULL AND COALESCE(v_arena.cash_games_enabled, false) THEN'
    );
    // Exactly one gate on the scan; a second IF would be a second answer.
    expect(decl.match(/IF v_arena\.id IS NOT NULL/g)).toHaveLength(1);
  });

  it('a closed arena therefore reports no open tables and no cheapest seat', () => {
    // v_open starts at zero and only the gated scan ever moves it.
    expect(decl).toMatch(/v_open\s+integer\s*:=\s*0;/);
    // Both seat figures are NULL when the gated scan did not find a table.
    expect(decl).toContain("'min_cash_buy_in',     CASE WHEN v_seat_id IS NULL THEN NULL");
    expect(decl).toContain(
      "'cheapest_table',      CASE WHEN v_seat_id IS NULL THEN NULL ELSE jsonb_build_object("
    );
  });

  /*
   * A RECORD THAT NOTHING ASSIGNED HAS NO STRUCTURE (2026-09-30).
   *
   * The first cut of the gate kept the seat figures in a plpgsql `record`.
   * Skipping the scan left it unassigned, and plpgsql needs a record's tuple
   * structure to evaluate ANY reference to it - including the `IS NULL` test
   * meant to handle exactly that case - so the whole summary raised
   * `55000 record "v_cheapest" is not assigned yet` for every caller, open
   * arena or closed. The own-read probe caught it minutes after it was applied.
   * Scalars are NULL from the start, which is the answer a closed arena owes.
   */
  it('the seat figures are scalars, so a skipped scan leaves nothing unassigned', () => {
    const code = decl
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code, 'no plpgsql record may hold the cheapest seat').not.toContain('v_cheapest');
    expect(code).toMatch(/v_seat_id\s+uuid;/);
    expect(code).toContain('INTO v_seat_id, v_seat_name, v_seat_sb, v_seat_bb, v_seat_min, v_open');
    // A scan that finds no eligible table must leave a readable zero, not NULL.
    expect(code).toContain('v_open := COALESCE(v_open, 0);');
  });

  it('the two flags are still reported as they are, so the surface can say Opens Soon', () => {
    expect(decl).toContain("'cash_games_enabled',  COALESCE(v_arena.cash_games_enabled, false)");
    expect(decl).toContain("'tournaments_enabled', COALESCE(v_arena.tournaments_enabled, false)");
  });

  it('the wallet surface reads the seat figures only while the arena is open', () => {
    const page = read('src/pages/PlayerWalletPage.tsx');
    expect(page).toContain(
      'const arenaOpen = Boolean(arena && (arena.cashGamesEnabled || arena.tournamentsEnabled));'
    );
    // The cheapest-seat sentence and the Sit Down shortfall both sit behind it.
    expect(page).toContain('arenaOpen && !seated && minSeat !== null');
    expect(page).toContain('arena && arenaOpen && minSeat !== null && short === 0 && !seated');
  });
});
