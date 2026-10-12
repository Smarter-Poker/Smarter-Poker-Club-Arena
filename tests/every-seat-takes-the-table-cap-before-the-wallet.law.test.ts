/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - EVERY SEAT TAKES THE TABLE CAP BEFORE THE WALLET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 11 of the Diamond Arena programme, line 2 (concurrency, duplicate
 * delivery and crash recovery). Two per-player locks guard a seat: the
 * table-cap lock and the Daily Missions lock on the profile row, which for a
 * Diamond player is the wallet. Every cash seat door takes the table cap
 * first. 20260930123828 made a Diamond seat acquisition take it first too, and
 * left a chip one on the old order - so one player's chip registration and
 * Diamond registration (or Diamond cash buy-in) deadlocked, which the
 * concurrency suite reproduced against production's own doors.
 *
 * 20260930131333 takes the table cap before the Daily Missions lock for every
 * seat acquisition, whatever the event's asset, by asserted substitution on the
 * block 20260930123828 installed (live md5 pinned, marker found once, reverse
 * proved). This pins that the new block has no asset condition, that the cap
 * comes before the Daily Missions lock, that the lock it orders is the one the
 * roster trigger and both cash buy-ins take, and the closing assertions.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_every_seat_takes_the_table_cap_before_the_wallet.sql'))
  .at(-1);
if (!NAME) throw new Error('the every-seat lock-order migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const EDIT = sliceBetween(
  MIG,
  '-- 1. EVERY SEAT ACQUISITION TAKES THE TABLE CAP BEFORE THE DAILY MISSIONS LOCK',
  '-- 2. THE ESTATE IS AS IT WAS'
);
const FINAL = sliceBetween(MIG, '-- 2. THE ESTATE IS AS IT WAS', 'COMMIT;');
const between = (from: string, to: string) => sliceBetween(EDIT, from, to).slice(from.length);
const OLD = between('v_old CONSTANT text := $old$', '$old$;');
const NEW = between('v_new CONSTANT text := $new$', '$new$;');

describe('LAW: every seat takes the table cap before the wallet', () => {
  it('opens nothing and declares its own proof of being live', () => {
    expect(code(MIG)).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*:?=\s*true/i);
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(MIG).toMatch(
      /^-- @live-proof: position\('WHERE c\.asset = ''diamonds''' in .*\) = 0 AND .*table_cap.*BETWEEN 1 AND .*fn_lock_daily_mission_user/m
    );
  });

  it('edits the seat acquisition in place: pinned, found once, proved in reverse', () => {
    const pin = /IF md5\(v_def\) <> '([0-9a-f]{32})' THEN/.exec(EDIT)?.[1];
    expect(pin, 'the live md5 pin is missing').toBeTruthy();
    expect(EDIT).toContain(`IF md5(replace(v_after, v_new, v_old)) <> '${pin}' THEN`);
    expect(MIG).toContain(`fn_ca_lock_tournament_seat_acquisition   ${pin}`);
    expect(EDIT).toContain(
      "RAISE EXCEPTION 'the Diamond-only table-cap block found % time(s), expected 1', v_hits;"
    );
    expect(EDIT).toContain('EXECUTE replace(v_def, v_old, v_new);');
  });

  it('replaces the Diamond-only block with one that has no asset condition', () => {
    expect(OLD).toContain("WHERE c.asset = 'diamonds'");
    expect(OLD).toContain('IF p_user_id IS NOT NULL AND EXISTS (');
    expect(code(NEW)).not.toMatch(/asset/i);
    expect(code(NEW)).not.toContain('EXISTS');
    expect(code(NEW).replace(/\s+/g, ' ').trim()).toBe(
      "IF p_user_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0)); PERFORM public.fn_lock_daily_mission_user(p_user_id); END IF;"
    );
  });

  it('checks that the lock it orders is the one the roster trigger and both cash buy-ins take', () => {
    expect(EDIT).toContain(
      "PERFORM pg_advisory_xact_lock(hashtextextended(''table_cap:'' || NEW.user_id::text, 0));"
    );
    expect(EDIT).toContain("hashtextextended(''table_cap:''||p_user_id,0)");
    expect(EDIT).toContain('the Diamond cash buy-in no longer takes the table_cap lock first');
    expect(EDIT).toContain('atomic_table_buyin_before_maintenance_announcement_gate');
    expect(EDIT).toContain('the chip cash buy-in no longer takes the table_cap lock');
    expect(EDIT).toContain(
      "IF has_function_privilege('anon', 'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)', 'EXECUTE') THEN"
    );
  });

  it('asserts at the end that the order landed for every event, the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain('IF v_cap = 0 OR v_dm = 0 OR v_cap > v_dm');
    expect(FINAL).toContain("OR position('WHERE c.asset = ''diamonds''' IN v_def) <> 0 THEN");
    expect(FINAL).toContain(
      'IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN'
    );
    expect(FINAL).toContain("RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;");
  });
});
