/**
 * NO LONE HORSE (CLAUDE.md 10.5, 2026-09-05)
 *
 * Measured on production at 15:22 CDT: 47 of 140 live cash-cluster tables held
 * exactly one horse (46 the only table of their game), seated 253 minutes on
 * average, 39 with no hand dealt in thirty minutes. A lone player cannot deal
 * a hand, and the lobby showed dozens of games with "1" where nothing was
 * happening.
 *
 * Two rules, both pinned here:
 *   THE SEEDING RULE - a cluster table is seeded to a dealable minimum or not
 *     at all (HorseFleetManager, via seatsToDealable / refusesLoneSeat);
 *   THE STAND RULE   - a horse alone at a cluster table for LONE_TABLE_MINUTES
 *     with no hand dealt leaves through the human door
 *     (HorseSessionRotator, via loneStandVerdict -> engine.leaveTable).
 *
 * The decisions are pure and tested directly; the wiring is pinned against
 * the shipped source, because the seeding loop and the rotator both need a
 * live Supabase to run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEALABLE_MINIMUM,
  LONE_TABLE_MINUTES,
  OPENING_FEEDER_GRACE_MINUTES,
  loneStandVerdict,
  refusesLoneSeat,
  seatsToDealable,
  type LoneStandSituation,
} from './HorseLoneTable.js';

const REPO = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');
const FLEET = read('server/src/services/HorseFleetManager.ts');
const ROTATOR = read('server/src/services/HorseSessionRotator.ts');

describe('the constants', () => {
  it('a table deals at two; a lone horse gives a dead table ten minutes', () => {
    expect(DEALABLE_MINIMUM).toBe(2);
    expect(LONE_TABLE_MINUTES).toBe(10);
    // The controller abandons an empty opening feeder at three minutes; the
    // grace must not outlive the feeder it protects.
    expect(OPENING_FEEDER_GRACE_MINUTES).toBe(3);
  });
});

describe('THE SEEDING RULE: a cluster table is seeded to two or not at all', () => {
  it('an empty cluster table asks for two even when the trickle said one', () => {
    expect(
      seatsToDealable({ clusterTable: true, currentCount: 0, seatsNeeded: 1, seatsAllowed: 5 })
    ).toBe(2);
  });

  it('a cluster table at one asks for the one that makes it dealable', () => {
    expect(
      seatsToDealable({ clusterTable: true, currentCount: 1, seatsNeeded: 0, seatsAllowed: 4 })
    ).toBe(1);
  });

  it('never exceeds what the cap allows (a cap of one is still a cap of one)', () => {
    expect(
      seatsToDealable({ clusterTable: true, currentCount: 0, seatsNeeded: 1, seatsAllowed: 1 })
    ).toBe(1);
    expect(
      seatsToDealable({ clusterTable: true, currentCount: 0, seatsNeeded: 0, seatsAllowed: 0 })
    ).toBe(0);
  });

  it('a table already at three still trickles - the rule only lifts 0 and 1', () => {
    expect(
      seatsToDealable({ clusterTable: true, currentCount: 3, seatsNeeded: 1, seatsAllowed: 6 })
    ).toBe(1);
    expect(
      seatsToDealable({ clusterTable: true, currentCount: 2, seatsNeeded: 2, seatsAllowed: 6 })
    ).toBe(2);
  });

  it('a non-cluster table keeps its old arithmetic untouched', () => {
    expect(
      seatsToDealable({ clusterTable: false, currentCount: 0, seatsNeeded: 1, seatsAllowed: 5 })
    ).toBe(1);
    expect(refusesLoneSeat({ clusterTable: false, currentCount: 0, sittable: 1 })).toBe(false);
  });

  it('an empty cluster table with ONE sittable horse seats nobody (lone_seat_refused)', () => {
    expect(refusesLoneSeat({ clusterTable: true, currentCount: 0, sittable: 1 })).toBe(true);
    expect(refusesLoneSeat({ clusterTable: true, currentCount: 0, sittable: 0 })).toBe(true);
  });

  it('with two sittable it seats two', () => {
    expect(refusesLoneSeat({ clusterTable: true, currentCount: 0, sittable: 2 })).toBe(false);
  });

  it('a table with one seated (or one arrival pending) takes the one that makes two', () => {
    expect(refusesLoneSeat({ clusterTable: true, currentCount: 1, sittable: 1 })).toBe(false);
  });
});

/** A horse alone for twelve minutes at a live cluster table where nothing has been dealt. */
function lone(over: Partial<LoneStandSituation> = {}): LoneStandSituation {
  return {
    clusterTable: true,
    seatedCount: 1,
    humanPresent: false,
    inboundPending: false,
    lifecycle: 'live',
    tableAgeMinutes: 400,
    minutesSeated: 12,
    minutesSinceLastHand: null,
    ...over,
  };
}

