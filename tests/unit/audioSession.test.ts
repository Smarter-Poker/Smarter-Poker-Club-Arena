/**
 * THE GAME IS HEARD WITH THE iPHONE ON SILENT (2026-09-26): the Sounds switch
 * decides the Safari audio session. On asks for "playback" (heard through the
 * silent switch), off sets "ambient"; a browser without the API is untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyAudioSession,
  audioSessionSupported,
  currentAudioSession,
} from '../../src/utils/audioSession';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../../src/utils/soundGate');
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

  it('is set by the sound engine at start and every time the switch moves', async () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { userAgent: 'Safari', audioSession: session });
    const { soundService } = await import('../../src/services/SoundService');
    expect(session.type).toBe('playback');
    soundService.setEnabled(false);
    expect(session.type).toBe('ambient');
    soundService.setEnabled(true);
    expect(session.type).toBe('playback');
  });
});
