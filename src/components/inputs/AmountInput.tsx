import React, { useState } from 'react';
import './AmountInput.css';

interface AmountInputProps {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
  presets?: number[];
  error?: string;
}

export const AmountInput: React.FC<AmountInputProps> = ({
  label,
  value,
  onChange,
  min = 0,
  max = Infinity,
  step = 1,
  prefix,
  suffix,
  presets,
  error,
}) => {
  const [inputValue, setInputValue] = useState(value.toString());

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    const numVal = parseFloat(val);
    if (!isNaN(numVal)) {
      onChange(Math.min(Math.max(numVal, min), max));
    }
  };

  const handlePreset = (amount: number) => {
    setInputValue(amount.toString());
    onChange(amount);
  };

  return (
    <div className={`amount-input__amount-input-wrapper ${error ? 'has-error' : ''}`}>
      {label && <label className="amount-label">{label}</label>}

      <div className="amount-container">
        {prefix && <span className="amount-prefix">{prefix}</span>}
        <input
          type="number"
          className="amount-input"
          value={inputValue}
          onChange={handleChange}
          min={min}
          max={max}
          step={step}
        />
        {suffix && <span className="amount-suffix">{suffix}</span>}
      </div>

      {presets && (
        <div className="amount-presets">
          {presets.map((preset) => (
            <button
              key={preset}
              className={`preset-btn ${value === preset ? 'active' : ''}`}
              onClick={() => handlePreset(preset)}
            >
              {preset.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </button>
          ))}
        </div>
      )}

      {error && <span className="amount-error">{error}</span>}
    </div>
  );
};

export default AmountInput;
