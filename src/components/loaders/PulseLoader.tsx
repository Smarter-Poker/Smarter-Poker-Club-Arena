import React from 'react';
import './PulseLoader.css';

interface PulseLoaderProps {
  size?: 'small' | 'medium' | 'large';
  color?: string;
}

export const PulseLoader: React.FC<PulseLoaderProps> = ({ size = 'medium', color = '#ffd700' }) => {
  return (
    <div className={`pulse-loader size-${size}`}>
      <span style={{ backgroundColor: color }} />
      <span style={{ backgroundColor: color }} />
      <span style={{ backgroundColor: color }} />
    </div>
  );
};

export default PulseLoader;
