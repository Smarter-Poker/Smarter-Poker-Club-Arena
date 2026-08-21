import React, { useState, useEffect } from 'react';
import { SoundSettings } from './SoundSettings';
import { NotificationSettings } from './NotificationSettings';
import { PrivacySettings } from './PrivacySettings';
import { GameplaySettings } from './GameplaySettings';
import { AppearanceSettings } from './AppearanceSettings';
import './SettingsPanel.css';

type SettingsTab = 'general' | 'sound' | 'notifications' | 'privacy' | 'gameplay' | 'appearance';

interface SettingsPanelProps {
  onClose?: () => void;
  initialTab?: SettingsTab;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  onClose,
  initialTab = 'general',
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const tabs: { id: SettingsTab; label: string; icon: string }[] = [
    { id: 'general', label: 'General', icon: '' },
    { id: 'sound', label: 'Sound', icon: '' },
    { id: 'notifications', label: 'Notifications', icon: '' },
    { id: 'privacy', label: 'Privacy', icon: '' },
    { id: 'gameplay', label: 'Gameplay', icon: '' },
    { id: 'appearance', label: 'Appearance', icon: '' },
  ];

  return (
    <div
      className="settings-panel"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div className="settings-header">
        <h2>Settings</h2>
        {onClose && (
          <button className="settings-close" onClick={onClose}>
            ×
          </button>
        )}
      </div>

      <div className="settings-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="tab-icon">{tab.icon}</span>
            <span className="tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-content">
        {activeTab === 'general' && (
          <div className="settings-section">
            <h3>General Settings</h3>
            <div className="setting-row">
              <label>Language</label>
              <select defaultValue="en">
                <option value="en">English</option>
                <option value="es">EspañOl</option>
                <option value="pt">PortuguêS</option>
                <option value="zh">中文</option>
              </select>
            </div>
            <div className="setting-row">
              <label>Currency Display</label>
              <select defaultValue="chips">
                <option value="chips">Chips</option>
                <option value="bb">Big Blinds</option>
              </select>
            </div>
            <div className="setting-row">
              <label>Time Zone</label>
              <select defaultValue="auto">
                <option value="auto">Auto-Detect</option>
                <option value="utc">UTC</option>
                <option value="est">Eastern</option>
                <option value="pst">Pacific</option>
              </select>
            </div>
          </div>
        )}

        {activeTab === 'sound' && (
          <div className="settings-section">
            <SoundSettings />
          </div>
        )}

        {activeTab === 'notifications' && (
          <div className="settings-section">
            <NotificationSettings />
          </div>
        )}

        {activeTab === 'privacy' && (
          <div className="settings-section">
            <PrivacySettings />
          </div>
        )}

        {activeTab === 'gameplay' && (
          <div className="settings-section">
            <GameplaySettings />
          </div>
        )}

        {activeTab === 'appearance' && (
          <div className="settings-section">
            <AppearanceSettings />
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsPanel;
