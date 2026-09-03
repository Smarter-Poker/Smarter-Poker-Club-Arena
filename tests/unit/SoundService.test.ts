/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SoundService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests volume controls, enable/disable, haptic convenience object,
 * and sound method existence. Web Audio API is browser-only so tests
 * focus on logic rather than audio output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Web Audio API ───────────────────────────────────────────────────

const mockGainNode = {
  gain: {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  },
  connect: vi.fn(),
};

const mockOscillator = {
  type: 'sine',
  frequency: {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  },
  connect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

const mockBufferSource = { buffer: null, connect: vi.fn(), start: vi.fn() };
const mockFilter = {
  type: 'lowpass',
  frequency: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
  connect: vi.fn(),
};

class MockAudioContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  createGain = vi.fn().mockReturnValue({ ...mockGainNode });
  createOscillator = vi.fn().mockReturnValue({ ...mockOscillator });
  createBufferSource = vi.fn().mockReturnValue({ ...mockBufferSource });
  createBiquadFilter = vi.fn().mockReturnValue({ ...mockFilter });
  createBuffer = vi.fn().mockReturnValue({ getChannelData: () => new Float32Array(100) });
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}

vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('navigator', { vibrate: vi.fn() });

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { soundService, haptic } from '../../src/services/SoundService';

describe('SoundService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('haptic convenience object', () => {
    it('should have light, medium, strong, double, triple', () => {
      expect(typeof haptic.light).toBe('function');
      expect(typeof haptic.medium).toBe('function');
      expect(typeof haptic.strong).toBe('function');
      expect(typeof haptic.double).toBe('function');
      expect(typeof haptic.triple).toBe('function');
    });
  });

  describe('volume controls', () => {
    it('isEnabled should return true by default', () => {
      expect(soundService.isEnabled()).toBe(true);
    });

    it('setEnabled(false) should disable sounds', () => {
      soundService.setEnabled(false);
      expect(soundService.isEnabled()).toBe(false);
      soundService.setEnabled(true); // Reset
    });

    it('getMasterVolume should return default 0.7', () => {
      expect(soundService.getMasterVolume()).toBe(0.7);
    });

    it('getEffectsVolume should return default 1.0', () => {
      // SOUND AUDIT 2026-08-27: default raised from 0.5 — the only caller of
      // setEffectsVolume is the Settings -> Sound panel, whose own default is
      // 100%. A player who never opened it ran at half gain forever.
      expect(soundService.getEffectsVolume()).toBe(1.0);
    });

    it('setMasterVolume should clamp to [0, 1]', () => {
      soundService.setMasterVolume(2.0);
      expect(soundService.getMasterVolume()).toBe(1.0);
      soundService.setMasterVolume(-1.0);
      expect(soundService.getMasterVolume()).toBe(0.0);
      soundService.setMasterVolume(0.7); // Reset
    });

    it('setEffectsVolume should clamp to [0, 1]', () => {
      soundService.setEffectsVolume(5.0);
      expect(soundService.getEffectsVolume()).toBe(1.0);
      soundService.setEffectsVolume(-0.5);
      expect(soundService.getEffectsVolume()).toBe(0.0);
      soundService.setEffectsVolume(0.5); // Reset
    });
  });

  describe('sound method existence', () => {
    it('should have all 16 game sound methods', () => {
      const methods = [
        'playDeal',
        'playCheck',
        'playChips',
        'playRaise',
        'playFold',
        'playAllIn',
        'playWin',
        'playBigWin',
        'playTurnAlert',
        'playTimerWarning',
        'playCommunityCard',
        'playShowdown',
        'playButtonClick',
        'playTimeBankActivated',
        'playPotCollect',
        'playSeatTaken',
      ];
      for (const method of methods) {
        expect(typeof (soundService as any)[method]).toBe('function');
      }
    });

    it('should have playNewHand and playReconnect', () => {
      expect(typeof (soundService as any).playNewHand).toBe('function');
      expect(typeof (soundService as any).playReconnect).toBe('function');
    });
  });

  describe('timer warning lifecycle', () => {
    it('should have startTimerWarning and stopTimerWarning', () => {
      expect(typeof (soundService as any).startTimerWarning).toBe('function');
      expect(typeof (soundService as any).stopTimerWarning).toBe('function');
    });

    it('stopTimerWarning should not crash when not started', () => {
      (soundService as any).stopTimerWarning();
    });
  });

  describe('destroy', () => {
    it('should have destroy method', () => {
      expect(typeof (soundService as any).destroy).toBe('function');
    });
  });
});
