/**
 * ♠ CLUB ARENA — Action Panel Component
 * PokerBros-style action buttons: Fold (red), Check/Call (green), Raise (amber)
 * Professional 3-button horizontal layout with raise mode sub-panel
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { haptic } from '../../services/SoundService';
import './ActionPanel.css';

interface ActionPanelProps {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canRaise: boolean;
  canAllIn: boolean;
  callAmount: number;
  minRaise: number;
  maxRaise: number;
  pot: number;
  bigBlind: number;
  onAction: (action: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number) => void;
  isMyTurn?: boolean;
  showPotOdds?: boolean;
  confirmAllIn?: boolean;
  showBetSizePresets?: boolean;
}

function formatChips(amount: number): string {
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 10000) return `${(amount / 1000).toFixed(1)}K`;
  if (amount === Math.floor(amount)) return amount.toLocaleString();
  return amount.toFixed(2);
}

export default function ActionPanel({
  canFold,
  canCheck,
  canCall,
  canRaise,
  canAllIn,
  callAmount,
  minRaise,
  maxRaise,
  pot,
  bigBlind,
  onAction,
  isMyTurn = true,
  showPotOdds = false,
  confirmAllIn = true,
  showBetSizePresets = true,
}: ActionPanelProps) {
  const [isRaiseMode, setIsRaiseMode] = useState(false);
  const [pendingAllIn, setPendingAllIn] = useState(false);
  const [raiseAmount, setRaiseAmount] = useState(minRaise);
  const [turnPulse, setTurnPulse] = useState(false);
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1024
  );
  const prevTurnRef = useRef(isMyTurn);

  // Reset raise amount when minRaise changes (new street/hand)
  useEffect(() => {
    setRaiseAmount(minRaise);
  }, [minRaise]);

  // Close raise mode and pending confirmations when turn ends
  useEffect(() => {
    if (!isMyTurn) {
      setIsRaiseMode(false);
      setPendingAllIn(false);
    }
  }, [isMyTurn]);

  // Attention pulse when isMyTurn becomes true
  useEffect(() => {
    if (isMyTurn && !prevTurnRef.current) {
      setTurnPulse(true);
      const timer = setTimeout(() => setTurnPulse(false), 600);
      prevTurnRef.current = isMyTurn;
      return () => clearTimeout(timer);
    }
    prevTurnRef.current = isMyTurn;
  }, [isMyTurn]);

  // Track window width for desktop keyboard shortcut hints
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isDesktop = windowWidth >= 768;

  // Smart presets — adapt to street context
  const presets = [
    { label: '⅓ Pot', value: Math.round(pot * 0.33) },
    { label: '½ Pot', value: Math.round(pot * 0.5) },
    { label: '¾ Pot', value: Math.round(pot * 0.75) },
    { label: 'Pot', value: pot },
  ];

  // Track last slider value for haptic snap feedback
  const lastSnapRef = useRef<number>(minRaise);

  const handleRaiseClick = useCallback(() => {
    if (!canRaise && !canAllIn) return;
    haptic.light();
    setIsRaiseMode(true);
    setRaiseAmount(minRaise);
    lastSnapRef.current = minRaise;
  }, [canRaise, canAllIn, minRaise]);

  const handleConfirmRaise = useCallback(() => {
    haptic.strong();
    if (raiseAmount >= maxRaise) {
      if (confirmAllIn) {
        setPendingAllIn(true);
        return;
      }
      onAction('allin', maxRaise);
    } else {
      onAction('raise', raiseAmount);
    }
    setIsRaiseMode(false);
  }, [raiseAmount, maxRaise, onAction, confirmAllIn]);

  const handleAllIn = useCallback(() => {
    haptic.strong();
    if (confirmAllIn) {
      setPendingAllIn(true);
      return;
    }
    onAction('allin', maxRaise);
    setIsRaiseMode(false);
  }, [maxRaise, onAction, confirmAllIn]);

  const adjustRaise = useCallback(
    (delta: number) => {
      haptic.light();
      setRaiseAmount((prev) => Math.max(minRaise, Math.min(maxRaise, prev + delta)));
    },
    [minRaise, maxRaise]
  );

  const setPreset = useCallback(
    (value: number) => {
      haptic.medium();
      setRaiseAmount(Math.max(minRaise, Math.min(maxRaise, value)));
    },
    [minRaise, maxRaise]
  );

  // Slider change with snap-to-preset haptic feedback
  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      setRaiseAmount(val);

      // Snap feedback — trigger haptic when crossing a BB boundary
      const currentBB = Math.round(val / (bigBlind || 1));
      const lastBB = Math.round(lastSnapRef.current / (bigBlind || 1));
      if (currentBB !== lastBB) {
        haptic.light();
        lastSnapRef.current = val;
      }

      // Stronger haptic when hitting a preset value (within 1 BB tolerance)
      const tolerance = bigBlind || 1;
      for (const p of presets) {
        if (
          Math.abs(val - p.value) <= tolerance &&
          Math.abs(lastSnapRef.current - p.value) > tolerance
        ) {
          haptic.medium();
          break;
        }
      }
    },
    [bigBlind, presets]
  );

  const sliderProgress =
    maxRaise > minRaise ? ((raiseAmount - minRaise) / (maxRaise - minRaise)) * 100 : 0;

  // ─── ALL-IN CONFIRMATION MODE ────────────────────────────────
  if (pendingAllIn) {
    return (
      <div className="action-panel action-panel--raise action-panel--allin-confirm">
        <div className="raise-actions" style={{ flexDirection: 'column', gap: '8px' }}>
          <button
            className="raise-confirm"
            style={{ backgroundColor: '#D32F2F', height: '64px', fontSize: '20px' }}
            onClick={() => {
              haptic.strong();
              onAction('allin', maxRaise);
              setPendingAllIn(false);
              setIsRaiseMode(false);
            }}
          >
            CONFIRM ALL-IN ({formatChips(maxRaise)})
          </button>
          <button className="raise-cancel" onClick={() => setPendingAllIn(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ─── RAISE MODE ──────────────────────────────────────────────
  if (isRaiseMode) {
    return (
      <div className="action-panel action-panel--raise">
        {/* Amount Display with +/- */}
        <div className="raise-header">
          <button
            className="raise-adjust raise-adjust--minus"
            onClick={() => adjustRaise(-bigBlind)}
            disabled={raiseAmount <= minRaise}
          >
            −
          </button>
          <div className="raise-value">
            <span className="raise-value__amount">{formatChips(raiseAmount)}</span>
            {bigBlind > 0 && (
              <span className="raise-value__bb">{(raiseAmount / bigBlind).toFixed(1)} BB</span>
            )}
          </div>
          <button
            className="raise-adjust raise-adjust--plus"
            onClick={() => adjustRaise(bigBlind)}
            disabled={raiseAmount >= maxRaise}
          >
            +
          </button>
        </div>

        {/* Slider with tick marks at 25%, 50%, 75%, 100% */}
        <div className="raise-slider-wrap">
          <input
            type="range"
            className="raise-slider"
            min={minRaise}
            max={maxRaise}
            step={bigBlind || 1}
            value={raiseAmount}
            onChange={handleSliderChange}
            style={{ '--slider-progress': `${sliderProgress}%` } as React.CSSProperties}
          />
          {/* Tick marks */}
          <div className="raise-slider-ticks">
            <div className="raise-slider-tick" style={{ left: '25%' }} />
            <div className="raise-slider-tick" style={{ left: '50%' }} />
            <div className="raise-slider-tick" style={{ left: '75%' }} />
            <div className="raise-slider-tick" style={{ left: '100%' }} />
          </div>
        </div>

        {/* Preset Row */}
        {showBetSizePresets && (
          <div className="raise-presets">
            {presets.map((p) => (
              <button
                key={p.label}
                className="raise-preset"
                onClick={() => setPreset(p.value)}
                disabled={p.value > maxRaise || p.value < minRaise}
              >
                {p.label}
              </button>
            ))}
            <button className="raise-preset raise-preset--allin" onClick={handleAllIn}>
              ALL IN
            </button>
          </div>
        )}
        {/* Confirm / Cancel Row */}
        <div className="raise-actions">
          <button className="raise-cancel" onClick={() => setIsRaiseMode(false)}>
            Back
          </button>
          <button className="raise-confirm" onClick={handleConfirmRaise}>
            Raise {formatChips(raiseAmount)}
          </button>
        </div>
      </div>
    );
  }

  // ─── STANDARD 3-BUTTON MODE ──────────────────────────────────
  return (
    <div
      className={`action-panel ${isMyTurn ? 'action-panel--active' : ''} ${turnPulse ? 'action-panel--attention' : ''}`}
    >
      <div className="action-row">
        {/* FOLD — Always Red, Left */}
        <button
          className="action-btn action-btn--fold"
          onClick={() => {
            haptic.medium();
            onAction('fold');
          }}
          disabled={!canFold}
          title={isDesktop ? 'F' : undefined}
        >
          <span className="action-btn__label">Fold</span>
          {isDesktop && <span className="action-btn__shortcut">F</span>}
        </button>

        {/* CHECK or CALL — Green, Center */}
        {canCheck ? (
          <button
            className="action-btn action-btn--check"
            onClick={() => {
              haptic.medium();
              onAction('check');
            }}
            title={isDesktop ? 'C' : undefined}
          >
            <span className="action-btn__label">Check</span>
            {isDesktop && <span className="action-btn__shortcut">C</span>}
          </button>
        ) : canCall ? (
          <button
            className="action-btn action-btn--call"
            onClick={() => {
              haptic.medium();
              onAction('call');
            }}
            title={isDesktop ? 'C' : undefined}
          >
            <span className="action-btn__label">Call</span>
            <span className="action-btn__amount">{formatChips(callAmount)}</span>
            {showPotOdds && pot > 0 && callAmount > 0 && (
              <span
                className="action-btn__odds"
                style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}
              >
                {Math.round((callAmount / (pot + callAmount)) * 100)}%
              </span>
            )}
            {isDesktop && <span className="action-btn__shortcut">C</span>}
          </button>
        ) : (
          <button className="action-btn action-btn--check" disabled>
            <span className="action-btn__label">—</span>
          </button>
        )}

        {/* RAISE — Amber/Orange, Right */}
        {canAllIn && !canRaise ? (
          <button
            className="action-btn action-btn--allin"
            onClick={handleAllIn}
            title={isDesktop ? 'R' : undefined}
          >
            <span className="action-btn__label">All In</span>
            <span className="action-btn__amount">{formatChips(maxRaise)}</span>
            {isDesktop && <span className="action-btn__shortcut">R</span>}
          </button>
        ) : (
          <button
            className="action-btn action-btn--raise"
            onClick={handleRaiseClick}
            disabled={!canRaise}
            title={isDesktop ? 'R' : undefined}
          >
            <span className="action-btn__label">Raise</span>
            {minRaise > 0 && bigBlind > 0 && (
              <span className="action-btn__amount">{(minRaise / bigBlind).toFixed(0)} BB</span>
            )}
            {isDesktop && <span className="action-btn__shortcut">R</span>}
          </button>
        )}
      </div>
    </div>
  );
}

export { ActionPanel };
