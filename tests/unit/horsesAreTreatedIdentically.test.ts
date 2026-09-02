/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSES ARE PLAYERS — the table cannot tell them apart (Dan, 2026-08-27)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER
 * NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING
 * FOR THE CLUB ARENA. YES IT STILL NEEDS TO THE SAME 5 SECOND PAUSE TO REBUY.
 * NOT EVERY HORSE ALWAYS REBUYS IN THE CASH GAMES, AND IF YOU DIDN'T GIVE THEM
 * THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE WOULD NOTICE!"
 *
 * The bug this pins: the rebuy pause filtered `p.is_horse === false`, so the
 * table held five seconds when a human busted and rolled straight on when a
 * horse did. The tell is the RHYTHM of the table — a seat whose bust never
 * costs the table a beat is a seat anybody can identify as a horse.
 *
 * These are source-level guards rather than engine integration tests because
 * the defect is a one-token filter that reads as harmless in review, and it is
 * exactly the kind of thing that gets reintroduced by someone "optimising" a
 * pause away. See CLAUDE.md section 10.5.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const DEALING = 'server/src/engine/ServerTableEngineDealing.ts';

describe('the bust/rebuy pause is identical for horses and humans', () => {
  it('pauses for every busted player, with no horse filter', () => {
    const src = read(DEALING);
    // The pause population must not be narrowed to humans.
    expect(src).toMatch(
      /const justBustedPlayers = activePlayers\.filter\(\(p\) => p\.stack === 0\)/
    );
    expect(src).not.toMatch(/justBustedHumans/);
  });

  it('never re-introduces an is_horse test in the bust filter', () => {
    const src = read(DEALING);
    const start =
      src.indexOf('Dan’s Rebuy Pause') >= 0
        ? src.indexOf('Dan’s Rebuy Pause')
        : src.indexOf("Dan's Rebuy Pause");
    expect(start).toBeGreaterThan(-1);
    // The filter that decides WHO the table waits for may not consult is_horse.
    // Pinned to the declaration itself, so it cannot drift out of a window.
    const filterLine = sliceStatement(src, 'const justBustedPlayers =');
    expect(filterLine).not.toMatch(/is_horse/);
  });

  it('still actually pauses (the window is what a busted player is owed)', () => {
    const src = read(DEALING);
    expect(src).toMatch(/setLoopPhase\('rebuy_pause'\)/);
    expect(src).toMatch(/await this\.sleep\(5000\)/);
  });
});

/**
 * THE SEAT CALL (2026-08-31).
 *
 * `fn_offer_open_seat` picked the head of the waitlist with an `is_horse`
 * exclusion, so a horse could hold a place in line forever and never be
 * offered the seat. Measured before the fix: 10,004 of 10,055 `table_waitlist`
 * rows were horses, 301 in 24 hours, and not one was ever offered — every
 * horse row ended at `cleared`, never `notified`, while human offers expired
 * unclaimed beside them.
 *
 * Dan, binding: "MAKE HORSES ANSWER A SEAT CALL, PROGRAM THAT IN FULLY, THEY
 * SHOULD NEVER BE SKIPPED."
 *
 * Deleting the exclusion alone would have been worse than leaving it: a horse
 * has no client to click "sit down", so the seat would idle for the full
 * 60-second hold while a real player waited. Both halves are the fix, and this
 * pins both — the same shape `rit_offer` already learned in 2026-08-18, where
 * the answer was to make the horse RESPOND, never to skip it.
 */
describe('a seat call is answered by whoever is first in line', () => {
  const FLEET = 'server/src/services/HorseFleetManager.ts';

  it('the fleet has a claim path for a seat it has been offered', () => {
    const src = read(FLEET);
    expect(src).toMatch(/private async claimOfferedSeats\(/);
    // It must act on a HELD seat, which is what 'notified' means.
    const body = sliceStatement(src, 'private async claimOfferedSeats(');
    expect(body).toMatch(/'notified'/);
    expect(body).toMatch(/seatHorse\(/);
    // And it must close the row out, or ensureWaitlist counts the horse as
    // still holding and never queues it again.
    expect(body).toMatch(/status: 'seated'/);
  });

  it('claims a called seat BEFORE seeding fills it with somebody else', () => {
    const src = read(FLEET);
    const claimAt = src.indexOf('await this.claimOfferedSeats(');
    const seedAt = src.indexOf('for (const table of orderedTables) {');
    expect(claimAt, 'the seeding cycle never claims offered seats').toBeGreaterThan(-1);
    expect(seedAt).toBeGreaterThan(-1);
    // The hold stops further OFFERS, not this manager seeding that same seat.
    expect(
      claimAt,
      'seeding runs before the claim, so a held seat can be taken by another horse'
    ).toBeLessThan(seedAt);
  });

  it('an expired hold is left for the sweep, not claimed late', () => {
    const body = sliceStatement(read(FLEET), 'private async claimOfferedSeats(');
    expect(body).toMatch(/hold_expires_at/);
    expect(body).toMatch(/continue;/);
  });

  it('the buy-in is sized by ONE function, shared with seeding', () => {
    const src = read(FLEET);
    expect(src).toMatch(/private computeHorseBuyIn\(/);
    // Two copies of this arithmetic is the bug src/lib/cashBuyIn.ts exists to
    // end. Both callers must go through the one helper.
    const calls = src.match(/this\.computeHorseBuyIn\(/g) ?? [];
    expect(calls.length, 'both the seeding loop and the claim path must use it').toBe(2);
  });

  it('the migration that removed the exclusion carries its own guard', () => {
    const sql = read(
      'supabase/migrations/20260831190110_the_seat_call_never_skips_a_horse.sql'
    );
    // The guard re-runs on every replay and fails if the filter comes back.
    expect(sql).toMatch(/still excludes horses from the queue/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    // Grants and the entry TTL are restated from production, not invented.
    expect(sql).toMatch(/p_entry_ttl interval DEFAULT '24 hours'::interval/);
    expect(sql).toMatch(/TO service_role;/);
  });
});

describe('the law is written down where the next agent will read it', () => {
  it('CLAUDE.md carries the binding section and forbids the carve-out', () => {
    const md = read('CLAUDE.md');
    expect(md).toMatch(/HORSES ARE PLAYERS/);
    expect(md).toMatch(/NO "EQUAL OUTCOME BY A DIFFERENT MECHANISM" EXEMPTION/);
    expect(md).toMatch(/TIMING IS PART OF THE TREATMENT/);
  });
});
