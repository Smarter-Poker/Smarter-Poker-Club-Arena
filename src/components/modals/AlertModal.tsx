import React, { useEffect } from 'react';
import './AlertModal.css';

interface AlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  type?: 'info' | 'success' | 'warning' | 'error' | 'confirm';
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
}

const TYPE_CONFIG = {
  info: { icon: '', color: '#60a5fa' },
  success: { icon: '', color: '#4ade80' },
  warning: { icon: '', color: '#fbbf24' },
  error: { icon: '', color: '#f87171' },
  confirm: { icon: '?', color: '#a78bfa' },
};

export const AlertModal: React.FC<AlertModalProps> = ({
  isOpen,
  onClose,
  type = 'info',
  title,
  message,
  confirmText = 'OK',
  cancelText = 'Cancel',
  onConfirm,
}) => {
  // Escape-to-close keyboard handler
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const config = TYPE_CONFIG[type];
  const isConfirmType = type === 'confirm' || onConfirm;

  return (
    <div className="alert-modal-overlay" onClick={onClose}>
      <div className="alert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="alert-icon" style={{ color: config.color }}>
          {config.icon}
        </div>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="alert-actions">
          {isConfirmType && (
            <button className="cancel-btn" onClick={onClose}>
              {cancelText}
            </button>
          )}
          <button
            className="confirm-btn"
            style={{ background: config.color }}
            onClick={() => {
              onConfirm?.();
              onClose();
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AlertModal;
