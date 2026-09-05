/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📑 TABS — Tabbed Navigation Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, createContext, useContext } from 'react';
import { motion } from 'framer-motion';
import './Tabs.css';

interface TabsContextType {
  activeTab: string;
  setActiveTab: (id: string) => void;
}

const TabsContext = createContext<TabsContextType | null>(null);

function useTabsContext() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs components must be used within a Tabs component');
  }
  return context;
}

interface TabsProps {
  defaultTab: string;
  children: React.ReactNode;
  onChange?: (tabId: string) => void;
  variant?: 'default' | 'pills' | 'underline' | 'enclosed';
  size?: 'small' | 'medium' | 'large';
  fullWidth?: boolean;
  className?: string;
}

/**
 * Tabs container
 */
export function Tabs({
  defaultTab,
  children,
  onChange,
  variant = 'default',
  size = 'medium',
  fullWidth = false,
  className = '',
}: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab);

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId);
    onChange?.(tabId);
  };

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab: handleTabChange }}>
      <div
        className={`tabs tabs-${variant} tabs-${size} ${fullWidth ? 'tabs-full' : ''} ${className}`}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

/**
 * Tab list container
 */
export function TabList({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`tab-list ${className}`} role="tablist">
      {children}
    </div>
  );
}

/**
 * Individual tab trigger
 */
export function Tab({
  id,
  children,
  icon,
  disabled = false,
  badge,
}: {
  id: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  badge?: React.ReactNode;
}) {
  const { activeTab, setActiveTab } = useTabsContext();
  const isActive = activeTab === id;

  return (
    <button
      className={`tab ${isActive ? 'tab-active' : ''} ${disabled ? 'tab-disabled' : ''}`}
      onClick={() => !disabled && setActiveTab(id)}
      role="tab"
      aria-selected={isActive}
      aria-controls={`tabpanel-${id}`}
      disabled={disabled}
    >
      {icon && <span className="tab-icon">{icon}</span>}
      <span className="tab-label">{children}</span>
      {badge && <span className="tab-badge">{badge}</span>}
      {isActive && (
        <motion.div
          className="tab-indicator"
          layoutId="tab-indicator"
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      )}
    </button>
  );
}

/**
 * Tab panel content
 */
export function TabPanel({
  id,
  children,
  className = '',
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { activeTab } = useTabsContext();

  if (activeTab !== id) return null;

  return (
    <motion.div
      className={`tabs__tab-panel ${className}`}
      role="tabpanel"
      id={`tabpanel-${id}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Simple tabs (all-in-one component)
 */
export function SimpleTabs({
  tabs,
  defaultTab,
  onChange,
  variant = 'default',
  className = '',
}: {
  tabs: Array<{
    id: string;
    label: string;
    content: React.ReactNode;
    icon?: React.ReactNode;
    disabled?: boolean;
  }>;
  defaultTab?: string;
  onChange?: (tabId: string) => void;
  variant?: 'default' | 'pills' | 'underline' | 'enclosed';
  className?: string;
}) {
  return (
    <Tabs
      defaultTab={defaultTab || tabs[0]?.id}
      onChange={onChange}
      variant={variant}
      className={className}
    >
      <TabList>
        {tabs.map((tab) => (
          <Tab key={tab.id} id={tab.id} icon={tab.icon} disabled={tab.disabled}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
      {tabs.map((tab) => (
        <TabPanel key={tab.id} id={tab.id}>
          {tab.content}
        </TabPanel>
      ))}
    </Tabs>
  );
}

export default Tabs;
