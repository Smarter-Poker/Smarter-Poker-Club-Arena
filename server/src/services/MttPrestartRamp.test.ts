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
  MTT_PRESTART_TICK_MS,
  MTT_PUBLISH_LEAD_MS,
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

describe('mttPrestartHorseTarget - the window', () => {
  it('is silent outside the build window', () => {
    /* WAS "more than an hour out". The window is 72 hours since 2026-08-26,
       because at one hour the board was 36 empty events out of 37 and only
       ever showed a field in the final hour of each. The rule now matches the
       lobby's own publish horizon: if it is on the board, it looks real. */
    expect(mtt(73 * 60 * MIN)).toBe(0);
    expect(mtt(7 * 24 * 60 * MIN)).toBe(0);
  });

  it('is silent at or past the start time - that is the top-up’s job', () => {
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

describe('mttPrestartHorseTarget - the curve', () => {
  it('never goes backwards as the start approaches', () => {
    let prev = -1;
    for (let m = 60; m >= 1; m--) {
      const target = curveOnly(m * MIN);
      expect(target).toBeGreaterThanOrEqual(prev);
      prev = target;
    }
  });

  it('is slow early and steep late, so the field looks like it is filling', () => {
    /* Rescaled to the 72-hour window. The shape is the point and it is
       unchanged: a squared curve, so an event days out shows a couple of
       entrants and the field arrives as the gun approaches. */
    const atSixtyHours = curveOnly(60 * 60 * MIN);
    const atThirtySixHours = curveOnly(36 * 60 * MIN);
    const atOneHour = curveOnly(60 * MIN);
    expect(atSixtyHours).toBeLessThan(atThirtySixHours);
    expect(atThirtySixHours).toBeLessThan(atOneHour);
    // Quadratic: the first half of the window delivers under a third of it.
    expect(atThirtySixHours).toBeLessThan(curveOnly(MIN) / 3);
  });

  it('EVERY event on the board carries a field, however far out', () => {
    /* The floor that fixes the dead board: `Math.max(1, ...)` inside the
       window. Measured before this change: 36 of 37 registering MTTs had a
       field of exactly zero. A lobby of empty games is not one anybody joins. */
    for (const hoursOut of [1, 6, 24, 48, 71]) {
      expect(curveOnly(hoursOut * 60 * MIN), `${hoursOut}h out`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('mttPrestartHorseTarget - safety', () => {
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

  it('leaves Spins alone - they start on seats bought, not registrations', () => {
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

describe('mttPrestartHorseTarget - the per-tick step', () => {
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

describe('a GUARANTEE decides the field, not the default cap', () => {
  /**
   * Dan 2026-08-26: "the horses should fill any and all seats to insure that
   * the guarantee is always met."
   *
   * MTT_PRESTART_MAX_HORSES is 24 - the right default for an ordinary event,
   * and nowhere near enough for a guaranteed one. The Sunday $200 Deep Stack
   * promises 20,000 and pays 180 of every 200 entry into the pool, so covering
   * it takes 112 entries. Ramping to 24 would have left ~15,000 of overlay on
   * an event the club had already promised to cover.
   *
   * A horse entry is a REAL entry: fn_register_horse_for_tournament debits the
   * horse's wallet, writes a rake row and adds the prize share to prize_pool.
   * So this genuinely funds the guarantee rather than papering over it.
   */
  const deepStack = (over: Record<string, unknown> = {}) => ({
    msUntilStart: 1000, // T-1s: the ramp curve is at full stretch
    maxPlayers: 1000,
    variant: 'freezeout',
    currentPlayers: 5,
    guaranteedPrize: 20000,
    prizePool: 900,
    buyInPrizeShare: 180,
    ...over,
  });

  /**
   * The ramp WALKS toward its goal - MTT_PRESTART_MAX_STEP caps one tick at 6
   * so a single call can never jump the field. GameServer re-ticks every 45s
   * inside a 60-minute window, so ~80 ticks are available. This runs the same
   * loop and returns where it settles, which is the thing worth asserting:
   * a single call's answer is a step, not the goal.
   */
  const rampToSettle = (over: Record<string, unknown> = {}) => {
    let current = Number(deepStack(over).currentPlayers) || 0;
    let pool = Number(deepStack(over).prizePool) || 0;
    const share = Number(deepStack(over).buyInPrizeShare) || 0;
    for (let tick = 0; tick < 80; tick++) {
      const ask = mttPrestartHorseTarget(
        deepStack({ ...over, currentPlayers: current, prizePool: pool })
      );
      if (ask <= current) break;
      // Each horse seated pays its prize share into the pool, exactly as
      // fn_register_horse_for_tournament does.
      pool += (ask - current) * share;
      current = ask;
    }
    return { seated: current, pool };
  };

  it('ramps far past the default 24 when a guarantee demands it', () => {
    // 20,000 guaranteed, 900 in, 180 a head. The default cap answers 24; the
    // guarantee needs the field to keep climbing until the pool covers it.
    const { seated, pool } = rampToSettle({ currentPlayers: 5 });
    expect(seated).toBeGreaterThan(MTT_PRESTART_MAX_HORSES);
    expect(pool).toBeGreaterThanOrEqual(20000);
  });

  it('one tick is a STEP, never a jump to the goal', () => {
    const ask = mttPrestartHorseTarget(deepStack({ currentPlayers: 100 }));
    expect(ask).toBeLessThanOrEqual(100 + 6);
  });

  it('counts the PRIZE side of the buy-in, never the total', () => {
    /* 180 of every 200 reaches the pool; the 20 fee is rake and never does.
       Sizing the field on the total would seat fewer horses than the
       guarantee needs and leave it short - the pool would land under 20,000
       while the ramp believed it was done. */
    const onPrizeSide = rampToSettle({ currentPlayers: 0 });
    expect(onPrizeSide.pool).toBeGreaterThanOrEqual(20000);
    // 900 is already in the fixture's pool, so the gap is 19,100 and the
    // honest count is ceil(19,100 / 180) = 107 - not 20,000 / 180.
    expect(onPrizeSide.seated).toBeGreaterThanOrEqual(Math.ceil((20000 - 900) / 180));
  });

  it('does not double count the field that already paid in', () => {
    /* `currentPlayers` already contributed to `prizePool`. A field that is
       HALF way there must settle at roughly half the extra seats, not the
       same number as an empty one. */
    const fromEmpty = rampToSettle({ currentPlayers: 0, prizePool: 0 });
    const fromHalf = rampToSettle({ currentPlayers: 56, prizePool: 10080 });
    expect(fromEmpty.pool).toBeGreaterThanOrEqual(20000);
    expect(fromHalf.pool).toBeGreaterThanOrEqual(20000);
    // The half-full event seats far fewer ADDITIONAL horses.
    expect(fromHalf.seated - 56).toBeLessThan(fromEmpty.seated);
  });

  it('stops the moment the field has covered the guarantee', () => {
    // Pool at the guarantee: nothing left to fund, so the default rule applies
    // again and a field already past it is left alone.
    const ask = mttPrestartHorseTarget(deepStack({ currentPlayers: 200, prizePool: 20000 }));
    expect(ask).toBe(0);
  });

  it('leaves an event with NO guarantee on the original 24', () => {
    const ask = mttPrestartHorseTarget(
      deepStack({ currentPlayers: 0, guaranteedPrize: 0, prizePool: 0 })
    );
    expect(ask).toBeLessThanOrEqual(MTT_PRESTART_MAX_HORSES);
  });

  it('STILL leaves a seat for a human, whatever the guarantee asks for', () => {
    /* Safety property 1, and the one a guarantee must never be allowed to
       override: a 40-seat event with an enormous guarantee fills to 39, not
       40. A full field is a table no human can join. */
    const ask = mttPrestartHorseTarget(
      deepStack({ maxPlayers: 40, currentPlayers: 0, guaranteedPrize: 1_000_000 })
    );
    expect(ask).toBeLessThanOrEqual(39);
  });

  it('never asks for more than the event can seat', () => {
    for (const seats of [10, 50, 200, 1000]) {
      const ask = mttPrestartHorseTarget(
        deepStack({ maxPlayers: seats, currentPlayers: 0, guaranteedPrize: 5_000_000 })
      );
      expect(ask).toBeLessThanOrEqual(seats - 1);
    }
  });

  it('a freeroll guarantee cannot divide by zero into an infinite field', () => {
    const ask = mttPrestartHorseTarget(
      deepStack({ currentPlayers: 0, buyInPrizeShare: 0, guaranteedPrize: 20000 })
    );
    expect(Number.isFinite(ask)).toBe(true);
    expect(ask).toBeLessThanOrEqual(MTT_PRESTART_MAX_HORSES);
  });

  it('is still bounded by the ramp window - no filling an event days out', () => {
    const ask = mttPrestartHorseTarget(
      deepStack({ msUntilStart: 6 * 24 * 60 * 60 * 1000, currentPlayers: 0 })
    );
    expect(ask).toBe(0);
  });
});

/**
 * THE PUBLICATION LEAD IS PART OF THE RAMP (2026-09-02).
 *
 * The ramp was never broken. It was being handed 60 seconds (createTournament)
 * or 5 minutes (createXMTT) to do a job sized for 72 hours, and a per-tick step
 * of MTT_PRESTART_MAX_STEP every MTT_PRESTART_TICK_MS turns that into a hard
 * entrant ceiling that no amount of free horses can lift.
 *
 * Measured over 5 days of completed guaranteed events: 299 published under ten
 * minutes ahead were overlaid 58.5% of the time for 24,495.40, while the 38
 * published more than a day ahead were overlaid 10.5% of the time for 420.00 -
 * same ramp, same fleet.
 *
 * These replay the ramp tick by tick rather than asserting on one call, because
 * the bug only exists across ticks: every individual call was returning exactly
 * what it was asked for.
 */
const replayRamp = (leadMs: number, ev: { gtd: number; prizeShare: number; seats: number }) => {
  let current = 0;
  let pool = 0;
  for (let t = leadMs; t > 0; t -= MTT_PRESTART_TICK_MS) {
    const ask = mttPrestartHorseTarget({
      msUntilStart: t,
      maxPlayers: ev.seats,
      variant: 'freezeout',
      currentPlayers: current,
      guaranteedPrize: ev.gtd,
      prizePool: pool,
      buyInPrizeShare: ev.prizeShare,
    });
    if (ask <= current) continue;
    pool += (ask - current) * ev.prizeShare;
    current = ask;
  }
  return { entrants: current, pool };
};

/* The largest guarantee on the recurring board: Union Grand Championship
   (NLH), 2,500 guaranteed, 45 to the prize side, 200 seats. It paid 910.00 of
   overlay on 2026-08-30 having been published 4.8 minutes before its own gun. */
const GRAND = { gtd: 2500, prizeShare: 45, seats: 200 };

describe('mttPrestartHorseTarget - the publication lead', () => {
  it('covers the biggest recurring guarantee within MTT_PUBLISH_LEAD_MS', () => {
    const { pool } = replayRamp(MTT_PUBLISH_LEAD_MS, GRAND);
    expect(pool).toBeGreaterThanOrEqual(GRAND.gtd);
  });

  it('could not cover it at the 60 second lead this replaces', () => {
    /* The regression itself. One tick, MTT_PRESTART_MAX_STEP entrants, and a
       guarantee needing 56. If this ever starts passing, the step cap or the
       tick interval moved and the lead should be re-derived, not the test. */
    const { pool } = replayRamp(60 * 1000, GRAND);
    expect(pool).toBeLessThan(GRAND.gtd);
  });

  it('leaves the pacing alone when there is time - six a tick, as before', () => {
    /* Far enough out that the curve, not the guarantee, is the binding
       constraint: the step must still be the honest MTT_PRESTART_MAX_STEP. */
    const ask = mttPrestartHorseTarget({
      msUntilStart: MTT_PUBLISH_LEAD_MS,
      maxPlayers: GRAND.seats,
      variant: 'freezeout',
      currentPlayers: 0,
      guaranteedPrize: GRAND.gtd,
      prizePool: 0,
      buyInPrizeShare: GRAND.prizeShare,
    });
    expect(ask).toBe(MTT_PRESTART_MAX_STEP);
  });
});

describe('mttPrestartHorseTarget - the step cap survives a guarantee', () => {
  /**
   * The first draft of the lead fix ALSO let a guaranteed event step past
   * MTT_PRESTART_MAX_STEP when the clock ran short. "one tick is a STEP, never
   * a jump to the goal" above caught it, and it was right to: registerHorses
   * buys in one horse per sequential RPC inside the same 5-second loop that
   * starts every other tournament, so a 107-entrant jump is a platform stall,
   * not a funded guarantee. These pin that the cap holds under a guarantee at
   * every distance, so nobody re-derives that shortcut from the overlay
   * numbers in the commit message.
   */
  it('holds at MTT_PRESTART_MAX_STEP however short the clock and however big the guarantee', () => {
    for (const sec of [1, 5, 30, 60, 120, 600]) {
      const ask = mttPrestartHorseTarget({
        msUntilStart: sec * 1000,
        maxPlayers: GRAND.seats,
        variant: 'freezeout',
        currentPlayers: 0,
        guaranteedPrize: 250000,
        prizePool: 0,
        buyInPrizeShare: GRAND.prizeShare,
      });
      expect(ask).toBeLessThanOrEqual(MTT_PRESTART_MAX_STEP);
    }
  });

  it('still never asks past seats - 1', () => {
    for (let sec = 1; sec <= 120; sec++) {
      expect(
        mttPrestartHorseTarget({
          msUntilStart: sec * 1000,
          maxPlayers: 12,
          variant: 'freezeout',
          currentPlayers: 0,
          guaranteedPrize: 100000,
          prizePool: 0,
          buyInPrizeShare: 1,
        })
      ).toBeLessThanOrEqual(11);
    }
  });

  it('is still silent for seat-first formats, guarantee or not', () => {
    for (const variant of ['spin', 'sng']) {
      expect(
        mttPrestartHorseTarget({
          msUntilStart: 30 * 1000,
          maxPlayers: 3,
          variant,
          currentPlayers: 0,
          guaranteedPrize: 5000,
          prizePool: 0,
          buyInPrizeShare: 10,
        })
      ).toBe(0);
    }
  });
});
