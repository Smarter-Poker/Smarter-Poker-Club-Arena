/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POT ODDS CALCULATOR — Quick Math Tool
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useMemo, useEffect } from 'react';
import './PotOddsCalculator.css';

interface PotOddsCalculatorProps {
  isOpen: boolean;
  onClose: () => void;
  initialPot?: number;
  initialBet?: number;
}

export function PotOddsCalculator({
  isOpen,
  onClose,
  initialPot = 0,
  initialBet = 0,
}: PotOddsCalculatorProps) {
  const [pot, setPot] = useState(initialPot);
  const [bet, setBet] = useState(initialBet);
  const [outs, setOuts] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  const calculations = useMemo(() => {
    const totalPot = pot + bet;
    const potOdds = bet > 0 ? (bet / totalPot) * 100 : 0;
    const impliedOdds = bet > 0 ? pot / bet : 0;

    // Rule of 2 and 4
    const oneCard = outs * 2;
    const twoCards = outs * 4;

    // Break-even needed
    const breakEven = potOdds;

    // Profitable call?
    const isProfitable = oneCard >= potOdds;

    return {
      potOdds: potOdds.toFixed(1),
      impliedOdds: impliedOdds.toFixed(2),
      oneCardEquity: oneCard.toFixed(1),
      twoCardEquity: twoCards.toFixed(1),
      breakEven: breakEven.toFixed(1),
      isProfitable,
    };
  }, [pot, bet, outs]);

  if (!isOpen) return null;

  return (
    <div className="pot-odds-overlay" onClick={onClose}>
      <div
        className="pot-odds"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="pot-odds__header">
          <h3> Pot Odds Calculator</h3>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="pot-odds__inputs">
          <div className="input-group">
            <label>Pot Size</label>
            <input
              type="number"
              value={pot || ''}
              onChange={(e) => setPot(Number(e.target.value))}
              placeholder="0"
            />
          </div>
          <div className="input-group">
            <label>Bet To Call</label>
            <input
              type="number"
              value={bet || ''}
              onChange={(e) => setBet(Number(e.target.value))}
              placeholder="0"
            />
          </div>
          <div className="input-group">
            <label>Outs</label>
            <input
              type="number"
              value={outs || ''}
              onChange={(e) => setOuts(Number(e.target.value))}
              placeholder="0"
              min={0}
              max={47}
            />
          </div>
        </div>

        <div className="pot-odds__results">
          <div className="result">
            <span className="label">Pot Odds</span>
            <span className="value">{calculations.potOdds}%</span>
          </div>
          <div className="result">
            <span className="label">Implied Odds</span>
            <span className="value">{calculations.impliedOdds}:1</span>
          </div>
          <div className="result">
            <span className="label">Equity (1 Card)</span>
            <span className="value">{calculations.oneCardEquity}%</span>
          </div>
          <div className="result">
            <span className="label">Equity (2 Cards)</span>
            <span className="value">{calculations.twoCardEquity}%</span>
          </div>
        </div>

        <div className={`pot-odds__verdict ${calculations.isProfitable ? 'call' : 'fold'}`}>
          {calculations.isProfitable ? (
            <>
              {' '}
              Profitable Call (Need {calculations.breakEven}%, Have {calculations.oneCardEquity}%)
            </>
          ) : (
            <>
              {' '}
              Unprofitable (Need {calculations.breakEven}%, Have {calculations.oneCardEquity}%)
            </>
          )}
        </div>

        <div className="pot-odds__outs-guide">
          <h4>Common Outs</h4>
          <div className="outs-grid">
            <button onClick={() => setOuts(4)}>Gutshot (4)</button>
            <button onClick={() => setOuts(8)}>OESD (8)</button>
            <button onClick={() => setOuts(9)}>Flush (9)</button>
            <button onClick={() => setOuts(15)}>Flush+OESD (15)</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PotOddsCalculator;
