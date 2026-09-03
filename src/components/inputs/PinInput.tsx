import React, { useRef, useState, useEffect } from 'react';
import './PinInput.css';

interface PinInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  masked?: boolean;
  error?: string;
}

export const PinInput: React.FC<PinInputProps> = ({
  length = 4,
  value,
  onChange,
  onComplete,
  masked = true,
  error,
}) => {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [focused, setFocused] = useState(0);

  const handleChange = (index: number, char: string) => {
    if (!/^\d*$/.test(char)) return;

    const newValue = value.split('');
    newValue[index] = char.slice(-1);
    const result = newValue.join('');
    onChange(result);

    if (char && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (result.length === length) {
      onComplete?.(result);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !value[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  return (
    <div className={`pin-input-wrapper ${error ? 'has-error' : ''}`}>
      <div className="pin-inputs">
        {Array.from({ length }).map((_, i) => (
          <input
            key={i}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type={masked ? 'password' : 'text'}
            inputMode="numeric"
            className="pin-digit"
            value={value[i] || ''}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onFocus={() => setFocused(i)}
            maxLength={1}
          />
        ))}
      </div>
      {error && <span className="pin-error">{error}</span>}
    </div>
  );
};

export default PinInput;
