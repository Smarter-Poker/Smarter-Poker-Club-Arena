import React from 'react';
import './IconButton.css';

interface IconButtonProps {
  icon: string;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger';
  size?: 'small' | 'medium' | 'large';
  disabled?: boolean;
  tooltip?: string;
  badge?: number;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  onClick,
  variant = 'default',
  size = 'medium',
  disabled = false,
  tooltip,
  badge,
}) => {
  return (
    <button
      className={`icon-button__icon-button variant-${variant} size-${size}`}
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
    >
      <span className="icon">{icon}</span>
      {badge !== undefined && badge > 0 && (
        <span className="icon-badge">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  );
};

export default IconButton;
