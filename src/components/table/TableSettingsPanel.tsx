/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE SETTINGS PANEL — Bible V8 §11.1 Reusable Settings Toggles
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders all 12 table settings toggles from Bible V8 §11.1.1.
 * Used in TWO locations:
 *   1. Table view gear icon (overlay panel)
 *   2. Hamburger menu Settings section (inline)
 *
 * Data source: useUserTableSettings hook → Supabase user_table_settings table
 * Both locations read/write the SAME row — changes persist across sessions.
 */

import React, { useState } from 'react';
import { type UserTableSettings, TABLE_SETTINGS_META } from '../../hooks/useUserTableSettings';
import './TableSettingsPanel.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableSettingsPanelProps {
  settings: UserTableSettings;
  loading: boolean;
  onToggle: (key: keyof UserTableSettings) => void;
  /** Render mode: 'overlay' for table gear icon, 'inline' for hamburger menu */
  mode?: 'overlay' | 'inline';
  /** Show close button (overlay mode only) */
  onClose?: () => void;
  /** Optional: open theme settings modal */
  onOpenThemeSettings?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableSettingsPanel({
  settings,
  loading,
  onToggle,
  mode = 'overlay',
  onClose,
  onOpenThemeSettings,
}: TableSettingsPanelProps) {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  // Stagger animation on mount
  React.useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    TABLE_SETTINGS_META.forEach((_, i) => {
      timers.push(
        setTimeout(() => {
          setVisibleItems((prev) => new Set([...prev, i]));
        }, i * 40)
      );
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  if (loading) {
    return (
      <div className={`tsp-container tsp-${mode}`}>
        <div className="tsp-loading">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className={`tsp-container tsp-${mode}`}>
      {/* Header (overlay mode only) */}
      {mode === 'overlay' && (
        <div className="tsp-header">
          <h3 className="tsp-title">Table Settings</h3>
          {onClose && (
            <button className="tsp-close" onClick={onClose} aria-label="Close settings">
              ×
            </button>
          )}
        </div>
      )}

      {/* Toggle List */}
      <div className="tsp-list">
        {TABLE_SETTINGS_META.map((meta, idx) => {
          const isEnabled = settings[meta.key];
          const isVisible = visibleItems.has(idx);

          return (
            <div
              key={meta.key}
              className={`tsp-item ${isEnabled ? 'tsp-item--active' : ''}`}
              onClick={() => onToggle(meta.key)}
              style={{
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0)' : 'translateY(6px)',
                transition: 'opacity 0.3s ease, transform 0.3s ease',
              }}
            >
              <div className="tsp-item__info">
                <span className="tsp-item__label">{meta.label}</span>
                <span className="tsp-item__desc">{meta.description}</span>
              </div>
              <button
                className={`tsp-toggle ${isEnabled ? 'tsp-toggle--on' : 'tsp-toggle--off'}`}
                role="switch"
                aria-checked={isEnabled}
                aria-label={`${meta.label}: ${isEnabled ? 'on' : 'off'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(meta.key);
                }}
              >
                <span className="tsp-toggle__track">
                  <span className="tsp-toggle__thumb" />
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* Theme Settings Link */}
      {onOpenThemeSettings && (
        <div className="tsp-theme-link" onClick={onOpenThemeSettings}>
          <span className="tsp-theme-link__label">Theme Settings</span>
          <span className="tsp-theme-link__arrow">›</span>
        </div>
      )}
    </div>
  );
}

export default TableSettingsPanel;
