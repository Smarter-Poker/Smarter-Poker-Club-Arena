/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INSURANCE PANEL — All-In Insurance Offer UI
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displayed when a player is all-in and insurance is offered.
 * Features:
 *   - Shows equity %, premium cost, and potential payout
 *   - Slider (like bet slider) for partial coverage (1-100%)
 *   - Real-time cost/payout preview as slider moves
 *   - Two decline options: "Decline Now" vs "Decline for Hand"
 *   - Accept button with coverage percentage
 *   - Auto-timeout countdown
 *
 * FIX 78: Partial coverage slider, dual decline options
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import './InsurancePanel.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsurancePanelProps {
  visible: boolean;
  equity: number; // Player's equity % (0-100)
  fullPremium: number; // Cost for 100% insurance
  fullInsuredAmount: number; // Payout for 100% insurance
  pot: number; // Current pot size
  timeoutSeconds: number; // Countdown timer
  onAccept: (coveragePercent: number) => void;
  onDeclineNow: () => void;
  onDeclineForHand: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function InsurancePanel({
  visible,
  equity,
  fullPremium,
  fullInsuredAmount,
  pot,
  timeoutSeconds,
  onAccept,
  onDeclineNow,
  onDeclineForHand,
}: InsurancePanelProps) {
  const [coveragePercent, setCoveragePercent] = useState(100);
  const [timeLeft, setTimeLeft] = useState(timeoutSeconds);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Calculate scaled values based on slider
  const currentPremium = Math.round(fullPremium * (coveragePercent / 100) * 100) / 100;
  const currentPayout = Math.round(fullInsuredAmount * (coveragePercent / 100) * 100) / 100;
  const netGain = currentPayout - currentPremium;

  // Countdown timer
  useEffect(() => {
    if (!visible) return;
    setTimeLeft(timeoutSeconds);
    setCoveragePercent(100);

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [visible, timeoutSeconds]);

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCoveragePercent(Number(e.target.value));
  }, []);

  // Quick preset buttons
  const presets = [25, 50, 75, 100];

  if (!visible) return null;

  return (
    <div className="insurance-panel">
      <div className="insurance-panel-inner">
        {/* Header */}
        <div className="insurance-header">
          <div className="insurance-shield">&#x1F6E1;&#xFE0F;</div>
          <div className="insurance-title">INSURANCE OFFER</div>
          <div className={`insurance-timer ${timeLeft <= 5 ? 'insurance-timer-urgent' : ''}`}>
            {timeLeft}s
          </div>
        </div>

        {/* Equity display */}
        <div className="insurance-equity">
          <span className="insurance-equity-label">Your Equity</span>
          <span className="insurance-equity-value">{equity.toFixed(1)}%</span>
        </div>

        {/* Coverage slider */}
        <div className="insurance-slider-section">
          <div className="insurance-slider-label">
            <span>Coverage</span>
            <span className="insurance-coverage-value">{coveragePercent}%</span>
          </div>
          <input
            type="range"
            min="1"
            max="100"
            value={coveragePercent}
            onChange={handleSliderChange}
            className="insurance-slider"
          />
          <div className="insurance-presets">
            {presets.map((p) => (
              <button
                key={p}
                className={`insurance-preset-btn ${coveragePercent === p ? 'insurance-preset-active' : ''}`}
                onClick={() => setCoveragePercent(p)}
              >
                {p}%
              </button>
            ))}
          </div>
        </div>

        {/* Cost / Payout display */}
        <div className="insurance-details">
          <div className="insurance-detail-row">
            <span className="insurance-detail-label">Premium (Cost)</span>
            <span className="insurance-detail-cost">-${currentPremium.toFixed(2)}</span>
          </div>
          <div className="insurance-detail-row">
            <span className="insurance-detail-label">If you lose, payout</span>
            <span className="insurance-detail-payout">+${currentPayout.toFixed(2)}</span>
          </div>
          <div className="insurance-detail-row insurance-detail-net">
            <span className="insurance-detail-label">Net gain if loss</span>
            <span
              className={`insurance-detail-value ${netGain > 0 ? 'insurance-positive' : 'insurance-negative'}`}
            >
              {netGain >= 0 ? '+' : ''}${netGain.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="insurance-actions">
          <button
            className="insurance-btn insurance-btn-accept"
            onClick={() => onAccept(coveragePercent)}
          >
            Accept {coveragePercent < 100 ? `${coveragePercent}%` : 'Full'} Insurance
          </button>
          <div className="insurance-decline-row">
            <button className="insurance-btn insurance-btn-decline-now" onClick={onDeclineNow}>
              Decline Now
            </button>
            <button className="insurance-btn insurance-btn-decline-hand" onClick={onDeclineForHand}>
              Decline for Hand
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default InsurancePanel;
