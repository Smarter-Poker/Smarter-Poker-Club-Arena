import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const audio = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  getMasterVolume: vi.fn(() => 0.5),
}));
vi.mock('../../src/services/SoundService', () => ({ soundService: audio }));
import { throwableVoice } from '../../src/services/ThrowableVoice';
const speak = vi.fn();
const cancel = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('speechSynthesis', { speak, cancel });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    }
  );
  audio.isEnabled.mockReturnValue(true);
  throwableVoice.cancel();
  vi.clearAllMocks();
});
afterEach(() => {
  throwableVoice.cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('throwable voice ownership', () => {
  it('cancels a delayed line before it can speak', () => {
    throwableVoice.speakFor('anvil');
    throwableVoice.cancel();
    vi.runAllTimers();
    expect(speak).not.toHaveBeenCalled();
  });
  it('rechecks mute at the delayed playback time', () => {
    throwableVoice.speakFor('anvil');
    audio.isEnabled.mockReturnValue(false);
    vi.runAllTimers();
    expect(speak).not.toHaveBeenCalled();
  });
  it('replaces a pending old line with the newest throw', () => {
    throwableVoice.speakFor('anvil');
    throwableVoice.speakFor('beer');
    vi.runAllTimers();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toBe('Cheers!');
    expect(speak.mock.calls[0][0].volume).toBe(0.45);
  });
  it('does not let an older throw teardown cancel newer speech', () => {
    const oldCleanup = throwableVoice.speakFor('anvil');
    throwableVoice.speakFor('beer');
    cancel.mockClear();
    oldCleanup?.();
    expect(cancel).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it('lets the owning throw cancel both scheduled and active speech', () => {
    const cleanup = throwableVoice.speakFor('beer');
    cleanup?.();
    vi.runAllTimers();
    expect(speak).not.toHaveBeenCalled();
    const activeCleanup = throwableVoice.speak({ text: 'Hello' });
    expect(speak).toHaveBeenCalledTimes(1);
    cancel.mockClear();
    activeCleanup?.();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('keeps silent items silent and tolerates unsupported speech', () => {
    throwableVoice.speakFor('boxing_glove');
    expect(speak).not.toHaveBeenCalled();
    vi.stubGlobal('speechSynthesis', undefined);
    expect(() => throwableVoice.speakFor('beer')).not.toThrow();
    vi.runAllTimers();
    expect(speak).not.toHaveBeenCalled();
  });
});
