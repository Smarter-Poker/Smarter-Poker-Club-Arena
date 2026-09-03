import React from 'react';
import './ContextMenu.css';

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  isOpen: boolean;
  onClose: () => void;
  items: MenuItem[];
  position?: { x: number; y: number };
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  isOpen,
  onClose,
  items,
  position = { x: 0, y: 0 },
}) => {
  if (!isOpen) return null;

  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} />
      <ul className="context-menu" style={{ top: position.y, left: position.x }}>
        {items.map((item, idx) => (
          <li
            key={idx}
            className={item.danger ? 'danger' : ''}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </>
  );
};

export default ContextMenu;
