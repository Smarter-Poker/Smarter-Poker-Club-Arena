/**
 *  CLUB SETTINGS PAGE — Club Configuration
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { retryFetch } from '../utils/retryFetch';
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
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import '../components/common/ButtonSpinner.css';
import './ClubSettingsPage.css';
import { reportError } from '../utils/errorReporter';
import { MAX_RAKE_CAP_BB, MAX_RAKE_PERCENT, RAKE_INHERIT } from '../config/RakeConfig';

// Buy-in bounds, in big blinds. A table cannot be seated below one big blind,
// and 1000 BB is the deepest stack the lobby renders sanely.
const BUYIN_BB_FLOOR = 1;
const BUYIN_BB_CEILING = 1000;

interface ClubSettings {
  name: string;
  description: string;
  is_public: boolean;
  requires_approval: boolean;
  default_rake_percent: number;
  rake_cap: number;
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
    default_rake_percent: RAKE_INHERIT,
    rake_cap: RAKE_INHERIT,
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
  // Bumped every time originalSettings.current is reassigned. changedFields
  // reads a ref, so without this a silent rebaseline (tab focus, realtime)
  // left the unsaved-changes banner listing stale fields.
  const [baselineVersion, setBaselineVersion] = useState(0);

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
    if (settings.allow_straddle !== orig.allow_straddle) changes.push('Straddle');
    if (settings.allow_run_it_twice !== orig.allow_run_it_twice) changes.push('Run It Twice');
    if (settings.allow_rabbit_hunt !== orig.allow_rabbit_hunt) changes.push('Rabbit Hunt');
    if (settings.min_buyin_bb !== orig.min_buyin_bb) changes.push('Min Buy-in');
    if (settings.max_buyin_bb !== orig.max_buyin_bb) changes.push('Max Buy-in');
    return changes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, baselineVersion]);
  const hasUnsavedChanges = changedFields.length > 0;

  // Buy-in bounds were the one numeric pair with no guard at all. The min/max
  // attributes on a number input are advisory outside a submitting <form>, and
  // this page never submits one — so "max 10, min 5000" saved happily and every
  // table in the club then had an impossible buy-in range.
  const buyinError = (() => {
    const min = settings.min_buyin_bb;
    const max = settings.max_buyin_bb;
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Buy-in limits must be numbers.';
    if (min < BUYIN_BB_FLOOR) return `Minimum buy-in must be at least ${BUYIN_BB_FLOOR} BB.`;
    if (max > BUYIN_BB_CEILING) return `Maximum buy-in cannot exceed ${BUYIN_BB_CEILING} BB.`;
    if (max <= min) return 'Maximum buy-in must be greater than the minimum.';
    return null;
  })();

  // The loaders below run from timers, realtime callbacks and bus events. They
  // close over whatever `hasUnsavedChanges` was when the effect was created, so
  // they need a ref to read the CURRENT value.
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  // Set when a background refresh finds the server copy has moved while the
  // owner has unsaved edits. We keep the edits and say so, rather than silently
  // overwriting one or the other.
  const [serverChanged, setServerChanged] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showStatsExport, setShowStatsExport] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const [loadError, setLoadError] = useState(false);
  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between club settings ──
  // React Router reuses the component when only the clubId param changes.
  useEffect(() => {
    setSaving(false);
    setIsOwner(false);
    setUserRole('member');
    setShowDeleteModal(false);
    setShowStatsExport(false);
    setIsDeleting(false);
    setConfirmText('');
    setLoadError(false);
    setServerChanged(false);
    loadingRef.current = false;
    originalSettings.current = null;
  }, [clubId]);

  // Re-fetch settings when user tabs back (covers WS disconnect gap).
  // Silent: tabbing away and back must not replace the form with a skeleton,
  // and must not throw away edits the owner has not saved yet.
  useVisibilityRefresh(() => loadClubSettings(undefined, { silent: true }));

  // Warn before a reload/close with unsaved edits. The page already tracks
  // exactly which fields changed; it just never used that to stop the browser
  // from throwing them away.
  useEffect(() => {
    if (!hasUnsavedChanges || !isOwner) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges, isOwner]);

  // Keyboard shortcut: Ctrl+S to save settings
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isOwner && hasUnsavedChanges && !saving) saveSettings();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOwner, hasUnsavedChanges, saving]);

  useEffect(() => {
    let isMounted = true;
    if (clubId) loadClubSettings(() => isMounted);
    return () => {
      isMounted = false;
    };
    // user?.id: on a cold load the store hydrates async; the first fetch runs
    // with user=null, computes isOwner=false, and the owner sees a read-only
    // page. Re-run once the user id is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, user?.id]);

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
            if (isMounted) loadClubSettings(() => isMounted, { silent: true });
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'ClubSettingsPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[ClubSettingsPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[ClubSettingsPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // ── Bus Listeners: cross-page event reactivity (debounced, scoped by clubId) ──
  useEffect(() => {
    let isMounted = true;
    const handler = (evt?: any) => {
      // Handlers get the BusEvent envelope ({type, payload, timestamp}), not
      // the bare payload — reading .clubId off the envelope made this filter
      // a no-op and the page refetched on every club's events.
      const evtClubId = evt?.payload?.clubId ?? evt?.clubId;
      if (evtClubId && evtClubId !== clubId) return;
      if (isMounted) loadClubSettings(() => isMounted, { silent: true });
    };
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', handler, 500),
      masterBus.subscribeDebounced('CLUB_LEFT', handler, 500),
      masterBus.subscribeDebounced('CLUB_UPDATED', handler, 500),
      masterBus.subscribeDebounced('CLUB_SETTINGS_UPDATED', handler, 500),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, [clubId]);

  const loadClubSettings = async (
    getIsMounted?: () => boolean,
    opts?: { silent?: boolean; force?: boolean }
  ) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadError(false);
    // silent = a background refresh (tab focus, realtime, bus). It must not
    // tear the rendered form down to a skeleton.
    if (!opts?.silent && (!getIsMounted || getIsMounted())) setLoading(true);
    try {
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId!);
      const data = await retryFetch(
        () =>
          supabase
            .from('clubs')
            .select(
              'id, owner_id, name, description, is_public, requires_approval, default_rake_percent, rake_cap, allow_straddle, allow_run_it_twice, allow_rabbit_hunt, min_buyin_bb, max_buyin_bb'
            )
            .eq(clubCol, clubVal)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            }),
        { maxRetries: 2 }
      );

      if (getIsMounted && !getIsMounted()) return;
      if (data) {
        // One mapping, used for both the form and the diff baseline. These were
        // two hand-written copies of the same twelve lines; they had already
        // drifted once and would again.
        // ?? not ||: 0 is a legitimate value for every numeric field here, and
        // || quietly turned "no minimum" into 40.
        const fromServer: ClubSettings = {
          name: data.name || '',
          description: data.description || '',
          is_public: data.is_public ?? true,
          requires_approval: data.requires_approval ?? false,
          default_rake_percent: data.default_rake_percent ?? RAKE_INHERIT,
          rake_cap: data.rake_cap ?? RAKE_INHERIT,
          allow_straddle: data.allow_straddle ?? true,
          allow_run_it_twice: data.allow_run_it_twice ?? true,
          allow_rabbit_hunt: data.allow_rabbit_hunt ?? true,
          min_buyin_bb: data.min_buyin_bb ?? 40,
          max_buyin_bb: data.max_buyin_bb ?? 200,
        };

        // A background refresh must never overwrite edits the owner has typed
        // and not saved. Three paths land here without the user asking —
        // tab-focus, the realtime UPDATE subscription, and four bus events —
        // and every one of them used to call setSettings() unconditionally.
        // The page even renders an "N unsaved changes" banner while doing it.
        const wouldDiscardEdits = !opts?.force && hasUnsavedChangesRef.current;
        if (wouldDiscardEdits) {
          const serverMoved = JSON.stringify(fromServer) !== JSON.stringify(originalSettings.current);
          // Re-baseline so the change list stays honest about what the save
          // would actually alter, and tell the owner the server copy moved.
          originalSettings.current = fromServer;
          setBaselineVersion((v) => v + 1);
          if (serverMoved) setServerChanged(true);
        } else {
          setSettings(fromServer);
          originalSettings.current = fromServer;
          setBaselineVersion((v) => v + 1);
          setServerChanged(false);
        }
        const ownerMatch = data.owner_id === user?.id;
        setIsOwner(ownerMatch);
        if (ownerMatch) {
          setUserRole('owner');
        } else if (user?.id) {
          // Fetch actual role from club_members
          try {
            const { data: membership } = await supabase
              .from('club_members')
              .select('role')
              .eq('club_id', data.id)
              .eq('user_id', user.id)
              .maybeSingle();
            if (getIsMounted && !getIsMounted()) return;
            if (membership?.role) {
              setUserRole(membership.role as 'owner' | 'admin' | 'agent' | 'member');
            }
          } catch (e) {
            reportError(e, 'ClubSettingsPage');
            /* non-critical */
          }
        }
      }
    } catch (error) {
      reportError(error, 'ClubSettingsPage.Failed_to_load_club_settings');
      setLoadError(true);
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load club settings');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  const saveSettings = async () => {
    if (!isOwner) return;
    if (buyinError) {
      toast.error(buyinError);
      return;
    }
    // Sanitize ONCE and use the result for the DB write, the local state and
    // the diff baseline. Sanitizing only inside the update payload meant the
    // server held the stripped copy while the baseline held the raw one — the
    // next background refresh then flagged your own save as a foreign edit.
    const toSave: ClubSettings = {
      ...settings,
      name: sanitizeInput(settings.name),
      description: sanitizeInput(settings.description),
    };
    setSaving(true);
    try {
      // Phase 13: Optimistic save — emit events instantly, then confirm with server
      await masterBus.executeOptimistic(
        'SETTINGS_UPDATED',
        { settings: { clubId, ...toSave } },
        async () => {
          if (clubId) masterBus.emit('CLUB_UPDATED', { clubId });
          if (clubId) masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId });
          const { error } = await supabase
            .from('clubs')
            .update({
              name: toSave.name,
              description: toSave.description,
              is_public: toSave.is_public,
              requires_approval: toSave.requires_approval,
              default_rake_percent: toSave.default_rake_percent,
              rake_cap: toSave.rake_cap,
              allow_straddle: toSave.allow_straddle,
              allow_run_it_twice: toSave.allow_run_it_twice,
              allow_rabbit_hunt: toSave.allow_rabbit_hunt,
              min_buyin_bb: toSave.min_buyin_bb,
              max_buyin_bb: toSave.max_buyin_bb,
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
      // Reset the diff baseline to what the server now holds, and clear any
      // conflict banner our own save raced into existence. Stay on the page:
      // navigating away hid the audit log entry the save just created.
      setSettings(toSave);
      originalSettings.current = { ...toSave };
      setBaselineVersion((v) => v + 1);
      setServerChanged(false);
    } catch (error) {
      reportError(error, 'ClubSettingsPage.Failed_to_save_settings');
      toast.error('Failed to save settings');
    }
    setSaving(false);
  };

  const updateSetting = <K extends keyof ClubSettings>(key: K, value: ClubSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleDeleteClub = async () => {
    if (!clubId || confirmText.trim() !== settings.name.trim()) return;

    setIsDeleting(true);
    try {
      await ClubsService.delete(clubId);
      toast.success('Club deleted successfully');
      navigate('/clubs');
    } catch (error: unknown) {
      reportError(error, 'ClubSettingsPage.Failed_to_delete_club');
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

  if (loadError && !loading) {
    return (
      <div className="club-settings-page">
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Failed to load settings</p>
          <button
            onClick={() => loadClubSettings(undefined, { force: true })}
            style={{
              padding: '10px 24px',
              borderRadius: '8px',
              background: 'var(--accent-blue, #3b82f6)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.95rem',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
        {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
      </div>
    );
  }

  return (
    <div className="club-settings-page">
      <div className="settings-content">
        {/* Non-owners used to get a page of silently disabled inputs with no
            explanation — every control looked broken. Say why, once. */}
        {!isOwner && (
          <div
            role="note"
            style={{
              padding: '10px 14px',
              marginBottom: '16px',
              borderRadius: '10px',
              background: 'rgba(0, 212, 255, 0.08)',
              border: '1px solid rgba(0, 212, 255, 0.25)',
              color: '#8fb8cc',
              fontSize: '0.85rem',
            }}
          >
            Read-only view. Only the club owner can change these settings.
          </div>
        )}
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
              maxLength={50}
            />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea
              value={settings.description}
              onChange={(e) => updateSetting('description', e.target.value)}
              rows={3}
              disabled={!isOwner}
              maxLength={500}
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
          {/* 2026-08-18: these two are real now. They used to persist to
              clubs.default_rake_percent / clubs.rake_cap and be read by
              nothing — the engine took 10% with a fixed cash cap whatever an
              owner set here.

              Empty = "Use the house schedule" and is stored as the -1 sentinel,
              because 0 is a legitimate setting (a rake-free club) and could not
              double as "unset". The clamp below is a courtesy: min/max on a
              number input are only enforced by form validation, which does not
              run here, so the previous handler happily saved 500. The real
              guard is server-side in getFullRakeConfig, since any club admin
              can UPDATE this row directly through RLS. */}
          <div className="form-group">
            <label>Default Rake (%)</label>
            <input
              type="number"
              placeholder="Use house schedule"
              value={settings.default_rake_percent < 0 ? '' : settings.default_rake_percent}
              onChange={(e) => {
                if (e.target.value === '') {
                  updateSetting('default_rake_percent', RAKE_INHERIT);
                  return;
                }
                const val = parseFloat(e.target.value);
                updateSetting(
                  'default_rake_percent',
                  isNaN(val) ? RAKE_INHERIT : Math.min(MAX_RAKE_PERCENT, Math.max(0, val))
                );
              }}
              min={0}
              max={MAX_RAKE_PERCENT}
              step={0.5}
              disabled={!isOwner}
            />
            <small className="form-hint">
              Leave blank to use the house schedule (10%). A club can take less, never more.
            </small>
          </div>
          <div className="form-group">
            <label>Rake Cap (BB)</label>
            <input
              type="number"
              placeholder="Use house schedule"
              value={settings.rake_cap < 0 ? '' : settings.rake_cap}
              onChange={(e) => {
                if (e.target.value === '') {
                  updateSetting('rake_cap', RAKE_INHERIT);
                  return;
                }
                const val = parseFloat(e.target.value);
                updateSetting(
                  'rake_cap',
                  isNaN(val) ? RAKE_INHERIT : Math.min(MAX_RAKE_CAP_BB, Math.max(0, val))
                );
              }}
              min={0}
              max={MAX_RAKE_CAP_BB}
              step={0.5}
              disabled={!isOwner}
            />
            <small className="form-hint">
              Most that can be raked from one pot, in big blinds. Blank uses the house cap for each
              stake ($3–$20 depending on blinds).
            </small>
          </div>
          {/* 2026-08-18: the "Time Bank (seconds)" field was removed. It
              persisted to clubs.time_bank_seconds, which no engine code has
              ever read — an owner could set it to 15 or to 120 and every table
              behaved identically. A time bank is a flat 20-second grant, 2 per
              street (Bible V8 s6.2); there is nothing per-club left to set. */}
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
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  updateSetting(
                    'min_buyin_bb',
                    isNaN(val) ? BUYIN_BB_FLOOR : Math.min(BUYIN_BB_CEILING, Math.max(BUYIN_BB_FLOOR, val))
                  );
                }}
                min={BUYIN_BB_FLOOR}
                max={BUYIN_BB_CEILING}
                disabled={!isOwner}
              />
            </div>
            <div className="form-group">
              <label>Max (BB)</label>
              <input
                type="number"
                value={settings.max_buyin_bb}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  updateSetting(
                    'max_buyin_bb',
                    isNaN(val) ? BUYIN_BB_CEILING : Math.min(BUYIN_BB_CEILING, Math.max(BUYIN_BB_FLOOR, val))
                  );
                }}
                min={BUYIN_BB_FLOOR}
                max={BUYIN_BB_CEILING}
                disabled={!isOwner}
              />
            </div>
          </div>
          {buyinError && (
            <small className="form-hint" role="alert" style={{ color: '#ff6b6b' }}>
              {buyinError}
            </small>
          )}
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
            <h3>Data Export</h3>
            <div className="export-item">
              <div className="export-info">
                <span className="export-label">Export Club Stats</span>
                <span className="export-desc">
                  Download player stats, hand histories, and club analytics.
                </span>
              </div>
              <button className="btn btn-secondary" onClick={() => setShowStatsExport(true)}>
                Export Stats
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
          <button
            className="btn btn-primary save-btn"
            onClick={saveSettings}
            disabled={saving || !hasUnsavedChanges}
            title={hasUnsavedChanges ? undefined : 'No changes to save'}
          >
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
                disabled={confirmText.trim() !== settings.name.trim() || isDeleting}
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

      {/* Someone else saved this club while you were editing */}
      {serverChanged && isOwner && (
        <div
          role="status"
          style={{
            position: 'fixed',
            bottom: clubId ? 128 : 72,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 999,
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.6rem 1.2rem',
            borderRadius: '14px',
            background: 'rgba(255, 176, 32, 0.14)',
            border: '1px solid rgba(255, 176, 32, 0.35)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            maxWidth: '90vw',
          }}
        >
          <span style={{ color: '#ffb020', fontSize: '0.75rem', fontWeight: 600 }}>
            These settings changed elsewhere
          </span>
          <span style={{ color: '#6a7a8a', fontSize: '0.7rem' }}>
            Your edits are still here. Saving overwrites the newer values.
          </span>
          <button
            onClick={() => {
              setServerChanged(false);
              loadClubSettings(undefined, { force: true });
            }}
            style={{
              padding: '0.35rem 0.75rem',
              background: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              borderRadius: '8px',
              color: '#ddd',
              fontSize: '0.7rem',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Load theirs
          </button>
        </div>
      )}

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
            disabled={saving || !!buyinError}
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
