import React from 'react';
import './EVCalculator.css';

interface EVCalculatorProps {
  potSize: number;
  betSize: number;
  winProbability: number;
  showBreakdown?: boolean;
}

export const EVCalculator: React.FC<EVCalculatorProps> = ({
  potSize,
  betSize,
  winProbability,
  showBreakdown = true,
}) => {
  // EV = (Win% * Pot) - (Lose% * Bet)
  const winEV = (winProbability / 100) * (potSize + betSize);
  const loseEV = ((100 - winProbability) / 100) * betSize;
  const totalEV = winEV - loseEV;

  // Required equity to break even
  const requiredEquity = (betSize / (potSize + betSize)) * 100;

  const isPositiveEV = totalEV > 0;

  return (
    <div className="ev-calculator">
      <div className="ev-result">
        <span className="evcalculator__ev-label">Expected Value</span>
        <span className={`ev-value ${isPositiveEV ? 'positive' : 'negative'}`}>
          {isPositiveEV ? '+' : ''}
          {totalEV.toFixed(2)}
        </span>
      </div>

      {showBreakdown && (
        <div className="ev-breakdown">
          <div className="breakdown-row">
            <span>Pot Size</span>
            <span>{potSize.toLocaleString()}</span>
          </div>
          <div className="breakdown-row">
            <span>Bet Size</span>
            <span>{betSize.toLocaleString()}</span>
          </div>
          <div className="breakdown-row">
            <span>Win Probability</span>
            <span>{winProbability.toFixed(1)}%</span>
          </div>
          <div className="breakdown-divider"></div>
          <div className="breakdown-row">
            <span>Win EV</span>
            <span className="positive">+{winEV.toFixed(2)}</span>
          </div>
          <div className="breakdown-row">
            <span>Lose EV</span>
            <span className="negative">-{loseEV.toFixed(2)}</span>
          </div>
          <div className="breakdown-divider"></div>
          <div className="breakdown-row required">
            <span>Required Equity</span>
            <span>{requiredEquity.toFixed(1)}%</span>
          </div>
        </div>
      )}

      <div className="ev-verdict">
        {isPositiveEV ? (
          <span className="verdict positive"> +EV Call</span>
        ) : (
          <span className="verdict negative"> -EV Call</span>
        )}
      </div>
    </div>
  );
};

export default EVCalculator;
