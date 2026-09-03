/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FOLD PROTECTION DIALOG — Spec §5.6 ("Check or Fold?")
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Misclick guard: when the player taps FOLD while CHECKING is free (no bet to
 * face), we pop a confirmation modal instead of folding immediately. If there
 * is a bet to call, Fold executes with no confirmation — same as before.
 *
 * Parent decides when to render. See TablePage's fold handlers for the gating
 * logic (canCheck + !isCallPending → prompt). The dialog never decides itself;
 * it just shows the UI and reports the user's choice.
 *
 * ── 2026-08-23: WHY THIS DIALOG USED TO LOOK BROKEN ──────────────────────────
 * Dan: "folding when you can check doesn't work, it just acts like a check."
 *
 * The dialog was already wired correctly. What killed it was that the overlay
 * carried `onClick={onDismiss}` across the whole viewport and mounted directly
 * under the finger that had just pressed FOLD. On touch devices the browser
 * synthesises a `click` ~300ms after `touchend`, and that ghost click landed on
 * the freshly-mounted backdrop — dismissing the dialog before a human could
 * read it. From the player's side: FOLD does nothing, the clock runs out, and
 * the server's timeout policy (check when free, fold when not) checks the hand.
 * A fold that behaves like a check.
 *
 * Two changes stop it:
 *   1. The backdrop no longer dismisses. This is a confirmation for an
 *      irreversible action; a stray tap anywhere on screen must not answer it.
 *      Escape and the × still close it, both of which are deliberate.
 *   2. Nothing in the dialog accepts input for the first 350ms, which outlasts
 *      the synthetic-click window. Covers the × too, so the opening tap cannot
 *      close what it just opened.
 *
 * Confirming FOLD is final — the parent submits it with no further prompt.
 */

import React, { useEffect, useRef, useState } from 'react';
import './FoldProtectionDialog.css';

/** Outlasts the ~300ms synthetic click a touch device fires after touchend. */
const GHOST_CLICK_GUARD_MS = 350;

interface FoldProtectionDialogProps {
  open: boolean;
  onCheck: () => void;
  onFold: () => void;
  onDismiss: () => void;
}

export const FoldProtectionDialog: React.FC<FoldProtectionDialogProps> = ({
  open,
  onCheck,
  onFold,
  onDismiss,
}) => {
  const [armed, setArmed] = useState(false);
  // Guards against a double-submit between the click and the parent's unmount.
  const answeredRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setArmed(false);
      answeredRef.current = false;
      return;
    }
    const t = setTimeout(() => setArmed(true), GHOST_CLICK_GUARD_MS);
    return () => clearTimeout(t);
  }, [open]);

  // Escape dismisses. Deliberate, unlike a backdrop tap, and it is the one
  // keyboard affordance a desktop player will reach for by reflex.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  const answer = (fn: () => void) => () => {
    if (!armed || answeredRef.current) return;
    answeredRef.current = true;
    fn();
  };

  return (
    <div
      className="fold-protect-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fold-protect-title"
      /* NO onClick here. See the header note: a backdrop that dismisses is what
         made this dialog invisible in practice. */
    >
      <div className="fold-protect-modal">
        <button
          type="button"
          className="fold-protect-close"
          aria-label="Dismiss"
          onClick={answer(onDismiss)}
        >
          ×
        </button>
        <h3 id="fold-protect-title" className="fold-protect-title">
          Check Or Fold?
        </h3>
        <p className="fold-protect-body">Notice: You Can Check This Hand Instead Of Folding.</p>
        <div className="fold-protect-actions">
          <button
            type="button"
            className="fold-protect-btn fold-protect-btn--check"
            onClick={answer(onCheck)}
          >
            Check
          </button>
          <button
            type="button"
            className="fold-protect-btn fold-protect-btn--fold"
            onClick={answer(onFold)}
          >
            Fold
          </button>
        </div>
      </div>
    </div>
  );
};

export default FoldProtectionDialog;
