/**
 * THE GAME IS HEARD WITH THE iPHONE ON SILENT (2026-09-26): the Sounds switch
 * decides the Safari audio session. The engine asks for "playback" only when
 * it is about to play a sound (never at import, never on the first tap that
 * resumes the context, which would pause the player's music), and switching
 * Sounds off sets "ambient" at once. A browser without the API is untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyAudioSession,
  audioSessionSupported,
  currentAudioSession,
} from '../../src/utils/audioSession';

/** A Web Audio context that accepts any call, so a real play path can run in jsdom. */
function fakeAudioContext() {
  const anything: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === 'value' ? 0 : key === 'state' ? 'running' : anything),
    set: () => true,
    apply: () => anything,
  });
  return class {
    state = 'running';
    currentTime = 0;
    sampleRate = 48000;
    destination = anything;
    createGain() {
      return anything;
    }
    createBuffer() {
      return { getChannelData: () => new Float32Array(1) };
    }
    resume() {
      return Promise.resolve();
    }
    addEventListener() {}
    constructor() {
      return new Proxy(this, {
        get: (target, key) => (key in target ? (target as never)[key] : () => anything),
      });
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe('the audio session follows the Sounds switch', () => {
  it('asks for playback with sound on and ambient with it off', () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { userAgent: 'Safari', audioSession: session });
    expect(audioSessionSupported()).toBe(true);
    expect(applyAudioSession(true)).toBe('playback');
    expect(session.type).toBe('playback');
    expect(currentAudioSession()).toBe('playback');
    expect(applyAudioSession(false)).toBe('ambient');
    expect(session.type).toBe('ambient');
  });

  it('leaves a browser without the API alone, and survives one that throws', () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome' });
    expect(audioSessionSupported()).toBe(false);
    expect(applyAudioSession(true)).toBeNull();
    expect(currentAudioSession()).toBeNull();
    const angry = {
      get type() {
        return 'auto';
      },
      set type(_v: string) {
        throw new Error('not allowed');
      },
    };
    vi.stubGlobal('navigator', { userAgent: 'Safari', audioSession: angry });
    expect(applyAudioSession(true)).toBeNull();
  });

  it('is left alone at import, becomes playback with the first sound, and ambient when Sounds goes off', async () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { userAgent: 'Safari', audioSession: session });
    vi.stubGlobal('AudioContext', fakeAudioContext());
    const { soundService } = await import('../../src/services/SoundService');
    // Loading the engine, and the first tap that resumes it, change nothing.
    expect(session.type).toBe('auto');
    window.dispatchEvent(new Event('pointerdown'));
    expect(session.type).toBe('auto');
    // The first sound the game plays asks for playback.
    soundService.playWin();
    expect(session.type).toBe('playback');
    // Sounds off: ambient at once, and nothing plays to change it back.
    soundService.setEnabled(false);
    expect(session.type).toBe('ambient');
    soundService.playWin();
    expect(session.type).toBe('ambient');
    // Sounds on again: playback returns with the next sound, not before. (The
    // engine lets one win cue per 50 ms frame through, so wait that frame out.)
    soundService.setEnabled(true);
    expect(session.type).toBe('ambient');
    await new Promise((resolve) => setTimeout(resolve, 60));
    soundService.playWin();
    expect(session.type).toBe('playback');
  });
});
