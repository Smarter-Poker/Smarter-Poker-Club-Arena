import { describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';

function fixture(repriced: boolean) {
  const lifecycle = {};
  const state = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: 'addon-tail',
    tournamentCache: { prize_pool: 100, prize_pool_finalized: true },
    captureLifecycleToken: vi.fn(() => lifecycle),
    lifecycleIsCurrent: vi.fn(() => true),
    recalculateEliminatedPrizes: vi.fn(async () => repriced),
    broadcast: vi.fn(async () => true),
    finishAddOnBreak: vi.fn(async () => undefined),
    clearLifecycleTimeout: vi.fn(),
    addOnPeriodEndTimer: { timer: 'deadline' },
    addOnFinalTailReplayTimer: { timer: 'original-tail' },
  });
  return state;
}

describe('the add-on tail requires completed entitlement repricing', () => {
  it('retains the original tail when repricing returns incomplete', async () => {
    const state = fixture(false);
    await expect(state.finishAddOnTail(100)).rejects.toThrow(/reprice/i);
    expect(state.broadcast).not.toHaveBeenCalled();
    expect(state.finishAddOnBreak).not.toHaveBeenCalled();
    expect(state.clearLifecycleTimeout).not.toHaveBeenCalled();
    expect(state.addOnFinalTailReplayTimer).toEqual({ timer: 'original-tail' });
  });

  it('completes the same tail once the unchanged entitlement operation succeeds', async () => {
    const state = fixture(false);
    await state.finishAddOnTail(100).catch(() => undefined);
    state.recalculateEliminatedPrizes.mockResolvedValue(true);
    await expect(state.finishAddOnTail(100)).resolves.toBeUndefined();
    expect(state.recalculateEliminatedPrizes).toHaveBeenNthCalledWith(1, 100);
    expect(state.recalculateEliminatedPrizes).toHaveBeenNthCalledWith(2, 100);
    expect(state.broadcast).toHaveBeenCalledTimes(1);
    expect(state.finishAddOnBreak).toHaveBeenCalledTimes(1);
    expect(state.addOnFinalTailReplayTimer).toBeNull();
  });

  it('preserves an already certified normal close without repeating repricing', async () => {
    const state = fixture(false);
    await expect(state.finishAddOnTail(100, true)).resolves.toBeUndefined();
    expect(state.recalculateEliminatedPrizes).not.toHaveBeenCalled();
    expect(state.broadcast).toHaveBeenCalledWith('ADDON_PERIOD_END', {});
    expect(state.finishAddOnBreak).toHaveBeenCalledTimes(1);
  });

  it('does not resume an obsolete lifecycle after the reprice awaits', async () => {
    const state = fixture(true);
    state.lifecycleIsCurrent.mockReturnValueOnce(true).mockReturnValue(false);
    await state.finishAddOnTail(100);
    expect(state.broadcast).not.toHaveBeenCalled();
    expect(state.finishAddOnBreak).not.toHaveBeenCalled();
  });
});
