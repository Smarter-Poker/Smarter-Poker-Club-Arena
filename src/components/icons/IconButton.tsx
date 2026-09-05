import React from 'react';
import './IconButton.css';

interface IconButtonProps {
  icon: string;
  onClick: () => void;
  variant?: 'ghost' | 'outlined' | 'filled';
  size?: 'small' | 'medium' | 'large';
  disabled?: boolean;
  title?: string;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  onClick,
  variant = 'ghost',
  size = 'medium',
  disabled = false,
  title,
}) => {
  return (
    <button
      className={`icon-button__icon-button variant-${variant} size-${size}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
    </button>
  );
};

export default IconButton;
