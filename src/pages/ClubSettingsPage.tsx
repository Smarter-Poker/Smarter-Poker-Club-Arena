/**
 *  CLUB SETTINGS PAGE — Club Configuration
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { ClubsService } from '../services/ClubsService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { sanitizeInput } from '../utils/sanitizeInput';
import PageSkeleton from '../components/common/PageSkeleton';
import ClubBottomNav from '../components/club/ClubBottomNav';
import AuditLog from '../components/admin/AuditLog';
import { StatsExport } from '../components/admin/StatsExport';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';
import '../components/common/ButtonSpinner.css';
import './ClubSettingsPage.css';

interface ClubSettings {
  name: string;
  description: string;
  is_public: boolean;
  requires_approval: boolean;
  default_rake_percent: number;
  rake_cap: number;
  time_bank_seconds: number;
  allow_straddle: boolean;
  allow_run_it_twice: boolean;
  allow_rabbit_hunt: boolean;
  min_buyin_bb: number;
  max_buyin_bb: number;
}

export default function ClubSettingsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const { user } = useAuthUser();
  const toast = useToast();

  const [settings, setSettings] = useState<ClubSettings>({
    name: '',
    description: '',
    is_public: true,
    requires_approval: false,
    default_rake_percent: 5,
    rake_cap: 3,
    time_bank_seconds: 30,
    allow_straddle: true,
    allow_run_it_twice: true,
    allow_rabbit_hunt: true,
    min_buyin_bb: 40,
    max_buyin_bb: 200,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const originalSettings = useRef<ClubSettings | null>(null);

  // Live change detection — compute which fields have been modified
  const changedFields = useMemo(() => {
    if (!originalSettings.current) return [];
    const changes: string[] = [];
    const orig = originalSettings.current;
    if (settings.name !== orig.name) changes.push('Name');
    if (settings.description !== orig.description) changes.push('Description');
    if (settings.is_public !== orig.is_public) changes.push('Public');
    if (settings.requires_approval !== orig.requires_approval) changes.push('Approval');
    if (settings.default_rake_percent !== orig.default_rake_percent) changes.push('Rake %');
    if (settings.rake_cap !== orig.rake_cap) changes.push('Rake Cap');
    if (settings.time_bank_seconds !== orig.time_bank_seconds) changes.push('Time Bank');
    if (settings.allow_straddle !== orig.allow_straddle) changes.push('Straddle');
    if (settings.allow_run_it_twice !== orig.allow_run_it_twice) changes.push('Run It Twice');
    if (settings.allow_rabbit_hunt !== orig.allow_rabbit_hunt) changes.push('Rabbit Hunt');
    if (settings.min_buyin_bb !== orig.min_buyin_bb) changes.push('Min Buy-in');
    if (settings.max_buyin_bb !== orig.max_buyin_bb) changes.push('Max Buy-in');
    return changes;
  }, [settings]);
  const hasUnsavedChanges = changedFields.length > 0;

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showStatsExport, setShowStatsExport] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');

  useEffect(() => {
    let isMounted = true;
    if (clubId) loadClubSettings(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [clubId]);

  // ── Realtime: live club settings changes ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `club-settings-${clubId}`;

    // Resolve UUID for realtime filter (integer club IDs need translation)
    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;
      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'clubs',
            filter: `id=eq.${resolvedId}`,
          },
          () => {
            if (isMounted) loadClubSettings(() => isMounted);
          }
        )
        .subscribe();
    };

    setupRealtime().catch((e) => console.warn('[ClubSettingsPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // ── Bus Listeners: cross-page event reactivity (debounced) ──
  useEffect(() => {
    let isMounted = true;
    const handler = () => {
      if (isMounted) loadClubSettings(() => isMounted);
    };
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', handler, 500),
      masterBus.subscribeDebounced('CLUB_LEFT', handler, 500),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadClubSettings = async (getIsMounted?: () => boolean) => {
    if (!getIsMounted || getIsMounted()) setLoading(true);
    try {
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId!);
      const { data, error } = await supabase
        .from('clubs')
        .select(
          'id, owner_id, name, description, is_public, requires_approval, default_rake_percent, rake_cap, time_bank_seconds, allow_straddle, allow_run_it_twice, allow_rabbit_hunt, min_buyin_bb, max_buyin_bb'
        )
        .eq(clubCol, clubVal)
        .maybeSingle();

      if (getIsMounted && !getIsMounted()) return;
      if (!error && data) {
        setSettings({
          name: data.name || '',
          description: data.description || '',
          is_public: data.is_public ?? true,
          requires_approval: data.requires_approval ?? false,
          default_rake_percent: data.default_rake_percent || 5,
          rake_cap: data.rake_cap || 3,
          time_bank_seconds: data.time_bank_seconds || 30,
          allow_straddle: data.allow_straddle ?? true,
          allow_run_it_twice: data.allow_run_it_twice ?? true,
          allow_rabbit_hunt: data.allow_rabbit_hunt ?? true,
          min_buyin_bb: data.min_buyin_bb || 40,
          max_buyin_bb: data.max_buyin_bb || 200,
        });
        // Capture original for live diff comparison
        originalSettings.current = {
          name: data.name || '',
          description: data.description || '',
          is_public: data.is_public ?? true,
          requires_approval: data.requires_approval ?? false,
          default_rake_percent: data.default_rake_percent || 5,
          rake_cap: data.rake_cap || 3,
          time_bank_seconds: data.time_bank_seconds || 30,
          allow_straddle: data.allow_straddle ?? true,
          allow_run_it_twice: data.allow_run_it_twice ?? true,
          allow_rabbit_hunt: data.allow_rabbit_hunt ?? true,
          min_buyin_bb: data.min_buyin_bb || 40,
          max_buyin_bb: data.max_buyin_bb || 200,
        };
        setIsOwner(data.owner_id === user?.id);
      }
    } catch (error) {
      console.error('Failed to load club settings:', error);
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load club settings');
    }
    if (!getIsMounted || getIsMounted()) setLoading(false);
  };

  const saveSettings = async () => {
    if (!isOwner) return;
    setSaving(true);
    try {
      // Phase 13: Optimistic save — emit events instantly, then confirm with server
      await masterBus.executeOptimistic(
        'SETTINGS_UPDATED',
        { settings: { clubId, ...settings } },
        async () => {
          if (clubId) masterBus.emit('CLUB_UPDATED', { clubId });
          if (clubId) masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId });
          const { error } = await supabase
            .from('clubs')
            .update({
              name: sanitizeInput(settings.name),
              description: sanitizeInput(settings.description),
              is_public: settings.is_public,
              requires_approval: settings.requires_approval,
              default_rake_percent: settings.default_rake_percent,
              rake_cap: settings.rake_cap,
              time_bank_seconds: settings.time_bank_seconds,
              allow_straddle: settings.allow_straddle,
              allow_run_it_twice: settings.allow_run_it_twice,
              allow_rabbit_hunt: settings.allow_rabbit_hunt,
              min_buyin_bb: settings.min_buyin_bb,
              max_buyin_bb: settings.max_buyin_bb,
            })
            .eq(resolveClubIdFilter(clubId!).column, resolveClubIdFilter(clubId!).value);
          if (error) throw error;
        }
      );
      toast.success('Settings saved!');
      masterBus.emit('ADMIN_ACTION', {
        action: 'settings_updated',
        target: clubId || '',
        details: { changedFields },
        userId: user?.id,
      });
      // Update original baseline so diff resets
      originalSettings.current = { ...settings };
      navigate(`/clubs/${clubId}`);
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
    }
    setSaving(false);
  };

  const updateSetting = <K extends keyof ClubSettings>(key: K, value: ClubSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleDeleteClub = async () => {
    if (!clubId || confirmText !== settings.name) return;

    setIsDeleting(true);
    try {
      await ClubsService.delete(clubId);
      toast.success('Club deleted successfully');
      navigate('/clubs');
    } catch (error: unknown) {
      console.error('Failed to delete club:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete club');
    } finally {
      setIsDeleting(false);
      setShowDeleteModal(false);
    }
  };

  if (loading) {
    return (
      <div className="club-settings-page">
        <PageSkeleton variant="settings" />
      </div>
    );
  }

  return (
    <div className="club-settings-page">
      <div className="settings-content">
        {/* Basic Info */}
        <section className="settings-section">
          <h3>Basic Information</h3>
          <div className="form-group">
            <label>Club Name</label>
            <input
              type="text"
              value={settings.name}
              onChange={(e) => updateSetting('name', e.target.value)}
              disabled={!isOwner}
            />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea
              value={settings.description}
              onChange={(e) => updateSetting('description', e.target.value)}
              rows={3}
              disabled={!isOwner}
            />
          </div>
        </section>

        {/* Privacy */}
        <section className="settings-section">
          <h3>Privacy</h3>
          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-label">Public Club</span>
              <span className="toggle-desc">Anyone can find and request to join</span>
            </div>
            <button
              className={`toggle-btn ${settings.is_public ? 'on' : ''}`}
              onClick={() => updateSetting('is_public', !settings.is_public)}
              disabled={!isOwner}
            >
              {settings.is_public ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-label">Require Approval</span>
              <span className="toggle-desc">Manually approve new members</span>
            </div>
            <button
              className={`toggle-btn ${settings.requires_approval ? 'on' : ''}`}
              onClick={() => updateSetting('requires_approval', !settings.requires_approval)}
              disabled={!isOwner}
            >
              {settings.requires_approval ? 'ON' : 'OFF'}
            </button>
          </div>
        </section>

        {/* Game Rules */}
        <section className="settings-section">
          <h3>Game Rules</h3>
          <div className="form-group">
            <label>Default Rake (%)</label>
            <input
              type="number"
              value={settings.default_rake_percent}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                updateSetting('default_rake_percent', isNaN(val) ? 0 : val);
              }}
              min={0}
              max={10}
              step={0.5}
              disabled={!isOwner}
            />
          </div>
          <div className="form-group">
            <label>Rake Cap (BB)</label>
            <input
              type="number"
              value={settings.rake_cap}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                updateSetting('rake_cap', isNaN(val) ? 0 : val);
              }}
              min={1}
              max={10}
              step={0.5}
              disabled={!isOwner}
            />
          </div>
          <div className="form-group">
            <label>Time Bank (seconds)</label>
            <input
              type="number"
              value={settings.time_bank_seconds}
              onChange={(e) => updateSetting('time_bank_seconds', parseInt(e.target.value) || 0)}
              min={15}
              max={120}
              disabled={!isOwner}
            />
          </div>
          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-label">Allow Straddle</span>
            </div>
            <button
              className={`toggle-btn ${settings.allow_straddle ? 'on' : ''}`}
              onClick={() => updateSetting('allow_straddle', !settings.allow_straddle)}
              disabled={!isOwner}
            >
              {settings.allow_straddle ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-label">Run It Twice</span>
            </div>
            <button
              className={`toggle-btn ${settings.allow_run_it_twice ? 'on' : ''}`}
              onClick={() => updateSetting('allow_run_it_twice', !settings.allow_run_it_twice)}
              disabled={!isOwner}
            >
              {settings.allow_run_it_twice ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-label">Rabbit Hunt</span>
            </div>
            <button
              className={`toggle-btn ${settings.allow_rabbit_hunt ? 'on' : ''}`}
              onClick={() => updateSetting('allow_rabbit_hunt', !settings.allow_rabbit_hunt)}
              disabled={!isOwner}
            >
              {settings.allow_rabbit_hunt ? 'ON' : 'OFF'}
            </button>
          </div>
        </section>

        {/* Buy-in Limits */}
        <section className="settings-section">
          <h3>Buy-in Limits</h3>
          <div className="form-row">
            <div className="form-group">
              <label>Min (BB)</label>
              <input
                type="number"
                value={settings.min_buyin_bb}
                onChange={(e) => updateSetting('min_buyin_bb', parseInt(e.target.value) || 0)}
                min={20}
                max={100}
                disabled={!isOwner}
              />
            </div>
            <div className="form-group">
              <label>Max (BB)</label>
              <input
                type="number"
                value={settings.max_buyin_bb}
                onChange={(e) => updateSetting('max_buyin_bb', parseInt(e.target.value) || 0)}
                min={100}
                max={1000}
                disabled={!isOwner}
              />
            </div>
          </div>
        </section>

        {/* Audit Log - Admin Activity */}
        {isOwner && clubId && (
          <section className="settings-section audit-section">
            <h3>Admin Activity Log</h3>
            <AuditLog clubId={clubId} />
          </section>
        )}

        {/* Data Export - Owner Only */}
        {isOwner && (
          <section className="settings-section export-section">
            <h3>📊 Data Export</h3>
            <div className="export-item">
              <div className="export-info">
                <span className="export-label">Export Club Stats</span>
                <span className="export-desc">
                  Download player stats, hand histories, and club analytics.
                </span>
              </div>
              <button className="btn btn-secondary" onClick={() => setShowStatsExport(true)}>
                📥 Export Stats
              </button>
            </div>
          </section>
        )}

        {/* Danger Zone - Owner Only */}
        {isOwner && (
          <section className="settings-section danger-zone">
            <h3> Danger Zone</h3>
            <div className="danger-item">
              <div className="danger-info">
                <span className="danger-label">Delete this club</span>
                <span className="danger-desc">
                  Once deleted, all club data, members, and tables will be permanently removed.
                </span>
              </div>
              <button className="btn btn-danger" onClick={() => setShowDeleteModal(true)}>
                Delete Club
              </button>
            </div>
          </section>
        )}

        {isOwner && (
          <button className="btn btn-primary save-btn" onClick={saveSettings} disabled={saving}>
            {saving ? (
              <>
                <span className="btn-spinner" /> Saving...
              </>
            ) : (
              'Save Changes'
            )}
          </button>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="modal-content delete-modal" onClick={(e) => e.stopPropagation()}>
            <h3> Delete Club</h3>
            <p>
              This action <strong>cannot be undone</strong>. This will permanently delete the club{' '}
              <strong>{settings.name}</strong> and remove all members.
            </p>
            <div className="form-group">
              <label>Type the club name to confirm:</label>
              <input
                type="text"
                placeholder={settings.name}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowDeleteModal(false);
                  setConfirmText('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDeleteClub}
                disabled={confirmText !== settings.name || isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete Club'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats Export Modal */}
      <StatsExport
        clubId={clubId}
        isOpen={showStatsExport}
        onClose={() => setShowStatsExport(false)}
      />

      {/* Live Preview: Unsaved Changes Bar */}
      {hasUnsavedChanges && isOwner && (
        <div
          style={{
            position: 'fixed',
            bottom: clubId ? 72 : 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 999,
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.75rem 1.5rem',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, rgba(0, 212, 255, 0.15), rgba(139, 92, 246, 0.1))',
            border: '1px solid rgba(0, 212, 255, 0.3)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 0 15px rgba(0, 212, 255, 0.2)',
            animation: 'slideUpFade 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            maxWidth: '90vw',
          }}
        >
          <span
            style={{ color: '#00d4ff', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            {changedFields.length} unsaved change{changedFields.length > 1 ? 's' : ''}
          </span>
          <span
            style={{
              color: '#6a7a8a',
              fontSize: '0.7rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '200px',
            }}
          >
            {changedFields.join(', ')}
          </span>
          <button
            onClick={() => {
              if (originalSettings.current) setSettings({ ...originalSettings.current });
            }}
            style={{
              padding: '0.4rem 0.8rem',
              background: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              color: '#aaa',
              fontSize: '0.75rem',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Discard
          </button>
          <button
            onClick={saveSettings}
            disabled={saving}
            style={{
              padding: '0.4rem 1rem',
              background: 'linear-gradient(135deg, #00d4ff, #0099cc)',
              border: 'none',
              borderRadius: '8px',
              color: '#000',
              fontWeight: 700,
              fontSize: '0.75rem',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}
