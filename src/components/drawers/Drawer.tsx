import React from 'react';
import './Drawer.css';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  position?: 'left' | 'right' | 'bottom';
  children: React.ReactNode;
  title?: string;
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  position = 'right',
  children,
  title,
}) => {
  if (!isOpen) return null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className={`drawer position-${position}`}>
        {title && (
          <div className="drawer-header">
            <h3>{title}</h3>
            <button className="drawer-close" onClick={onClose}>
              ×
            </button>
          </div>
        )}
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
};

export default Drawer;
