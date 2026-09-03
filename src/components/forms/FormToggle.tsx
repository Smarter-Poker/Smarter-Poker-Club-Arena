import React from 'react';
import './FormToggle.css';

interface FormToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export const FormToggle: React.FC<FormToggleProps> = ({
  label,
  checked,
  onChange,
  disabled = false,
  size = 'medium',
}) => {
  return (
    <label className={`form-toggle ${disabled ? 'disabled' : ''} size-${size}`}>
      <span className="toggle-label">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
};

export default FormToggle;
