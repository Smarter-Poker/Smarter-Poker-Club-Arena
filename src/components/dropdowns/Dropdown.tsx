import React, { useState } from 'react';
import './Dropdown.css';

interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

interface DropdownProps {
  options: DropdownOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export const Dropdown: React.FC<DropdownProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Select...',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <div className="dropdown">
      <button className="dropdown-trigger" onClick={() => setIsOpen(!isOpen)}>
        {selected ? (
          <>
            {selected.icon}
            <span>{selected.label}</span>
          </>
        ) : (
          <span className="placeholder">{placeholder}</span>
        )}
        <span className="dropdown-arrow">▼</span>
      </button>

      {isOpen && (
        <>
          <div className="dropdown-backdrop" onClick={() => setIsOpen(false)} />
          <ul className="dropdown-menu">
            {options.map((opt) => (
              <li
                key={opt.value}
                className={opt.value === value ? 'selected' : ''}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
              >
                {opt.icon}
                <span>{opt.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

export default Dropdown;
