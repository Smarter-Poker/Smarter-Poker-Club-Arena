import React from 'react';
import './FormSelect.css';

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

interface FormSelectProps {
  label?: string;
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}

export const FormSelect: React.FC<FormSelectProps> = ({
  label,
  options,
  value,
  onChange,
  placeholder = 'Select...',
  error,
  disabled = false,
  required = false,
}) => {
  return (
    <div
      className={`form-select-wrapper ${error ? 'has-error' : ''} ${disabled ? 'disabled' : ''}`}
    >
      {label && (
        <label className="form-label">
          {label}
          {required && <span className="required-mark">*</span>}
        </label>
      )}
      <div className="select-container">
        <select
          className="form-select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={required}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="select-arrow">▼</span>
      </div>
      {error && <span className="select-error">{error}</span>}
    </div>
  );
};

export default FormSelect;
