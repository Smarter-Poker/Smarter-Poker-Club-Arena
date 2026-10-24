import { afterEach, describe, expect, it } from 'vitest';
import fixtures from './fixtures/horse-maniac-marginal-flops.json';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import { decodeHorseDecisionReads, type HorseDecisionReadFrame } from './HorseDecisionReadFrame.js';
import { restoreFastRandom, saveFastRandom, variantInfo, equityWorkCounters } from './HorseEval.js';
import { equityGovernor } from './EquityLoadGovernor.js';
import type { SeatPlayer } from '../types.js';

afterEach(() => {
  HorseMind.reset();
  equityGovernor.__setScaleForTest(null);
});
describe('retained profitable heads-up maniac boundary calls', () => {
  for (const fixture of fixtures)
    it(`${fixture.player.cards.map((c) => c.rank + c.suit[0]).join(' ')} on ${fixture.board.map((c) => c.rank + c.suit[0]).join(' ')}`, () => {
      const player = fixture.player as unknown as SeatPlayer;
      const gs = fixture.gameState as unknown as HorseGameStateV2;
      expect(gs.players.every((p) => p.cards.length === 0)).toBe(true);
      // Three independent 20k-draw seeds on this same public range put the
      // selection-adjusted mean above the unchanged required price.
      expect(
        fixture.measurements.every((m) => m.conditionedAfterSelection > fixture.required)
      ).toBe(true);
      expect(fixture.originalEq).toBeLessThan(fixture.required);
      const view = decodeHorseDecisionReads(
        fixture.frame as unknown as HorseDecisionReadFrame,
        gs.players,
        null
      );
      const saved = saveFastRandom();
      try {
        HorseMind.runInSandbox(view, () => {
          HorseMind.setDecisionScope(readScopeOf('nlh', gs.dealtSeatIds!.length), 'nlh', 'cash');
          restoreFastRandom(fixture.recoveryRngBefore);
          const before = equityWorkCounters();
          const decision = HorseLogic.__testables.maniacCallDown(
            { action: 'fold', thinkTime: 0 },
            player,
            gs,
            variantInfo('nlh'),
            {}
          );
          expect(decision.action).toBe('call');
          expect(equityWorkCounters().samples - before.samples).toBe(4300);
        });
      } finally {
        restoreFastRandom(saved);
      }
    });
});

it('keeps the fresh confirmation subject to the live load governor', () => {
  const f = fixtures[0],
    gs = f.gameState as unknown as HorseGameStateV2;
  const view = decodeHorseDecisionReads(
    f.frame as unknown as HorseDecisionReadFrame,
    gs.players,
    null
  );
  const saved = saveFastRandom();
  equityGovernor.__setScaleForTest(0.2);
  try {
    HorseMind.runInSandbox(view, () => {
      HorseMind.setDecisionScope(readScopeOf('nlh', gs.dealtSeatIds!.length), 'nlh', 'cash');
      restoreFastRandom(f.recoveryRngBefore);
      const before = equityWorkCounters();
      HorseLogic.__testables.maniacCallDown(
        { action: 'fold', thinkTime: 0 },
        f.player as unknown as SeatPlayer,
        gs,
        variantInfo('nlh'),
        {}
      );
      const samples = equityWorkCounters().samples - before.samples;
      expect(samples).toBeGreaterThan(0);
      expect(samples).toBeLessThanOrEqual(860);
    });
  } finally {
    restoreFastRandom(saved);
  }
});
