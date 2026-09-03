import React from 'react';
import './TabPanel.css';

interface TabPanelProps {
  id: string;
  activeTab: string;
  children: React.ReactNode;
}

export const TabPanel: React.FC<TabPanelProps> = ({ id, activeTab, children }) => {
  if (activeTab !== id) return null;

  return (
    <div className="tab-panel" role="tabpanel" id={`panel-${id}`}>
      {children}
    </div>
  );
};

export default TabPanel;
