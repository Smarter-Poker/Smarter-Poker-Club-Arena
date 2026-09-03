import React, { useEffect } from 'react';
import './ActionSheet.css';

interface ActionItem {
  id: string;
  label: string;
  icon?: string;
  destructive?: boolean;
  disabled?: boolean;
}

interface ActionSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  actions: ActionItem[];
  onAction: (actionId: string) => void;
}

export const ActionSheet: React.FC<ActionSheetProps> = ({
  isOpen,
  onClose,
  title,
  actions,
  onAction,
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

  return (
    <div className="action-sheet-overlay" onClick={onClose}>
      <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
        {title && <div className="sheet-title">{title}</div>}
        <div className="sheet-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              className={`sheet-action ${action.destructive ? 'destructive' : ''} ${action.disabled ? 'disabled' : ''}`}
              onClick={() => {
                onAction(action.id);
                onClose();
              }}
              disabled={action.disabled}
            >
              {action.icon && <span className="action-icon">{action.icon}</span>}
              {action.label}
            </button>
          ))}
        </div>
        <button className="sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
};

export default ActionSheet;
