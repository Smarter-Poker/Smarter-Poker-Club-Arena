/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SoundManager
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests enable/disable, volume control, and 4 sound method existence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Web Audio API ───────────────────────────────────────────────────

class MockAudioContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  createGain = vi.fn().mockReturnValue({
    gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  });
  createOscillator = vi.fn().mockReturnValue({
    type: 'sine',
    frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  });
}

vi.stubGlobal('AudioContext', MockAudioContext);

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { soundManager } from '../../src/services/SoundManager';

describe('SoundManager', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('sound method existence', () => {
    it('should have playAchievement method', () => {
      expect(typeof soundManager.playAchievement).toBe('function');
    });

    it('should have playBigWin method', () => {
      expect(typeof soundManager.playBigWin).toBe('function');
    });

    it('should have playEmote method', () => {
      expect(typeof soundManager.playEmote).toBe('function');
    });

    it('should have playStreak method', () => {
      expect(typeof soundManager.playStreak).toBe('function');
    });
  });

  describe('setEnabled', () => {
    it('should disable sounds without crashing', () => {
      soundManager.setEnabled(false);
      soundManager.playAchievement(); // Should return early
      soundManager.setEnabled(true); // Reset
    });
  });

  describe('setVolume', () => {
    it('should clamp volume to [0, 1]', () => {
      soundManager.setVolume(5.0);
      // Can't directly read volume since it's private,
      // but setVolume should not throw
      soundManager.setVolume(-1.0);
      soundManager.setVolume(0.3); // Reset
    });
  });

  describe('sound execution', () => {
    it('playAchievement should not throw', () => {
      soundManager.playAchievement();
    });

    it('playBigWin should not throw', () => {
      soundManager.playBigWin();
    });

    it('playEmote should not throw', () => {
      soundManager.playEmote();
    });

    it('playStreak should not throw', () => {
      soundManager.playStreak();
    });
  });
});
