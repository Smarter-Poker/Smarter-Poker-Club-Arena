/**
 * The bankroll layer refuses seats, caps buy-ins and declines reloads, and
 * every one of those decisions was silent. That silence is what made the
 * 2026-08-31 cash-floor outage take forty minutes to diagnose: a floor that
 * refuses every seat and a floor whose seating path is broken look identical
 * from the outside. The difference is entirely the reason, so these pins are
 * about the reason surviving.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bankrollEvent,
  bankrollCounters,
  bankrollSummaryLine,
  resetBankrollCounters,
} from './HorseBankrollTelemetry.js';

// Server specs run with cwd = server/.
const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
const FLEET = read('services/HorseFleetManager.ts');
const ROTATOR = read('services/HorseSessionRotator.ts');
const TOURNEY = read('services/TournamentRecurringService.ts');
const REBUY = read('services/HorseRebuyPolicy.ts');
const TELEMETRY = read('services/HorseBankrollTelemetry.ts');

describe('telemetry says WHY, and stays quiet when there is nothing to say', () => {
  beforeEach(() => resetBankrollCounters());

  it('a silent cycle prints nothing, because a line of zeroes is a line nobody reads', () => {
    expect(bankrollSummaryLine()).toBeNull();
  });

  it('counts, and orders the loudest reason first', () => {
    bankrollEvent('seat_refused_underrolled', 5);
    bankrollEvent('buyin_capped');
    expect(bankrollCounters().seat_refused_underrolled).toBe(5);
    expect(bankrollSummaryLine()).toMatch(/^\[Bankroll\] seat_refused_underrolled=5 /);
  });

  it('a standing condition is a GAUGE, so re-counting it must not inflate it', () => {
    // 40 stranded horses re-counted every 30 seconds is 115,200 a day, and
    // means nothing. Last value wins for a gauge; events beside it still add.
    bankrollEvent('ladder_exhausted', 40);
    bankrollEvent('ladder_exhausted', 40);
    bankrollEvent('ladder_exhausted', 12);
    expect(bankrollCounters().ladder_exhausted).toBe(12);
    bankrollEvent('topup_refused');
    bankrollEvent('topup_refused');
    expect(bankrollCounters().topup_refused).toBe(2);
  });

  /**
   * The line prints every 30 seconds against counters that only climb. A
   * running total answers "has this ever happened", which is permanently yes
   * after the first occurrence and tells nobody anything at 3am. The delta
   * answers "is this happening NOW", which is the question a quiet floor
   * actually poses.
   */
  it('reports the change since the last line, not the running total', () => {
    bankrollEvent('seat_refused_underrolled', 5);
    expect(bankrollSummaryLine()).toBe('[Bankroll] seat_refused_underrolled=5');
    bankrollEvent('seat_refused_underrolled', 2);
    expect(bankrollSummaryLine()).toBe('[Bankroll] seat_refused_underrolled=2');
    expect(bankrollCounters().seat_refused_underrolled).toBe(7);
  });

  it('goes quiet when a reason stops firing, instead of repeating its history', () => {
    bankrollEvent('seat_refused_underrolled', 5);
    bankrollSummaryLine();
    expect(bankrollSummaryLine()).toBeNull();
  });

  it('keeps reporting a standing gauge, because a strand that goes quiet reads as fixed', () => {
    bankrollEvent('ladder_exhausted', 40);
    expect(bankrollSummaryLine()).toBe('[Bankroll] ladder_exhausted=40');
    expect(bankrollSummaryLine()).toBe('[Bankroll] ladder_exhausted=40');
    bankrollEvent('ladder_exhausted', 0);
    expect(bankrollSummaryLine()).toBeNull();
  });
});

