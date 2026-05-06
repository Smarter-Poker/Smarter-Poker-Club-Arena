/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableKeyboard — Keyboard Shortcuts for Power Users
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx.
 * Binds keyboard shortcuts for fast play:
 *
 *  ACTION KEYS (only when it's hero's turn):
 *    F = Fold
 *    C = Call / Check
 *    R = Raise (focus bet input)
 *    A = All-in
 *    1-4 = Bet presets (1/3, 1/2, 3/4, pot)
 *
 *  TOGGLE KEYS (always active):
 *    M = Mute/unmute sound
 *    S = Toggle stats HUD
 *    (FIX 199: H key for hand strength REMOVED — not allowed for live play)
 *    Escape = Close any open panel or modal
 *
 * OPTIMIZATION: Uses refs for all callbacks and state to prevent
 * re-subscribing the keydown listener on every render. Only one
 * listener is registered for the lifetime of the component.
 */

import { useEffect, useRef } from 'react';

export interface UseTableKeyboardOptions {
  isHeroTurn: boolean;
  isSpectator: boolean;
  isModalOpen: boolean;

  // Action callbacks
  onFold?: () => void;
  onCallCheck?: () => void;
  onRaise?: () => void;
  onAllIn?: () => void;
  onBetPreset?: (preset: number) => void; // 0=1/3, 1=1/2, 2=3/4, 3=pot

  // Toggle callbacks
  onToggleSound?: () => void;
  // FIX 199: onToggleHandStrength REMOVED — not allowed for live online gameplay
  onToggleStats?: () => void;
  onClosePanel?: () => void;
}

export function useTableKeyboard(options: UseTableKeyboardOptions): void {
  // Store all options in a ref — updated every render, always fresh in the listener
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const opts = optionsRef.current;

      // Skip if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      const key = e.key.toLowerCase();

      // ── Escape: always works ──
      if (key === 'escape') {
        e.preventDefault();
        opts.onClosePanel?.();
        return;
      }

      // ── Toggle keys: always active (unless spectator) ──
      if (!opts.isSpectator) {
        switch (key) {
          case 'm':
            e.preventDefault();
            opts.onToggleSound?.();
            return;
          // FIX 199: 'h' key for hand strength REMOVED — not allowed for live play
          case 's':
            if (!e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              opts.onToggleStats?.();
            }
            return;
        }
      }

      // ── Action keys: only when it's hero's turn ──
      if (opts.isHeroTurn && !opts.isSpectator && !opts.isModalOpen) {
        switch (key) {
          case 'f':
            e.preventDefault();
            opts.onFold?.();
            return;
          case 'c':
            e.preventDefault();
            opts.onCallCheck?.();
            return;
          case 'r':
            e.preventDefault();
            opts.onRaise?.();
            return;
          case 'a':
            e.preventDefault();
            opts.onAllIn?.();
            return;
          case '1':
            e.preventDefault();
            opts.onBetPreset?.(0); // 1/3 pot
            return;
          case '2':
            e.preventDefault();
            opts.onBetPreset?.(1); // 1/2 pot
            return;
          case '3':
            e.preventDefault();
            opts.onBetPreset?.(2); // 3/4 pot
            return;
          case '4':
            e.preventDefault();
            opts.onBetPreset?.(3); // pot
            return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Empty deps — optionsRef always fresh
}
