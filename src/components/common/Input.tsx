/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INPUT — Form Input Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { forwardRef, useState } from 'react';
import './Input.css';

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  size?: 'small' | 'medium' | 'large';
  variant?: 'default' | 'filled' | 'outlined';
  fullWidth?: boolean;
  required?: boolean;
}

/**
 * Main input component
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      icon,
      iconPosition = 'left',
      size = 'medium',
      variant = 'default',
      fullWidth = false,
      className = '',
      disabled,
      required,
      id,
      ...props
    },
    ref
  ) => {
    const [focused, setFocused] = useState(false);
    const messageId = `${id}-message`;

    return (
      <div className={`input-wrapper ${fullWidth ? 'input-full' : ''} ${className}`}>
        {label && (
          <label className="input-label" htmlFor={id}>
            {label}
            {required && <span aria-label="Required"> *</span>}
          </label>
        )}
        <div
          className={`input-container input-${size} input-${variant} ${focused ? 'input-focused' : ''} ${error ? 'input-error' : ''} ${disabled ? 'input-disabled' : ''}`}
        >
          {icon && iconPosition === 'left' && (
            <span className="input-icon input-icon-left">{icon}</span>
          )}
          <input
            ref={ref}
            id={id}
            className="input-field"
            disabled={disabled}
            aria-required={required}
            aria-invalid={!!error}
            aria-describedby={error || hint ? messageId : undefined}
            onFocus={(e) => {
              setFocused(true);
              props.onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              props.onBlur?.(e);
            }}
            {...props}
          />
          {icon && iconPosition === 'right' && (
            <span className="input-icon input-icon-right">{icon}</span>
          )}
        </div>
        {(error || hint) && (
          <span id={messageId} className={`input-message ${error ? 'input-message-error' : ''}`}>
            {error || hint}
          </span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

/**
 * Textarea component
 */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  {
    label?: string;
    error?: string;
    hint?: string;
    rows?: number;
    fullWidth?: boolean;
    className?: string;
    required?: boolean;
  } & React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(
  (
    {
      label,
      error,
      hint,
      rows = 4,
      fullWidth = false,
      className = '',
      disabled,
      required,
      id,
      ...props
    },
    ref
  ) => {
    const [focused, setFocused] = useState(false);
    const messageId = `${id}-message`;

    return (
      <div className={`input-wrapper ${fullWidth ? 'input-full' : ''} ${className}`}>
        {label && (
          <label className="input-label" htmlFor={id}>
            {label}
            {required && <span aria-label="Required"> *</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={id}
          className={`textarea-field ${focused ? 'input-focused' : ''} ${error ? 'input-error' : ''} ${disabled ? 'input-disabled' : ''}`}
          rows={rows}
          disabled={disabled}
          aria-required={required}
          aria-invalid={!!error}
          aria-describedby={error || hint ? messageId : undefined}
          onFocus={(e) => {
            setFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            props.onBlur?.(e);
          }}
          {...props}
        />
        {(error || hint) && (
          <span id={messageId} className={`input-message ${error ? 'input-message-error' : ''}`}>
            {error || hint}
          </span>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

/**
 * Select component
 */
export const Select = forwardRef<
  HTMLSelectElement,
  {
    label?: string;
    error?: string;
    hint?: string;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    placeholder?: string;
    size?: 'small' | 'medium' | 'large';
    fullWidth?: boolean;
    className?: string;
    required?: boolean;
  } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'>
>(
  (
    {
      label,
      error,
      hint,
      options,
      placeholder,
      size = 'medium',
      fullWidth = false,
      className = '',
      disabled,
      required,
      id,
      ...props
    },
    ref
  ) => {
    const messageId = `${id}-message`;

    return (
      <div className={`input-wrapper ${fullWidth ? 'input-full' : ''} ${className}`}>
        {label && (
          <label className="input-label" htmlFor={id}>
            {label}
            {required && <span aria-label="Required"> *</span>}
          </label>
        )}
        <div
          className={`select-container input-${size} ${error ? 'input-error' : ''} ${disabled ? 'input-disabled' : ''}`}
        >
          <select
            ref={ref}
            id={id}
            className="select-field"
            disabled={disabled}
            aria-required={required}
            aria-invalid={!!error}
            aria-describedby={error || hint ? messageId : undefined}
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="select-arrow">▼</span>
        </div>
        {(error || hint) && (
          <span id={messageId} className={`input-message ${error ? 'input-message-error' : ''}`}>
            {error || hint}
          </span>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';

/**
 * Checkbox component
 */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled = false,
  className = '',
}: {
  label?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={`checkbox-wrapper ${disabled ? 'checkbox-disabled' : ''} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="checkbox-input"
      />
      <span className="checkbox-box">{checked && <span className="checkbox-check"></span>}</span>
      {label && <span className="checkbox-label">{label}</span>}
    </label>
  );
}

/**
 * Toggle/Switch component
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'medium',
  className = '',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  size?: 'small' | 'medium' | 'large';
  className?: string;
}) {
  return (
    <label
      className={`toggle-wrapper toggle-${size} ${disabled ? 'toggle-disabled' : ''} ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="toggle-input"
      />
      <span className={`toggle-track ${checked ? 'toggle-on' : ''}`}>
        <span className="toggle-thumb" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

/**
 * Chip amount input (for poker)
 */
export function ChipInput({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  presets,
  label,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  presets?: Array<{ label: string; value: number }>;
  label?: string;
  disabled?: boolean;
}) {
  const handleChange = (newValue: number) => {
    if (max !== undefined && newValue > max) newValue = max;
    if (newValue < min) newValue = min;
    onChange(newValue);
  };

  return (
    <div className="chip-input-wrapper">
      {label && <label className="input-label">{label}</label>}
      <div className="chip-input-container">
        <button
          type="button"
          className="chip-input-btn"
          onClick={() => handleChange(value - step)}
          disabled={disabled || value <= min}
        >
          −
        </button>
        <input
          type="number"
          value={value}
          onChange={(e) => handleChange(Number(e.target.value))}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          className="chip-input-field"
        />
        <button
          type="button"
          className="chip-input-btn"
          onClick={() => handleChange(value + step)}
          disabled={disabled || (max !== undefined && value >= max)}
        >
          +
        </button>
      </div>
      {presets && (
        <div className="chip-input-presets">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={`chip-preset-btn ${value === preset.value ? 'active' : ''}`}
              onClick={() => handleChange(preset.value)}
              disabled={disabled}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default Input;
