/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTableKeyboard — Keyboard Shortcuts for Power Users
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TablePage.tsx.
 * Binds keyboard shortcuts for fast play:
 *
 *  ACTION KEYS (only when it's hero's turn):
 *    F, Q = Fold
 *    C, W = Call / Check
 *    R, E = Raise (open the sizing panel)
 *    A    = All-in
 *    1-4  = Bet presets (1/3, 1/2, 3/4, pot) — ONLY while the sizing panel is
 *           open; see `isSizingOpen` below.
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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THIS IS THE ONLY KEYBOARD SYSTEM ON THE TABLE (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TablePage carried a SECOND `window.addEventListener('keydown')` of its own,
 * handling F/Q, C/W, R/E and A through a parallel set of handlers. Both were
 * live at once, so every one of those keys ran two code paths per press; the
 * only thing standing between that and a double-submitted action was
 * `actionLockRef` happening to be taken synchronously by whichever handler got
 * there first. That effect is deleted and its Q/W/E aliases moved here.
 *
 * THE PART THAT COST MONEY, and the reason `isActive` is now REQUIRED:
 * MultiTablePage keeps up to four TablePage instances mounted, and each one
 * mounted its own copy of this listener on `window`. Nothing consulted which
 * table the player was actually looking at. Hero with action on two tables —
 * routine when multi-tabling — pressed F once and folded BOTH hands, into two
 * different pots, with two different `actionLockRef`s that cannot see each
 * other. `C` called both. `M` toggled the sound once per open table, so with an
 * even number of tables mute did nothing at all.
 *
 * `isActive` is not optional and has no default. A caller that cannot say which
 * table is in front has to answer the question rather than inherit `true`.
 */

import { useEffect, useRef } from 'react';

export interface UseTableKeyboardOptions {
  /**
   * Is this the table the player is actually looking at? Every key below is
   * ignored when false. Required on purpose — see the note above.
   */
  isActive: boolean;
  isHeroTurn: boolean;
  isSpectator: boolean;
  isModalOpen: boolean;
  /**
   * Is the bet-sizing panel open? The number row is shared with MultiTablePage,
   * where 1-4 SWITCH TABLES, and both listeners are on `window` — so pressing
   * "2" to move to table two also armed a half-pot raise on the table being
   * left. The presets size a bet that is already being sized; they do not start
   * one. Press R (or E) first, then 1-4.
   */
  isSizingOpen: boolean;

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

      // NOT THIS TABLE, NOT THIS KEYPRESS. First test in the handler, before
      // anything can preventDefault or fire a callback: an inactive table has
      // no business seeing the keyboard at all, and one that does folds hands
      // the player is not looking at.
      if (!opts.isActive) return;

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
      // Two aliases per action (Phase 2 T1-10 / spec §5.5): the F/C/R/A
      // mnemonic row and the PokerBros-style left-hand Q/W/E row. They were in
      // TablePage's own duplicate listener until 2026-08-28; they live here now
      // so there is one place a key maps to an action.
      if (opts.isHeroTurn && !opts.isSpectator && !opts.isModalOpen) {
        switch (key) {
          case 'f':
          case 'q':
            e.preventDefault();
            opts.onFold?.();
            return;
          case 'c':
          case 'w':
            e.preventDefault();
            opts.onCallCheck?.();
            return;
          case 'r':
          case 'e':
            e.preventDefault();
            opts.onRaise?.();
            return;
          case 'a':
            e.preventDefault();
            opts.onAllIn?.();
            return;
          case '1':
          case '2':
          case '3':
          case '4':
            // Sizing only. Un-open, the number row belongs to MultiTablePage's
            // table switcher — see `isSizingOpen`. Falling through WITHOUT
            // preventDefault is the point: the switch still gets the key.
            if (!opts.isSizingOpen) return;
            e.preventDefault();
            // 0 = 1/3 pot, 1 = 1/2, 2 = 3/4, 3 = pot
            opts.onBetPreset?.(Number(key) - 1);
            return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Empty deps — optionsRef always fresh
}
