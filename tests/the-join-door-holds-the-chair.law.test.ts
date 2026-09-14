/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE JOIN DOOR HOLDS THE CHAIR IT HANDS OUT (2026-09-10, must-move audit
 *  lane B, finding F6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_cash_game_join` answered `action: 'seat'` with a table it did not hold,
 * so two players told about the same last chair both got it and the second
 * was refused at `atomic_table_buyin` (23505 / TABLE_SIZE). The 2026-09-09
 * client recovery is a net; CLAUDE.md 10.12 says a net is not a fix.
 *
 * The door now writes the SAME hold the open-seat offer writes - a
 * `table_waitlist` row `notified`, `hold_expires_at = now() + 60s` - which the
 * buy-in gate (SEAT_RESERVED, excluding the holder), `fn_cash_game_open_seats`
 * and the census already honour. Each candidate table is locked on the
 * buy-in gate's own key before the hold is written, so two callers in the
 * same instant are serialized. One live hold per player per game.
 *
 * Pins are on the migration text; the behaviour was proven rolled back on
 * production (scripts/dev/probe-join-door-hold.sql, S17-S22).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIG = read(
  'supabase/migrations/20260910183043_the_join_door_holds_the_chair_it_hands_out.sql'
);

describe('the join door holds the chair it hands out', () => {
  it('writes the same hold the open-seat offer writes', () => {
    expect(MIG).toMatch(
      /INSERT INTO public\.table_waitlist \(table_id, user_id, position, status, notified_at, hold_expires_at\)/
    );
    expect(MIG).toMatch(/VALUES \(t\.id, v_uid, 0, 'notified', now\(\), v_hold_until\)/);
    expect(MIG).toMatch(/v_hold_ttl CONSTANT interval := interval '60 seconds'/);
  });

  it("locks each candidate on the buy-in gate's own key before writing the hold", () => {
    expect(MIG).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('table_seat:' \|\| t\.id::text, 0\)\)/
    );
    // and re-reads under the lock: the second of two same-instant callers moves on
    expect(MIG).toMatch(/CONTINUE WHEN public\.fn_cash_game_open_seats\(t\.id\) <= 0;/);
  });

  it('asking twice is one hold: an existing live hold is returned and refreshed', () => {
    expect(MIG).toMatch(
      /w\.user_id = v_uid AND w\.status = 'notified' AND w\.hold_expires_at > now\(\)/
    );
    expect(MIG).toMatch(
      /UPDATE public\.table_waitlist SET hold_expires_at = v_hold_until WHERE id = h\.id;/
    );
  });

  it('one live hold per player per game, on both branches', () => {
    const expiries = MIG.match(/AND w\.user_id = v_uid AND w\.status = 'notified';/g) ?? [];
    expect(expiries.length).toBeGreaterThanOrEqual(2);
    expect(MIG).toMatch(/tb\.cluster_id = g\.id AND w\.id <> h\.id/);
    expect(MIG).toMatch(/tb\.cluster_id = g\.id AND w\.table_id <> t\.id/);
  });

  it('the chairs open TO THE CALLER count the one they hold', () => {
    expect(MIG).toMatch(/'open_seats', public\.fn_cash_game_open_seats\(t\.id\) \+ 1/);
    expect(MIG).toMatch(/'open_seats', public\.fn_cash_game_open_seats\(h\.table_id\) \+ 1/);
  });

  it('the response shape is additive only: no new action, no new copy', () => {
    // The client (lane G, cashGameLobby.ts) navigates on 'seat' and ignores
    // unknown keys; the only new key is hold_expires_at.
    expect(MIG).toMatch(/'hold_expires_at', v_hold_until/);
    expect(MIG).toMatch(/'action', 'seat'/);
    expect(MIG).toMatch(/'action', 'waitlisted'/);
    expect(MIG).toMatch(/'action', 'seated'/);
    expect(MIG).not.toMatch(/'action', '(held|hold|reserved)'/);
  });

  it('answers the three questions in its header', () => {
    expect(MIG).toMatch(/\(a\) THE SAME CALLER BUYING IN WITHIN THE MINUTE IS ADMITTED/);
    expect(MIG).toMatch(/\(b\) A SECOND CALLER IN THAT MINUTE IS TOLD THE TRUTH/);
    expect(MIG).toMatch(/\(c\) HORSES ARE PLAYERS/);
  });

  it('reads is_horse nowhere and asserts so (CLAUDE.md 10.5)', () => {
    const body = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_game_join'));
    const fn = body.slice(0, body.indexOf('$function$', body.indexOf('$function$') + 10));
    expect(fn).not.toMatch(/is_horse/);
    expect(MIG).toMatch(/the join door must not read is_horse/);
  });

  it('asserts the two readers it relies on still honour the row (10.86 rule 3)', () => {
    expect(MIG).toMatch(
      /the buy-in gate no longer honours a notified hold the way this door relies on/
    );
    expect(MIG).toMatch(/fn_cash_game_open_seats no longer subtracts a live hold/);
  });

  it('is one transaction, md5-guarded, self-skipping', () => {
    expect(MIG.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(MIG.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(MIG).toMatch(/65c5304a59da3882a540794de16fe9a7/);
    expect(MIG).toMatch(/join door already applied/);
  });

  it('no em dashes anywhere (CLAUDE.md 10.7)', () => {
    // \u2014 by escape, never the literal: this file is code too.
    expect(MIG).not.toMatch(/\u2014/);
  });
});
