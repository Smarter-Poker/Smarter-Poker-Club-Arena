import React from 'react';
import './Spinner.css';

interface SpinnerProps {
  size?: 'small' | 'medium' | 'large';
  color?: 'primary' | 'white' | 'muted';
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 'medium', color = 'primary' }) => {
  return <div className={`spinner size-${size} color-${color}`} />;
};

export default Spinner;
