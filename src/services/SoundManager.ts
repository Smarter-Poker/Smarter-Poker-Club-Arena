/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SOUND MANAGER — Audio cues for gamification events
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Plays subtle audio feedback for:
 * - Achievement unlocked
 * - Big win confetti
 * - Emote sent
 * - Streak milestone
 *
 * Uses Web Audio API for low-latency playback.
 * All sounds are generated programmatically (no external audio files needed).
 */

class SoundManagerClass {
  private audioCtx: AudioContext | null = null;
  private enabled: boolean = true;
  private volume: number = 0.3; // 0-1

  private getContext(): AudioContext | null {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      return this.audioCtx;
    } catch (err) {

      console.error("[SoundManager] Error:", err);
      return null;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Achievement unlocked — ascending chime
   */
  playAchievement(): void {
    if (!this.enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    gainNode.gain.setValueAtTime(this.volume * 0.4, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    // Ascending triad: C5 → E5 → G5
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gainNode);
      osc.start(now + i * 0.12);
      osc.stop(now + 0.8);
    });
  }

  /**
   * Big win — triumphant fanfare
   */
  playBigWin(): void {
    if (!this.enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    gainNode.gain.setValueAtTime(this.volume * 0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

    // Major chord sweep: C4 → E4 → G4 → C5
    [261.63, 329.63, 392.0, 523.25].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.connect(gainNode);
      osc.start(now + i * 0.15);
      osc.stop(now + 1.2);
    });
  }

  /**
   * Emote sent — soft pop
   */
  playEmote(): void {
    if (!this.enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    gainNode.gain.setValueAtTime(this.volume * 0.25, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);
    osc.connect(gainNode);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  /**
   * Streak milestone (3+) — ascending ping
   */
  playStreak(): void {
    if (!this.enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
    gainNode.gain.setValueAtTime(this.volume * 0.2, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(1400, now + 0.3);
    osc.connect(gainNode);
    osc.start(now);
    osc.stop(now + 0.4);
  }
}

export const soundManager = new SoundManagerClass();
export default soundManager;
