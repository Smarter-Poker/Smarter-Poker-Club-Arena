/**
 * V53 MEASUREMENT SWITCHES (2026-10-24) - the switches with no other home.
 *
 * #7838, #7866 and #7876 shipped their continuation and PLO-discipline
 * layers always-on. Each now has a default-on HorseDecideOpts switch so the
 * nightly league can measure it (HorseLeague.ts V53 cards). The per-layer
 * spot pins live beside the incidents they came from (HorsePremiumContinuation,
 * HorseManiacColdFlushGuard, HorsePloTripBoardIncident,
 * HorseOmahaWeakFlushStackRecovery, HorseOmahaImpliedDrawCredit,
 * HorseRangeAdvantage). This file holds the two whose evidence is a call
 * path rather than an action: the physical Omaha blocker, and the maniac
 * boundary's sampling budget on the retained marginal-flop fixtures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixtures from './fixtures/horse-maniac-marginal-flops.json';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import * as Blocker from './OmahaFlushBlocker.js';
import { decodeHorseDecisionReads, type HorseDecisionReadFrame } from './HorseDecisionReadFrame.js';
import {
  equityWorkCounters,
  restoreFastRandom,
  saveFastRandom,
  seedFastRandom,
  variantInfo,
} from './HorseEval.js';
import type { Card, SeatPlayer } from '../types.js';

const suits: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const cards = (s: string): Card[] =>
  s.match(/../g)!.map((c) => ({ rank: c[0], suit: suits[c[1]] }) as Card);

afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

describe('v53OmahaBlockers', () => {
  for (const variant of ['plo4', 'plo5', 'plo6'] as const)
    it(`${variant}: on reads the physical two-hole blocker, off the generic one`, () => {
      const extra = variant === 'plo5' ? '9h' : variant === 'plo6' ? '9h6c' : '';
      const hero = {
        seat: 2,
        user_id: 'hero',
        username: 'Hero',
        totalInvested: 7,
        stack: 1000,
        bet: 0,
        is_folded: false,
        cards: cards('AdQcJsTh' + extra),
      } as SeatPlayer;
      const gs = {
        players: [
          { seat: 1, user_id: 'opponent', stack: 1000, bet: 0, is_folded: false, cards: [] },
          hero,
        ],
        communityCards: cards('Kd8d2d'),
        pot: 16,
        currentBet: 0,
        minRaise: 2,
        lastRaise: 2,
        stage: 'flop',
        gameVariant: variant,
        bigBlind: 2,
        smallBlind: 1,
        dealerSeat: 2,
        actionHistory: [
          { stage: 'preflop', seat: 2, userId: 'hero', action: 'raise', amount: 7 },
          { stage: 'preflop', seat: 1, userId: 'opponent', action: 'call', amount: 7 },
          { stage: 'flop', seat: 1, userId: 'opponent', action: 'check', amount: 0 },
        ],
      } as unknown as HorseGameStateV2;
      const physical = vi.spyOn(Blocker, 'omahaFlushBlocker');
      const generic = vi.spyOn(HorseMind, 'hasBlocker');
      seedFastRandom(10);
      HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: false });
      expect(physical).toHaveBeenCalled();
      physical.mockClear();
      generic.mockClear();
      seedFastRandom(10);
      HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: false, v53OmahaBlockers: false });
      expect(physical).not.toHaveBeenCalled();
      expect(generic).toHaveBeenCalled();
    });
});

describe('v53ManiacRecovery: the boundary sampling', () => {
  it('on: 4,300 granted samples and a fresh confirmation; off: the pre-#7866 single pooled refinement', () => {
    const f = fixtures[0];
    const gs = f.gameState as unknown as HorseGameStateV2;
    const view = decodeHorseDecisionReads(
      f.frame as unknown as HorseDecisionReadFrame,
      gs.players,
      null
    );
    const run = (opts: { v53ManiacRecovery?: boolean }) => {
      const saved = saveFastRandom();
      try {
        return HorseMind.runInSandbox(view, () => {
          HorseMind.setDecisionScope(readScopeOf('nlh', gs.dealtSeatIds!.length), 'nlh', 'cash');
          restoreFastRandom(f.recoveryRngBefore);
          const before = equityWorkCounters();
          const d = HorseLogic.__testables.maniacCallDown(
            { action: 'fold', thinkTime: 0 },
            f.player as unknown as SeatPlayer,
            gs,
            variantInfo('nlh'),
            opts
          );
          return { action: d.action, samples: equityWorkCounters().samples - before.samples };
        });
      } finally {
        restoreFastRandom(saved);
      }
    };
    expect(run({})).toEqual({ action: 'call', samples: 4300 });
    const off = run({ v53ManiacRecovery: false });
    // Without the fresh 2,500-deal confirmation only the first estimate and
    // the single pooled refinement are drawn.
    expect(off.samples).toBe(4300 - 2500);
  });
});
