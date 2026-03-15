/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎬 STREAMER MODE — Hide Sensitive Info
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState } from 'react';
import './StreamerMode.css';

interface StreamerModeProps {
  isEnabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function StreamerMode({ isEnabled, onToggle }: StreamerModeProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [hideBalance, setHideBalance] = useState(true);
  const [hideHoleCards, setHideHoleCards] = useState(false);
  const [hideUsername, setHideUsername] = useState(false);
  const [delay, setDelay] = useState(120);

  return (
    <div className="streamer-mode">
      <button
        className={`toggle-btn ${isEnabled ? 'active' : ''}`}
        onClick={() => onToggle(!isEnabled)}
      >
        <span className="icon">🎬</span>
        <span className="label">Streamer Mode</span>
        <span className="status">{isEnabled ? 'ON' : 'OFF'}</span>
      </button>

      {isEnabled && (
        <button
          className="settings-btn"
          onClick={() => setShowSettings(!showSettings)}
          aria-label="Streamer mode settings"
        >
          ⚙
        </button>
      )}

      {showSettings && (
        <div className="streamer-settings">
          <h4>Streamer Settings</h4>

          <label className="option">
            <input
              type="checkbox"
              checked={hideBalance}
              onChange={(e) => setHideBalance(e.target.checked)}
            />
            <span>Hide Balance</span>
          </label>

          <label className="option">
            <input
              type="checkbox"
              checked={hideHoleCards}
              onChange={(e) => setHideHoleCards(e.target.checked)}
            />
            <span>Hide Hole Cards</span>
          </label>

          <label className="option">
            <input
              type="checkbox"
              checked={hideUsername}
              onChange={(e) => setHideUsername(e.target.checked)}
            />
            <span>Hide Username</span>
          </label>

          <div className="delay-setting">
            <label>Stream Delay</label>
            <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
              <option value={0}>None</option>
              <option value={60}>1 min</option>
              <option value={120}>2 mins</option>
              <option value={300}>5 mins</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

export default StreamerMode;
