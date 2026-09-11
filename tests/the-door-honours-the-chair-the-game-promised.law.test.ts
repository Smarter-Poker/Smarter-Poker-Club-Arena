/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DOOR HONOURS THE CHAIR THE GAME PROMISED (2026-09-10, must-move audit
 *  lane B, finding F10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The cluster tick plans a must-move into an open chair and every count of
 * open chairs treats that plan as a reservation (`fn_cash_game_open_seats`,
 * the planner, the lobby). The buy-in gate did not: it counted seats taken
 * plus `table_waitlist` holds and nothing else, so a browser or the horse
 * fleet could take the chair the game had promised to a mover, who was then
 * refused `destination_full` - 17 of 41 in 24 hours.
 *
 * One clause beside the hold count, counting EXACTLY what
 * `fn_cash_game_open_seats` counts (pending, unlinked, into this table) and
 * never the player's own move. A linked swap row is not a reservation (both
 * chairs are occupied; the 2026-09-05 lobby changelog says so). The refusal
 * keeps the `SEAT_RESERVED:` prefix the client already recovers from.
 *
 * Pins are on the migration text; the behaviour was proven rolled back on
 * production (scripts/dev/probe-join-door-hold.sql, S23-S28).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIG = read('supabase/migrations/20260910184427_the_door_honours_the_chair_the_game_promised.sql');
const OPEN_SEATS = read(
  'supabase/migrations/20260905060000_the_must_move_lobby_a_seat_change_and_the_order_you_joined.sql'
);

describe('the door honours the chair the game promised', () => {
  it('counts pending, unlinked moves into the table, never the player\'s own', () => {
    expect(MIG).toMatch(/SELECT COUNT\(\*\) INTO v_moves\s*\n\s*FROM public\.cash_seat_moves m/);
    expect(MIG).toMatch(/m\.to_table_id = p_table_id\s*\n\s*AND m\.state = 'pending'\s*\n\s*AND m\.swap_move_id IS NULL\s*\n\s*AND m\.player_id <> p_user_id;/);
  });

  it('counts exactly what fn_cash_game_open_seats counts', () => {
    // The census's predicate, from the migration that defines it.
    expect(OPEN_SEATS).toMatch(/m\.to_table_id = t\.id AND m\.state = 'pending' AND m\.swap_move_id IS NULL/);
    // No reason filter and no expires_at filter here either: the two readers
    // must agree in the 5 s before the tick sweeps a lapsed move.
    // The clause as written into the gate (the last occurrence; the header
    // quotes it once more in prose).
    const start = MIG.lastIndexOf('SELECT COUNT(*) INTO v_moves');
    const clause = MIG.slice(start, MIG.indexOf('IF v_seats_taken + v_holds >= v_max_players', start));
    expect(clause).not.toMatch(/reason/);
    expect(clause).not.toMatch(/expires_at/);
    expect(MIG).toMatch(/fn_cash_game_open_seats no longer counts pending unlinked moves the way the door now does/);
  });

  it('names every reason a pending move can exist, and says which are reservations', () => {
    for (const reason of ['must_move', 'break', 'balance', 'seat_change']) {
      expect(MIG).toMatch(new RegExp(`^--   ${reason}`, 'm'));
    }
    expect(MIG).toMatch(/seat_change, linked \(swap_move_id IS NOT NULL\)[\s\S]{0,400}NOT A RESERVATION/);
  });

  it('refuses with the SEAT_RESERVED prefix the client already recovers from', () => {
    expect(MIG).toMatch(/'SEAT_RESERVED: the open seat is held for a player the game is moving here'/);
    // and keeps the waiting-list refusal as it was
    expect(MIG).toMatch(/'SEAT_RESERVED: the open seat is held for the next player on the waiting list'/);
    expect(MIG).toMatch(/the waiting-list refusal was lost/);
  });

  it('names the client copy that lane G would add, without editing the client', () => {
    expect(MIG).toMatch(/src\/lib\/cashBuyIn\.ts/);
    expect(MIG).toMatch(/SEAT_RESERVED: \.\*moving here/);
    expect(MIG).toMatch(/This Chair Is Held For A Player The Game Is Moving Here\. Tap Join Game For The Next Open Chair\./);
  });

  it('patches the live gate by anchor and checks every landmark of the money path', () => {
    expect(MIG).toMatch(/pg_get_functiondef\('public\.atomic_table_buyin_before_maintenance_announcement_gate'::regproc\)/);
    expect(MIG).not.toMatch(/CREATE OR REPLACE FUNCTION public\.atomic_table_buyin/);
    for (const landmark of [
      'transaction_idempotency_keys', 'fn_caller_session_is_live', 'fn_cash_rejoin_floor', 'BUYIN_BELOW_FLOOR',
      'Banned from this club', 'VIP_ONLY', 'fn_nit_check', 'Player already seated at this table',
      'TABLE_SIZE: table is full', 'TABLE_CAP_REACHED', 'fn_seat_club_for_user', 'fn_ensure_club_wallet',
      'chip_balance = chip_balance - p_amount', 'Insufficient club chips for buy-in', 'fn_cash_session_open', 'wallet_transactions',
    ]) {
      expect(MIG).toContain(landmark);
    }
    expect(MIG).toMatch(/823cfb123c2d5041ecc824d188a31997/);
    expect(MIG).toMatch(/buy-in gate already applied/);
  });

  it('reads is_horse nowhere and refuses a gate that does (CLAUDE.md 10.5)', () => {
    expect(MIG).toMatch(/OR position\('is_horse' in v_new\) > 0 THEN/);
    expect(MIG).toMatch(/the buy-in gate must not read is_horse/);
  });

  it('is one transaction and asserts afterwards', () => {
    expect(MIG.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(MIG.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(MIG).toMatch(/\$assert\$/);
  });

  it('no em dashes anywhere (CLAUDE.md 10.7)', () => {
    // \u2014 by escape, never the literal: this file is code too.
    expect(MIG).not.toMatch(/\u2014/);
  });
});
