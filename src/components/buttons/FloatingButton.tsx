import React from 'react';
import './FloatingButton.css';

interface FloatingButtonProps {
  icon: string;
  onClick?: () => void;
  position?: 'bottom-right' | 'bottom-left' | 'bottom-center';
  size?: 'medium' | 'large';
  extended?: boolean;
  label?: string;
}

export const FloatingButton: React.FC<FloatingButtonProps> = ({
  icon,
  onClick,
  position = 'bottom-right',
  size = 'medium',
  extended = false,
  label,
}) => {
  return (
    <button
      className={`floating-button position-${position} size-${size} ${extended ? 'extended' : ''}`}
      onClick={onClick}
    >
      <span className="fab-icon">{icon}</span>
      {extended && label && <span className="fab-label">{label}</span>}
    </button>
  );
};

export default FloatingButton;
