import React from 'react';
import './Spacer.css';

interface SpacerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  direction?: 'horizontal' | 'vertical';
}

export const Spacer: React.FC<SpacerProps> = ({ size = 'md', direction = 'vertical' }) => {
  return <div className={`spacer direction-${direction} size-${size}`} />;
};

export default Spacer;
