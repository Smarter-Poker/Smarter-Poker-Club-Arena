/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE SETTINGS PANEL — Bible V8 §11.1 Reusable Settings Toggles
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders every toggle in TABLE_SETTINGS_META (the hook owns the list; this
 * file has never owned a count and must not start - it said "all 12" while
 * the list held 13, and then 14).
 * Used in TWO locations:
 *   1. Table view gear icon (overlay panel)
 *   2. Hamburger menu Settings section (inline)
 *
 * Data source: useUserTableSettings hook → Supabase user_table_settings table
 * Both locations read/write the SAME row — changes persist across sessions.
 */

import React, { useState } from 'react';
import { type UserTableSettings, TABLE_SETTINGS_META } from '../../hooks/useUserTableSettings';
import { useVIPStatus } from '../../hooks/useVIP';
import { masterBus } from '../../core/MasterBus';
import { ALL_IN_SQUEEZE_VIP_REQUIRED_MESSAGE } from '../../presentation/cardPresentation/squeezeEligibility';
import './TableSettingsPanel.css';

/**
 * VIP ALL-IN SQUEEZE 2026-09-05: what a VIP-gated switch SHOWS. The stored
 * preference defaults to true for everyone so a new VIP finds the perk on;
 * for a non-VIP it is inert and the switch must say so. While the VIP check
 * is still in flight the stored value is shown, so a VIP never sees their
 * switch flash off and on when the panel opens.
 */
export function effectiveSettingValue(
  stored: boolean,
  vipGated: boolean | undefined,
  isVIP: boolean,
  vipLoading: boolean
): boolean {
  if (!vipGated) return stored;
  return stored && (isVIP || vipLoading);
}

/**
 * Dan: "IF A NONE VIP MEMBER TRIES TO TURN IT ON THEY SHOULD BE INSTRUCTED
 * THAT THEY NEED A VIP CARD TO USE THIS FEATURE." Through the bus, like the
 * hook's own save-failure toast, so both settings surfaces (gear overlay and
 * hamburger inline) say it without needing a Toast provider in scope. The
 * Toast layer applies the house Title Case transform (popupStyle.ts).
 */
export function announceVipRequired(): void {
  masterBus.emit('SHOW_TOAST', {
    severity: 'info',
    message: ALL_IN_SQUEEZE_VIP_REQUIRED_MESSAGE,
    source: 'TableSettingsPanel',
  });
}

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
  const { isVIP, isLoading: vipLoading } = useVIPStatus();

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
            const isEnabled = effectiveSettingValue(
              !!settings[meta.key],
              meta.vip,
              isVIP,
              vipLoading
            );
            const isVisible = visibleItems.has(idx);
            const onClick = () => {
              if (!meta.vip) {
                onToggle(meta.key);
                return;
              }
              if (vipLoading) return;
              if (!isVIP) {
                announceVipRequired();
                return;
              }
              onToggle(meta.key);
            };
            const labelId = `table-setting-${String(meta.key)}-label`;
            const descriptionId = `table-setting-${String(meta.key)}-description`;

            return (
              <button
                type="button"
                key={meta.key}
                className={`tsp-item ${isEnabled ? 'tsp-item--active' : ''}`}
                onClick={onClick}
                role="switch"
                aria-checked={isEnabled}
                data-vip-gated={meta.vip ? 'true' : undefined}
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
