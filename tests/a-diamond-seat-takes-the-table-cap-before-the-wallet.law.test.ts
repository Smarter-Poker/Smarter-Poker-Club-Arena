/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND SEAT TAKES THE TABLE CAP BEFORE THE WALLET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 11 of the Diamond Arena programme, line 2 (concurrency, duplicate
 * delivery and crash recovery). The concurrency suite released one player's
 * five spenders at once against production's doors and the cash buy-in died
 * of a deadlock: the Diamond cash doors take the player's table-cap lock and
 * then the wallet (the profile row), while a Diamond registration took the
 * profile first (the Daily Missions lock in fn_ca_lock_tournament_seat_acquisition)
 * and the table-cap lock last (the roster trigger fn_enforce_booking_game_cap).
 *
 * The fix takes the table-cap lock for a Diamond event before the Daily
 * Missions lock, by asserted substitution (live md5 pinned, marker found once,
 * reverse proved), and checks that the lock taken is the very lock the roster
 * trigger and the buy-in take. It left a chip event on the old order, which made
 * one player's chip entry and Diamond entry a new deadlocking pair;
 * 20260930131333 (tests/every-seat-takes-the-table-cap-before-the-wallet.law.test.ts)
 * takes the table cap first for every event. This law pins what 123828's own
 * file says; the order production runs is the later law's.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_seat_takes_the_table_cap_before_the_wallet.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond seat lock-order migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const EDIT = sliceBetween(
  MIG,
  '-- 1. A DIAMOND SEAT ACQUISITION TAKES THE TABLE CAP BEFORE THE DAILY MISSIONS LOCK',
  '-- 2. THE ESTATE IS AS IT WAS'
);
const FINAL = sliceBetween(MIG, '-- 2. THE ESTATE IS AS IT WAS', 'COMMIT;');

describe('LAW: a Diamond seat takes the table cap before the wallet', () => {
  it('opens nothing and declares its own proof of being live', () => {
    expect(code(MIG)).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*:?=\s*true/i);
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(MIG).toMatch(/^-- @live-proof: .*table_cap.*fn_ca_lock_tournament_seat_acquisition/m);
  });

  it('edits the seat acquisition in place: pinned, found once, proved in reverse', () => {
    expect(EDIT).toContain("IF md5(v_def) <> '2d8c9bd676a8ee02e009dd470fbfd585' THEN");
    expect(EDIT).toContain(
      "IF md5(replace(v_after, v_new, v_old)) <> '2d8c9bd676a8ee02e009dd470fbfd585' THEN"
    );
    expect(EDIT).toContain(
      "RAISE EXCEPTION 'Daily Missions lock marker found % time(s), expected 1', v_hits;"
    );
    expect(EDIT).toContain('EXECUTE replace(v_def, v_old, v_new);');
  });

  it('takes the table-cap lock only for a Diamond event, and before the Daily Missions lock', () => {
    const newText = EDIT.slice(EDIT.indexOf('v_new CONSTANT text := $new$'));
    const cap = newText.indexOf(
      "PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));"
    );
    const missions = newText.indexOf('PERFORM public.fn_lock_daily_mission_user(p_user_id);');
    expect(cap).toBeGreaterThan(0);
    expect(missions).toBeGreaterThan(cap);
    expect(newText).toContain("WHERE c.asset = 'diamonds'");
    expect(newText).toContain(
      '(SELECT tb.tournament_id FROM public.tables tb WHERE tb.id = p_table_id)'
    );
  });

  it('checks that the lock it orders is the one the roster trigger and the Diamond buy-in take', () => {
    expect(EDIT).toContain(
      "PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || NEW.user_id::text, 0));"
    );
    expect(EDIT).toContain("hashtextextended(''table_cap:''||p_user_id,0)");
    expect(EDIT).toContain('the Diamond buy-in no longer takes the table_cap lock first');
  });

  it('asserts at the end that the order landed, the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain(
      'a Diamond seat acquisition does not take the table cap before the Daily Missions lock'
    );
    expect(FINAL).toContain(
      'IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN'
    );
    expect(FINAL).toContain("RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;");
  });
});
