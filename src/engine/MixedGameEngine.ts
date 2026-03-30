/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MIXED GAME ENGINE — Automatic Game Variant Rotation (HORSE, etc.)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages automatic rotation of poker variants at a table:
 * - HORSE: Hold'em → Omaha Hi/Lo → Razz → Stud → Eight-or-Better
 * - Custom sequences: any combination of supported variants
 * - Rotation trigger: after N hands (default: 1 full orbit)
 * - Bus emissions for UI synchronization
 */

import { masterBus } from '../core/MasterBus';
import type { GameVariant } from '../types/database.types';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Standard mixed game rotations.
 * Each key maps to an ordered array of variants.
 */
export const MIXED_GAME_PRESETS: Record<string, GameVariant[]> = {
  HORSE: ['nlh', 'plo4', 'nlh', 'nlh', 'plo4'],
  // Full HORSE requires Razz/Stud/8OB — placeholder for when those variants are added
  // True HORSE: ['nlh', 'plo8', 'razz', 'stud', 'stud8'],
  HOLDEM_OMAHA: ['nlh', 'plo4'],
  HOLDEM_PLO5: ['nlh', 'plo5'],
  DOUBLE_BOARD_ROTATION: ['nlh', 'plo4', 'plo5', 'plo6'],
  OMAHA_VARIANTS: ['plo4', 'plo5', 'plo6'],
};

export interface MixedGameConfig {
  /** Preset name or 'custom' */
  presetName: string;
  /** Ordered list of variants to rotate through */
  variants: GameVariant[];
  /** How many hands at each variant before rotating (default: equals player count for 1 orbit) */
  handsPerVariant: number;
  /** If true, automatically set handsPerVariant to player count (1 orbit) */
  rotatePerOrbit: boolean;
}

export interface MixedGameState {
  tableId: string;
  config: MixedGameConfig;
  currentIndex: number;
  handsDealtAtCurrentVariant: number;
  totalRotations: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIXED GAME ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class MixedGameEngineClass {
  private tableStates: Map<string, MixedGameState> = new Map();

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Configure mixed game rotation for a table
   */
  configure(tableId: string, config: MixedGameConfig): void {
    if (config.variants.length === 0) return;

    this.tableStates.set(tableId, {
      tableId,
      config,
      currentIndex: 0,
      handsDealtAtCurrentVariant: 0,
      totalRotations: 0,
    });
  }

  /**
   * Configure using a preset name
   */
  configurePreset(
    tableId: string,
    presetName: string,
    handsPerVariant: number = 6,
    rotatePerOrbit: boolean = true
  ): void {
    const variants = MIXED_GAME_PRESETS[presetName];
    if (!variants) {
      reportError(new Error(`[MixedGameEngine] Unknown preset: ${presetName}`), 'MixedGameEngine.Unknown_preset');
      return;
    }

    this.configure(tableId, {
      presetName,
      variants: [...variants],
      handsPerVariant,
      rotatePerOrbit,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VARIANT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the current game variant for the table.
   * Called by HeadlessTableEngine before each hand to determine which variant to deal.
   */
  getCurrentVariant(tableId: string): GameVariant | null {
    const state = this.tableStates.get(tableId);
    if (!state) return null;
    return state.config.variants[state.currentIndex];
  }

  /**
   * Called after each hand is dealt.
   * Tracks hands played and rotates variant when threshold is reached.
   *
   * @param playerCount - Current number of active players (used for orbit calculation)
   * @returns The new variant if rotation occurred, null otherwise
   */
  onHandComplete(tableId: string, playerCount: number): GameVariant | null {
    const state = this.tableStates.get(tableId);
    if (!state) return null;

    state.handsDealtAtCurrentVariant++;

    // Determine rotation threshold
    const threshold = state.config.rotatePerOrbit
      ? Math.max(playerCount, 2) // 1 orbit = playerCount hands
      : state.config.handsPerVariant;

    // Check if it's time to rotate
    if (state.handsDealtAtCurrentVariant >= threshold) {
      const previousVariant = state.config.variants[state.currentIndex];
      const handsAtPrevious = state.handsDealtAtCurrentVariant;

      // Rotate to next variant
      state.currentIndex = (state.currentIndex + 1) % state.config.variants.length;
      state.handsDealtAtCurrentVariant = 0;
      state.totalRotations++;

      const newVariant = state.config.variants[state.currentIndex];

      masterBus.emit('GAME_VARIANT_ROTATED', {
        tableId,
        previousVariant,
        newVariant,
        handsAtPrevious,
      });

      return newVariant;
    }

    return null;
  }

  /**
   * Manually force rotation to the next variant
   */
  forceRotate(tableId: string): GameVariant | null {
    const state = this.tableStates.get(tableId);
    if (!state) return null;

    const previousVariant = state.config.variants[state.currentIndex];
    state.currentIndex = (state.currentIndex + 1) % state.config.variants.length;
    state.handsDealtAtCurrentVariant = 0;
    state.totalRotations++;

    const newVariant = state.config.variants[state.currentIndex];

    masterBus.emit('GAME_VARIANT_ROTATED', {
      tableId,
      previousVariant,
      newVariant,
      handsAtPrevious: 0,
    });

    return newVariant;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  getState(tableId: string): MixedGameState | null {
    return this.tableStates.get(tableId) ?? null;
  }

  isActive(tableId: string): boolean {
    return this.tableStates.has(tableId);
  }

  /**
   * Get display info for the rotation schedule
   */
  getSchedule(tableId: string): Array<{ variant: GameVariant; isCurrent: boolean }> | null {
    const state = this.tableStates.get(tableId);
    if (!state) return null;

    return state.config.variants.map((variant, i) => ({
      variant,
      isCurrent: i === state.currentIndex,
    }));
  }

  getHandsUntilRotation(tableId: string, playerCount: number): number {
    const state = this.tableStates.get(tableId);
    if (!state) return 0;

    const threshold = state.config.rotatePerOrbit
      ? Math.max(playerCount, 2)
      : state.config.handsPerVariant;

    return Math.max(0, threshold - state.handsDealtAtCurrentVariant);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(tableId: string): void {
    this.tableStates.delete(tableId);
  }
}

export const mixedGameEngine = new MixedGameEngineClass();
export default mixedGameEngine;
