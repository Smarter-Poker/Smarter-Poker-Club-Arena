import React, { useState, useEffect } from 'react';
import './NotificationSettings.css';

interface NotificationConfig {
  pushEnabled: boolean;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  tournamentReminders: boolean;
  friendActivity: boolean;
  clubAnnouncements: boolean;
  promotions: boolean;
  tableInvites: boolean;
  handResults: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

interface NotificationSettingsProps {
  onChange?: (config: NotificationConfig) => void;
}

const NOTIF_STORAGE_KEY = 'sp_notification_settings';

export const NotificationSettings: React.FC<NotificationSettingsProps> = ({ onChange }) => {
  const [config, setConfig] = useState<NotificationConfig>({
    pushEnabled: true,
    emailEnabled: false,
    inAppEnabled: true,
    tournamentReminders: true,
    friendActivity: true,
    clubAnnouncements: true,
    promotions: false,
    tableInvites: true,
    handResults: false,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
  });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(NOTIF_STORAGE_KEY);
      if (stored) setConfig(JSON.parse(stored));
    } catch {
      /* ignore corrupt data */
    }
    setTimeout(() => setMounted(true), 50);
  }, []);

  const updateConfig = (key: keyof NotificationConfig, value: boolean | string) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(newConfig));
    onChange?.(newConfig);
  };

  const Toggle: React.FC<{
    label: string;
    description?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
  }> = ({ label, description, checked, onChange, disabled }) => (
    <label className={`notification-toggle ${disabled ? 'disabled' : ''}`}>
      <div className="toggle-info">
        <span className="toggle-name">{label}</span>
        {description && <span className="toggle-desc">{description}</span>}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="toggle-switch"></span>
    </label>
  );

  return (
    <div
      className="notification-settings"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      <div className="notification-section">
        <h4>Notification Channels</h4>
        <Toggle
          label="Push Notifications"
          description="Receive alerts on your device"
          checked={config.pushEnabled}
          onChange={(v) => updateConfig('pushEnabled', v)}
        />
        <Toggle
          label="Email Notifications"
          description="Receive updates via email"
          checked={config.emailEnabled}
          onChange={(v) => updateConfig('emailEnabled', v)}
        />
        <Toggle
          label="In-App Notifications"
          description="Show notifications in the app"
          checked={config.inAppEnabled}
          onChange={(v) => updateConfig('inAppEnabled', v)}
        />
      </div>

      <div className="notification-section">
        <h4>Notification Types</h4>
        <Toggle
          label="Tournament Reminders"
          description="Starting soon, late registration closing"
          checked={config.tournamentReminders}
          onChange={(v) => updateConfig('tournamentReminders', v)}
        />
        <Toggle
          label="Friend Activity"
          description="Friend requests, online status"
          checked={config.friendActivity}
          onChange={(v) => updateConfig('friendActivity', v)}
        />
        <Toggle
          label="Club Announcements"
          description="News from your clubs"
          checked={config.clubAnnouncements}
          onChange={(v) => updateConfig('clubAnnouncements', v)}
        />
        <Toggle
          label="Table Invites"
          description="Invitations to join tables"
          checked={config.tableInvites}
          onChange={(v) => updateConfig('tableInvites', v)}
        />
        <Toggle
          label="Hand Results"
          description="Notifications for big wins/losses"
          checked={config.handResults}
          onChange={(v) => updateConfig('handResults', v)}
        />
        <Toggle
          label="Promotions & Offers"
          description="Bonuses and special events"
          checked={config.promotions}
          onChange={(v) => updateConfig('promotions', v)}
        />
      </div>

      <div className="notification-section">
        <h4>Quiet Hours</h4>
        <Toggle
          label="Enable Quiet Hours"
          description="Pause notifications during set times"
          checked={config.quietHoursEnabled}
          onChange={(v) => updateConfig('quietHoursEnabled', v)}
        />
        <div className={`quiet-hours-times ${!config.quietHoursEnabled ? 'disabled' : ''}`}>
          <div className="time-input">
            <label>Start</label>
            <input
              type="time"
              value={config.quietHoursStart}
              onChange={(e) => updateConfig('quietHoursStart', e.target.value)}
              disabled={!config.quietHoursEnabled}
            />
          </div>
          <span className="time-separator">to</span>
          <div className="time-input">
            <label>End</label>
            <input
              type="time"
              value={config.quietHoursEnd}
              onChange={(e) => updateConfig('quietHoursEnd', e.target.value)}
              disabled={!config.quietHoursEnabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotificationSettings;
