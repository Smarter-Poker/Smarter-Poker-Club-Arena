/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE SETTINGS — VIP-Gated Table Options
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Settings panel with VIP feature gating:
 * - Show Stack in BBs: FREE for everyone
 * - Offline Protection: 1 free per session, VIP unlimited
 * - Auto Time Bank: VIP=free, Non-VIP=5D per activation (confirmation popup)
 */

import React, { useState, useEffect } from 'react';
import { vipService, FEATURE_PRICING, VIPFeature } from '../../services/VIPService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './TableSettings.css';
import { reportError } from '../../utils/errorReporter';

interface TableSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  bigBlind: number;
  onSettingsChange: (settings: TableSettingsState) => void;
  currentSettings: TableSettingsState;
}

export interface TableSettingsState {
  showStackInBB: boolean;
  offlineProtection: boolean;
  autoTimeBank: boolean;
}

interface SettingConfig {
  key: keyof TableSettingsState;
  feature?: VIPFeature;
  label: string;
  description: string;
  icon: string;
  isFree?: boolean;
  freeLabel?: string;
}

const SETTINGS: SettingConfig[] = [
  {
    key: 'showStackInBB',
    label: 'Show Stack in BBs',
    description: 'Display stacks as big blind multiples',
    icon: '',
    isFree: true,
    freeLabel: 'FREE',
  },
  {
    key: 'offlineProtection',
    feature: 'offline_protection',
    label: 'Offline Protection',
    description: '1 free per session · VIP unlimited',
    icon: '',
  },
  {
    key: 'autoTimeBank',
    feature: 'auto_time_bank',
    label: 'Auto Time Bank',
    description: 'Auto-uses time bank · VIP free · Non-VIP 5D per use',
    icon: '',
  },
];

