import React, { useState, useEffect } from 'react';
import './GameplaySettings.css';

interface GameplayConfig {
  autoMuck: boolean;
  autoPostBlinds: boolean;
  showOneCard: boolean;
  confirmAllIn: boolean;
  showBBFormat: boolean;
  fourColorDeck: boolean;
  runItTwiceDefault: boolean;
  autoTopUp: boolean;
  topUpThreshold: number;
  topUpAmount: number;
  timeBank: number;
  sitOutOnBlind: boolean;
}

interface GameplaySettingsProps {
  onChange?: (config: GameplayConfig) => void;
}

const GAMEPLAY_STORAGE_KEY = 'sp_gameplay_settings';

export const GameplaySettings: React.FC<GameplaySettingsProps> = ({ onChange }) => {
  const [config, setConfig] = useState<GameplayConfig>({
    autoMuck: true,
    autoPostBlinds: true,
    showOneCard: false,
    confirmAllIn: true,
    showBBFormat: false,
    fourColorDeck: true,
    runItTwiceDefault: true,
    autoTopUp: false,
    topUpThreshold: 50,
    topUpAmount: 100,
    timeBank: 30,
    sitOutOnBlind: false,
  });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(GAMEPLAY_STORAGE_KEY);
      if (stored) setConfig(JSON.parse(stored));
    } catch {
      /* ignore corrupt data */
    }
    setTimeout(() => setMounted(true), 50);
  }, []);

  const updateConfig = <K extends keyof GameplayConfig>(key: K, value: GameplayConfig[K]) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    localStorage.setItem(GAMEPLAY_STORAGE_KEY, JSON.stringify(newConfig));
    onChange?.(newConfig);
  };

  const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({
    label,
    checked,
    onChange,
  }) => (
    <label className="gameplay-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-switch"></span>
    </label>
  );

  return (
    <div
      className="gameplay-settings"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      <div className="gameplay-section">
        <h4>Hand Actions</h4>
        <Toggle
          label="Auto-Muck Losing Hands"
          checked={config.autoMuck}
          onChange={(v) => updateConfig('autoMuck', v)}
        />
        <Toggle
          label="Auto-Post Blinds"
          checked={config.autoPostBlinds}
          onChange={(v) => updateConfig('autoPostBlinds', v)}
        />
        <Toggle
          label="Show One Card on Win"
          checked={config.showOneCard}
          onChange={(v) => updateConfig('showOneCard', v)}
        />
        <Toggle
          label="Confirm All-In Bets"
          checked={config.confirmAllIn}
          onChange={(v) => updateConfig('confirmAllIn', v)}
        />
      </div>

      <div className="gameplay-section">
        <h4>Display Options</h4>
        <Toggle
          label="Show Stacks in Big Blinds"
          checked={config.showBBFormat}
          onChange={(v) => updateConfig('showBBFormat', v)}
        />
        <Toggle
          label="Four-Color Deck"
          checked={config.fourColorDeck}
          onChange={(v) => updateConfig('fourColorDeck', v)}
        />
      </div>

      <div className="gameplay-section">
        <h4>Special Features</h4>
        <Toggle
          label="Run It Twice by Default"
          checked={config.runItTwiceDefault}
          onChange={(v) => updateConfig('runItTwiceDefault', v)}
        />
        <Toggle
          label="Sit Out After Big Blind"
          checked={config.sitOutOnBlind}
          onChange={(v) => updateConfig('sitOutOnBlind', v)}
        />
      </div>

      <div className="gameplay-section">
        <h4>Auto Top-Up</h4>
        <Toggle
          label="Enable Auto Top-Up"
          checked={config.autoTopUp}
          onChange={(v) => updateConfig('autoTopUp', v)}
        />
        <div className={`topup-config ${!config.autoTopUp ? 'disabled' : ''}`}>
          <div className="slider-row">
            <label>
              <span>Threshold</span>
              <span className="slider-value">{config.topUpThreshold} BB</span>
            </label>
            <input
              type="range"
              min="20"
              max="80"
              value={config.topUpThreshold}
              onChange={(e) => updateConfig('topUpThreshold', parseInt(e.target.value))}
              disabled={!config.autoTopUp}
            />
          </div>
          <div className="slider-row">
            <label>
              <span>Top-Up To</span>
              <span className="slider-value">{config.topUpAmount} BB</span>
            </label>
            <input
              type="range"
              min="50"
              max="200"
              value={config.topUpAmount}
              onChange={(e) => updateConfig('topUpAmount', parseInt(e.target.value))}
              disabled={!config.autoTopUp}
            />
          </div>
        </div>
      </div>

      <div className="gameplay-section">
        <h4>Time Bank</h4>
        <div className="slider-row">
          <label>
            <span>Default Time Bank</span>
            <span className="slider-value">{config.timeBank}s</span>
          </label>
          <input
            type="range"
            min="10"
            max="120"
            step="5"
            value={config.timeBank}
            onChange={(e) => updateConfig('timeBank', parseInt(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
};

export default GameplaySettings;
