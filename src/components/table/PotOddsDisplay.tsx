/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Pot Odds Calculator Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows real-time pot odds when hero needs to call.
 * Displays both ratio and percentage format.
 */

import { memo, useMemo } from 'react';
import './PotOddsDisplay.css';

export interface PotOddsDisplayProps {
  pot: number;
  amountToCall: number;
  isVisible: boolean;
}

const PotOddsDisplay = memo(function PotOddsDisplay({
  pot,
  amountToCall,
  isVisible,
}: PotOddsDisplayProps) {
  const computed = useMemo(() => {
    if (!amountToCall || amountToCall <= 0 || !pot) return null;

    const totalPot = pot + amountToCall;
    const percentage = Math.round((amountToCall / totalPot) * 100);
    const ratio = (pot / amountToCall).toFixed(1);

    return { percentage, ratio, totalPot };
  }, [pot, amountToCall]);

  if (!isVisible || !computed) return null;

  return (
    <div className="pot-odds">
      <span className="pot-odds__label">Pot Odds</span>
      <span className="pot-odds__ratio">{computed.ratio}:1</span>
      <span className="pot-odds__pct">({computed.percentage}%)</span>
    </div>
  );
});

export default PotOddsDisplay;
