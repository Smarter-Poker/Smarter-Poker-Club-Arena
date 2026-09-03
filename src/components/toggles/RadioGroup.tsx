import React from 'react';
import './RadioGroup.css';

interface RadioOption {
  value: string;
  label: string;
}

interface RadioGroupProps {
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  direction?: 'horizontal' | 'vertical';
}

export const RadioGroup: React.FC<RadioGroupProps> = ({
  name,
  options,
  value,
  onChange,
  direction = 'vertical',
}) => {
  return (
    <div className={`radio-group direction-${direction}`}>
      {options.map((opt) => (
        <label key={opt.value} className="radio-item">
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="radio-circle" />
          <span className="radio-label">{opt.label}</span>
        </label>
      ))}
    </div>
  );
};

export default RadioGroup;
