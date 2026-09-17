import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { ServerTableEngineTurns } from './ServerTableEngineTurns.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => {
  enableBrainTelemetry();
  drainFires();
});
afterEach(() => vi.restoreAllMocks());
describe('brain exception fallback provenance', () => {
  it.each([0, 20])(
    'marks the real exception fallback facing %s chips without copying the error',
    (toCall) => {
      vi.spyOn(HorseLogic as any, 'decideInternal').mockImplementation(() => {
        throw Error('private-debug-input');
      });
      const d = HorseLogic.decide(
        { user_id: 'hero', bet: 0 } as any,
        { currentBet: toCall, players: [], gameVariant: 'nlh' } as any,
        'balanced',
        {},
        { mind: false, telemetry: true }
      );
      expect(d).toEqual({
        action: toCall ? 'fold' : 'check',
        thinkTime: 1500,
        policyFallback: 'brain_exception',
      });
      expect(JSON.stringify(d)).not.toContain('private-debug-input');
      expect(drainFires()).toContainEqual({ feature: 'phase15_brain_exception', fires: 1 });
    }
  );
  it('preserves the valid fast answer when a deep exception degrades to fold', () => {
    expect(
      ServerTableEngineTurns.secondLookVerdict(
        { action: 'call', amount: 20 },
        { action: 'fold', policyFallback: 'brain_exception' }
      )
    ).toBeNull();
    expect(
      ServerTableEngineTurns.secondLookVerdict({ action: 'call', amount: 20 }, { action: 'fold' })
    ).toEqual({ action: 'fold', amount: undefined });
  });
});
