import React, { useState } from 'react';
import './AutoRebuyToggle.css';

interface AutoRebuyToggleProps {
  enabled: boolean;
  threshold: number;
  amount: number;
  maxBuyIn: number;
  onChange?: (enabled: boolean, threshold: number, amount: number) => void;
}

export const AutoRebuyToggle: React.FC<AutoRebuyToggleProps> = ({
  enabled,
  threshold,
  amount,
  maxBuyIn,
  onChange,
}) => {
  const [isEnabled, setIsEnabled] = useState(enabled);
  const [thresholdValue, setThresholdValue] = useState(threshold);
  const [amountValue, setAmountValue] = useState(amount);
  const [showSettings, setShowSettings] = useState(false);

  const handleToggle = () => {
    const newEnabled = !isEnabled;
    setIsEnabled(newEnabled);
    onChange?.(newEnabled, thresholdValue, amountValue);
  };

  const handleSave = () => {
    onChange?.(isEnabled, thresholdValue, amountValue);
    setShowSettings(false);
  };

  return (
    <div className="auto-rebuy-toggle">
      <div className="toggle-main" onClick={handleToggle}>
        <div className={`toggle-switch ${isEnabled ? 'on' : ''}`}>
          <div className="toggle-knob"></div>
        </div>
        <div className="toggle-label">
          <span className="label-title">Auto Rebuy</span>
          {isEnabled && (
            <span className="label-subtitle">
              Below {thresholdValue}BB → {amountValue}BB
            </span>
          )}
        </div>
        <button
          className="settings-btn"
          aria-label="Rebuy Settings"
          onClick={(e) => {
            e.stopPropagation();
            setShowSettings(!showSettings);
          }}
        ></button>
      </div>

      {showSettings && (
        <div className="toggle-settings">
          <div className="setting-row">
            <label>Trigger Below</label>
            <div className="setting-input">
              <input
                type="number"
                value={thresholdValue}
                onChange={(e) => setThresholdValue(parseInt(e.target.value) || 0)}
                min={10}
                max={100}
              />
              <span>BB</span>
            </div>
          </div>
          <div className="setting-row">
            <label>Rebuy To</label>
            <div className="setting-input">
              <input
                type="number"
                value={amountValue}
                onChange={(e) => setAmountValue(parseInt(e.target.value) || 0)}
                min={50}
                max={maxBuyIn}
              />
              <span>BB</span>
            </div>
          </div>
          <button className="save-settings-btn" onClick={handleSave}>
            Save Settings
          </button>
        </div>
      )}
    </div>
  );
};

export default AutoRebuyToggle;
