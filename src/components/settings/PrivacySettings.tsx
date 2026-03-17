import React, { useState, useEffect } from 'react';
import { masterBus } from '../../core/MasterBus';
import './PrivacySettings.css';

interface PrivacyConfig {
  profileVisibility: 'public' | 'friends' | 'private';
  showOnlineStatus: boolean;
  showHandHistory: boolean;
  showStats: boolean;
  allowFriendRequests: boolean;
  allowTableInvites: boolean;
  allowDirectMessages: 'everyone' | 'friends' | 'none';
  hideFromSearch: boolean;
}

interface PrivacySettingsProps {
  onChange?: (config: PrivacyConfig) => void;
}

const PRIVACY_STORAGE_KEY = 'sp_privacy_settings';

export const PrivacySettings: React.FC<PrivacySettingsProps> = ({ onChange }) => {
  const [config, setConfig] = useState<PrivacyConfig>({
    profileVisibility: 'friends',
    showOnlineStatus: true,
    showHandHistory: false,
    showStats: true,
    allowFriendRequests: true,
    allowTableInvites: true,
    allowDirectMessages: 'friends',
    hideFromSearch: false,
  });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(PRIVACY_STORAGE_KEY);
      if (stored) setConfig(JSON.parse(stored));
    } catch {
      /* ignore corrupt data */
    }
    setTimeout(() => setMounted(true), 50);
  }, []);

  const updateConfig = <K extends keyof PrivacyConfig>(key: K, value: PrivacyConfig[K]) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    localStorage.setItem(PRIVACY_STORAGE_KEY, JSON.stringify(newConfig));
    masterBus.emit('SETTINGS_UPDATED', {
      settings: newConfig as unknown as Record<string, unknown>,
    });
    onChange?.(newConfig);
  };

  return (
    <div
      className="privacy-settings"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      <div className="privacy-section">
        <h4>Profile Visibility</h4>
        <div className="visibility-options">
          {(['public', 'friends', 'private'] as const).map((opt) => (
            <label
              key={opt}
              className={`visibility-option ${config.profileVisibility === opt ? 'active' : ''}`}
            >
              <input
                type="radio"
                name="visibility"
                checked={config.profileVisibility === opt}
                onChange={() => updateConfig('profileVisibility', opt)}
              />
              <span className="option-icon">
                {opt === 'public' ? '' : opt === 'friends' ? '' : ''}
              </span>
              <span className="option-label">{opt.charAt(0).toUpperCase() + opt.slice(1)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="privacy-section">
        <h4>Profile Information</h4>
        <label className="privacy-toggle">
          <span>Show Online Status</span>
          <input
            type="checkbox"
            checked={config.showOnlineStatus}
            onChange={(e) => updateConfig('showOnlineStatus', e.target.checked)}
          />
          <span className="toggle-switch"></span>
        </label>
        <label className="privacy-toggle">
          <span>Show Hand History</span>
          <input
            type="checkbox"
            checked={config.showHandHistory}
            onChange={(e) => updateConfig('showHandHistory', e.target.checked)}
          />
          <span className="toggle-switch"></span>
        </label>
        <label className="privacy-toggle">
          <span>Show Statistics</span>
          <input
            type="checkbox"
            checked={config.showStats}
            onChange={(e) => updateConfig('showStats', e.target.checked)}
          />
          <span className="toggle-switch"></span>
        </label>
      </div>

      <div className="privacy-section">
        <h4>Social Settings</h4>
        <label className="privacy-toggle">
          <span>Allow Friend Requests</span>
          <input
            type="checkbox"
            checked={config.allowFriendRequests}
            onChange={(e) => updateConfig('allowFriendRequests', e.target.checked)}
          />
          <span className="toggle-switch"></span>
        </label>
        <label className="privacy-toggle">
          <span>Allow Table Invites</span>
          <input
            type="checkbox"
            checked={config.allowTableInvites}
            onChange={(e) => updateConfig('allowTableInvites', e.target.checked)}
          />
          <span className="toggle-switch"></span>
        </label>
        <label className="privacy-toggle">
          <span>Hide from Search</span>
          <input
            type="checkbox"
            checked={config.hideFromSearch}
            onChange={(e) => updateConfig('hideFromSearch', e.target.checked)}
          />
          <span className="toggle-switch"></span>
        </label>
      </div>

      <div className="privacy-section">
        <h4>Direct Messages</h4>
        <div className="dm-options">
          {(['everyone', 'friends', 'none'] as const).map((opt) => (
            <label
              key={opt}
              className={`dm-option ${config.allowDirectMessages === opt ? 'active' : ''}`}
            >
              <input
                type="radio"
                name="dm"
                checked={config.allowDirectMessages === opt}
                onChange={() => updateConfig('allowDirectMessages', opt)}
              />
              <span>{opt === 'none' ? 'No one' : opt.charAt(0).toUpperCase() + opt.slice(1)}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PrivacySettings;
