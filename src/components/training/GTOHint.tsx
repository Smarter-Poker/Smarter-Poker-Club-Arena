import React from 'react';
import './GTOHint.css';

interface GTOHintProps {
  action: 'fold' | 'check' | 'call' | 'raise' | 'all-in';
  frequency: number;
  evDiff?: number;
  alternativeAction?: string;
  alternativeFreq?: number;
  isExpanded?: boolean;
  onToggle?: () => void;
}

const ACTION_COLORS: Record<string, string> = {
  fold: '#f87171',
  check: '#60a5fa',
  call: '#4ade80',
  raise: '#fbbf24',
  'all-in': '#c084fc',
};

export const GTOHint: React.FC<GTOHintProps> = ({
  action,
  frequency,
  evDiff,
  alternativeAction,
  alternativeFreq,
  isExpanded = false,
  onToggle,
}) => {
  const actionColor = ACTION_COLORS[action] || '#ffd700';

  return (
    <div className={`gto-hint ${isExpanded ? 'expanded' : ''}`} onClick={onToggle}>
      <div className="hint-header">
        <span className="hint-label">GTO</span>
        <div className="hint-action" style={{ color: actionColor }}>
          {action.toUpperCase()}
        </div>
        <div className="hint-freq">{frequency}%</div>
      </div>

      {isExpanded && (
        <div className="hint-details">
          {evDiff !== undefined && (
            <div className="ev-info">
              <span className="gtohint__ev-label">EV Difference</span>
              <span className={`ev-value ${evDiff >= 0 ? 'positive' : 'negative'}`}>
                {evDiff >= 0 ? '+' : ''}
                {evDiff.toFixed(2)} BB
              </span>
            </div>
          )}

          {alternativeAction && (
            <div className="alternative">
              <span className="alt-label">Alternative:</span>
              <span className="alt-action" style={{ color: ACTION_COLORS[alternativeAction] }}>
                {alternativeAction.toUpperCase()}
              </span>
              <span className="alt-freq">{alternativeFreq}%</span>
            </div>
          )}

          <div className="hint-footer">
            <span> Mix Strategies At This Frequency</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default GTOHint;
