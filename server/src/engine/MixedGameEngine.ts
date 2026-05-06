/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MIXED GAME ENGINE — Automatic Game Variant Rotation (HORSE, etc.)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages automatic rotation of poker variants at a table:
 * - HORSE: Hold'em → Omaha Hi/Lo → Razz → Stud → Eight-or-Better
 * - Custom sequences: any combination of supported variants
 * - Rotation trigger: after N hands (default: 1 full orbit)
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/MixedGameEngine.ts (230 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

import type { GameVariant } from '../types.js';
import { reportError } from '../services/errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

// FIX 160: Bible V8 §7.20 — HORSE preset corrected to include plo8 (Omaha Hi/Lo)
// True HORSE = Hold'em → Omaha Hi/Lo → Razz → Stud → Eight-or-Better
// Since Razz/Stud are not yet supported, we approximate with available variants.
// When Stud variants are added, update this preset.
export const MIXED_GAME_PRESETS: Record<string, GameVariant[]> = {
  HORSE: ['nlh', 'plo4', 'plo8', 'short_deck', 'plo8'],
  HOLDEM_OMAHA: ['nlh', 'plo4'],
  HOLDEM_PLO_HILO: ['nlh', 'plo4', 'plo8'],
  HOLDEM_PLO5: ['nlh', 'plo5'],
  DOUBLE_BOARD_ROTATION: ['nlh', 'plo4', 'plo5', 'plo6'],
  OMAHA_VARIANTS: ['plo4', 'plo5', 'plo6'],
};

export interface MixedGameConfig {
  presetName: string;
  variants: GameVariant[];
  handsPerVariant: number;
  rotatePerOrbit: boolean;
}

export interface MixedGameState {
  tableId: string;
  config: MixedGameConfig;
  currentIndex: number;
  handsDealtAtCurrentVariant: number;
  totalRotations: number;
}

export type MixedGameEventType = 'GAME_VARIANT_ROTATED';

export interface MixedGameEvent {
  type: MixedGameEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIXED GAME ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class MixedGameEngine {
  private tableStates: Map<string, MixedGameState> = new Map();
  private onEvent?: (event: MixedGameEvent) => void;

  constructor(onEvent?: (event: MixedGameEvent) => void) {
    this.onEvent = onEvent;
  }

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

  configurePreset(
    tableId: string,
    presetName: string,
    handsPerVariant: number = 6,
    rotatePerOrbit: boolean = true
  ): void {
    const variants = MIXED_GAME_PRESETS[presetName];
    if (!variants) {
      reportError(
        new Error(`[MixedGameEngine] Unknown preset: ${presetName}`),
        'MixedGameEngine.Unknown_preset'
      );
      return;
    }

    this.configure(tableId, {
      presetName,
      variants: [...variants],
      handsPerVariant,
      rotatePerOrbit,
    });
  }

  getCurrentVariant(tableId: string): GameVariant | null {
    const state = this.tableStates.get(tableId);
    if (!state) return null;
    return state.config.variants[state.currentIndex];
  }

  /**
   * Called after each hand. Rotates variant when threshold reached.
   * @returns The new variant if rotation occurred, null otherwise
   */
  onHandComplete(tableId: string, playerCount: number): GameVariant | null {
    const state = this.tableStates.get(tableId);
    if (!state) return null;

    state.handsDealtAtCurrentVariant++;

    const threshold = state.config.rotatePerOrbit
      ? Math.max(playerCount, 2)
      : state.config.handsPerVariant;

    if (state.handsDealtAtCurrentVariant >= threshold) {
      const previousVariant = state.config.variants[state.currentIndex];
      const handsAtPrevious = state.handsDealtAtCurrentVariant;

      state.currentIndex = (state.currentIndex + 1) % state.config.variants.length;
      state.handsDealtAtCurrentVariant = 0;
      state.totalRotations++;

      const newVariant = state.config.variants[state.currentIndex];

      this.emitEvent({
        type: 'GAME_VARIANT_ROTATED',
        tableId,
        previousVariant,
        newVariant,
        handsAtPrevious,
      });

      return newVariant;
    }

    return null;
  }

  forceRotate(tableId: string): GameVariant | null {
    const state = this.tableStates.get(tableId);
    if (!state) return null;

    const previousVariant = state.config.variants[state.currentIndex];
    state.currentIndex = (state.currentIndex + 1) % state.config.variants.length;
    state.handsDealtAtCurrentVariant = 0;
    state.totalRotations++;

    const newVariant = state.config.variants[state.currentIndex];

    this.emitEvent({
      type: 'GAME_VARIANT_ROTATED',
      tableId,
      previousVariant,
      newVariant,
      handsAtPrevious: 0,
    });

    return newVariant;
  }

  getState(tableId: string): MixedGameState | null {
    return this.tableStates.get(tableId) ?? null;
  }

  isActive(tableId: string): boolean {
    return this.tableStates.has(tableId);
  }

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

  dispose(tableId: string): void {
    this.tableStates.delete(tableId);
  }

  disposeAll(): void {
    this.tableStates.clear();
  }

  private emitEvent(event: MixedGameEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'MixedGameEngine.Event_handler_error');
      }
    }
  }
}
