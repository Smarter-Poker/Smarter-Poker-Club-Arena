import React from 'react';
import './SliderInput.css';

interface SliderInputProps {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  showRange?: boolean;
  formatValue?: (value: number) => string;
}

export const SliderInput: React.FC<SliderInputProps> = ({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  showValue = true,
  showRange = true,
  formatValue = (v) => v.toString(),
}) => {
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className="slider-input-wrapper">
      {label && (
        <div className="slider-header">
          <label className="slider-label">{label}</label>
          {showValue && <span className="slider-value">{formatValue(value)}</span>}
        </div>
      )}

      <div className="slider-track-container">
        <input
          type="range"
          className="slider-input"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          min={min}
          max={max}
          step={step}
          style={{ '--value-percent': `${percentage}%` } as React.CSSProperties}
        />
      </div>

      {showRange && (
        <div className="slider-range">
          <span>{formatValue(min)}</span>
          <span>{formatValue(max)}</span>
        </div>
      )}
    </div>
  );
};

export default SliderInput;
