import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { getFullRakeConfig } from '../config/RakeConfig.js';
import { playPlo4PolicyHand, type Plo4LeagueProfile } from './Plo4PolicyLeague.js';

afterEach(() => vi.restoreAllMocks());
describe('whole-hand benchmark public pricing agrees with the live worker snapshot', () => {
  it.each([false, true])(
    'carries fee units and the dealt census with jointPolicy=%s',
    async (jointPolicy) => {
      const snapshots: HorseGameStateV2[] = [];
      const original = HorseLogic.decide;
      vi.spyOn(HorseLogic, 'decide').mockImplementation(function (...args) {
        snapshots.push(args[1]);
        return original.apply(HorseLogic, args);
      });
      const profile: Plo4LeagueProfile = {
        id: 'public-price-snapshot-development',
        seats: 6,
        tableSeats: 6,
        stackBB: 40,
        rakePercent: 10,
        rakeCapBB: 5,
        anteBB: 0,
        straddle: false,
        tournament: false,
        opponentStyle: 'balanced',
        publishedRake: true,
        jointPolicy,
      };
      const hand = await playPlo4PolicyHand(profile, 2601027, 1, 2, 'off');
      expect(hand.truncated + hand.illegalActions + hand.conservationErrors).toBe(0);
      expect(snapshots.length).toBeGreaterThan(0);
      const fees = getFullRakeConfig(1, 2, 'plo4');
      for (const gs of snapshots) {
        expect(gs.asset).toBe('chips');
        expect(gs.chipUnit).toBe(0.01);
        expect(gs.dealtSeatIds).toEqual([1, 2, 3, 4, 5, 6]);
        expect(gs.bbjConfig).toMatchObject({
          enabled: fees.bbjEnabled,
          feeBB: fees.bbjFeeBB,
          minPlayersDealt: fees.rules.minPlayersDealt,
        });
        expect(gs.players.every((p) => p.cards.length === 0)).toBe(true);
      }
    },
    30_000
  );
});
