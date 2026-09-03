/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB SETTINGS — Customization & Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Comprehensive settings panel for club owners:
 * - General Info (Name, Description, Avatar)
 * - Game Config (Rake %, Jackpot Contribution)
 * - Member Policy (Approval Required, Agent Access)
 * - Danger Zone (Delete Club)
 */

import React, { useState, useEffect } from 'react';
import './ClubSettings.css';
import ClubLogoSelector from '../ClubLogoSelector';

export interface ClubSettingsData {
  name: string;
  description: string;
  avatarUrl: string;
  rakePercentage: number;
  jackpotContribution: number;
  requireApproval: boolean;
  agentsCanInvite: boolean;
  contactEmail?: string;
}

export interface ClubSettingsProps {
  initialSettings: ClubSettingsData;
  onSave: (settings: ClubSettingsData) => void;
  onClose: () => void;
  onDeleteClub: () => void;
}

export function ClubSettings({
  initialSettings,
  onSave,
  onClose,
  onDeleteClub,
}: ClubSettingsProps) {
  const [formData, setFormData] = useState<ClubSettingsData>(initialSettings);
  const [activeTab, setActiveTab] = useState<'general' | 'game' | 'policy'>('general');
  const [hasChanges, setHasChanges] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  const handleChange = (key: keyof ClubSettingsData, value: any) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
    setHasChanges(false);
  };

  return (
    <div className="club-settings-overlay" onClick={onClose}>
      <form
        className="club-settings"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        {/* Header */}
        <div className="club-settings__header">
          <h2 className="club-settings__title">Club Settings</h2>
          <button type="button" className="club-settings__close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="club-settings__tabs">
          <button
            type="button"
            className={`club-settings__tab ${activeTab === 'general' ? 'club-settings__tab--active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            type="button"
            className={`club-settings__tab ${activeTab === 'game' ? 'club-settings__tab--active' : ''}`}
            onClick={() => setActiveTab('game')}
          >
            Game Config
          </button>
          <button
            type="button"
            className={`club-settings__tab ${activeTab === 'policy' ? 'club-settings__tab--active' : ''}`}
            onClick={() => setActiveTab('policy')}
          >
            Policy
          </button>
        </div>

        {/* Content */}
        <div className="club-settings__content">
          {activeTab === 'general' && (
            <div className="settings-section">
              <div className="form-group">
                <label>Club Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                  className="form-input"
                  required
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => handleChange('description', e.target.value)}
                  className="form-textarea"
                  rows={3}
                />
              </div>
              <div className="form-group">
                <label>Club Logo</label>
                <ClubLogoSelector
                  clubId="settings"
                  currentLogo={formData.avatarUrl}
                  onLogoChange={(url) => handleChange('avatarUrl', url)}
                />
              </div>
              <div className="form-group">
                <label>Contact Email</label>
                <input
                  type="email"
                  value={formData.contactEmail || ''}
                  onChange={(e) => handleChange('contactEmail', e.target.value)}
                  className="form-input"
                />
              </div>
            </div>
          )}

          {activeTab === 'game' && (
            <div className="settings-section">
              <div className="form-group">
                <label>Rake Percentage (%)</label>
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.5"
                  value={formData.rakePercentage}
                  onChange={(e) => handleChange('rakePercentage', parseFloat(e.target.value))}
                  className="form-input"
                />
                <span className="form-hint">Standard Is 5%</span>
              </div>
              <div className="form-group">
                <label>Jackpot Contribution (Chips)</label>
                <input
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  value={formData.jackpotContribution}
                  onChange={(e) => handleChange('jackpotContribution', parseFloat(e.target.value))}
                  className="form-input"
                />
                <span className="form-hint">Amount Taken Per Hand For BBJ</span>
              </div>
            </div>
          )}

          {activeTab === 'policy' && (
            <div className="settings-section">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={formData.requireApproval}
                  onChange={(e) => handleChange('requireApproval', e.target.checked)}
                />
                <div className="checkbox-info">
                  <span className="checkbox-label">Require Verification</span>
                  <span className="checkbox-desc">New Members Must Be Approved By Admin</span>
                </div>
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={formData.agentsCanInvite}
                  onChange={(e) => handleChange('agentsCanInvite', e.target.checked)}
                />
                <div className="checkbox-info">
                  <span className="checkbox-label">Agent Invitations</span>
                  <span className="checkbox-desc">Allow Agents To Generate Invite Links</span>
                </div>
              </label>

              <div className="danger-zone">
                <h4 className="danger-limit">Danger Zone</h4>
                <button type="button" className="btn-danger" onClick={onDeleteClub}>
                  Delete Club Permanently
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="club-settings__footer">
          <button type="button" className="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-save" disabled={!hasChanges}>
            Save Changes
          </button>
        </div>
      </form>
    </div>
  );
}

export default ClubSettings;
