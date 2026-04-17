/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🔘 STRADDLE TOGGLE — UTG Option
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Toggle switch for UTG player to enable/disable straddle:
 * - Shows cost (2x BB)
 * - Visual on/off state
 * - Wired to StraddleEngine for bus event emission
 */

import React from 'react';
import { haptic, soundService } from '../../services/SoundService';
import './StraddleToggle.css';

export interface StraddleToggleProps {
  tableId: string;
  playerId: string;
  isEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  amount: number;
  currency?: string;
  isAvailable: boolean; // only available to UTG before cards dealt
}

export function StraddleToggle({
  tableId,
  playerId,
  isEnabled,
  onToggle,
  amount,
  currency = '',
  isAvailable,
}: StraddleToggleProps) {
  if (!isAvailable) return null;

  // FIX 189: Use haptic service instead of raw navigator.vibrate
  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = e.target.checked;
    soundService.playStraddle();
    // Server-authoritative: parent handles the server API call via onToggle
    onToggle(enabled);
  };

  return (
    <div className="straddle-toggle">
      <label className="straddle-toggle__wrapper">
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={handleToggle}
          className="straddle-toggle__input"
        />
        <div className="straddle-toggle__switch">
          <span className="straddle-toggle__knob" />
        </div>
        <div className="straddle-toggle__info">
          <span className="straddle-toggle__label">STRADDLE</span>
          {/* FIX 190: Format with toLocaleString for proper number display */}
          <span className="straddle-toggle__amount">
            {currency}
            {amount.toLocaleString()}
          </span>
        </div>
      </label>
    </div>
  );
}

export default StraddleToggle;
