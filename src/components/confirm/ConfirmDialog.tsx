import React from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import './ConfirmDialog.css';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'default' | 'danger';
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default',
}) => {
  if (!isOpen) return null;

  return (
    <div className="confirm-dialog-overlay">
      <div className="confirm-dialog">
        <h3 className="confirm-title">{formatPopupText(title)}</h3>
        <p className="confirm-message">{formatPopupText(message)}</p>
        <div className="confirm-actions">
          <button className="btn-cancel" onClick={onCancel}>
            {formatPopupText(cancelLabel)}
          </button>
          <button className={`btn-confirm variant-${variant}`} onClick={onConfirm}>
            {formatPopupText(confirmLabel)}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
