/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NOTIFICATION SETTINGS PANEL — Q3: Per-Type Notification Preferences
 * ═══════════════════════════════════════════════════════════════════════════════
 * Granular muting: messages, games, social, achievements, system.
 * DND shortcut + preferences persist via localStorage.
 */

import { useState } from 'react';
import { messagingService } from '../../services/MessagingService';
import { notificationService } from '../../services/NotificationService';
import styles from './NotificationSettingsPanel.module.css';

interface NotificationSettingsPanelProps {
  onClose: () => void;
}

const CATEGORIES = [
  { key: 'messages', label: 'Messages', icon: '✉', desc: 'DMs and group chats' },
  { key: 'games', label: 'Games', icon: '▦', desc: 'Table invites, waitlist, hands' },
  { key: 'social', label: 'Social', icon: '◉', desc: 'Friend requests, club invites' },
  { key: 'achievements', label: 'Achievements', icon: '★', desc: 'Badges, streaks, diamonds' },
  { key: 'system', label: 'System', icon: '⚙', desc: 'Updates, maintenance, security' },
];

export default function NotificationSettingsPanel({ onClose }: NotificationSettingsPanelProps) {
  const [prefs, setPrefs] = useState(() => messagingService.getNotificationPreferences());
  const dndActive = notificationService.isDndActive();
  const dndRemaining = notificationService.getDndRemaining();

  const toggle = (key: string) => {
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    messagingService.setNotificationPreferences(updated);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>Notification Settings</h3>
          <button className={styles.closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        {/* DND Status */}
        {dndActive && (
          <div className={styles.dndBanner}>
            Do Not Disturb - {dndRemaining}m Remaining
            <button
              onClick={() => {
                notificationService.clearDnd();
                onClose();
              }}
            >
              Resume
            </button>
          </div>
        )}

        {/* Per-Category Toggles */}
        <div className={styles.categories}>
          {CATEGORIES.map((cat) => (
            <div key={cat.key} className={styles.categoryRow}>
              <div className={styles.categoryInfo}>
                <span className={styles.categoryIcon}>{cat.icon}</span>
                <div>
                  <span className={styles.categoryLabel}>{cat.label}</span>
                  <span className={styles.categoryDesc}>{cat.desc}</span>
                </div>
              </div>
              <button
                className={`${styles.toggleSwitch} ${prefs[cat.key] !== false ? styles.toggleOn : ''}`}
                onClick={() => toggle(cat.key)}
              >
                <span className={styles.toggleKnob} />
              </button>
            </div>
          ))}
        </div>

        {/* Quick DND */}
        <div className={styles.dndSection}>
          <span className={styles.dndLabel}>Quick DND</span>
          <div className={styles.dndOptions}>
            {[15, 30, 60, 120].map((m) => (
              <button
                key={m}
                className={styles.dndBtn}
                onClick={() => {
                  notificationService.setDnd(m);
                  onClose();
                }}
              >
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