describe('THE STAND RULE: a lone horse leaves a dead table', () => {
  it('lone for ten minutes with no hand dealt -> stood', () => {
    expect(loneStandVerdict(lone())).toBe('stand');
    expect(loneStandVerdict(lone({ minutesSeated: LONE_TABLE_MINUTES }))).toBe('stand');
    // A hand dealt before the window opened does not save the table.
    expect(loneStandVerdict(lone({ minutesSinceLastHand: LONE_TABLE_MINUTES + 0.5 }))).toBe(
      'stand'
    );
  });

  it('lone for five minutes -> stays', () => {
    expect(loneStandVerdict(lone({ minutesSeated: 5 }))).toBe('too_soon');
  });

  it('a hand dealt inside the window -> stays (the table is not dead)', () => {
    expect(loneStandVerdict(lone({ minutesSinceLastHand: 4 }))).toBe('hand_dealt_recently');
  });

  it('lone with a human seated -> stays (the horse is their opponent)', () => {
    // With a person at the table the horse is not alone at all...
    expect(loneStandVerdict(lone({ seatedCount: 2, humanPresent: true }))).toBe('not_alone');
    // ...and the flag alone is honoured even if the count somehow read one.
    expect(loneStandVerdict(lone({ humanPresent: true }))).toBe('human_present');
  });

  it('lone with a pending move INTO the table -> stays (a partner is coming)', () => {
    expect(loneStandVerdict(lone({ inboundPending: true }))).toBe('partner_inbound');
  });

  it('an opening feeder younger than three minutes -> stays; older -> the rule applies', () => {
    expect(loneStandVerdict(lone({ lifecycle: 'opening', tableAgeMinutes: 2 }))).toBe(
      'opening_grace'
    );
    expect(
      loneStandVerdict(
        lone({ lifecycle: 'opening', tableAgeMinutes: OPENING_FEEDER_GRACE_MINUTES + 8 })
      )
    ).toBe('stand');
  });

  it('two or more seated is a game, not a lone horse', () => {
    expect(loneStandVerdict(lone({ seatedCount: 2 }))).toBe('not_alone');
  });

  it('a non-cluster table is not this rule', () => {
    expect(loneStandVerdict(lone({ clusterTable: false }))).toBe('not_cluster');
  });
});

describe('THE WIRING (source contract)', () => {
  it('the fleet lifts every cluster table at 0 or 1 to the dealable minimum, not only opening feeders', () => {
    expect(FLEET).toMatch(
      /seedToDealable = !!table\.cluster_id && currentCount < DEALABLE_MINIMUM/
    );
    expect(FLEET).toMatch(/if \(openingFeeder \|\| seedToDealable\)/);
    expect(FLEET).toMatch(/seatsNeeded = seatsToDealable\(\{/);
  });

  it('the fleet asks the sit verdict for every selected horse BEFORE the first buy-in and refuses a lone seat', () => {
    const verdictAt = FLEET.indexOf('cleared.push({ horse, seatNumber: emptySeats[i], verdict })');
    const refusalAt = FLEET.indexOf('refusesLoneSeat({');
    const seatAt = FLEET.indexOf('for (const { horse, seatNumber, verdict } of cleared)');
    expect(verdictAt).toBeGreaterThan(0);
    expect(refusalAt).toBeGreaterThan(verdictAt);
    expect(seatAt).toBeGreaterThan(refusalAt);
    // The refusal is counted and logged once per cycle, never silent.
    expect(FLEET).toMatch(/loneSeatRefused\+\+/);
    expect(FLEET).toMatch(/noteSkip\(diag, 'lone_seat_refused'\)/);
    expect(FLEET).toMatch(/lone_seat_refused=\$\{loneSeatRefused\}/);
  });

  it('the rotator stands a lone horse through the human door, outside the population floor', () => {
    expect(ROTATOR).toMatch(
      /import \{ LONE_TABLE_MINUTES, loneStandVerdict \} from '\.\/HorseLoneTable\.js'/
    );
    const loneAt = ROTATOR.indexOf('this.lastLoneStands = await this.standLoneHorses(');
    const floorAt = ROTATOR.indexOf('tableSeats.length < (humanPresent ? 5 : 4)) continue');
    expect(loneAt).toBeGreaterThan(0);
    // The pass runs BEFORE the discretionary loop whose floor would skip a table at one.
    expect(loneAt).toBeLessThan(floorAt);
    const pass = ROTATOR.slice(ROTATOR.indexOf('private async standLoneHorses('));
    expect(pass).toMatch(/await engine\.leaveTable\(userId\)/);
    // No seat surgery: nothing in the pass writes table_seats.
    expect(pass.slice(0, pass.indexOf('private async considerSeatChanges'))).not.toMatch(
      /from\('table_seats'\)/
    );
  });

  it('the rotator reads the two facts it cannot infer, fails closed on both, and exposes loneStands', () => {
    const pass = ROTATOR.slice(ROTATOR.indexOf('private async standLoneHorses('));
    expect(pass).toMatch(/from\('cash_seat_moves'\)[\s\S]*?\.eq\('state', 'pending'\)/);
    expect(pass).toMatch(/if \(!inboundRead\.complete\) return 0;/);
    expect(pass).toMatch(/from\('hand_history'\)[\s\S]*?\.gte\('created_at', since\)/);
    expect(pass).toMatch(/if \(!handsRead\.complete\) return 0;/);
    expect(ROTATOR).toMatch(/get loneStands\(\): number/);
    expect(ROTATOR).toMatch(/loneStands=\$\{this\.lastLoneStands\}/);
    // The seat read carries the table's created_at for the opening grace.
    expect(ROTATOR).toMatch(
      /main_index, lifecycle, created_at, max_players, min_buy_in, max_buy_in\)'/
    );
  });
});
