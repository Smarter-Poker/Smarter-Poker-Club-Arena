/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SOUND PACK SERVICE — Themed Sound Profiles
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps SoundService to provide different sound themes (packs).
 * Each pack controls volume profiles and enables/disables specific sounds.
 *
 * Packs:
 *   - 'casino'     — Full experience with all sounds (default)
 *   - 'minimal'    — Essential sounds only (deal, check, chips)
 *   - 'tournament' — Enhanced drama (louder showdown, timer, all-in)
 *   - 'silent'     — All sounds disabled (haptics still work)
 */

import { soundService } from './SoundService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SoundPackId = 'casino' | 'minimal' | 'tournament' | 'silent';

interface SoundPackConfig {
  id: SoundPackId;
  name: string;
  description: string;
  icon: string;
  masterVolume: number;
  effectsVolume: number;
  enabledSounds: Set<string>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PACK DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const SOUND_PACKS: Record<SoundPackId, SoundPackConfig> = {
  casino: {
    id: 'casino',
    name: 'Casino',
    description: 'Full casino experience with all sounds',
    icon: '🎰',
    masterVolume: 0.7,
    effectsVolume: 0.5,
    enabledSounds: new Set([
      'deal',
      'check',
      'chips',
      'raise',
      'fold',
      'allIn',
      'win',
      'bigWin',
      'turnAlert',
      'timerWarning',
      'communityCard',
      'showdown',
      'buttonClick',
      'timeBankActivated',
    ]),
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal',
    description: 'Essential sounds only — no celebrations',
    icon: '🔇',
    masterVolume: 0.5,
    effectsVolume: 0.3,
    enabledSounds: new Set([
      'deal',
      'check',
      'chips',
      'fold',
      'turnAlert',
      'timerWarning',
      'buttonClick',
    ]),
  },
  tournament: {
    id: 'tournament',
    name: 'Tournament',
    description: 'Enhanced drama — louder showdowns and all-ins',
    icon: '🏆',
    masterVolume: 0.85,
    effectsVolume: 0.65,
    enabledSounds: new Set([
      'deal',
      'check',
      'chips',
      'raise',
      'fold',
      'allIn',
      'win',
      'bigWin',
      'turnAlert',
      'timerWarning',
      'communityCard',
      'showdown',
      'buttonClick',
      'timeBankActivated',
    ]),
  },
  silent: {
    id: 'silent',
    name: 'Silent',
    description: 'All sounds off — haptics still work',
    icon: '🔕',
    masterVolume: 0,
    effectsVolume: 0,
    enabledSounds: new Set<string>(),
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SOUND PACK SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class SoundPackService {
  private currentPack: SoundPackId = 'casino';

  /**
   * Get all available sound packs for UI display
   */
  getAvailablePacks(): Array<{ id: SoundPackId; name: string; description: string; icon: string }> {
    return Object.values(SOUND_PACKS).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      icon: p.icon,
    }));
  }

  /**
   * Get the currently active pack
   */
  getCurrentPack(): SoundPackId {
    return this.currentPack;
  }

  /**
   * Switch to a different sound pack
   */
  setPack(packId: SoundPackId): void {
    const pack = SOUND_PACKS[packId];
    if (!pack) return;

    this.currentPack = packId;

    // Apply volume levels to SoundService
    soundService.setMasterVolume(pack.masterVolume);
    soundService.setEffectsVolume(pack.effectsVolume);

    // Enable/disable based on pack
    if (packId === 'silent') {
      soundService.setEnabled(false);
    } else {
      soundService.setEnabled(true);
    }

    // Persist selection
    try {
      localStorage.setItem('smarter_sound_pack', packId);
    } catch (err) {
      console.error('[SoundPackService] Error:', err);
      // localStorage might not be available
    }
  }

  /**
   * Check if a specific sound is enabled in the current pack
   */
  isSoundEnabled(soundName: string): boolean {
    const pack = SOUND_PACKS[this.currentPack];
    return pack.enabledSounds.has(soundName);
  }

  /**
   * Load saved pack preference from localStorage
   */
  loadSavedPack(): void {
    try {
      const saved = localStorage.getItem('smarter_sound_pack') as SoundPackId | null;
      if (saved && SOUND_PACKS[saved]) {
        this.setPack(saved);
      }
    } catch (err) {
      console.error('[SoundPackService] Error:', err);
      // Use default
    }
  }
}

// Singleton instance
export const soundPackService = new SoundPackService();
export default soundPackService;
