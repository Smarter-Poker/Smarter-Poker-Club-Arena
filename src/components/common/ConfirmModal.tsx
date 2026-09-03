/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONFIRM MODAL — Reusable Confirmation Dialog
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium replacement for window.confirm with:
 * - Customizable title, message, and button text
 * - Danger/default variants
 * - Accessible keyboard handling
 * - Smooth animations
 */

import React, { useEffect, useCallback } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import './ConfirmModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  loading?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ConfirmModal({
  isOpen,
  onConfirm,
  onCancel,
  title = 'Confirm Action',
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'default',
  loading = false,
}: ConfirmModalProps) {
  // Handle escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onCancel();
      }
    },
    [onCancel, loading]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div className="confirm-modal-overlay" onClick={loading ? undefined : onCancel}>
      <div
        className={`confirm-modal ${variant === 'danger' ? 'confirm-modal--danger' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        {/* Icon */}
        <div className="confirm-modal__icon">
          {variant === 'danger' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 9v4m0 4h.01M12 3L2 21h20L12 3z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4m0-4h.01" />
            </svg>
          )}
        </div>

        {/* Content */}
        <h2 id="confirm-modal-title" className="confirm-modal__title">
          {formatPopupText(title)}
        </h2>
        <p className="confirm-modal__message">{formatPopupText(message)}</p>

        {/* Actions */}
        <div className="confirm-modal__actions">
          <button
            className="confirm-modal__btn confirm-modal__btn--cancel"
            onClick={onCancel}
            disabled={loading}
          >
            {formatPopupText(cancelText)}
          </button>
          <button
            className={`confirm-modal__btn confirm-modal__btn--confirm ${
              variant === 'danger' ? 'confirm-modal__btn--danger' : ''
            }`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <span className="confirm-modal__spinner" /> : formatPopupText(confirmText)}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmModal;
