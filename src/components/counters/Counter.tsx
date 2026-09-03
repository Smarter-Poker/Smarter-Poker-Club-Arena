import React from 'react';
import './Counter.css';

interface CounterProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export const Counter: React.FC<CounterProps> = ({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  disabled = false,
}) => {
  const decrement = () => {
    const newVal = value - step;
    if (newVal >= min) onChange(newVal);
  };

  const increment = () => {
    const newVal = value + step;
    if (newVal <= max) onChange(newVal);
  };

  return (
    <div className={`counter ${disabled ? 'disabled' : ''}`}>
      <button className="counter-btn" onClick={decrement} disabled={disabled || value <= min}>
        −
      </button>
      <span className="counter-value">{value}</span>
      <button className="counter-btn" onClick={increment} disabled={disabled || value >= max}>
        +
      </button>
    </div>
  );
};

export default Counter;
