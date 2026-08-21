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
 */

import React from 'react';
import './FoldProtectionDialog.css';

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
  if (!open) return null;
  return (
    <div
      className="fold-protect-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fold-protect-title"
      onClick={onDismiss}
    >
      <div className="fold-protect-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="fold-protect-close"
          aria-label="Dismiss"
          onClick={onDismiss}
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
            onClick={onCheck}
          >
            Check
          </button>
          <button
            type="button"
            className="fold-protect-btn fold-protect-btn--fold"
            onClick={onFold}
          >
            Fold
          </button>
        </div>
      </div>
    </div>
  );
};

export default FoldProtectionDialog;
