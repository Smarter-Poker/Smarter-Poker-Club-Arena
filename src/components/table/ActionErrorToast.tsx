import React, { useEffect, useRef } from 'react';
import './ActionErrorToast.css';
import { formatPopupText } from '../../utils/popupStyle';

// lucide-react is not a project dependency; use plain text/unicode glyphs
// so this component compiles. Swap to a real icon set later if desired.
const AlertCircle = (_: { size?: number; className?: string }) => <span aria-hidden="true">!</span>;
const X = (_: { size?: number }) => <span aria-hidden="true">&#10005;</span>;
const ChevronsRight = (_: { size?: number }) => <span aria-hidden="true">&#187;</span>;

export interface ActionErrorData {
  error: string;
  code?: string;
  hint?: {
    suggestedAction?: string;
    suggestedAmount?: number;
    [key: string]: any;
  };
}

interface ActionErrorToastProps {
  errorData: ActionErrorData | null;
  onClear: () => void;
  onApplyHint?: (action: string, amount: number) => void;
}

/** How long a refusal stays on the felt before it clears itself. */
const AUTO_CLEAR_MS = 4000;

export const ActionErrorToast: React.FC<ActionErrorToastProps> = ({
  errorData,
  onClear,
  onApplyHint,
}) => {
  /**
   * ═══ THE AUTO-DISMISS THAT NEVER FIRED ════════════════════════════════════
   * AUDIT 2026-08-25.
   *
   * The 4-second timeout depended on `[errorData, onClear]`, and TablePage
   * passes `onClear={() => setActionErrorData(null)}` — a NEW function object on
   * every render. TablePage re-renders whenever anything at the table moves, so
   * the effect tore its own timeout down and started a fresh one over and over
   * and the four seconds never elapsed. On the old ~30Hz action clock it
   * restarted about thirty times a second for the whole of a turn.
   *
   * So the toast that says the engine refused your action sat over the middle
   * of the felt, covering the board, until the player found the small × in the
   * corner of it. That is the opposite of "glassmorphic toast should not block".
   *
   * The callback lives in a ref; the timeout depends only on the error itself.
   */
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;

  useEffect(() => {
    if (!errorData) return;
    const timer = setTimeout(() => onClearRef.current(), AUTO_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [errorData]);

  if (!errorData) return null;

  const { error, hint } = errorData;

  const handleApply = () => {
    if (hint?.suggestedAction && hint?.suggestedAmount !== undefined && onApplyHint) {
      onApplyHint(hint.suggestedAction, hint.suggestedAmount);
      onClear();
    }
  };

  /* House rule (Dan 2026-08-20, binding): every popup renders with the First
     Letter Of Every Word Capitalized and no em dashes. This is a hand-rolled
     popup rather than a Toast — it has to be, because it carries an actionable
     hint button the Toast layer has no shape for — so it applies the Toast
     layer's own transform rather than being the one surface exempt from the
     rule. The strings come from the ENGINE, which writes them in ordinary
     sentence case, so without this it was the only popup at the table that
     looked different from every other one. */
  const message = formatPopupText(error);

  return (
    <div className="action-error-toast-container">
      {/* An action was refused. `role="alert"` is what makes a screen reader
          say so; without it the only notification of a rejected bet was
          visual. `assertive` because the player is on a shot clock. */}
      <div className="action-error-toast glass-metal-frame" role="alert" aria-live="assertive">
        <div className="toast-icon">
          <AlertCircle size={20} className="text-status-negative" />
        </div>

        <div className="toast-content">
          <div className="toast-message">{message}</div>

          {hint?.suggestedAction && hint?.suggestedAmount !== undefined && onApplyHint && (
            <button className="toast-hint-btn" onClick={handleApply}>
              <span>
                {/* House rule 5: format numbers with toLocaleString. A suggested
                    min-raise of 12500 printed as "12500". */}
                Snap To {formatPopupText(hint.suggestedAction)}{' '}
                {hint.suggestedAmount.toLocaleString()}
              </span>
              <ChevronsRight size={14} />
            </button>
          )}
        </div>

        {/* Was an unlabelled button holding a bare × — nothing for a screen
            reader, and nothing in the tooltip either. */}
        <button className="toast-close" onClick={onClear} aria-label="Dismiss" title="Dismiss">
          <X size={16} />
        </button>
      </div>
    </div>
  );
};
