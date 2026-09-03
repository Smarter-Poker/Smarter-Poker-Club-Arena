import React from 'react';
import './SidePanel.css';

interface SidePanelProps {
  isOpen: boolean;
  children: React.ReactNode;
  width?: number;
}

export const SidePanel: React.FC<SidePanelProps> = ({ isOpen, children, width = 280 }) => {
  return (
    <aside className={`side-panel ${isOpen ? 'open' : ''}`} style={{ width }}>
      {children}
    </aside>
  );
};

export default SidePanel;
