/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB SETTINGS PANEL — Club Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import { resolveClubIdFilter } from '../../utils/clubIdResolver';
import { masterBus } from '../../core/MasterBus';
import './ClubSettingsPanel.css';

interface ClubSettingsPanelProps {
  clubId: string;
  isOpen: boolean;
  onClose: () => void;
  onSave?: () => void;
}

interface ClubSettings {
  name: string;
  description: string;
  logo: string;
  isPrivate: boolean;
  requireApproval: boolean;
  minBuyIn: number;
  maxBuyIn: number;
  rakePercent: number;
  rakeCap: number;
  defaultGameType: string;
  allowInsurance: boolean;
  allowRunItTwice: boolean;
  allowStraddle: boolean;
  autoApproveAgents: boolean;
}

export function ClubSettingsPanel({ clubId, isOpen, onClose, onSave }: ClubSettingsPanelProps) {
  const toast = useToast();

  const [settings, setSettings] = useState<ClubSettings>({
    name: '',
    description: '',
    logo: '',
    isPrivate: false,
    requireApproval: false,
    minBuyIn: 20,
    maxBuyIn: 200,
    rakePercent: 5,
    rakeCap: 3,
    defaultGameType: 'nlh',
    allowInsurance: true,
    allowRunItTwice: true,
    allowStraddle: true,
    autoApproveAgents: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [visibleSections, setVisibleSections] = useState<boolean[]>([]);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
      setVisibleSections([]);
      [0, 1, 2, 3, 4].forEach((i) => {
        setTimeout(() => {
          setVisibleSections((prev) => [...prev, true]);
        }, i * 60);
      });
    }
  }, [isOpen, clubId]);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data, error } = await supabase
        .from('clubs')
        .select('*')
        .eq(clubCol, clubVal)
        .maybeSingle();

      if (!error && data) {
        setSettings({
          name: data.name || '',
          description: data.description || '',
          logo: data.logo || '',
          isPrivate: data.is_private || false,
          requireApproval: data.require_approval || false,
          minBuyIn: data.min_buy_in || 20,
          maxBuyIn: data.max_buy_in || 200,
          rakePercent: data.rake_percent || 5,
          rakeCap: data.rake_cap || 3,
          defaultGameType: data.default_game_type || 'nlh',
          allowInsurance: data.allow_insurance ?? true,
          allowRunItTwice: data.allow_run_it_twice ?? true,
          allowStraddle: data.allow_straddle ?? true,
          autoApproveAgents: data.auto_approve_agents || false,
        });
      }
    } catch (error) {
      toast.error('Failed to load settings');
    }
    setLoading(false);
  };

  const updateSetting = (key: keyof ClubSettings, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('clubs')
        .update({
          name: settings.name,
          description: settings.description,
          logo: settings.logo,
          is_private: settings.isPrivate,
          require_approval: settings.requireApproval,
          min_buy_in: settings.minBuyIn,
          max_buy_in: settings.maxBuyIn,
          rake_percent: settings.rakePercent,
          rake_cap: settings.rakeCap,
          default_game_type: settings.defaultGameType,
          allow_insurance: settings.allowInsurance,
          allow_run_it_twice: settings.allowRunItTwice,
          allow_straddle: settings.allowStraddle,
          auto_approve_agents: settings.autoApproveAgents,
        })
        .eq(resolveClubIdFilter(clubId).column, resolveClubIdFilter(clubId).value);

      if (error) throw error;

      // Emit CLUB_UPDATED so all live components refresh with new settings
      masterBus.emit('CLUB_UPDATED', { clubId });
      toast.success('Settings saved');
      onSave?.();
      onClose();
    } catch (error) {
      toast.error('Failed to save settings');
    }
    setSaving(false);
  };

  if (!isOpen) return null;

  return (
    <div className="club-settings-overlay" onClick={onClose}>
      <div className="club-settings" onClick={(e) => e.stopPropagation()}>
        <div className="club-settings__header">
          <h3> Club Settings</h3>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        {loading ? (
          <div className="loading-state">Loading...</div>
        ) : (
          <div className="club-settings__content">
            <section
              style={{
                opacity: visibleSections[0] ? 1 : 0,
                transform: visibleSections[0] ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <h4>Basic Info</h4>
              <div className="form-group">
                <label>Club Name</label>
                <input
                  type="text"
                  value={settings.name}
                  onChange={(e) => updateSetting('name', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={settings.description}
                  onChange={(e) => updateSetting('description', e.target.value)}
                  rows={3}
                />
              </div>
            </section>

            <section
              style={{
                opacity: visibleSections[1] ? 1 : 0,
                transform: visibleSections[1] ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <h4>Access</h4>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.isPrivate}
                  onChange={(e) => updateSetting('isPrivate', e.target.checked)}
                />
                <span>Private Club</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.requireApproval}
                  onChange={(e) => updateSetting('requireApproval', e.target.checked)}
                />
                <span>Require Approval</span>
              </label>
            </section>

            <section
              style={{
                opacity: visibleSections[2] ? 1 : 0,
                transform: visibleSections[2] ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <h4>Rake Settings</h4>
              <div className="form-row">
                <div className="form-group">
                  <label>Rake %</label>
                  <input
                    type="number"
                    value={settings.rakePercent}
                    onChange={(e) => updateSetting('rakePercent', Number(e.target.value))}
                    min={0}
                    max={10}
                  />
                </div>
                <div className="form-group">
                  <label>Rake Cap</label>
                  <input
                    type="number"
                    value={settings.rakeCap}
                    onChange={(e) => updateSetting('rakeCap', Number(e.target.value))}
                    min={0}
                  />
                </div>
              </div>
            </section>

            <section
              style={{
                opacity: visibleSections[3] ? 1 : 0,
                transform: visibleSections[3] ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <h4>Game Features</h4>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.allowRunItTwice}
                  onChange={(e) => updateSetting('allowRunItTwice', e.target.checked)}
                />
                <span>Run It Twice</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.allowInsurance}
                  onChange={(e) => updateSetting('allowInsurance', e.target.checked)}
                />
                <span>Insurance</span>
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.allowStraddle}
                  onChange={(e) => updateSetting('allowStraddle', e.target.checked)}
                />
                <span>Straddle</span>
              </label>
            </section>
          </div>
        )}

        <div className="club-settings__footer">
          <button className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="save-btn" onClick={saveSettings} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ClubSettingsPanel;
