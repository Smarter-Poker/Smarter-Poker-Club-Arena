/**
 * MTT PRE-START HORSE RAMP — Dan 2026-08-23
 *
 * "HORSES NEED TO BE REGISTERING FOR MTT TOURNAMENTS UP TO AN HOUR BEFORE THE
 *  TOURNAMENT STARTS. PLAYERS DON'T JUMP IN AND PLAY TOURNAMENTS THAT HAVE NO
 *  PLAYERS IN THEM. THIS NEEDS TO BE A STANDARD PRACTICE."
 *
 * The dangerous failure of a rule like this is not that the field stays empty.
 * It is that the ramp fills a tournament to its cap and the `maxReached` gate
 * in discoverTournaments starts the event ahead of its own clock, or that it
 * touches a Spin, whose separate binding rule is that it starts on seats
 * BOUGHT and never on registrations. Most of what follows pins those.
 */
import { describe, it, expect } from 'vitest';
import {
  mttPrestartHorseTarget,
  MTT_PRESTART_RAMP_MS,
  MTT_PRESTART_MAX_HORSES,
} from './TournamentRecurringService.js';

const MIN = 60 * 1000;
const mtt = (msUntilStart: number, maxPlayers = 60) =>
  mttPrestartHorseTarget({ msUntilStart, maxPlayers, variant: 'freezeout' });

describe('mttPrestartHorseTarget — the window', () => {
  it('is silent more than an hour out', () => {
    expect(mtt(61 * MIN)).toBe(0);
    expect(mtt(24 * 60 * MIN)).toBe(0);
  });

  it('is silent at or past the start time — that is the top-up’s job', () => {
    expect(mtt(0)).toBe(0);
    expect(mtt(-5 * MIN)).toBe(0);
  });

  it('puts at least one entrant on the board the moment the hour opens', () => {
    // A lobby row reading 1 is a game somebody is in. 0 is a game nobody joins.
    expect(mtt(MTT_PRESTART_RAMP_MS - 1)).toBeGreaterThanOrEqual(1);
  });

  it('ignores a nonsense clock rather than seeding on it', () => {
    expect(mtt(Number.NaN)).toBe(0);
    expect(mtt(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('mttPrestartHorseTarget — the curve', () => {
  it('never goes backwards as the start approaches', () => {
    let prev = -1;
    for (let m = 60; m >= 1; m--) {
      const target = mtt(m * MIN);
      expect(target).toBeGreaterThanOrEqual(prev);
      prev = target;
    }
  });

  it('is slow early and steep late, so the field looks like it is filling', () => {
    const atFiftyMins = mtt(50 * MIN);
    const atThirtyMins = mtt(30 * MIN);
    const atFiveMins = mtt(5 * MIN);
    expect(atFiftyMins).toBeLessThan(atThirtyMins);
    expect(atThirtyMins).toBeLessThan(atFiveMins);
    // Quadratic: the first half of the hour delivers under a third of the field.
    expect(atThirtyMins).toBeLessThan(mtt(MIN) / 3);
  });
});

describe('mttPrestartHorseTarget — safety', () => {
  it('ALWAYS leaves a seat, so it can never trip the maxReached start gate', () => {
    for (const seats of [3, 4, 6, 9, 18, 60, 200]) {
      for (let m = 60; m >= 0; m--) {
        const target = mttPrestartHorseTarget({
          msUntilStart: m * MIN,
          maxPlayers: seats,
          variant: 'freezeout',
        });
        expect(target).toBeLessThanOrEqual(seats - 1);
      }
    }
  });

  it('caps the draw on the horse pool however big the field is', () => {
    expect(mttPrestartHorseTarget({ msUntilStart: 1, maxPlayers: 200, variant: 'freezeout' })).toBe(
      MTT_PRESTART_MAX_HORSES
    );
    expect(
      mttPrestartHorseTarget({ msUntilStart: 1, maxPlayers: 5000, variant: 'freezeout' })
    ).toBe(MTT_PRESTART_MAX_HORSES);
  });

  it('leaves Spins alone — they start on seats bought, not registrations', () => {
    for (let m = 60; m >= 0; m--) {
      expect(
        mttPrestartHorseTarget({ msUntilStart: m * MIN, maxPlayers: 3, variant: 'spin' })
      ).toBe(0);
    }
  });

  it('leaves heads-up games alone for the same reason', () => {
    expect(mttPrestartHorseTarget({ msUntilStart: 5 * MIN, maxPlayers: 2, variant: 'sng' })).toBe(
      0
    );
  });

  it('does nothing for a field too small to leave a seat in', () => {
    expect(
      mttPrestartHorseTarget({ msUntilStart: 5 * MIN, maxPlayers: 1, variant: 'freezeout' })
    ).toBe(0);
    expect(
      mttPrestartHorseTarget({ msUntilStart: 5 * MIN, maxPlayers: 0, variant: 'freezeout' })
    ).toBe(0);
  });

  it('fills the bounty formats too, not just plain freezeouts', () => {
    for (const variant of ['freezeout', 'progressive_bounty', 'mystery_bounty', 'bounty']) {
      expect(
        mttPrestartHorseTarget({ msUntilStart: 2 * MIN, maxPlayers: 60, variant })
      ).toBeGreaterThan(0);
    }
  });
});
