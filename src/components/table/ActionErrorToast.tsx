import React, { useEffect } from 'react';
import './ActionErrorToast.css';
// lucide-react is not a project dependency; use plain text/unicode glyphs
// so this component compiles. Swap to a real icon set later if desired.
const AlertCircle = (_: { size?: number; className?: string }) => <span aria-hidden="true">!</span>;
const X = (_: { size?: number }) => <span aria-hidden="true">×</span>;
const ChevronsRight = (_: { size?: number }) => <span aria-hidden="true">»</span>;

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

export const ActionErrorToast: React.FC<ActionErrorToastProps> = ({
  errorData,
  onClear,
  onApplyHint,
}) => {
  useEffect(() => {
    if (errorData) {
      // Auto-clear after 4 seconds (glassmorphic toast should not block)
      const timer = setTimeout(() => {
        onClear();
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [errorData, onClear]);

  if (!errorData) return null;

  const { error, hint } = errorData;

  const handleApply = () => {
    if (hint?.suggestedAction && hint?.suggestedAmount !== undefined && onApplyHint) {
      onApplyHint(hint.suggestedAction, hint.suggestedAmount);
      onClear();
    }
  };

  return (
    <div className="action-error-toast-container">
      <div className="action-error-toast glass-metal-frame">
        <div className="toast-icon">
          <AlertCircle size={20} className="text-status-negative" />
        </div>

        <div className="toast-content">
          <div className="toast-message">{error}</div>

          {hint?.suggestedAction && hint?.suggestedAmount !== undefined && onApplyHint && (
            <button className="toast-hint-btn" onClick={handleApply}>
              <span>
                Snap To {hint.suggestedAction.toUpperCase()} {hint.suggestedAmount}
              </span>
              <ChevronsRight size={14} />
            </button>
          )}
        </div>

        <button className="toast-close" onClick={onClear}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
};
