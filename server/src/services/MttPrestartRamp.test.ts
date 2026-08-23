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
  startsOnBoughtSeats,
  MTT_PRESTART_RAMP_MS,
  MTT_PRESTART_MAX_HORSES,
  MTT_PRESTART_MAX_STEP,
} from './TournamentRecurringService.js';

const MIN = 60 * 1000;
/**
 * The curve as seen from an EMPTY field. `currentPlayers: 0` plus a step cap
 * means a single tick can only ask for MTT_PRESTART_MAX_STEP, so these curve
 * assertions read the uncapped shape via `curveOnly` and the shipped
 * behaviour via `mtt`.
 */
const mtt = (msUntilStart: number, maxPlayers = 60) =>
  mttPrestartHorseTarget({ msUntilStart, maxPlayers, variant: 'freezeout', currentPlayers: 0 });

/** The curve with the step cap lifted, by pretending we are already there. */
const curveOnly = (msUntilStart: number, maxPlayers = 60) => {
  for (let assumed = 0; assumed <= maxPlayers; assumed++) {
    const ask = mttPrestartHorseTarget({
      msUntilStart,
      maxPlayers,
      variant: 'freezeout',
      currentPlayers: assumed,
    });
    if (ask === 0) return assumed; // the curve has been reached
  }
  return maxPlayers;
};

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
      const target = curveOnly(m * MIN);
      expect(target).toBeGreaterThanOrEqual(prev);
      prev = target;
    }
  });

  it('is slow early and steep late, so the field looks like it is filling', () => {
    const atFiftyMins = curveOnly(50 * MIN);
    const atThirtyMins = curveOnly(30 * MIN);
    const atFiveMins = curveOnly(5 * MIN);
    expect(atFiftyMins).toBeLessThan(atThirtyMins);
    expect(atThirtyMins).toBeLessThan(atFiveMins);
    // Quadratic: the first half of the hour delivers under a third of the field.
    expect(atThirtyMins).toBeLessThan(curveOnly(MIN) / 3);
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
    // Read through the step cap: the curve itself must never exceed the pool
    // cap, whatever the field size. 584 horses exist and most are already
    // dealing cash or in another event.
    expect(curveOnly(1, 200)).toBe(MTT_PRESTART_MAX_HORSES);
    expect(curveOnly(1, 5000)).toBe(MTT_PRESTART_MAX_HORSES);
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

describe('mttPrestartHorseTarget — the per-tick step', () => {
  it('walks toward the curve instead of jumping to it', () => {
    // Two minutes out on a 60-seat field the curve is near the 24 cap, but a
    // single tick from an empty field may only ask for the step.
    expect(curveOnly(2 * MIN)).toBeGreaterThan(MTT_PRESTART_MAX_STEP);
    expect(mtt(2 * MIN)).toBe(MTT_PRESTART_MAX_STEP);
  });

  it('never asks for more than the curve, however far behind the field is', () => {
    for (let m = 60; m >= 1; m--) {
      const ask = mttPrestartHorseTarget({
        msUntilStart: m * MIN,
        maxPlayers: 200,
        variant: 'freezeout',
        currentPlayers: 0,
      });
      expect(ask).toBeLessThanOrEqual(curveOnly(m * MIN, 200));
    }
  });

  it('asks for nothing once the field has caught up', () => {
    expect(
      mttPrestartHorseTarget({
        msUntilStart: 30 * MIN,
        maxPlayers: 60,
        variant: 'freezeout',
        currentPlayers: MTT_PRESTART_MAX_HORSES,
      })
    ).toBe(0);
  });

  it('stands down entirely when humans have already filled past the curve', () => {
    // Real players turning up is the whole point. The ramp must not keep
    // adding horses on top of them.
    expect(
      mttPrestartHorseTarget({
        msUntilStart: 45 * MIN,
        maxPlayers: 60,
        variant: 'freezeout',
        currentPlayers: 40,
      })
    ).toBe(0);
  });

  it('tolerates a nonsense current count rather than seeding on it', () => {
    const ask = mttPrestartHorseTarget({
      msUntilStart: 10 * MIN,
      maxPlayers: 60,
      variant: 'freezeout',
      currentPlayers: -5 as number,
    });
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThanOrEqual(MTT_PRESTART_MAX_STEP);
  });
});