export function TableSettings({
  isOpen,
  onClose,
  bigBlind,
  onSettingsChange,
  currentSettings,
}: TableSettingsProps) {
  const { user } = useAuthUser();
  const toast = useToast();

  const [settings, setSettings] = useState<TableSettingsState>(currentSettings);
  const [isVIP, setIsVIP] = useState(false);
  const [loading, setLoading] = useState(true);
  const [offlineUsedThisSession, setOfflineUsedThisSession] = useState(false);
  const [showTimeBankConfirm, setShowTimeBankConfirm] = useState(false);
  const [visibleSettings, setVisibleSettings] = useState<boolean[]>([]);

  // Check VIP status on mount
  useEffect(() => {
    const checkVIP = async () => {
      if (!user?.id) {
        setLoading(false);
        return;
      }
      try {
        const vip = await vipService.isVIP(user.id);
        setIsVIP(vip);
      } catch (err) {
        reportError(err, 'TableSettings.Error');
        setIsVIP(false);
      }
      setLoading(false);
    };

    if (isOpen) {
      checkVIP();
      // Check session storage for offline protection usage
      const used = sessionStorage.getItem('offline_protection_used');
      setOfflineUsedThisSession(used === 'true');
      setVisibleSettings([]);
      SETTINGS.forEach((_, i) => {
        setTimeout(() => {
          setVisibleSettings((prev) => [...prev, true]);
        }, i * 60);
      });
    }
  }, [isOpen, user?.id]);

  const handleToggle = async (setting: SettingConfig) => {
    if (!user?.id) {
      toast.error('Please log in');
      return;
    }

    const currentValue = settings[setting.key];

    // ── Show Stack in BBs — FREE for everyone ──
    if (setting.isFree) {
      const newSettings = { ...settings, [setting.key]: !currentValue };
      setSettings(newSettings);
      onSettingsChange(newSettings);
      return;
    }

    // ── Auto Time Bank — Non-VIP needs confirmation ──
    if (setting.key === 'autoTimeBank' && !currentValue && !isVIP) {
      setShowTimeBankConfirm(true);
      return;
    }

    // ── Offline Protection — 1 free per session for non-VIP ──
    if (setting.key === 'offlineProtection' && !currentValue && !isVIP) {
      if (offlineUsedThisSession) {
        toast.error('Offline protection already used this session. Get VIP for unlimited!');
        return;
      }
      // Grant free usage, mark session
      sessionStorage.setItem('offline_protection_used', 'true');
      setOfflineUsedThisSession(true);
      toast.info('Offline protection activated (1 free per session)');
    }

    // Toggle the setting
    const newSettings = { ...settings, [setting.key]: !currentValue };
    setSettings(newSettings);
    onSettingsChange(newSettings);
  };

  const confirmAutoTimeBank = () => {
    const newSettings = { ...settings, autoTimeBank: true };
    setSettings(newSettings);
    onSettingsChange(newSettings);
    setShowTimeBankConfirm(false);
    toast.info('Auto Time Bank enabled · 5D per activation');
  };

  if (!isOpen) return null;

  return (
    <div className="table-settings-overlay" onClick={onClose}>
      <div className="table-settings" onClick={(e) => e.stopPropagation()}>
        <div className="table-settings__header">
          <h3> Table Settings</h3>
          <button className="table-settings__close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="table-settings__content">
          {loading ? (
            <div className="table-settings__loading">Loading...</div>
          ) : (
            SETTINGS.map((setting, idx) => {
              const isEnabled = settings[setting.key];
              const isFreeFeature = setting.isFree || isVIP;

              // Offline protection: show status
              let costLabel = '';
              if (setting.isFree) {
                costLabel = 'FREE';
              } else if (isVIP) {
                costLabel = ' FREE';
              } else if (setting.key === 'offlineProtection') {
                costLabel = offlineUsedThisSession ? 'Used' : '1 Free';
              } else if (setting.key === 'autoTimeBank') {
                costLabel = `${FEATURE_PRICING.auto_time_bank.cost} per use`;
              }

              return (
                <div
                  key={setting.key}
                  className={`table-settings__item ${isEnabled ? 'active' : ''}`}
                  onClick={() => handleToggle(setting)}
                  style={{
                    opacity: visibleSettings[idx] ? 1 : 0,
                    transform: visibleSettings[idx] ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <div className="table-settings__item-icon">{setting.icon}</div>
                  <div className="table-settings__item-info">
                    <span className="table-settings__item-label">{setting.label}</span>
                    <span className="table-settings__item-desc">{setting.description}</span>
                  </div>
                  <div className="table-settings__item-cost">
                    {isFreeFeature ? (
                      <span className="cost-free">{costLabel || ' FREE'}</span>
                    ) : (
                      <span className="cost-diamond">{costLabel}</span>
                    )}
                  </div>
                  <div className={`table-settings__toggle ${isEnabled ? 'on' : 'off'}`}>
                    <div className="toggle-track">
                      <div className="toggle-thumb" />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="table-settings__footer">
          <span className="table-settings__bb-info">
            Current Big Blind: <strong>{bigBlind}</strong> Chips
          </span>
        </div>
      </div>

      {/* ═══ Auto Time Bank Confirmation Modal (Non-VIP) ═══ */}
      {showTimeBankConfirm && (
        <div
          className="table-settings__confirm-overlay"
          onClick={() => setShowTimeBankConfirm(false)}
        >
          <div className="table-settings__confirm" onClick={(e) => e.stopPropagation()}>
            <h4>Enable Auto Time Bank?</h4>
            <p>
              Each Time Bank Activation Will Cost{' '}
              <strong>{FEATURE_PRICING.auto_time_bank.cost} D</strong>. Diamonds Are Automatically
              Deducted From Your Balance.
            </p>
            <div className="table-settings__confirm-vip">
              <span>D</span>
              <div>
                <strong>VIP Diamond Members</strong> Get Unlimited Time Bank For Free!
                <a
                  href="/vip"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  Learn More →
                </a>
              </div>
            </div>
            <div className="table-settings__confirm-actions">
              <button
                className="confirm-btn confirm-btn--cancel"
                onClick={() => setShowTimeBankConfirm(false)}
              >
                Cancel
              </button>
              <button className="confirm-btn confirm-btn--accept" onClick={confirmAutoTimeBank}>
                Enable (5D/Use)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TableSettings;
