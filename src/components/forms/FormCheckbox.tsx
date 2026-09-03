import React from 'react';
import './FormCheckbox.css';

interface FormCheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: string;
}

export const FormCheckbox: React.FC<FormCheckboxProps> = ({
  label,
  checked,
  onChange,
  disabled = false,
  description,
}) => {
  return (
    <label className={`form-checkbox ${disabled ? 'disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="checkbox-box">{checked && <span className="checkmark"></span>}</span>
      <div className="checkbox-text">
        <span className="checkbox-label">{label}</span>
        {description && <span className="checkbox-desc">{description}</span>}
      </div>
    </label>
  );
};

export default FormCheckbox;
