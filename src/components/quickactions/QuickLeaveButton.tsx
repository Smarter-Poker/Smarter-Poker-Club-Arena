import React, { useState } from 'react';
import './QuickLeaveButton.css';

interface QuickLeaveButtonProps {
  currentStack: number;
  buyIn: number;
  onLeave?: () => void;
}

export const QuickLeaveButton: React.FC<QuickLeaveButtonProps> = ({
  currentStack,
  buyIn,
  onLeave,
}) => {
  const [showConfirm, setShowConfirm] = useState(false);

  const profit = currentStack - buyIn;
  const profitPercent = ((profit / buyIn) * 100).toFixed(1);

  const handleLeave = () => {
    onLeave?.();
    setShowConfirm(false);
  };

  return (
    <>
      <button className="quick-leave-button" onClick={() => setShowConfirm(true)}>
        <span className="leave-icon"></span>
        <span className="leave-text">Leave Table</span>
      </button>

      {showConfirm && (
        <div className="leave-confirm-overlay" onClick={() => setShowConfirm(false)}>
          <div className="leave-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Leave Table?</h3>

            <div className="leave-summary">
              <div className="quick-leave-button__summary-row">
                <span>Buy-In</span>
                <span>{buyIn.toLocaleString()}</span>
              </div>
              <div className="quick-leave-button__summary-row">
                <span>Current Stack</span>
                <span>{currentStack.toLocaleString()}</span>
              </div>
              <div
                className={`quick-leave-button__summary-row profit ${profit >= 0 ? 'positive' : 'negative'}`}
              >
                <span>Profit/Loss</span>
                <span>
                  {profit >= 0 ? '+' : ''}
                  {profit.toLocaleString()}
                  <small>
                    {' '}
                    ({profit >= 0 ? '+' : ''}
                    {profitPercent}%)
                  </small>
                </span>
              </div>
            </div>

            <div className="leave-actions">
              <button className="cancel-btn" onClick={() => setShowConfirm(false)}>
                Stay
              </button>
              <button className="confirm-btn" onClick={handleLeave}>
                Leave & Cash Out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default QuickLeaveButton;
