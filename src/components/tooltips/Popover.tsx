import React from 'react';
import './Popover.css';

interface PopoverProps {
  isOpen: boolean;
  onClose: () => void;
  trigger: React.ReactNode;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export const Popover: React.FC<PopoverProps> = ({
  isOpen,
  onClose,
  trigger,
  children,
  position = 'bottom',
}) => {
  return (
    <div className="popover-wrapper">
      <div className="popover-trigger">{trigger}</div>
      {isOpen && (
        <>
          <div className="popover-backdrop" onClick={onClose} />
          <div className={`popover-content position-${position}`}>{children}</div>
        </>
      )}
    </div>
  );
};

export default Popover;
