/**
 * A fixed-limit all-in is built and priced as the wager the controller
 * executes (Horse Brain loss diagnosis, October 6, 2026).
 *
 * In fixed limit the real HandController advertises `all_in` whenever its
 * clamp turns the button into a legal wager, and performAction executes it
 * through clampToStructure as a bet or raise to the street ceiling (a call on
 * a capped street). The shared candidate builder gated a pot-limit jam on the
 * ceiling but built a fixed-limit jam with the whole stack as its investment,
 * so every consumer that commits `candidate.investment` priced a stack shove
 * the table never makes: the Phase 7 tournament utility (live by default for
 * horse tournament decisions) and the joint one-response model.
 *
 * Law, on natural spots from a real HandController (flh and flo8):
 * - the builder's jam raises to exactly the controller's executed raise-to;
 * - the Phase 7 ledger never prices a clamped jam differently from the bet or
 *   raise to the ceiling it executes as.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseDecideOpts } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import { buildTournamentActionCandidates } from './HorseTournamentUtility.js';
import { remainingVariantSpot } from '../benchmark/RemainingVariantPolicyEvidence.js';
import { controllerSpotRandom } from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { forEachJointControllerSpot } from './multiway/JointControllerSpots.test-support.js';
import {
  clampJointAllIn,
  jointBettingState,
  openJointStreet,
} from './multiway/JointStreetBetting.js';

function pinDeckEntropy(seed: number) {
  const random = controllerSpotRandom(seed);
  vi.stubGlobal('crypto', {
    getRandomValues(target: Uint32Array) {
      for (let i = 0; i < target.length; i++) target[i] = Math.floor(random() * 0x100000000) >>> 0;
      return target;
    },
  });
}
afterEach(() => vi.unstubAllGlobals());

const opts: HorseDecideOpts = {
  telemetry: false,
  mind: false,
  decisionTimeMs: 0,
  phase8Postflop: 'off',
  phase10Plo4: 'off',
  phase11Omaha: 'off',
  phase12Remaining: 'off',
  phase13Joint: 'off',
};

describe('a fixed-limit all-in is built and priced as the executed wager', () => {
  it.each([
    ['flh', 'cash'],
    ['flo8', 'cash'],
    ['flh', 'tournament'],
    ['flo8', 'tournament'],
  ] as const)(
    '%s %s: the builder jam raises to the controller executed raise-to',
    (variant, mode) => {
      pinDeckEntropy(0x13f30000 ^ variant.length ^ (mode.length << 8));
      let clamped = 0;
      const wrong: unknown[] = [];
      forEachJointControllerSpot(variant, mode, 30, 0x13f3 + variant.length, (spot) => {
        const { hero, state: s } = spot;
        const legal = s.legalActions ?? [];
        if (!legal.includes('all_in')) return;
        const toCall = Math.min(hero.stack, Math.max(0, s.currentBet - hero.bet));
        const built = buildTournamentActionCandidates({
          hero,
          toCall,
          legalActions: legal,
          minRaiseTo: s.minRaiseTo ?? null,
          maxRaiseTo: s.maxRaiseTo ?? null,
          pot: s.pot,
          currentBet: s.currentBet,
          bettingStructure: s.bettingStructure!,
          baseline: { action: toCall > 0 ? 'call' : 'check', thinkTime: 0 },
          settlement: { chipUnit: s.chipUnit! },
        });
        const jam = built.find((c) => c.kind === 'jam');
        if (!jam) return;
        const street = openJointStreet(s);
        const me = { ...hero };
        const executed = clampJointAllIn(street, me, jointBettingState(street, me));
        const executedTo =
          executed.action === 'bet' || executed.action === 'raise'
            ? executed.amount!
            : executed.action === 'all_in'
              ? hero.bet + hero.stack
              : null;
        if (executed.action !== 'all_in') clamped++;
        if (executedTo === null || Math.abs(hero.bet + jam.investment - executedTo) > 1e-9)
          wrong.push({
            stage: s.stage,
            executed,
            jamTo: hero.bet + jam.investment,
            stack: hero.stack,
          });
      });
      expect(wrong.slice(0, 3)).toEqual([]);
      expect(clamped).toBeGreaterThan(0);
    }
  );

  it.each(['flh', 'flo8'] as const)(
    '%s tournament: Phase 7 prices a clamped jam as the bet or raise to the ceiling',
    (variant) => {
      pinDeckEntropy(0x13f40000 ^ variant.length);
      let compared = 0,
        evaluated = 0;
      const wrong: unknown[] = [];
      forEachJointControllerSpot(variant, 'tournament', 40, 0x13f4 + variant.length, (spot) => {
        const { hero, state: s } = spot;
        const legal = s.legalActions ?? [];
        const wager = legal.includes('raise') ? 'raise' : legal.includes('bet') ? 'bet' : null;
        if (
          !legal.includes('all_in') ||
          !wager ||
          typeof s.maxRaiseTo !== 'number' ||
          hero.bet + hero.stack <= s.maxRaiseTo + 0.005
        )
          return;
        // The controller spot carries no tournament context; attach the one
        // the live builder supplies (the Phase 12 tournament spot's, with
        // this table's field), so the Phase 7 owner runs as it does live.
        const live = s.players.filter((p) => !p.is_sitting_out);
        s.tournament = {
          ...remainingVariantSpot('flh', 'river', 4, 'tournament').state.tournament!,
          gameVariant: variant,
          currentSmallBlind: s.bigBlind / 2,
          currentBigBlind: s.bigBlind,
          playersLeft: live.length,
          spotsPaid: Math.max(1, Math.floor(live.length / 2)),
          payoutPct: live.length > 3 ? [65, 35] : [100],
          stacks: live.map((p) => p.stack + p.totalInvested),
          stackByUser: Object.fromEntries(live.map((p) => [p.user_id, p.stack + p.totalInvested])),
        } as typeof s.tournament;
        seedFastRandom(0x13f5);
        const decision = HorseLogic.decide(hero, s, 'balanced', {}, opts);
        const rows = decision.tournamentUtility?.candidates;
        evaluated += Number(Boolean(rows));
        if (!rows) return;
        const jam = rows.find((r) => r.id === 'jam');
        if (!jam) return;
        compared++;
        const ceilingInvestment = s.maxRaiseTo - hero.bet;
        const ceiling = rows.find((r) => r.action === wager && r.amount === s.maxRaiseTo);
        if (
          Math.abs(jam.investment - ceilingInvestment) > 1e-9 ||
          (ceiling &&
            (Math.abs(jam.chipEv - ceiling.chipEv) > 1e-9 ||
              Math.abs(jam.allFoldProbability - ceiling.allFoldProbability) > 1e-9))
        )
          wrong.push({
            stage: s.stage,
            jam: [jam.investment, jam.chipEv, jam.allFoldProbability],
            ceiling: ceiling
              ? [ceiling.id, ceiling.investment, ceiling.chipEv, ceiling.allFoldProbability]
              : ceilingInvestment,
          });
      });
      expect(wrong.slice(0, 3)).toEqual([]);
      expect(wrong.length).toBe(0);
      // Phase 7 really priced these spots, and a clamped jam on them.
      expect(evaluated).toBeGreaterThan(10);
      expect(compared).toBeGreaterThan(10);
    },
    120_000
  );
});
