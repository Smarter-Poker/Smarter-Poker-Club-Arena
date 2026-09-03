import React, { useState } from 'react';
import './Tabs.css';

interface Tab {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
}

interface TabsProps {
  tabs: Tab[];
  activeTab?: string;
  onChange?: (tabId: string) => void;
  variant?: 'default' | 'pills' | 'underline';
  children?: React.ReactNode;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeTab,
  onChange,
  variant = 'default',
  children,
}) => {
  const [active, setActive] = useState(activeTab || tabs[0]?.id);

  const handleChange = (id: string) => {
    setActive(id);
    onChange?.(id);
  };

  return (
    <div className="tabs-container">
      <div className={`tabs-list variant-${variant}`} role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            className={`tab-button ${active === tab.id ? 'active' : ''}`}
            onClick={() => handleChange(tab.id)}
            disabled={tab.disabled}
            aria-selected={active === tab.id}
          >
            {tab.icon && <span className="tab-icon">{tab.icon}</span>}
            <span className="tab-text">{tab.label}</span>
          </button>
        ))}
      </div>
      {children}
    </div>
  );
};

export default Tabs;
