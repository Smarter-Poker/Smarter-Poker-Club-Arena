/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NUMERIC KEYPAD — Cash App-style touch-optimized financial input
 * ═══════════════════════════════════════════════════════════════════════════════
 * Provides large, haptic-enabled number buttons with quick-amount presets
 * and real-time chip value display.
 */

import { useCallback } from 'react';
import './NumericKeypad.css';
import { reportError } from '../../utils/errorReporter';
import { fireVibration } from '../../utils/vibrationGate';

// Haptic feedback utility
const triggerHaptic = (pattern: number | number[] = 8) => {
  try {
    // AUDIT 2026-08-20: private copy that called navigator.vibrate directly,
    // so neither vibration switch reached it. Routed through the shared gate.
    fireVibration(pattern);
  } catch (err) {
    reportError(err, 'NumericKeypad.Error');
    /* silent */
  }
};

interface NumericKeypadProps {
  value: string;
  onChange: (value: string) => void;
  maxAmount?: number;
  /** Quick-select presets shown above the keypad */
  quickAmounts?: number[];
  /** Conversion rate: chips per unit (e.g., 100 = 100 chips per 1 unit) */
  chipsPerUnit?: number;
  /** Whether to show the conversion display */
  showConversion?: boolean;
  /** Label shown above the value (e.g., "Deposit Amount") */
  label?: string;
}

export default function NumericKeypad({
  value,
  onChange,
  maxAmount,
  quickAmounts = [50, 100, 500, 1000],
  chipsPerUnit = 100,
  showConversion = true,
  label = 'Amount',
}: NumericKeypadProps) {
  const numericValue = parseFloat(value) || 0;
  const unitValue = chipsPerUnit > 0 ? numericValue / chipsPerUnit : 0;

  const handleKey = useCallback(
    (key: string) => {
      triggerHaptic(8);
      if (key === 'backspace') {
        onChange(value.slice(0, -1));
      } else if (key === '.') {
        if (!value.includes('.')) {
          onChange(value + '.');
        }
      } else {
        // Prevent leading zeros (except "0.")
        const next = value === '0' && key !== '.' ? key : value + key;
        // Enforce max 2 decimal places
        const parts = next.split('.');
        if (parts[1] && parts[1].length > 2) return;
        // Enforce max amount
        const parsed = parseFloat(next);
        if (maxAmount && parsed > maxAmount) return;
        onChange(next);
      }
    },
    [value, onChange, maxAmount]
  );

  const handleQuickAmount = useCallback(
    (amount: number) => {
      triggerHaptic(12);
      onChange(amount.toString());
    },
    [onChange]
  );

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'backspace'];

  return (
    <div className="numeric-keypad">
      {/* Display */}
      <div className="keypad-display">
        <span className="keypad-label">{label}</span>
        <div className="keypad-value">
          <span className="keypad-amount">{value || '0'}</span>
          <span className="keypad-chips-label">Chips</span>
        </div>
        {showConversion && numericValue > 0 && (
          <span className="keypad-conversion">≈ {unitValue.toFixed(2)} Units</span>
        )}
      </div>

      {/* Quick amount presets */}
      <div className="keypad-presets">
        {quickAmounts.map((qa) => (
          <button
            key={qa}
            className={`keypad-preset-btn ${numericValue === qa ? 'active' : ''}`}
            onClick={() => handleQuickAmount(qa)}
            type="button"
          >
            {qa >= 1000 ? `${qa / 1000}K` : qa.toLocaleString()}
          </button>
        ))}
      </div>

      {/* Keypad grid */}
      <div className="keypad-grid">
        {keys.map((key) => (
          <button
            key={key}
            className={`keypad-key ${key === 'backspace' ? 'keypad-key-action' : ''}`}
            onClick={() => handleKey(key)}
            type="button"
          >
            {key === 'backspace' ? '⌫' : key}
          </button>
        ))}
      </div>
    </div>
  );
}
