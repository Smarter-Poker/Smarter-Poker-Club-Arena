/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: THE PERSONA SURVIVES THE TUNER (2026-09-05, V48)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `profiles.horse_profile` carries two different kinds of thing:
 *
 *   AUTHORED  - style, and now `persona` (straddleRate, gtoAdherence,
 *               preferredDepthBB). Written by a person, by onboarding, or by
 *               the deterministic default. It is who the horse IS.
 *   MEASURED  - tightness, aggression, bluffFreq, leaks*. Rewritten every
 *               night by HorseSelfTuner from what the horse DID.
 *
 * The tuner writes the whole `horse_profile` object back, so the only thing
 * standing between an authored personality and the fleet average is that the
 * tuner does not name those keys. On 2026-09-04 the regression rule halved
 * all three dials on 221 of 383 horses in one run: if `persona` were in that
 * write, a night like that would flatten the fleet's identity permanently and
 * the audit log would record a confident reason for it.
 *
 * This law reads the tuner's source and fails if it ever writes a persona
 * key, and pins the read boundary that bounds every field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultPersonaFor,
  personaFromValue,
  resolvePersona,
  wantsStraddle,
  followsSolver,
  PERSONA_DEFAULT,
} from '../engine/HorsePersona.js';
import { HorseLogic, resolveHorseStyle, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { setGtoCharts, _clearGtoCharts } from '../engine/GtoCharts.js';
import { enableBrainTelemetry, drainFires } from '../engine/BrainTelemetry.js';
import { seedFastRandom } from '../engine/HorseEval.js';
import type { SeatPlayer, HandStage } from '../types.js';

/** UTG first-in at 10bb with aces, in a tournament: the charted jam spot. */
function jamSpot(handNumber: number): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const bb = 2;
  const mk = (seat: number, over: Partial<SeatPlayer> = {}): SeatPlayer =>
    ({
      seat,
      user_id: `p-${seat}`,
      username: `P${seat}`,
      stack: 200,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: true,
      ...over,
    }) as SeatPlayer;
  const hero = mk(3, {
    user_id: 'hero',
    stack: 10 * bb,
    cards: [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ],
  });
  return {
    hero,
    gs: {
      players: [
        mk(1, { bet: bb / 2, totalInvested: bb / 2 }),
        mk(2, { bet: bb, totalInvested: bb }),
        hero,
        mk(4),
        mk(5),
        mk(6),
      ],
      communityCards: [],
      pot: bb * 1.5,
      currentBet: bb,
      minRaise: bb,
      stage: 'preflop' as HandStage,
      gameVariant: 'nlh',
      bigBlind: bb,
      dealerSeat: 6,
      gameMode: 'tournament' as const,
      format: 'mtt',
      // the hand's identity for the deterministic per-hand roll
      actionHistory: [
        {
          seat: 1,
          userId: 'p-1',
          action: 'sb',
          amount: bb / 2,
          timestamp: 1_700_000_000_000 + handNumber * 60_000,
          stage: 'preflop',
        },
      ],
    } as unknown as HorseGameStateV2,
  };
}

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('LAW: the persona survives the tuner', () => {
  it('the self-tuner never writes a persona key', () => {
    const tuner = read('services/HorseSelfTuner.ts');
    // The one place the tuner assembles what it writes back.
    const start = tuner.indexOf('const newProfile = {');
    expect(start, 'the tuner still assembles newProfile').toBeGreaterThan(0);
    const written = tuner.slice(start, tuner.indexOf('};', start));
    expect(
      /\bpersona\b/.test(written),
      'HorseSelfTuner now writes a persona key - the authored personality would be rewritten every night'
    ).toBe(false);
    // and nowhere else in the file either
    expect(
      /persona\s*:/.test(tuner),
      'HorseSelfTuner mentions a persona field; the tuner writes MEASURED keys only'
    ).toBe(false);
  });

  it('the whole profile still round-trips through one read boundary', () => {
    const { mods } = resolveHorseStyle(
      {
        style: 'lag',
        tightness: 1.05,
        persona: { straddleRate: 0.3, gtoAdherence: 0.9 },
      },
      'h1'
    );
    expect(mods.persona).toEqual({ straddleRate: 0.3, gtoAdherence: 0.9 });
    expect(mods.tightness).toBe(1.05);
  });

  it('every field is bounded at the boundary, and a bad row degrades', () => {
    const p = personaFromValue({ straddleRate: 99, gtoAdherence: -5 }, 'h2');
    expect(p.straddleRate).toBe(0.6);
    expect(p.gtoAdherence).toBe(0.5);
    // junk of the wrong type falls back to the horse's default, not to zero
    const junk = personaFromValue({ straddleRate: 'lots' }, 'h2');
    expect(junk.straddleRate).toBe(defaultPersonaFor('h2').straddleRate);
    expect(resolvePersona(null, 'h2')).toEqual(defaultPersonaFor('h2'));
    expect(resolvePersona({ persona: 'nonsense' }, 'h2')).toEqual(defaultPersonaFor('h2'));
  });

  it('a horse with no authored persona is still an individual, deterministically', () => {
    const a = defaultPersonaFor('horse-a');
    const b = defaultPersonaFor('horse-b');
    expect(defaultPersonaFor('horse-a')).toEqual(a);
    expect(a).not.toEqual(b);
    for (const id of ['x', 'y', 'z', 'horse-1', 'horse-2']) {
      const d = defaultPersonaFor(id);
      expect(d.straddleRate).toBeGreaterThanOrEqual(0);
      expect(d.straddleRate).toBeLessThanOrEqual(0.6);
      expect(d.gtoAdherence).toBeGreaterThanOrEqual(0.5);
      expect(d.gtoAdherence).toBeLessThanOrEqual(1);
    }
    expect(PERSONA_DEFAULT.straddleRate).toBe(0);
  });

  it('the straddle answer is deterministic in (horse, hand) and honours the rate', () => {
    expect(wantsStraddle('h', 41, 0.3)).toBe(wantsStraddle('h', 41, 0.3));
    expect(wantsStraddle('h', 0, 0)).toBe(false);
    // a rate of 0.3 straddles roughly a third of hands, and never all of them
    let n = 0;
    for (let hand = 0; hand < 400; hand++) if (wantsStraddle('horse-x', hand, 0.3)) n++;
    expect(n / 400).toBeGreaterThan(0.2);
    expect(n / 400).toBeLessThan(0.42);
    // a different horse gets a different pattern on the same hands
    let m = 0;
    for (let hand = 0; hand < 400; hand++) if (wantsStraddle('horse-y', hand, 0.3)) m++;
    expect(m).not.toBe(n);
  });

  it('a horse with adherence under 1 actually declines the solver consult in a live decision', () => {
    // The chart: UTG at 10bb jams AA always. A horse with adherence 1 takes
    // it every time; one with a real persona sometimes answers with its own
    // read, and the receipt says which.
    _clearGtoCharts();
    setGtoCharts([
      {
        game_type: 'Tournament',
        stack_depth: 10,
        hero_position: 'UTG',
        villain_action: 'fold_to_hero',
        hand_matrix: { AA: { push: 1, fold: 0 } },
      },
    ]);
    enableBrainTelemetry();
    let deviations = 0;
    for (let hand = 1; hand <= 60; hand++) {
      seedFastRandom(hand * 7919);
      const { hero, gs } = jamSpot(hand);
      HorseLogic.decide(
        hero,
        gs,
        'balanced',
        { persona: { straddleRate: 0, gtoAdherence: 0.7 } },
        {
          telemetry: true,
          mind: false,
        }
      );
    }
    const fires = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    deviations = fires.v48_gto_deviation ?? 0;
    expect(deviations).toBeGreaterThan(0);
    expect(deviations).toBeLessThan(60);

    // adherence 1 never deviates
    for (let hand = 1; hand <= 30; hand++) {
      seedFastRandom(hand * 7919);
      const { hero, gs } = jamSpot(hand);
      HorseLogic.decide(
        hero,
        gs,
        'balanced',
        { persona: { straddleRate: 0, gtoAdherence: 1 } },
        {
          telemetry: true,
          mind: false,
        }
      );
    }
    const clean = Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));
    expect(clean.v48_gto_deviation ?? 0).toBe(0);
    expect(clean.v27_gto_open_jam ?? 0).toBeGreaterThan(0);
    _clearGtoCharts();
  });

  it('solver adherence is deterministic per spot, so one hand can deviate on one street', () => {
    expect(followsSolver('h', 3, 'flop', 1)).toBe(true);
    expect(followsSolver('h', 3, 'flop', 0.8)).toBe(followsSolver('h', 3, 'flop', 0.8));
    let follows = 0;
    for (let hand = 0; hand < 300; hand++) if (followsSolver('h', hand, 'flop', 0.8)) follows++;
    expect(follows / 300).toBeGreaterThan(0.7);
    expect(follows / 300).toBeLessThan(0.9);
  });
});
