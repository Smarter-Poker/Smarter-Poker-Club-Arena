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

  return (
    <div className={`tsp-container tsp-${mode}`} aria-busy={loading}>
      {/* Header (overlay mode only) */}
      {mode === 'overlay' && (
        <div className="tsp-header">
          <h3 className="tsp-title">Table Settings</h3>
          {onClose && (
            <button
              type="button"
              className="tsp-close"
              onClick={onClose}
              aria-label="Close Settings"
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* Cached or default settings are already safe to use while the
          canonical row refreshes. Keeping the switches mounted makes a slow
          preference read non-blocking; the hook preserves any choice made
          before that background read settles. */}
      {loading && (
        <div className="tsp-loading" role="status" aria-live="polite">
          Refreshing Settings In Background...
        </div>
      )}

      {/* Toggle List */}
      <div className="tsp-list">
        {TABLE_SETTINGS_META.filter((m) => typeof settings[m.key] === 'boolean').map(
          (meta, idx) => {
            const isEnabled = !!settings[meta.key];
            const isVisible = visibleItems.has(idx);
            const labelId = `table-setting-${String(meta.key)}-label`;
            const descriptionId = `table-setting-${String(meta.key)}-description`;

            return (
              <button
                type="button"
                key={meta.key}
                className={`tsp-item ${isEnabled ? 'tsp-item--active' : ''}`}
                onClick={() => onToggle(meta.key)}
                role="switch"
                aria-checked={isEnabled}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                style={{
                  opacity: isVisible ? 1 : 0,
                  transform: isVisible ? 'translateY(0)' : 'translateY(6px)',
                  transition: 'opacity 0.3s ease, transform 0.3s ease',
                }}
              >
                <div className="tsp-item__info">
                  <span className="tsp-item__label" id={labelId}>
                    {meta.label}
                  </span>
                  <span className="tsp-item__desc" id={descriptionId}>
                    {meta.description}
                  </span>
                </div>
                <span
                  className={`tsp-toggle ${isEnabled ? 'tsp-toggle--on' : 'tsp-toggle--off'}`}
                  aria-hidden="true"
                >
                  <span className="tsp-toggle__track">
                    <span className="tsp-toggle__thumb" />
                  </span>
                </span>
              </button>
            );
          }
        )}
      </div>
    </div>
  );
}

export default TableSettingsPanel;
