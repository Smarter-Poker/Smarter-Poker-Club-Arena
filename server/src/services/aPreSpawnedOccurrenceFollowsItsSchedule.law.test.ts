/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW — A PRE-SPAWNED OCCURRENCE FOLLOWS ITS SCHEDULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What happened (2026-10-17): #7173 moved the five Free Buy schedules to the
 * :30 Chicago board with Dan's doubled tiers, and by 10:45Z every SCHEDULE
 * row was right — while the 28 OCCURRENCES already spawned for 10-17..19 sat
 * at :00, because resolveTimeChange (correctly) keeps a date that already
 * holds an old-time occurrence on the old times, and nothing in the engine
 * moved the occurrences themselves. The hourly freeBuyAudit held "40
 * problem(s) across 20 event(s)" open from 03:01Z and migration
 * 20261017105003 moved the 28 rows by hand with two hours to spare.
 *
 * A data migration needed twice for one cause was never a fix (CLAUDE.md
 * 10.11), so the board writer now conforms its own pre-spawned occurrences:
 * planOccurrenceConform pairs each date's claimed old-time keys with the
 * schedule's new times and conformClaimedOccurrences moves each qualifying
 * occurrence's start_time, then renames its spawn key — in that order, so a
 * failure between the two leaves the date reading "old times claimed" and
 * nothing can double.
 *
 * The law:
 *   1. A claimed occurrence on a date at or past the change moves to its
 *      schedule's new slot, key and start together.
 *   2. The move is fail-closed: ambiguous time lists plan nothing, a claimed
 *      new key is never overwritten, a date before the change or on a
 *      retired timetable stays, and a slot closer than CONFORM_MIN_LEAD_MS
 *      is too late to move onto.
 *   3. THE GUARANTEE IS NEVER PART OF A CONFORM. It is the settlement
 *      contract trg_freeze_registered_tournament_settlement_contract froze
 *      at the first entrant; the conform updates start_time and the spawn
 *      key, nothing else.
 *   4. start_time moves BEFORE the key is renamed, and the conform stands
 *      down during the maintenance freeze.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFORM_MIN_LEAD_MS,
  OCCURRENCE_CONFORM_MAX_PER_POLL,
  planOccurrenceConform,
  type ScheduleTimeChange,
} from './ScheduledTournamentService.js';

const SRC = readFileSync(join(__dirname, 'ScheduledTournamentService.ts'), 'utf8');

const ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const NOW = new Date('2026-10-17T10:45:00.000Z');
const CHI = 'America/Chicago';

/** The Free Buy shape: five :00 Chicago slots moved to :30. */
const freeBuySchedule = {
  id: ID,
  start_times_utc: ['00:30', '08:30', '12:30', '16:30', '20:30'],
  time_zone: CHI,
};
const freeBuyChange: ScheduleTimeChange = {
  previous: ['00:00', '08:00', '12:00', '16:00', '20:00'],
  from: '2026-10-17',
};
const claimedOld = (dates: string[]) =>
  new Set(dates.flatMap((d) => freeBuyChange.previous.map((tm) => `${ID}:${d}:${tm}`)));

