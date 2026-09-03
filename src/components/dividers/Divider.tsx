import React from 'react';
import './Divider.css';

interface DividerProps {
  variant?: 'solid' | 'dashed' | 'gradient';
  spacing?: 'small' | 'medium' | 'large';
  label?: string;
}

export const Divider: React.FC<DividerProps> = ({
  variant = 'solid',
  spacing = 'medium',
  label,
}) => {
  if (label) {
    return (
      <div className={`divider-labeled spacing-${spacing}`}>
        <div className={`divider-line variant-${variant}`} />
        <span className="divider-label">{label}</span>
        <div className={`divider-line variant-${variant}`} />
      </div>
    );
  }

  return <div className={`divider variant-${variant} spacing-${spacing}`} />;
};

export default Divider;
