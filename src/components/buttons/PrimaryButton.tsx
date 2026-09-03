import React from 'react';
import './PrimaryButton.css';

interface PrimaryButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'filled' | 'outline' | 'ghost';
  size?: 'small' | 'medium' | 'large';
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  type?: 'button' | 'submit';
}

export const PrimaryButton: React.FC<PrimaryButtonProps> = ({
  children,
  onClick,
  variant = 'filled',
  size = 'medium',
  fullWidth = false,
  disabled = false,
  loading = false,
  icon,
  type = 'button',
}) => {
  return (
    <button
      type={type}
      className={`primary-button variant-${variant} size-${size} ${fullWidth ? 'full-width' : ''}`}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading ? (
        <span className="loading-spinner" />
      ) : (
        <>
          {icon && <span className="btn-icon">{icon}</span>}
          <span className="btn-text">{children}</span>
        </>
      )}
    </button>
  );
};

export default PrimaryButton;