describe('LAW: a pre-spawned occurrence follows its schedule', () => {
  it('moves every claimed old-time occurrence at or past the change to its new slot', () => {
    const dates = ['2026-10-17', '2026-10-18', '2026-10-19'];
    const plans = planOccurrenceConform(
      freeBuySchedule,
      freeBuyChange,
      claimedOld(dates),
      dates,
      NOW
    );
    // 15 slots across three dates; the 08:00 Chicago slot of 10-17 is 13:00Z,
    // whose :30 target (13:30Z) is still over the lead away at 10:45Z, so all
    // except the already-past midnight slot of 10-17 (05:30Z) move.
    expect(plans.length).toBe(14);
    const first = plans.find((p) => p.oldKey === `${ID}:2026-10-17:08:00`);
    expect(first).toBeDefined();
    expect(first!.newKey).toBe(`${ID}:2026-10-17:08:30`);
    expect(first!.newStart.toISOString()).toBe('2026-10-17T13:30:00.000Z');
    // The dying slot of the day is simply skipped, never thrown on.
    expect(plans.some((p) => p.oldKey === `${ID}:2026-10-17:00:00`)).toBe(false);
  });

  it('a date before the change, or already run on a retired timetable, stays', () => {
    const dates = ['2026-10-16', '2026-10-18'];
    const claimed = new Set([
      `${ID}:2026-10-16:08:00`,
      `${ID}:2026-10-18:08:00`,
      `${ID}:2026-10-18:19:30`, // retired-timetable occurrence already planned
    ]);
    const plans = planOccurrenceConform(
      freeBuySchedule,
      { ...freeBuyChange, retired: ['19:30'] },
      claimed,
      dates,
      NOW
    );
    expect(plans).toEqual([]);
  });

  it('fail-closed: ambiguous time lists plan nothing, a claimed new key is never overwritten', () => {
    // Different counts: 5 old times against 4 new — ambiguous pairing.
    const ambiguous = planOccurrenceConform(
      { ...freeBuySchedule, start_times_utc: ['00:30', '08:30', '12:30', '16:30'] },
      freeBuyChange,
      claimedOld(['2026-10-18']),
      ['2026-10-18'],
      NOW
    );
    expect(ambiguous).toEqual([]);
    // A twin already claimed at the new spelling: that slot is skipped.
    const claimed = claimedOld(['2026-10-18']);
    claimed.add(`${ID}:2026-10-18:08:30`);
    const plans = planOccurrenceConform(
      freeBuySchedule,
      freeBuyChange,
      claimed,
      ['2026-10-18'],
      NOW
    );
    expect(plans.some((p) => p.newKey === `${ID}:2026-10-18:08:30`)).toBe(false);
    expect(plans.length).toBe(4);
  });

  it('a new slot closer than the lead is too late to move onto', () => {
    expect(CONFORM_MIN_LEAD_MS).toBe(20 * 60_000);
    // 13:30Z target read at 13:15Z: 15 minutes out, under the lead.
    const plans = planOccurrenceConform(
      freeBuySchedule,
      freeBuyChange,
      claimedOld(['2026-10-17']),
      ['2026-10-17'],
      new Date('2026-10-17T13:15:00.000Z')
    );
    expect(plans.some((p) => p.newKey === `${ID}:2026-10-17:08:30`)).toBe(false);
  });

  it('a slot whose time did not move is left alone', () => {
    const plans = planOccurrenceConform(
      { id: ID, start_times_utc: ['08:00', '12:30'], time_zone: CHI },
      { previous: ['08:00', '12:00'], from: '2026-10-17' },
      new Set([`${ID}:2026-10-18:08:00`, `${ID}:2026-10-18:12:00`]),
      ['2026-10-18'],
      NOW
    );
    expect(plans.length).toBe(1);
    expect(plans[0].oldKey).toBe(`${ID}:2026-10-18:12:00`);
  });

  it('the guarantee is never part of a conform, and the key renames only after the move', () => {
    const method = SRC.slice(
      SRC.indexOf('private async conformClaimedOccurrences'),
      SRC.indexOf('INTERVAL MODE')
    );
    expect(method.length).toBeGreaterThan(0);
    // 3. The conform writes start_time and the spawn key, never the money.
    expect(method).not.toContain('guaranteed_prize');
    expect(method).not.toContain('prize_pool:');
    expect(method).not.toContain('buy_in');
    // 4. Move strictly before rename, and the freeze stands the conform down.
    const moveAt = method.indexOf('start_time: plan.newStart.toISOString()');
    const renameAt = method.indexOf('spawn_key: plan.newKey');
    expect(moveAt).toBeGreaterThan(-1);
    expect(renameAt).toBeGreaterThan(moveAt);
    expect(method).toContain('isMaintenanceFrozen()');
    // The move is guarded by the start_time it was read at.
    expect(method).toContain(".eq('start_time', t.start_time)");
    // An occurrence that no longer qualifies is skipped, not forced.
    expect(method).toContain("['ANNOUNCED', 'REGISTERING']");
    expect(method).toContain('prize_pool_finalized');
  });

  it('the conform is wired into the timed path before the dates are resolved', () => {
    const timed = SRC.slice(
      SRC.indexOf('private async processTimedSchedule'),
      SRC.indexOf('INTERVAL MODE')
    );
    const conformAt = timed.indexOf('conformClaimedOccurrences(');
    const resolveAt = timed.indexOf('resolveTimeChange(dueNew');
    expect(conformAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(conformAt);
    expect(OCCURRENCE_CONFORM_MAX_PER_POLL).toBeGreaterThanOrEqual(28);
  });

  it('is not a repair job: the conform lives on the live spawn path, no cron, no sweep', () => {
    // 10.12: the fix is the board writer itself conforming on its own poll,
    // not a scheduled back-fill. No new cron.schedule, no fn_*_repair/sweep.
    expect(SRC).not.toMatch(/cron\.schedule/);
    expect(SRC).not.toMatch(/fn_[a-z_]*_(repair|backpay|redrive|catchup|heal)_/);
  });
});
