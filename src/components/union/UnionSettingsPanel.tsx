import React, { useState, useEffect } from 'react';
import { unionService } from '../../services';
import { useToast } from '../common/Toast';
import ClubLogoSelector from '../ClubLogoSelector';
import './UnionSettingsPanel.css';

interface UnionSettings {
  id: string;
  name: string;
  logoUrl?: string;
  revenueSplit: number;
  settlementFrequency: 'daily' | 'weekly' | 'monthly';
  autoSettlement: boolean;
  minimumSettlement: number;
  rakeCap: number | null;
  allowMemberWithdrawal: boolean;
  requireApprovalForJoin: boolean;
}

interface UnionSettingsPanelProps {
  unionId: string;
  isOwner: boolean;
  onSave?: () => void;
}

export const UnionSettingsPanel: React.FC<UnionSettingsPanelProps> = ({
  unionId,
  isOwner,
  onSave,
}) => {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<UnionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  useEffect(() => {
    loadSettings();
  }, [unionId]);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const data = await unionService.getUnionSettings(unionId);
      setSettings(data);
    } catch (error) {
      showToast('Failed to load settings', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await unionService.updateUnionSettings(unionId, settings);
      showToast('Settings saved', 'success');
      onSave?.();
    } catch (error) {
      showToast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = <K extends keyof UnionSettings>(key: K, value: UnionSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : null));
  };

  if (loading) {
    return <div className="union-settings-loading">Loading settings...</div>;
  }

  if (!settings) {
    return <div className="union-settings-error">Settings not found</div>;
  }

  return (
    <div
      className="union-settings-panel"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div className="settings-header">
        <h3>Union Settings</h3>
        {!isOwner && <span className="readonly-badge">View Only</span>}
      </div>

      <div className="settings-section">
        <h4>Union Branding</h4>

        <div className="setting-row">
          <label>Union Logo</label>
          <ClubLogoSelector
            clubId={`union-${unionId}`}
            currentLogo={settings.logoUrl || ''}
            onLogoChange={(url: string) => updateSetting('logoUrl', url)}
          />
        </div>
      </div>

      <div className="settings-section">
        <h4>Revenue & Settlement</h4>

        <div className="setting-row">
          <label>Revenue Split to Union</label>
          <div className="setting-input">
            <input
              type="number"
              value={settings.revenueSplit}
              onChange={(e) => updateSetting('revenueSplit', Number(e.target.value))}
              min={0}
              max={100}
              disabled={!isOwner}
            />
            <span className="input-suffix">%</span>
          </div>
        </div>

        <div className="setting-row">
          <label>Settlement Frequency</label>
          <select
            value={settings.settlementFrequency}
            onChange={(e) =>
              updateSetting(
                'settlementFrequency',
                e.target.value as UnionSettings['settlementFrequency']
              )
            }
            disabled={!isOwner}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>

        <div className="setting-row">
          <label>Minimum Settlement Amount</label>
          <div className="setting-input">
            <input
              type="number"
              value={settings.minimumSettlement}
              onChange={(e) => updateSetting('minimumSettlement', Number(e.target.value))}
              min={0}
              disabled={!isOwner}
            />
            <span className="input-suffix">chips</span>
          </div>
        </div>

        <div className="setting-row toggle">
          <label>Auto Settlement</label>
          <button
            className={`toggle-btn ${settings.autoSettlement ? 'active' : ''}`}
            onClick={() => updateSetting('autoSettlement', !settings.autoSettlement)}
            disabled={!isOwner}
          >
            <span className="toggle-thumb" />
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h4>Member Policies</h4>

        <div className="setting-row toggle">
          <label>Require Approval for New Members</label>
          <button
            className={`toggle-btn ${settings.requireApprovalForJoin ? 'active' : ''}`}
            onClick={() =>
              updateSetting('requireApprovalForJoin', !settings.requireApprovalForJoin)
            }
            disabled={!isOwner}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <div className="setting-row toggle">
          <label>Allow Member Chip Withdrawal</label>
          <button
            className={`toggle-btn ${settings.allowMemberWithdrawal ? 'active' : ''}`}
            onClick={() => updateSetting('allowMemberWithdrawal', !settings.allowMemberWithdrawal)}
            disabled={!isOwner}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <div className="setting-row">
          <label>Rake Cap (Optional)</label>
          <div className="setting-input">
            <input
              type="number"
              value={settings.rakeCap || ''}
              onChange={(e) =>
                updateSetting('rakeCap', e.target.value ? Number(e.target.value) : null)
              }
              placeholder="No cap"
              disabled={!isOwner}
            />
            <span className="input-suffix">chips</span>
          </div>
        </div>
      </div>

      {isOwner && (
        <button className="save-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      )}
    </div>
  );
};

export default UnionSettingsPanel;