describe('WIRING - the module exists and something calls it', () => {
  it('the fleet writes the ladder gauge every cycle, so it can fall back to zero', () => {
    expect(FLEET).toMatch(/bankrollEvent\('ladder_exhausted', stranded\);/);
    /* UNCONDITIONALLY. Guarding the write with `if (stranded > 0)` looks
       harmless, since the summary line suppresses zeroes anyway, but it means
       the gauge can never come DOWN: the day the micro relaunch fixes the
       ladder, the counter still reports the last bad number, forever. */
    expect(FLEET).not.toMatch(/if \(stranded > 0\)/);
  });

  it('prints the line from the seeding cycle, or nothing is ever read', () => {
    expect(FLEET).toMatch(
      /const brLine = bankrollSummaryLine\(\);\s*if \(brLine\) console\.log\(brLine\);/
    );
  });

  /**
   * REWRITTEN 2026-09-01 — the fail-open became a membership refusal, and
   * the reason the old pin existed no longer applies. The 2026-08-31 outage
   * this pin guarded against ("emptied the cash floor for forty minutes")
   * was caused by WRONG KEYS: the bankroll map was keyed on two hard-coded
   * club ids that owned zero cash tables, so every lookup missed and the
   * then-refusal refused everybody. The loader has derived its club ids
   * from the LIVE TABLE SET ever since (pinned below), and the map is
   * loaded all-or-nothing behind `bankrollsLoaded` — so inside a complete
   * map, an absent `${club_id}:${user_id}` key means exactly one thing:
   * this horse is NOT a member of this table's club. Sending non-members
   * to atomic_table_buyin just made the RPC refuse them one network
   * round-trip later, silently, wasting most of a standalone club's
   * seeding cycle (Deep Stack, 416 members among ~1,000 fleet horses:
   * most picks failed). A horse plays only in its own club — the
   * containment now lives at the pick.
   */
  it('refuses a missing membership at the pick, with the counter adjacent', () => {
    expect(FLEET).toMatch(
      /rollUnknown\+\+;\s*bankrollEvent\('seat_fail_open_roll_unknown'\);\s*return false;/
    );
  });

  it('the loader derives club ids from the live table set, which is what makes strictness safe', () => {
    expect(FLEET).toMatch(/const clubIdsToLoad = new Set<string>\(this\.clubIds\);/);
    expect(FLEET).toMatch(/if \(cid\) clubIdsToLoad\.add\(cid\);/);
  });

  it('counts a genuine refusal at the refusal itself', () => {
    expect(FLEET).toMatch(/bankrollEvent\('seat_refused_underrolled'\);\s*return false;/);
    /* 2026-08-31: this refusal now lives in `computeHorseBuyIn`, which reports a
       refused seat by returning 0 rather than by `continue`-ing a loop it is no
       longer inside. The counter must still fire AT the refusal. */
    expect(FLEET).toMatch(/bankrollEvent\('seat_refused_share_below_min'\);\s*return 0;/);
  });

  it('counts a cap only when the policy actually cut the buy-in', () => {
    expect(FLEET).toMatch(/if \(capped < buyIn\) bankrollEvent\('buyin_capped'\);/);
  });

  /**
   * A declined reload shows up as an ABSENCE - a short stack that stays
   * short - so it is the one bankroll decision indistinguishable from the
   * top-up path being broken. It is counted only when a reload would
   * otherwise have been PAID, or every horse sitting comfortably deep counts
   * as a refusal every 90 seconds.
   */
  it('counts a refused reload only when one was actually due', () => {
    expect(ROTATOR).toMatch(/else if \(desiredTopUp >= bb\) \{/);
    expect(ROTATOR).toMatch(/bankrollEvent\('topup_refused'\);/);
    expect(ROTATOR).toMatch(/const desiredTopUp = amount;/);
  });

  it('names the session exit by which side of the policy it left on', () => {
    expect(ROTATOR).toMatch(
      /bankrollEvent\(verdict === 'book_win' \? 'session_book_win' : 'session_stop_loss'\);/
    );
  });

  /**
   * NO DEAD VOCABULARY. A reason that can never be counted reads as a
   * decision that never fires, which is exactly the confusion this module
   * exists to end. Every name in the union must be emitted by something.
   */
  it('declares no event that nothing emits', () => {
    const declared = [...TELEMETRY.matchAll(/^\s*\| '([a-z_]+)';?$/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThanOrEqual(13);
    /* Every file that may emit. A name whose only emitter is a file missing
       from this list reads as dead vocabulary and fails the pin, which is how
       the tournament gate's two events were caught when they landed. */
    const emitters = FLEET + ROTATOR + TOURNEY + REBUY;
    for (const event of declared) {
      expect(emitters, `no emitter for ${event}`).toContain(`'${event}'`);
    }
  });
});
