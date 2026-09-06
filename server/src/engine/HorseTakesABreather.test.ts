/**
 * V48: A HORSE THAT LOSES A BUY-IN TAKES AN ORBIT OFF (2026-09-06)
 *
 * The last of the three persona behaviours whose hook actually existed, and
 * it went in the moment the hook was found rather than being shipped as a
 * field with nothing behind it. A horse had never once stood up after a bad
 * hand: it takes a 200bb cooler and is in the very next hand, every time,
 * forever - one of the most visible absences at a live table.
 *
 * These tests are about DISTRIBUTION and DETERMINISM, because those are the
 * two things a by-hand test cannot see and the two things that go wrong. The
 * persona hash has already been caught twice by exactly this shape of test:
 * `horse-a` and `horse-b` landing in the same bucket, and a rate of 0.30
 * firing on 66% of hands.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultPersonaFor,
  personaFromValue,
  wantsSitOutAfterLoss,
  PERSONA_DEFAULT,
  SIT_OUT_LOSS_BB,
  SIT_OUT_MS,
} from './HorsePersona.js';

describe('the breather is a real rate, not a coin flip', () => {
  it('fires at close to the persona rate over many hands', () => {
    for (const rate of [0.05, 0.12, 0.3]) {
      let fired = 0;
      const N = 20_000;
      for (let hand = 1; hand <= N; hand++) {
        if (wantsSitOutAfterLoss('horse-rate-test', hand, rate)) fired++;
      }
      const observed = fired / N;
      expect(
        Math.abs(observed - rate),
        `rate ${rate} observed ${observed.toFixed(4)} - the hash is not mixing`
      ).toBeLessThan(0.02);
    }
  });

  it('a rate of zero never fires, and that is the fleet default', () => {
    expect(PERSONA_DEFAULT.sitOutAfterLossRate).toBe(0);
    for (let hand = 1; hand <= 5_000; hand++) {
      expect(wantsSitOutAfterLoss('horse-nit', hand, 0)).toBe(false);
    }
  });

  it('is deterministic in (horse, hand) - a replayed hand answers the same', () => {
    for (let hand = 1; hand <= 200; hand++) {
      const a = wantsSitOutAfterLoss('horse-x', hand, 0.25);
      const b = wantsSitOutAfterLoss('horse-x', hand, 0.25);
      expect(a).toBe(b);
    }
  });

  it('two horses one character apart are not the same player', () => {
    const a = defaultPersonaFor('horse-a');
    const b = defaultPersonaFor('horse-b');
    const same =
      a.sitOutAfterLossRate === b.sitOutAfterLossRate &&
      a.straddleRate === b.straddleRate &&
      a.gtoAdherence === b.gtoAdherence;
    expect(same, 'horse-a and horse-b landed in the same persona bucket').toBe(false);
  });

  it('the fleet is mostly grinders, with a real minority who walk', () => {
    let never = 0;
    let walks = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const p = defaultPersonaFor(`horse-${i}`);
      expect(p.sitOutAfterLossRate).toBeGreaterThanOrEqual(0);
      expect(p.sitOutAfterLossRate).toBeLessThanOrEqual(0.35);
      if (p.sitOutAfterLossRate === 0) never++;
      else walks++;
    }
    // A seat that stands up is a seat not filled, and fleet_seat_starvation
    // already reports 545 of 821 cash seats empty. Most horses must grind.
    expect(never / N).toBeGreaterThan(0.4);
    expect(never / N).toBeLessThan(0.7);
    expect(walks).toBeGreaterThan(0);
  });

  it('an authored rate is bounded at the read boundary, like every dial', () => {
    expect(personaFromValue({ sitOutAfterLossRate: 99 }, 'h').sitOutAfterLossRate).toBe(0.35);
    expect(personaFromValue({ sitOutAfterLossRate: -5 }, 'h').sitOutAfterLossRate).toBe(0);
    // a bad type degrades to the horse's own default, it does not throw
    expect(personaFromValue({ sitOutAfterLossRate: 'lots' }, 'h').sitOutAfterLossRate).toBe(
      defaultPersonaFor('h').sitOutAfterLossRate
    );
  });
});

describe('the breather is wired into settlement', () => {
  const src = readFileSync(
    join(process.cwd(), 'src/engine/ServerTableEngineSettlement.ts'),
    'utf8'
  );

  it('runs at settlement and uses the public sitOut a human button calls', () => {
    expect(src.includes('this.horsesTakeABreather(snap);')).toBe(true);
    expect(src.includes('this.sitOut(seated.user_id, true);')).toBe(true);
    expect(src.includes("noteFire('v48_sit_out_after_loss')")).toBe(true);
  });

  it('books the seat back in, and only if the seat is still there', () => {
    const fn = src.slice(src.indexOf('private horsesTakeABreather'));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body.includes('this.sitOut(userId, false);')).toBe(true);
    expect(
      body.includes('if (!this.seatedPlayers.some((p) => p.user_id === userId)) return;'),
      'a horse evicted or moved during the breather must not be dragged back'
    ).toBe(true);
    expect(body.includes("noteFire('v48_sit_back_in')")).toBe(true);
  });

  it('never touches a tournament seat', () => {
    const fn = src.slice(src.indexOf('private horsesTakeABreather'));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(
      body.includes('if (this.isTournamentTable()) return;'),
      'a tournament seat is bought and gets blinded off - sitting out there is a leak, not a breather'
    ).toBe(true);
  });

  it('the threshold is a full buy-in and the breather is about an orbit', () => {
    expect(SIT_OUT_LOSS_BB).toBe(100);
    expect(SIT_OUT_MS).toBeGreaterThan(30_000);
    expect(SIT_OUT_MS).toBeLessThan(5 * 60_000); // inside the eviction clock
  });
});
