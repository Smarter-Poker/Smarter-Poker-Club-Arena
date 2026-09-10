import React, { useId, useState } from 'react';
import { formatChips } from '../../utils/format';
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
  /* A money field with no accessible name reads to a screen reader as an
     unnamed spinbutton, and an error that is only a red span beside it is
     never announced. The label is bound by htmlFor, the field carries
     aria-invalid while rejected, and the error is its description. */
  const inputId = useId();
  const errorId = `${inputId}-error`;

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
    <div className={`amount-input-wrapper ${error ? 'has-error' : ''}`}>
      {label && (
        <label className="amount-label" htmlFor={inputId}>
          {label}
        </label>
      )}

      <div className="amount-container">
        {prefix && <span className="amount-prefix">{prefix}</span>}
        <input
          id={inputId}
          type="number"
          inputMode="decimal"
          className="amount-input"
          value={inputValue}
          onChange={handleChange}
          min={min}
          max={max}
          step={step}
          aria-label={label ? undefined : 'Amount'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {suffix && <span className="amount-suffix">{suffix}</span>}
      </div>

      {presets && (
        <div className="amount-presets">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`preset-btn ${value === preset ? 'active' : ''}`}
              aria-pressed={value === preset}
              onClick={() => handlePreset(preset)}
            >
              {formatChips(preset)}
            </button>
          ))}
        </div>
      )}

      {error && (
        <span className="amount-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
};

export default AmountInput;
