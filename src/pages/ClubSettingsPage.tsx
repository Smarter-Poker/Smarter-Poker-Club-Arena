/**
 *  CLUB SETTINGS PAGE — Club Configuration
 */

import { useState, useEffect, useRef, useMemo, type ChangeEvent } from 'react';
import type { ClubRole } from '../types/clubRoles';
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
import {
  MAX_RAKE_CAP_BB,
  MAX_RAKE_PERCENT,
  RAKE_INHERIT,
  getRakeConfig,
} from '../config/RakeConfig';
import {
  BUYIN_BB_CEILING,
  BUYIN_BB_FLOOR,
  CLUB_NAME_MAX,
  WATCHED_COLUMNS,
  type ClubDeletionImpact,
  blockingDeletionReason,
  clubAssetPathFromPublicUrl,
  clampBuyin,
  privateClubNeedsApproval,
  sanitizationWouldAlter,
  validateBuyinRange,
  validateClubName,
} from '../utils/clubSettingsRules';

const DESCRIPTION_MAX = 500;

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
  // Read-only club identity shown in Basic Information.
  const [clubCode, setClubCode] = useState<number | null>(null);
  // Logo: current stored URL + a not-yet-saved local pick. The file is
  // uploaded only when Save runs, so the logo participates in the same
  // unsaved-changes / discard flow as every other field.
  const [currentLogoUrl, setCurrentLogoUrl] = useState<string | null>(null);
  const [pendingLogo, setPendingLogo] = useState<{ file: File; preview: string } | null>(null);

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
  const changedFieldsDisplay = pendingLogo ? [...changedFields, 'Logo'] : changedFields;
  // The delete confirmation must quote the club's SAVED name. It read the
  // live form value, so typing a new name without saving made the modal
  // demand the unsaved text — and the placeholder advertised a name the club
  // does not have.
  const savedClubName = originalSettings.current?.name ?? settings.name;
  const hasUnsavedChanges = changedFieldsDisplay.length > 0;

  // Buy-in bounds were the one numeric pair with no guard at all. The min/max
  // attributes on a number input are advisory outside a submitting <form>, and
  // this page never submits one — so "max 10, min 5000" saved happily and every
  // table in the club then had an impossible buy-in range.
  const buyinError = validateBuyinRange(settings.min_buyin_bb, settings.max_buyin_bb);
  // clubs.name is NOT NULL but has no CHECK against '', and this page had no
  // name validation at all — a blank name saved happily, leaving a nameless
  // club whose delete confirmation was armed by an empty box.
  const nameError = validateClubName(settings.name, sanitizeInput(settings.name));
  const formError = nameError || buyinError;

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
  // What a delete would actually destroy. tables and club_wallets are both
  // ON DELETE CASCADE from clubs, so the modal must show real numbers and
  // refuse while anything is live.
  const [deleteImpact, setDeleteImpact] = useState<ClubDeletionImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [showStatsExport, setShowStatsExport] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [userRole, setUserRole] = useState<ClubRole>('player');
  // Mirrors the audit_trail SELECT policies: owner, or is_club_admin() which
  // accepts role IN ('owner','admin','manager','agent').
  const canSeeAuditLog = isOwner || userRole === 'admin' || userRole === 'agent';
  const deleteBlockedReason = deleteImpact ? blockingDeletionReason(deleteImpact) : null;

  // What the Rake Cap setting actually means in money, at two reference
  // stakes. Derived from getRakeConfig — the same function the engine mirrors —
  // because a local `capBB * bb` cannot see the published ceiling. Before this,
  // the hint promised "$20.00 per pot at 1/2" for a 10 BB cap while the engine
  // would take $5.
  const capPreview = (() => {
    if (settings.rake_cap < 0) return null;
    const at = (sb: number, bb: number) =>
      getRakeConfig(bb, 'nlh', sb, { rakeCapBB: settings.rake_cap }).rakeCap;
    const low = at(1, 2);
    const high = at(5, 10);
    const uncappedLow = Math.round(settings.rake_cap * 2 * 100) / 100;
    const uncappedHigh = Math.round(settings.rake_cap * 10 * 100) / 100;
    const limited = uncappedLow > low || uncappedHigh > high;
    return `Currently ${settings.rake_cap} BB - $${low.toFixed(2)} per pot at 1/2 and $${high.toFixed(
      2
    )} at 5/10${limited ? ', held down by the house cap for those stakes.' : '.'}`;
  })();
  const [loadError, setLoadError] = useState(false);
  // A club id that resolves to no row (deleted club, bad code, or a club RLS
  // hides) used to fall straight through the `if (data)` block: no error, no
  // state change, loading -> false. The page then rendered a fully blank,
  // editable settings form for a club that does not exist.
  const [notFound, setNotFound] = useState(false);
  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between club settings ──
  // React Router reuses the component when only the clubId param changes.
  useEffect(() => {
    setSaving(false);
    setIsOwner(false);
    setUserRole('player');
    setShowDeleteModal(false);
    setDeleteImpact(null);
    setImpactLoading(false);
    setShowStatsExport(false);
    setIsDeleting(false);
    setConfirmText('');
    setLoadError(false);
    setNotFound(false);
    setServerChanged(false);
    setClubCode(null);
    setCurrentLogoUrl(null);
    setPendingLogo((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return null;
    });
    loadingRef.current = false;
    originalSettings.current = null;
  }, [clubId]);

  // Release the pending-logo blob URL when the page goes away. The per-club
  // reset and the save/discard paths revoke it, but plain unmount did not.
  const pendingLogoRef = useRef<{ file: File; preview: string } | null>(null);
  // Path of the object uploaded during the in-flight save, so the catch block
  // can clean it up if the row update fails.
  const uploadedPathRef = useRef<string | null>(null);
  const currentLogoUrlRef = useRef<string | null>(null);
  useEffect(() => {
    pendingLogoRef.current = pendingLogo;
  }, [pendingLogo]);
  useEffect(() => {
    currentLogoUrlRef.current = currentLogoUrl;
  }, [currentLogoUrl]);
  useEffect(
    () => () => {
      if (pendingLogoRef.current) URL.revokeObjectURL(pendingLogoRef.current.preview);
    },
    []
  );

  // Re-fetch settings when user tabs back (covers WS disconnect gap).
  // Silent: tabbing away and back must not replace the form with a skeleton,
  // and must not throw away edits the owner has not saved yet.
  useVisibilityRefresh(() => loadClubSettings(undefined, { silent: true }));

  // In-app navigation loses edits silently. beforeunload only covers a reload
  // or a tab close; clicking the bottom nav is a React Router <Link>, which
  // never fires it. This app mounts <BrowserRouter>, not a data router, so
  // useBlocker() is unavailable — intercept the anchor click instead, in the
  // capture phase, and only while there is something to lose.
  useEffect(() => {
    if (!hasUnsavedChanges || !isOwner) return;
    const onClickCapture = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const anchor = (e.target as HTMLElement | null)?.closest?.(
        'a[href]'
      ) as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return; // in-page anchor, not a navigation
      let dest: URL;
      try {
        dest = new URL(anchor.href, window.location.href);
      } catch {
        return; // unparseable (mailto:, tel:, javascript:) — not our business
      }
      // Leaving the origin is already covered by the beforeunload handler.
      if (dest.origin !== window.location.origin) return;
      if (dest.pathname === window.location.pathname) return; // same page
      if (!window.confirm('You have unsaved settings changes. Leave this page and discard them?')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, [hasUnsavedChanges, isOwner]);

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
        if (isOwner && hasUnsavedChanges && !saving && !formError) saveSettings();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOwner, hasUnsavedChanges, saving, formError]);

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
          (payload: { new?: Record<string, unknown> }) => {
            if (!isMounted) return;
            // clubs rows are rewritten on hot paths — chip_pool by the rake
            // waterfall, member_count by the membership sync trigger — so an
            // unfiltered UPDATE subscription refetched this page continuously
            // on a busy club. Only react when a column this page shows moved.
            const next = payload?.new;
            if (next && originalSettings.current) {
              const base = originalSettings.current as unknown as Record<string, unknown>;
              const touched = WATCHED_COLUMNS.some(
                (k) => k in next && String(next[k]) !== String(base[k])
              );
              const logoTouched =
                'logo_url' in next &&
                (next.logo_url ?? null) !== (currentLogoUrlRef.current ?? null);
              if (!touched && !logoTouched) return;
            }
            loadClubSettings(() => isMounted, { silent: true });
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
    setNotFound(false);
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
              'id, owner_id, club_id, logo_url, name, description, is_public, requires_approval, default_rake_percent, rake_cap, allow_straddle, allow_run_it_twice, allow_rabbit_hunt, min_buyin_bb, max_buyin_bb'
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
        setClubCode(typeof data.club_id === 'number' ? data.club_id : null);
        setCurrentLogoUrl(data.logo_url || null);
        const wouldDiscardEdits = !opts?.force && hasUnsavedChangesRef.current;
        if (wouldDiscardEdits) {
          const serverMoved =
            JSON.stringify(fromServer) !== JSON.stringify(originalSettings.current);
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
              setUserRole(membership.role as ClubRole);
            }
          } catch (e) {
            reportError(e, 'ClubSettingsPage');
            /* non-critical */
          }
        }
      } else if (!getIsMounted || getIsMounted()) {
        setNotFound(true);
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
    if (formError) {
      toast.error(formError);
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
      // Upload the pending logo first so the row update carries its URL.
      // The club-assets bucket caps files at 2 MB / images only server-side.
      let newLogoUrl: string | null = null;
      if (pendingLogo) {
        const resolvedId = await resolveClubUUID(clubId!);
        const ext = pendingLogo.file.type.includes('png')
          ? 'png'
          : pendingLogo.file.type.includes('webp')
            ? 'webp'
            : pendingLogo.file.type.includes('gif')
              ? 'gif'
              : 'jpg';
        const path = `club-logos/${resolvedId}-${Date.now()}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('club-assets')
          .upload(path, pendingLogo.file, { contentType: pendingLogo.file.type });
        if (uploadErr) throw uploadErr;
        uploadedPathRef.current = path;
        newLogoUrl =
          supabase.storage.from('club-assets').getPublicUrl(path).data?.publicUrl || null;
      }
      // Phase 13: Optimistic save — emit events instantly, then confirm with server
      await masterBus.executeOptimistic(
        'SETTINGS_UPDATED',
        { settings: { clubId, ...toSave } },
        async () => {
          if (clubId) masterBus.emit('CLUB_UPDATED', { clubId });
          if (clubId) masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId });
          const { data: updated, error } = await supabase
            .from('clubs')
            .update({
              ...(newLogoUrl ? { logo_url: newLogoUrl } : {}),
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
            .eq(resolveClubIdFilter(clubId!).column, resolveClubIdFilter(clubId!).value)
            // .select() is what makes a rejected write observable. Without it
            // an UPDATE matching zero rows — RLS denied it, ownership moved,
            // the club was deleted — returns no error at all, and the page
            // cheerfully reported "Settings saved!" while nothing had been.
            // Verified against production: a non-owner UPDATE returns 0 rows
            // and no error.
            .select('id');
          if (error) throw error;
          if (!updated || updated.length === 0) {
            throw new Error(
              'Settings were not saved - you may no longer own this club, or it no longer exists.'
            );
          }
        }
      );
      // Saving strips HTML. Silently changing what the owner typed and
      // showing a plain success toast made the edit look corrupted.
      if (
        sanitizationWouldAlter(settings.name, toSave.name) ||
        sanitizationWouldAlter(settings.description, toSave.description)
      ) {
        toast.success('Settings saved. Some formatting characters were removed.');
      } else {
        toast.success('Settings saved!');
      }
      masterBus.emit('ADMIN_ACTION', {
        action: 'settings_updated',
        target: clubId || '',
        details: { changedFields: changedFieldsDisplay },
        userId: user?.id,
      });
      if (newLogoUrl) {
        // The logo it replaced would otherwise sit in the bucket forever.
        // Best-effort: a failed cleanup must never fail a successful save.
        const stale = clubAssetPathFromPublicUrl(currentLogoUrl);
        if (stale) {
          await supabase.storage
            .from('club-assets')
            .remove([stale])
            .catch(() => undefined);
        }
        setCurrentLogoUrl(newLogoUrl);
      }
      setPendingLogo((prev) => {
        if (prev) URL.revokeObjectURL(prev.preview);
        return null;
      });
      // Reset the diff baseline to what the server now holds, and clear any
      // conflict banner our own save raced into existence. Stay on the page:
      // navigating away hid the audit log entry the save just created.
      setSettings(toSave);
      originalSettings.current = { ...toSave };
      setBaselineVersion((v) => v + 1);
      setServerChanged(false);
    } catch (error) {
      // The logo lands in storage before the row update. If the update then
      // fails, drop the object rather than leaving it orphaned in the bucket.
      if (uploadedPathRef.current) {
        await supabase.storage
          .from('club-assets')
          .remove([uploadedPathRef.current])
          .catch(() => undefined);
      }
      reportError(error, 'ClubSettingsPage.Failed_to_save_settings');
      toast.error(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      uploadedPathRef.current = null;
    }
    setSaving(false);
  };

  const updateSetting = <K extends keyof ClubSettings>(key: K, value: ClubSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const LOGO_MAX_BYTES = 2 * 1024 * 1024;

  const onLogoSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // same file can be re-picked after a discard
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      toast.error('Logo must be a PNG, JPG, WEBP or GIF image');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast.error('Logo must be 2 MB or smaller');
      return;
    }
    setPendingLogo((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return { file, preview: URL.createObjectURL(file) };
    });
  };

  /** Clearing the logo was impossible: it could be replaced but never removed. */
  const removeLogo = async () => {
    if (!isOwner || !clubId || !currentLogoUrl) return;
    setSaving(true);
    try {
      const { data: updated, error } = await supabase
        .from('clubs')
        .update({ logo_url: null })
        .eq(resolveClubIdFilter(clubId).column, resolveClubIdFilter(clubId).value)
        .select('id');
      if (error) throw error;
      if (!updated || updated.length === 0) {
        throw new Error('Logo was not removed - you may no longer own this club.');
      }
      const stale = clubAssetPathFromPublicUrl(currentLogoUrl);
      if (stale) {
        await supabase.storage
          .from('club-assets')
          .remove([stale])
          .catch(() => undefined);
      }
      setCurrentLogoUrl(null);
      toast.success('Logo removed');
      masterBus.emit('CLUB_UPDATED', { clubId });
    } catch (e) {
      reportError(e, 'ClubSettingsPage.Failed_to_remove_logo');
      toast.error(e instanceof Error ? e.message : 'Failed to remove logo');
    }
    setSaving(false);
  };

  const clearPendingLogo = () => {
    setPendingLogo((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return null;
    });
  };

  const copyClubCode = async () => {
    if (clubCode == null) return;
    try {
      await navigator.clipboard.writeText(String(clubCode));
      toast.success('Club code copied');
    } catch {
      toast.error('Could not copy - code is ' + String(clubCode));
    }
  };

  const loadDeleteImpact = async () => {
    if (!clubId) return;
    setImpactLoading(true);
    setDeleteImpact(null);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      // One authoritative read instead of three client queries. The previous
      // version asked club_wallets directly, and that table has RLS enabled
      // with NO policies — an owner's SELECT returns no rows rather than an
      // error, so the guard reported "0 chips" for every club while the wallet
      // was about to be destroyed by ON DELETE CASCADE. The RPC is
      // SECURITY DEFINER, owner-gated, and counts both balance columns.
      const { data, error } = await supabase.rpc('fn_club_deletion_impact', {
        p_club_id: resolvedId,
      });
      if (error) throw error;
      const impact = (data || {}) as {
        members?: number;
        running_tables?: number;
        wallet_chips?: number | string;
      };
      setDeleteImpact({
        members: Number(impact.members ?? 0),
        runningTables: Number(impact.running_tables ?? 0),
        walletChips: Number(impact.wallet_chips ?? 0),
      });
    } catch (e) {
      reportError(e, 'ClubSettingsPage.Failed_to_load_delete_impact');
      // Unknown impact must not read as "safe to delete".
      setDeleteImpact(null);
    } finally {
      setImpactLoading(false);
    }
  };

  const handleDeleteClub = async () => {
    if (!clubId || !savedClubName.trim() || confirmText.trim() !== savedClubName.trim()) return;
    // Belt and braces: the button is disabled for these cases, but a delete
    // that cascades 56 running tables deserves a second gate.
    if (!deleteImpact) {
      toast.error('Still checking what this would delete - try again in a moment.');
      return;
    }
    const blocked = blockingDeletionReason(deleteImpact);
    if (blocked) {
      toast.error(blocked);
      return;
    }

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

  // Without a club id nothing ever loads: the fetch effect is gated on
  // `clubId`, so `loading` stayed true and the page showed its skeleton
  // forever instead of saying what was wrong.
  if (!clubId) {
    return (
      <div className="club-settings-page">
        <div className="settings-empty-state">
          <p className="settings-empty-title">No Club Selected</p>
          <p className="settings-empty-desc">
            Open This Page From A Club So It Knows Which Settings To Show.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/clubs')}>
            Browse Clubs
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="club-settings-page">
        <PageSkeleton variant="settings" />
      </div>
    );
  }

  if (notFound && !loading) {
    return (
      <div className="club-settings-page">
        <div className="settings-empty-state">
          <p className="settings-empty-title">Club Not Found</p>
          <p className="settings-empty-desc">
            This Club Does Not Exist, Or It Is Private And You Are Not A Member.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/clubs')}>
            Browse Clubs
          </button>
        </div>
        <ClubBottomNav clubId={clubId} userRole={userRole} />
      </div>
    );
  }

  if (loadError && !loading) {
    return (
      <div className="club-settings-page">
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
          <p style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Failed To Load Settings</p>
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
            Read-Only View. Only The Club Owner Can Change These Settings.
          </div>
        )}
        {/* Basic Info */}
        {/* Role Management (Moved to Profile Tab conceptually as requested) */}
        {canSeeAuditLog && (
          <section className="settings-section">
            <h3>Role Management</h3>
            <p className="setting-description" style={{ marginBottom: 16 }}>
              Assign And Manage Roles For Your Club Members. Promote Players To Admin, Manager,
              Agent, Or Sub-Agent To Help Run The Club.
            </p>
            <button
              className="btn btn--primary"
              onClick={() => navigate(`/clubs/${clubId}/members`)}
              style={{ padding: '0 24px', height: '40px' }}
            >
              Assign Roles & Manage Players
            </button>
          </section>
        )}

        <section className="settings-section">
          <h3>Basic Information</h3>
          <div className="form-group">
            <label htmlFor="club-name">Club Name</label>
            <input
              id="club-name"
              type="text"
              value={settings.name}
              onChange={(e) => updateSetting('name', e.target.value)}
              disabled={!isOwner}
              maxLength={CLUB_NAME_MAX}
              aria-invalid={!!nameError}
              aria-describedby="club-name-hint"
            />
            <small
              id="club-name-hint"
              className="form-hint"
              role={nameError ? 'alert' : undefined}
              style={nameError ? { color: '#ff6b6b' } : undefined}
            >
              {nameError || `${settings.name.length}/${CLUB_NAME_MAX}`}
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="club-description">Description</label>
            <textarea
              id="club-description"
              value={settings.description}
              onChange={(e) => updateSetting('description', e.target.value)}
              rows={3}
              disabled={!isOwner}
              maxLength={DESCRIPTION_MAX}
              aria-describedby="club-description-hint"
            />
            <small id="club-description-hint" className="form-hint">
              {settings.description.length}/{DESCRIPTION_MAX}
            </small>
          </div>
          {clubCode != null && (
            <div className="form-group">
              <label>Club Code</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '1.1rem',
                    letterSpacing: '3px',
                    color: 'var(--text-primary, #e6edf3)',
                  }}
                >
                  {clubCode}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                  onClick={copyClubCode}
                  aria-label="Copy club code"
                >
                  Copy
                </button>
              </div>
              <small className="form-hint">
                Players Can Find And Join The Club With This Code.
              </small>
            </div>
          )}
          <div className="form-group">
            <label>Club Logo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {pendingLogo?.preview || currentLogoUrl ? (
                <img
                  src={pendingLogo?.preview || currentLogoUrl || undefined}
                  alt="Club logo"
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 12,
                    objectFit: 'cover',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px dashed rgba(255, 255, 255, 0.2)',
                    color: 'var(--text-secondary, #6a7a8a)',
                    fontSize: '0.65rem',
                  }}
                >
                  No Logo
                </div>
              )}
              {isOwner && (
                <label
                  className="btn btn-secondary"
                  style={{ cursor: 'pointer', padding: '6px 14px', fontSize: '0.8rem' }}
                >
                  {pendingLogo ? 'Change' : currentLogoUrl ? 'Replace' : 'Upload'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    style={{ display: 'none' }}
                    onChange={onLogoSelect}
                  />
                </label>
              )}
              {pendingLogo && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                  onClick={clearPendingLogo}
                >
                  Undo
                </button>
              )}
              {isOwner && !pendingLogo && currentLogoUrl && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                  onClick={removeLogo}
                  disabled={saving}
                >
                  Remove
                </button>
              )}
            </div>
            <small className="form-hint">
              PNG, JPG, WEBP Or GIF Up To 2 MB. Applied When You Save Changes.
            </small>
          </div>
        </section>

        {/* Privacy */}
        <section className="settings-section">
          <h3>Privacy</h3>
          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-label">Public Club</span>
              <span className="toggle-desc">Anyone Can Find And Request To Join</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.is_public}
              aria-label="Public Club"
              className={`toggle-btn ${settings.is_public ? 'on' : ''}`}
              onClick={() => {
                const nextPublic = !settings.is_public;
                // Going private also switches approval on, matching what club
                // creation already does (requires_approval = !isPublic).
                // Without it the club is merely hidden, not closed.
                setSettings((prev) => ({
                  ...prev,
                  is_public: nextPublic,
                  requires_approval: nextPublic ? prev.requires_approval : true,
                }));
              }}
              disabled={!isOwner}
            >
              {settings.is_public ? 'ON' : 'OFF'}
            </button>
          </div>
          {privateClubNeedsApproval(settings.is_public, settings.requires_approval) && (
            <small className="form-hint" role="alert" style={{ color: '#ffb020' }}>
              This Club Is Private But Admits Anyone Instantly. Private Only Hides The Club From
              Search - Joining Is Gated By Require Approval.
            </small>
          )}
          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-label">Require Approval</span>
              <span className="toggle-desc">Manually Approve New Members</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.requires_approval}
              aria-label="Require Approval"
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
            <label htmlFor="club-rake-percent">Default Rake (%)</label>
            <input
              id="club-rake-percent"
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
              Leave Blank To Use The House Schedule (10%). A Club Can Take Less, Never More.{' '}
              {settings.default_rake_percent < 0
                ? 'Currently: house schedule.'
                : `Currently: ${settings.default_rake_percent}% (house caps still apply).`}
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="club-rake-cap">Rake Cap (BB)</label>
            <input
              id="club-rake-cap"
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
              Most That Can Be Raked From One Pot, In Big Blinds. Blank Uses The House Cap For Each
              Stake ($3-$20 Depending On Blinds).{' '}
              {settings.rake_cap < 0 ? 'Currently: house cap.' : capPreview}
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
              type="button"
              role="switch"
              aria-checked={settings.allow_straddle}
              aria-label="Allow Straddle"
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
              type="button"
              role="switch"
              aria-checked={settings.allow_run_it_twice}
              aria-label="Run It Twice"
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
              type="button"
              role="switch"
              aria-checked={settings.allow_rabbit_hunt}
              aria-label="Rabbit Hunt"
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
          <h3>Buy-In Limits</h3>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="club-min-buyin">Min (BB)</label>
              <input
                type="number"
                id="club-min-buyin"
                value={Number.isFinite(settings.min_buyin_bb) ? settings.min_buyin_bb : ''}
                onChange={(e) => updateSetting('min_buyin_bb', parseInt(e.target.value, 10))}
                onBlur={() =>
                  updateSetting('min_buyin_bb', clampBuyin(settings.min_buyin_bb, BUYIN_BB_FLOOR))
                }
                min={BUYIN_BB_FLOOR}
                max={BUYIN_BB_CEILING}
                disabled={!isOwner}
              />
            </div>
            <div className="form-group">
              <label htmlFor="club-max-buyin">Max (BB)</label>
              <input
                type="number"
                id="club-max-buyin"
                value={Number.isFinite(settings.max_buyin_bb) ? settings.max_buyin_bb : ''}
                onChange={(e) => updateSetting('max_buyin_bb', parseInt(e.target.value, 10))}
                onBlur={() =>
                  updateSetting('max_buyin_bb', clampBuyin(settings.max_buyin_bb, BUYIN_BB_CEILING))
                }
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

        {/* Audit Log — visible to anyone the audit_trail RLS lets read it:
            the owner, plus club admins/agents via is_club_admin(). It was
            owner-only, so a staff member who could read the log never saw it. */}
        {canSeeAuditLog && clubId && (
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
                  Download The Member Roster With Lifetime Stats, Or Your Own Hand History For This
                  Club, As CSV Or JSON.
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
            <h3>Danger Zone</h3>
            <div className="danger-item">
              <div className="danger-info">
                <span className="danger-label">Delete This Club</span>
                <span className="danger-desc">
                  Once Deleted, All Club Data, Members, And Tables Will Be Permanently Removed.
                </span>
              </div>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setShowDeleteModal(true);
                  loadDeleteImpact();
                }}
              >
                Delete Club
              </button>
            </div>
          </section>
        )}

        {isOwner && (
          <button
            className="btn btn-primary save-btn"
            onClick={saveSettings}
            disabled={saving || !hasUnsavedChanges || !!formError}
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
            <h3>Delete Club</h3>
            <p>
              This Action <strong>Cannot Be Undone</strong>. This Will Permanently Delete The Club{' '}
              <strong>{savedClubName}</strong>.
            </p>
            {impactLoading && <p className="delete-impact">Checking What This Would Delete...</p>}
            {!impactLoading && deleteImpact && (
              <ul className="delete-impact">
                <li>{deleteImpact.members.toLocaleString()} Member Records</li>
                <li>
                  Every Table In This Club
                  {deleteImpact.runningTables > 0
                    ? `, including ${deleteImpact.runningTables} currently running`
                    : ' (none are running)'}
                </li>
                <li>Club Wallets Holding {deleteImpact.walletChips.toLocaleString()} Chips</li>
              </ul>
            )}
            {!impactLoading && !deleteImpact && (
              <p className="delete-impact delete-impact--blocked">
                Could Not Check What This Would Delete. Deletion Is Disabled Until That Check
                Succeeds.
              </p>
            )}
            {deleteBlockedReason && (
              <p className="delete-impact delete-impact--blocked" role="alert">
                {deleteBlockedReason}
              </p>
            )}
            <div className="form-group">
              <label htmlFor="confirm-club-name">Type The Club Name To Confirm:</label>
              <input
                id="confirm-club-name"
                type="text"
                placeholder={savedClubName}
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
                  setDeleteImpact(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDeleteClub}
                disabled={
                  !savedClubName.trim() ||
                  confirmText.trim() !== savedClubName.trim() ||
                  isDeleting ||
                  impactLoading ||
                  !deleteImpact ||
                  !!deleteBlockedReason
                }
                title={deleteBlockedReason || undefined}
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
            These Settings Changed Elsewhere
          </span>
          <span style={{ color: '#6a7a8a', fontSize: '0.7rem' }}>
            Your Edits Are Still Here. Saving Overwrites The Newer Values.
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
            Load Theirs
          </button>
        </div>
      )}

      {/* Live Preview: Unsaved Changes Bar */}
      {hasUnsavedChanges && isOwner && (
        <div className="unsaved-bar" role="status">
          <span className="unsaved-bar__count">
            {changedFieldsDisplay.length} Unsaved Change{changedFieldsDisplay.length > 1 ? 's' : ''}
          </span>
          <span className="unsaved-bar__fields" title={changedFieldsDisplay.join(', ')}>
            {changedFieldsDisplay.join(', ')}
          </span>
          <button
            type="button"
            className="unsaved-bar__discard"
            onClick={() => {
              if (originalSettings.current) setSettings({ ...originalSettings.current });
              clearPendingLogo();
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="unsaved-bar__save"
            onClick={saveSettings}
            disabled={saving || !!formError}
            title={formError || undefined}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}
