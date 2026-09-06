/**
 *  CLUB SETTINGS PAGE — Club Configuration
 */

import { useState, useEffect, useRef, useMemo, type ChangeEvent } from 'react';
import { isClubStaff, type ClubRole } from '../types/clubRoles';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { retryFetch } from '../utils/retryFetch';
import { masterBus } from '../core/MasterBus';
import { ClubsService } from '../services/ClubsService';
import { MembershipService } from '../services/MembershipService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import SpinActivationPanel from '../components/club/SpinActivationPanel';
import { sanitizeInput } from '../utils/sanitizeInput';
import PageSkeleton from '../components/common/PageSkeleton';
import AuditLog from '../components/admin/AuditLog';
import { StatsExport } from '../components/admin/StatsExport';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useIsMounted } from '../hooks/useIsMounted';
import '../components/common/ButtonSpinner.css';
import './ClubSettingsPage.css';

/**
 * The handover picker shows each candidate's current role so the owner is not
 * choosing from a list of bare names. Title Cased at the source, like every
 * other label the estate renders.
 */
/** The membership states transfer_club_ownership accepts as a recipient. */
const HANDOVER_ELIGIBLE_STATUSES = new Set(['active', 'approved']);

function roleLabelForHandover(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'co_owner':
      return 'Co Owner';
    case 'admin':
      return 'Admin';
    case 'manager':
      return 'Manager';
    case 'super_agent':
      return 'Super Agent';
    case 'agent':
      return 'Agent';
    case 'sub_agent':
      return 'Sub Agent';
    default:
      return 'Player';
  }
}
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { SHARK_CLUB_ID } from '../lib/constants';
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
  type ClubRetirementImpact,
  blockingRetirementReason,
  clubAssetPathFromPublicUrl,
  clampBuyin,
  privateClubNeedsApproval,
  sanitizationWouldAlter,
  validateBuyinRange,
  validateClubName,
} from '../utils/clubSettingsRules';

const DESCRIPTION_MAX = 500;
const TAGLINE_MAX = 72;
/* Dan 2026-09-01: the club's custom / day's message, printed at the top of the
   lobby rail. Same 240-character cap `fn_set_club_lobby_message` enforces. */
const LOBBY_MESSAGE_MAX = 240;

interface ClubSettings {
  name: string;
  description: string;
  tagline: string;
  lobby_message: string;
  is_public: boolean;
  requires_approval: boolean;
  default_rake_percent: number;
  rake_cap: number;
  spins_enabled: boolean;
}

export default function ClubSettingsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const { user } = useAuthUser();
  const toast = useToast();

  const [playerNumber, setPlayerNumber] = useState<number | null>(null);
  const [inUnion, setInUnion] = useState<boolean>(false);
  const [clubNumericId, setClubNumericId] = useState<number | null>(null);
  const [settings, setSettings] = useState<ClubSettings>({
    name: '',
    description: '',
    tagline: '',
    lobby_message: '',
    is_public: true,
    requires_approval: false,
    default_rake_percent: RAKE_INHERIT,
    rake_cap: RAKE_INHERIT,
    spins_enabled: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  /**
   * The two rake fields are held as RAW TEXT while the owner types and only
   * parsed/clamped on blur. See the onBlur handlers for why: clamping a
   * controlled number input on every keystroke makes a decimal impossible to
   * enter, and turns "0.5" into 5.
   */
  const [rakePercentText, setRakePercentText] = useState('');
  const [rakeCapText, setRakeCapText] = useState('');
  // Keep the text in step whenever the settings change from anywhere other
  // than typing (load, realtime, discard, "load theirs").
  useEffect(() => {
    setRakePercentText(
      settings.default_rake_percent < 0 ? '' : String(settings.default_rake_percent)
    );
  }, [settings.default_rake_percent]);
  useEffect(() => {
    setRakeCapText(settings.rake_cap < 0 ? '' : String(settings.rake_cap));
  }, [settings.rake_cap]);
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
    if (settings.tagline !== orig.tagline) changes.push('Tag Line');
    if (settings.lobby_message !== orig.lobby_message) changes.push('Club Message');
    if (settings.is_public !== orig.is_public) changes.push('Public');
    if (settings.requires_approval !== orig.requires_approval) changes.push('Approval');
    if (settings.default_rake_percent !== orig.default_rake_percent) changes.push('Rake %');
    if (settings.rake_cap !== orig.rake_cap) changes.push('Rake Cap');
    return changes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, baselineVersion]);
  const changedFieldsDisplay = pendingLogo ? [...changedFields, 'Logo'] : changedFields;
  // The retirement confirmation must quote the club's SAVED name. It read the
  // live form value, so typing a new name without saving made the modal
  // demand the unsaved text — and the placeholder advertised a name the club
  // does not have.
  const savedClubName = originalSettings.current?.name ?? settings.name;
  const hasUnsavedChanges = changedFieldsDisplay.length > 0;

  // Buy-in bounds were the one numeric pair with no guard at all. The min/max
  // attributes on a number input are advisory outside a submitting <form>, and
  // this page never submits one — so "max 10, min 5000" saved happily and every
  // table in the club then had an impossible buy-in range.
  const buyinError = '';
  // clubs.name is NOT NULL but has no CHECK against '', and this page had no
  // name validation at all — a blank name saved happily, leaving a nameless
  // club whose delete confirmation was armed by an empty box.
  const nameError = validateClubName(settings.name, sanitizeInput(settings.name));
  const taglineError =
    /all fish of all shapes and sizes are welcome/i.test(settings.tagline) &&
    clubNumericId !== SHARK_CLUB_ID
      ? 'That Tag Line Belongs To Shark Club'
      : '';
  const formError = nameError || taglineError || buyinError;

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

  const [showRetirementModal, setShowRetirementModal] = useState(false);

  // ───────────────────────────────────────────────────────────────────────────
  // HANDING THE CLUB OVER
  // ───────────────────────────────────────────────────────────────────────────
  // transfer_club_ownership has always permitted the owner to do this - it
  // checks `v_actor <> v_old` and refuses anybody else - but the only screen
  // that called it was AdminDashboardPage, which a club owner cannot open. So
  // the one person the rule was written for had to ask a platform admin to do
  // it for them. This is that screen.
  //
  // The RPC does the rest: it refuses a recipient who is not an active member,
  // demotes the outgoing owner to admin, writes both role_changes rows and the
  // audit row, and tells both people. Nothing here re-implements any of that.
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [handoverCandidates, setHandoverCandidates] = useState<
    { userId: string; displayName: string; role: string }[]
  >([]);
  const [handoverLoading, setHandoverLoading] = useState(false);
  const [handoverTarget, setHandoverTarget] = useState('');
  const [handoverConfirm, setHandoverConfirm] = useState('');
  const [isHandingOver, setIsHandingOver] = useState(false);
  const [handoverError, setHandoverError] = useState<string | null>(null);
  const handoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  // What must be settled before the retained club can become read-only.
  const [retirementImpact, setRetirementImpact] = useState<ClubRetirementImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  /** Why the retirement check failed. Without it the modal said only "Could Not
   *  Check Retirement Readiness" and the action stayed permanently
   *  disabled with no retry - Cancel and reopen was the only recourse. */
  const [impactError, setImpactError] = useState<string | null>(null);
  /** True when we could not confirm the reader's role, so the page can say so
   *  instead of silently degrading them to `player`. */
  const [roleLoadFailed, setRoleLoadFailed] = useState(false);
  const [showStatsExport, setShowStatsExport] = useState(false);
  const [isRetiring, setIsRetiring] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [userRole, setUserRole] = useState<ClubRole>('player');
  // Mirrors the audit_trail SELECT policies: owner, or is_club_admin() which
  // accepts role IN ('owner','co_owner','admin','manager','agent').
  const canSeeAuditLog =
    isOwner || isClubStaff(userRole) || userRole === 'agent' || userRole === 'super_agent';
  const retirementBlockedReason = retirementImpact
    ? blockingRetirementReason(retirementImpact)
    : null;

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
    setClubNumericId(null);
    setClubCode(null);
    setIsOwner(false);
    setUserRole('player');
    setShowRetirementModal(false);
    setRetirementImpact(null);
    setImpactLoading(false);
    setShowStatsExport(false);
    setIsRetiring(false);
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
    // Was not reset: navigating from a club whose role read failed to a club
    // you OWN skips the lookup entirely (ownerMatch short-circuits it), so the
    // "We Could Not Confirm Your Role" notice stayed on screen for a club where
    // the role is known for certain.
    setRoleLoadFailed(false);
  }, [clubId]);

  // Release the pending-logo blob URL when the page goes away. The per-club
  // reset and the save/discard paths revoke it, but plain unmount did not.
  const pendingLogoRef = useRef<{ file: File; preview: string } | null>(null);
  // Path of the object uploaded during the in-flight save, so the catch block
  // can clean it up if the row update fails.
  const uploadedPathRef = useRef<string | null>(null);
  const currentLogoUrlRef = useRef<string | null>(null);
  const isMountedRef = useIsMounted();
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const retirementTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  /* getIsMounted passed through (Dan 2026-08-25). Without it every branch of
     the loader - setSettings, setLoadError, setNotFound, setLoading and
     toast.error('Failed to load club settings') - ran after the user had
     navigated away mid-request. A toast for a page they had left. */
  useVisibilityRefresh(() => loadClubSettings(() => isMountedRef.current, { silent: true }));

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
      if (!window.confirm('You Have Unsaved Settings Changes. Leave This Page And Discard Them?')) {
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

  /**
   * Escape closes the retirement modal, and focus returns to the button that
   * opened it.
   *
   * This was written once and lost in a merge, which is why `retirementTriggerRef`
   * existed with nothing reading it and the modal carried `role="dialog"
   * aria-modal="true"` with nothing enforcing either. On the control that
   * changes the club's lifecycle, dismissal was overlay-click only.
   */
  /**
   * `isRetiring` goes through a REF, not the dep array (Dan 2026-08-25).
   *
   * It was a dependency, so pressing Retire Club - which sets isRetiring true -
   * tore this effect down and ran its cleanup, and the cleanup moves focus back
   * to the trigger BEHIND the overlay. Focus left an open `aria-modal` dialog
   * at the exact moment the irreversible request was in flight. Depending only
   * on `showRetirementModal` means cleanup runs when the modal actually closes,
   * which is the only time returning focus is correct.
   */
  /**
   * Who may receive the club. The RPC's own rule is "an active member of this
   * club", so this asks for exactly that set and nothing cleverer - a list on
   * screen that disagrees with the write behind it is how somebody ends up
   * picking a name and being told no.
   */
  const loadHandoverCandidates = async () => {
    if (!clubId) return;
    setHandoverLoading(true);
    setHandoverError(null);
    try {
      const members = await MembershipService.getClubMembers(clubId);
      const eligible = members
        .filter((m) => m.userId !== user?.id)
        // The server's rule is status IN ('active','approved'). MemberStatus does
        // not list 'approved', but club_members does hold it, so narrowing to the
        // TS union here would hide real members from a list whose whole job is to
        // agree with the write behind it. Compared as strings, deliberately.
        .filter((m) => HANDOVER_ELIGIBLE_STATUSES.has(m.status as string))
        .map((m) => ({
          userId: m.userId,
          displayName: m.displayName || 'Unnamed Member',
          role: m.role as string,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      if (!isMountedRef.current) return;
      setHandoverCandidates(eligible);
    } catch (e) {
      reportError(e, 'ClubSettingsPage.loadHandoverCandidates');
      if (isMountedRef.current) setHandoverError('Could Not Load The Member List. Try Again.');
    } finally {
      if (isMountedRef.current) setHandoverLoading(false);
    }
  };

  /**
   * The write. Everything that makes this safe lives in the RPC, so the only
   * job here is to not swallow its reason: it refuses a non-member, a recipient
   * who already owns the club, and any caller who is not the current owner, and
   * each of those refusals is a sentence worth showing.
   */
  const handOverClub = async () => {
    if (!clubId || !handoverTarget || isHandingOver) return;
    setIsHandingOver(true);
    setHandoverError(null);
    try {
      const uuid = await resolveClubUUID(clubId);
      const { error } = await supabase.rpc('transfer_club_ownership', {
        p_club_id: uuid,
        p_new_owner_id: handoverTarget,
      });
      if (error) throw error;

      const recipient =
        handoverCandidates.find((c) => c.userId === handoverTarget)?.displayName ?? 'The New Owner';
      toast.success(`${savedClubName} Now Belongs To ${recipient}. You Are An Admin Of It.`);
      masterBus.emit('CLUB_UPDATED', { clubId: uuid });
      masterBus.emit('MEMBER_ROLE_CHANGED', {
        clubId: uuid,
        userId: handoverTarget,
        newRole: 'owner',
        previousRole: 'admin',
      });

      // Every permission on this page just changed hands. Reloading is the
      // honest response: staying put would leave owner-only controls on screen
      // for somebody who is now an admin, and every one of them would fail.
      setShowHandoverModal(false);
      navigate(`/clubs/${clubId}`, { replace: true });
    } catch (e) {
      reportError(e, 'ClubSettingsPage.handOverClub');
      if (isMountedRef.current) {
        setHandoverError(
          e instanceof Error && e.message
            ? e.message
            : 'The Handover Was Refused. Nothing Was Changed.'
        );
      }
    } finally {
      if (isMountedRef.current) setIsHandingOver(false);
    }
  };

  // Escape closes the handover dialog, and focus goes back to the control that
  // opened it - the same contract the delete dialog got on 2026-08-25.
  const isHandingOverRef = useRef(isHandingOver);
  isHandingOverRef.current = isHandingOver;
  useEffect(() => {
    if (!showHandoverModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isHandingOverRef.current) setShowHandoverModal(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      handoverTriggerRef.current?.focus();
    };
  }, [showHandoverModal]);

  const isRetiringRef = useRef(isRetiring);
  isRetiringRef.current = isRetiring;
  useEffect(() => {
    if (!showRetirementModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isRetiringRef.current) setShowRetirementModal(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      retirementTriggerRef.current?.focus();
    };
  }, [showRetirementModal]);

  /**
   * Ctrl+S. Through a REF (Dan 2026-08-25).
   *
   * `saveSettings` closes over `settings`, but this effect only re-registered
   * when one of four booleans changed. Rename the club A -> B (the effect
   * re-runs, capturing B), then B -> C, press Ctrl+S: it wrote **B**.
   */
  const saveRef = useRef<(() => void | Promise<void>) | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isOwner && hasUnsavedChanges && !saving && !formError) void saveRef.current?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOwner, hasUnsavedChanges, saving, formError]);

  useEffect(() => {
    let isMounted = true;
    if (user?.id) {
      supabase
        .from('profiles')
        .select('player_number')
        .eq('id', user.id)
        // .maybeSingle(), never .single(): a profile row that does not exist
        // yet is a normal state, and .single() resolves with a PGRST116 error
        // and null data. The .then below only reads `data`, so the failure was
        // invisible and the player number silently never rendered.
        .maybeSingle()
        .then(({ data }) => {
          if (isMounted && data) {
            setPlayerNumber(data.player_number);
          }
        });
    }
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
    /**
     * SILENT MEANS SILENT (Dan 2026-08-25).
     *
     * These were cleared at the TOP of every load, including background ones.
     * On a deleted or RLS-hidden club that flipped `notFound` to false while
     * `loading` stayed false, so for the duration of the request the page
     * rendered the full EDITABLE settings form, with defaults, for a club that
     * does not exist. Reset only on a foreground load, where the skeleton
     * covers the gap.
     */
    if (!opts?.silent) {
      setLoadError(false);
      setNotFound(false);
    }
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
              'id, owner_id, club_id, logo_url, name, description, tagline, lobby_message, is_public, requires_approval, default_rake_percent, rake_cap, spins_enabled, union_id'
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
          tagline: data.tagline || '',
          lobby_message: data.lobby_message || '',
          is_public: data.is_public ?? true,
          requires_approval: data.requires_approval ?? false,
          default_rake_percent: data.default_rake_percent ?? RAKE_INHERIT,
          rake_cap: data.rake_cap ?? RAKE_INHERIT,
          spins_enabled: data.spins_enabled ?? false,
        };

        /* THE UNION FLAG IS SET FROM THE ROW, WHICH IT NEVER WAS (phase 8).
           `setInUnion` had no caller anywhere in this file, so `inUnion` was
           permanently false and the Rake & BBJ section below - the one it
           guards - was shown to every club, including clubs whose rake their
           UNION governs. An owner could set a rake percentage the union then
           overrode, with nothing on screen saying so. `union_id` was already
           in the select; it was simply never read. */
        setInUnion(Boolean(data.union_id));

        // A background refresh must never overwrite edits the owner has typed
        // and not saved. Three paths land here without the user asking —
        // tab-focus, the realtime UPDATE subscription, and four bus events —
        // and every one of them used to call setSettings() unconditionally.
        // The page even renders an "N unsaved changes" banner while doing it.
        setClubCode(typeof data.club_id === 'number' ? data.club_id : null);
        setClubNumericId(typeof data.club_id === 'number' ? data.club_id : null);
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
            // Supabase RETURNS errors, it does not throw them, so the
            // surrounding try/catch could never fire and `error` was discarded.
            // A failed or RLS-blocked read left userRole at 'player', which
            // hides Role Management and the Admin Activity Log from an
            // admin/agent with no indication anything went wrong.
            const { data: membership, error: roleErr } = await supabase
              .from('club_members')
              .select('role')
              .eq('club_id', data.id)
              .eq('user_id', user.id)
              .maybeSingle();
            if (roleErr) {
              reportError(roleErr, 'ClubSettingsPage.role_lookup');
              setRoleLoadFailed(true);
            } else {
              setRoleLoadFailed(false);
            }
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
      // A SILENT refresh must not replace the whole form with the error screen.
      // Tab away for 30s, come back, hit a network blip, and the owner's typed
      // changes vanished from view - and the only control offered was a Retry
      // that overwrites them with the server copy.
      if (!opts?.silent) setLoadError(true);
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
      tagline: sanitizeInput(settings.tagline).slice(0, TAGLINE_MAX),
      lobby_message: sanitizeInput(settings.lobby_message)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LOBBY_MESSAGE_MAX),
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
      /**
       * ROLLBACK, AND EMIT AFTER THE WRITE (Dan 2026-08-25).
       *
       * Two faults in one call. `executeOptimistic` takes a fourth argument,
       * the rollback payload it emits when the async function throws, and this
       * call omitted it - so a rejected save left every other surface holding
       * the un-saved values for the rest of the session. And CLUB_UPDATED /
       * CLUB_SETTINGS_UPDATED were emitted BEFORE the UPDATE ran, so the lobby
       * and every open club surface repainted with a name and a rake that might
       * never land. Both moved below the zero-rows guard.
       */
      await masterBus.executeOptimistic(
        'SETTINGS_UPDATED',
        { settings: { clubId, ...toSave } },
        async () => {
          const { data: updated, error } = await supabase
            .from('clubs')
            .update({
              ...(newLogoUrl ? { logo_url: newLogoUrl } : {}),
              name: toSave.name,
              description: toSave.description,
              tagline: toSave.tagline || null,
              /* The lobby's own inline editor writes this through
                 fn_set_club_lobby_message, which is what lets a co-owner or an
                 admin set it too. Here the owner is already updating the row
                 directly under RLS, so the column rides along with the rest of
                 Basic Information - and carries its own timestamp, exactly as
                 the RPC does, so "how fresh is the day's message" cannot depend
                 on which surface wrote it. */
              lobby_message: toSave.lobby_message || null,
              lobby_message_updated_at: toSave.lobby_message ? new Date().toISOString() : null,
              is_public: toSave.is_public,
              requires_approval: toSave.requires_approval,
              default_rake_percent: toSave.default_rake_percent,
              rake_cap: toSave.rake_cap,
              /* FOUR COLUMNS USED TO BE WRITTEN FROM HERE AND ARE NOT ANY MORE
                 (phase 8, 2026-09-05). `tests/settings-only-write-what-they-offer.test.ts`
                 already states the rule for the other settings surface: a page
                 writes what it OFFERS, and nothing else. This page offered a
                 switch for one of them and no control at all for three, yet
                 blind-wrote whatever it happened to have loaded on every save.

                 - `spins_enabled` IS READ, by the lobby (ClubHomePage). There
                   was no control for it here, so a save carrying a stale copy
                   could turn Spins off for a club that had just turned it on
                   somewhere else. That is the live one.
                 - `spins_preseed_amount` and `spins_wallet_funding` have no
                   control and no reader anywhere in src/ or server/.
                 - `bbj_rake_enabled` HAD a visible switch here and no reader at
                   all - the BBJ engine reads the separate `bbj_enabled`. The
                   switch is gone with this change rather than wired up,
                   because whether a club takes BBJ rake sets what players pay,
                   and CLAUDE.md 10.9 reserves that to Dan. A switch that does
                   nothing is worse than no switch: it tells an operator they
                   have turned something off. */
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
          // Only now is it true.
          if (clubId) {
            masterBus.emit('CLUB_UPDATED', { clubId });
            masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId });
          }
        },
        { settings: { clubId, ...(originalSettings.current ?? settings) } }
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
        // The REF, not the closure. currentLogoUrlRef is maintained for exactly
        // this: if another admin replaces the logo during the save, the closed-
        // over value is stale and the wrong object gets deleted (or the real
        // predecessor leaks in the bucket).
        const stale = clubAssetPathFromPublicUrl(currentLogoUrlRef.current);
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
      // INSIDE the finally. Anything that threw within the catch above - the
      // storage remove() rejecting before .catch attached, reportError, the
      // toast - skipped this line and left `saving` stuck true: Save
      // permanently disabled with a spinner, Remove Logo disabled with it, and
      // no way out but a reload.
      setSaving(false);
    }
  };

  // Kept current on every render so the Ctrl+S handler above always calls the
  // latest closure rather than the one captured when it last re-registered.
  saveRef.current = saveSettings;

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
    } finally {
      setSaving(false);
    }
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

  const loadRetirementImpact = async () => {
    if (!clubId) return;
    setImpactLoading(true);
    setRetirementImpact(null);
    setImpactError(null);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      // One owner-gated authoritative read covers canonical chip liabilities,
      // diamonds, Promo Vault inventory, games, credit and settlement work.
      const { data, error } = await supabase.rpc('fn_club_retirement_impact', {
        p_club_id: resolvedId,
      });
      if (error) throw error;
      /**
       * SHAPE-CHECKED (Dan 2026-08-25).
       *
       * `(data || {})` plus `?? 0` meant that if the RPC ever returned a row
       * SET rather than a json object, every field was undefined, every figure
       * became 0, blockingRetirementReason returned null - and the action button
       * armed on a live club with members and running tables. A non-numeric
       * wallet_chips gave NaN, and `NaN > 0` is false, for the same outcome.
       */
      const impact = (Array.isArray(data) ? data[0] : data) as {
        members?: unknown;
        running_tables?: unknown;
        active_tournaments?: unknown;
        wallet_chips?: unknown;
        diamonds?: unknown;
        inventory_items?: unknown;
        open_obligations?: unknown;
        union_affiliated?: unknown;
        already_retired?: unknown;
      } | null;
      const members = Number(impact?.members ?? NaN);
      const runningTables = Number(impact?.running_tables ?? NaN);
      const activeTournaments = Number(impact?.active_tournaments ?? NaN);
      const walletChips = Number(impact?.wallet_chips ?? NaN);
      const diamonds = Number(impact?.diamonds ?? NaN);
      const inventoryItems = Number(impact?.inventory_items ?? NaN);
      const openObligations = Number(impact?.open_obligations ?? NaN);
      const unionAffiliated = impact?.union_affiliated;
      const alreadyRetired = impact?.already_retired;
      const numericValues = [
        members,
        runningTables,
        activeTournaments,
        walletChips,
        diamonds,
        inventoryItems,
        openObligations,
      ];
      if (
        !impact ||
        typeof impact !== 'object' ||
        numericValues.some((value) => !Number.isFinite(value) || value < 0) ||
        typeof unionAffiliated !== 'boolean' ||
        typeof alreadyRetired !== 'boolean'
      ) {
        throw new Error('The retirement check returned something unreadable.');
      }
      setImpactError(null);
      setRetirementImpact({
        members,
        runningTables,
        activeTournaments,
        walletChips,
        diamonds,
        inventoryItems,
        openObligations,
        unionAffiliated,
        alreadyRetired,
      });
    } catch (e) {
      reportError(e, 'ClubSettingsPage.Failed_to_load_retirement_impact');
      // Unknown impact must not read as "safe to retire".
      setImpactError(safeErrorMessage(e, 'Could not check whether this club is ready to retire.'));
      setRetirementImpact(null);
    } finally {
      setImpactLoading(false);
    }
  };

  const handleRetireClub = async () => {
    if (!clubId || !savedClubName.trim() || confirmText.trim() !== savedClubName.trim()) return;
    // The button has the same gate, but the handler remains fail-closed for
    // keyboard/programmatic activation and stale renders.
    if (!retirementImpact) {
      toast.error('Still checking whether this club can retire - try again in a moment.');
      return;
    }
    const blocked = blockingRetirementReason(retirementImpact);
    if (blocked) {
      toast.error(blocked);
      return;
    }

    setIsRetiring(true);
    try {
      await ClubsService.retire(clubId, confirmText.trim());
      toast.success('Club Retired. Membership, Game, Financial, And Audit Records Were Retained.');
      setShowRetirementModal(false);
      navigate('/clubs');
    } catch (error: unknown) {
      reportError(error, 'ClubSettingsPage.Failed_to_retire_club');
      // Keep the dialog and typed confirmation open so the owner can resolve a
      // newly-arrived obligation, retry, or read the server's exact refusal.
      toast.error(safeErrorMessage(error, 'The club could not be retired. Nothing was changed.'));
    } finally {
      setIsRetiring(false);
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
        {/* Share Club Link */}
        <section
          className="settings-section"
          style={{
            background: 'linear-gradient(145deg, #1f1f2e 0%, #151522 100%)',
            border: '1px solid #333',
          }}
        >
          <h3>Share Club</h3>
          <p className="setting-description" style={{ marginBottom: 16 }}>
            Invite Players To Join Your Club By Sharing Your Unique Referral Link.
          </p>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: 16 }}>
            <div
              style={{
                flex: 1,
                minWidth: '120px',
                padding: '12px',
                background: 'rgba(0,0,0,0.4)',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  color: 'rgba(255,255,255,0.5)',
                  marginBottom: '4px',
                }}
              >
                Club Code
              </div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#fff' }}>
                {clubNumericId || '...'}
              </div>
            </div>
            {playerNumber && (
              <div
                style={{
                  flex: 1,
                  minWidth: '120px',
                  padding: '12px',
                  background: 'rgba(0,0,0,0.4)',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <div
                  style={{
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.5)',
                    marginBottom: '4px',
                  }}
                >
                  Referral Code
                </div>
                <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#4caf50' }}>
                  {playerNumber}
                </div>
              </div>
            )}
          </div>
          {playerNumber && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                // The canonical invite link, the same one InvitePage and the
                // agent modal hand out. What was here before was dead three
                // separate ways and had never carried a single person into a
                // club:
                //   1. it omitted the router basename, so `origin + '/clubs'`
                //      landed outside the SPA entirely;
                //   2. `/clubs` is `<Navigate to="/" replace />` in App.tsx and
                //      Navigate carries no search string, so `c` and `ref` were
                //      destroyed even at the right path (the real list page is
                //      `/clubs-list`);
                //   3. `?c=` fed a five-digit code to a form that demanded six.
                // Corroboration: club_members has 1502 rows and exactly ONE
                // non-null invited_by.
                const url = `${window.location.origin}/hub/club-arena/invite/${clubId}?ref=${playerNumber}`;
                navigator.clipboard.writeText(url);
                toast.success('Invite Link Copied To Clipboard!');
              }}
              style={{
                width: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
              </svg>
              Copy Invite Link
            </button>
          )}
        </section>

        {/* Basic Info */}
        {/* A failed role lookup used to leave the reader silently demoted to
            `player`, which hides Role Management and the Admin Activity Log.
            Say it out loud instead of quietly removing their tools. */}
        {roleLoadFailed && (
          <div className="settings-notice" role="status">
            We Could Not Confirm Your Role In This Club, So Some Staff Tools May Be Hidden. Reload
            To Try Again.
          </div>
        )}
        {/* Role Management (Moved to Profile Tab conceptually as requested) */}
        {canSeeAuditLog && (
          <section className="settings-section">
            <h3>Role Management</h3>
            <p className="setting-description" style={{ marginBottom: 16 }}>
              Assign And Manage Roles For Your Club Members. Promote Players To Admin, Manager,
              Agent, Or Sub-Agent To Help Run The Club.
            </p>
            <button
              className="btn btn-primary"
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
            <label htmlFor="club-tagline">Club Tag Line</label>
            <input
              id="club-tagline"
              type="text"
              value={settings.tagline}
              onChange={(e) => updateSetting('tagline', e.target.value)}
              disabled={!isOwner}
              maxLength={TAGLINE_MAX}
              aria-invalid={Boolean(taglineError)}
              aria-describedby="club-tagline-hint"
            />
            <small id="club-tagline-hint" className="form-hint">
              {taglineError ||
                `${settings.tagline.length}/${TAGLINE_MAX} · Write An Original Line For This Club`}
            </small>
          </div>
          {/* Dan 2026-09-01: "that should be the 'custom clickable message' for
              the club owners to put the days message, or something custom".
              The lobby rail shows this above the club card and opens it in
              full when tapped; club staff can also write it from there. This
              is the same field, where an owner already manages the club. */}
          <div className="form-group">
            <label htmlFor="club-lobby-message">Club Message</label>
            <textarea
              id="club-lobby-message"
              value={settings.lobby_message}
              onChange={(e) => updateSetting('lobby_message', e.target.value)}
              rows={2}
              disabled={!isOwner}
              maxLength={LOBBY_MESSAGE_MAX}
              placeholder="Tonight At 8, Double Rakeback On Every Nine Handed Table"
              aria-describedby="club-lobby-message-hint"
            />
            <small id="club-lobby-message-hint" className="form-hint">
              {settings.lobby_message.length}/{LOBBY_MESSAGE_MAX} &middot; Shown At The Top Of The
              Club Lobby. Leave It Empty To Fall Back To The Tag Line
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
                  aria-label="Copy Club Code"
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
                  alt="Club Logo"
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
              {/* A REAL BUTTON (Dan 2026-08-25). This was a <label> wrapping an
                  input with `display: none` - which removes the input from the
                  tab order, and a <label> is not focusable, so there was no
                  keyboard or screen-reader path to the file picker AT ALL. The
                  input is now visually hidden but still focusable, and the
                  button drives it. */}
              {isOwner && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                    onClick={() => logoInputRef.current?.click()}
                  >
                    {pendingLogo ? 'Change' : currentLogoUrl ? 'Replace' : 'Upload'}
                  </button>
                  <input
                    ref={logoInputRef}
                    id="club-logo-input"
                    className="visually-hidden-input"
                    type="file"
                    aria-label="Choose A Club Logo"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={onLogoSelect}
                  />
                </>
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
                setSettings((prev) => ({
                  ...prev,
                  is_public: nextPublic,
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

        {/* Rake & BBJ Settings */}
        {!inUnion && (
          <section className="settings-section">
            <h3>Rake & BBJ Settings</h3>

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
                placeholder="Use House Schedule"
                /* DECIMALS HAVE TO BE TYPEABLE (Dan 2026-08-25).
                 This clamped on every keystroke against a CONTROLLED value, so
                 typing "0.5" went "0" -> 0, then "0." -> parseFloat -> 0 -> the
                 input re-rendered as "0", and the next keystroke produced **5**
                 - ten times the intended rake, on the field that decides how
                 much money the club takes. Hold the raw string while typing and
                 clamp on blur, which is exactly what the buy-in inputs below
                 already do. */
                value={rakePercentText}
                onChange={(e) => setRakePercentText(e.target.value)}
                onBlur={() => {
                  const raw = rakePercentText.trim();
                  if (raw === '') {
                    updateSetting('default_rake_percent', RAKE_INHERIT);
                    return;
                  }
                  const val = parseFloat(raw);
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
                  ? 'Currently: House Schedule.'
                  : `Currently: ${settings.default_rake_percent}% (House Caps Still Apply).`}
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="club-rake-cap">Rake Cap (BB)</label>
              <input
                id="club-rake-cap"
                type="number"
                placeholder="Use House Schedule"
                /* Same shape as the rake field above: raw while typing, clamp on
                 blur, so "1.5" cannot be read as 15. */
                value={rakeCapText}
                onChange={(e) => setRakeCapText(e.target.value)}
                onBlur={() => {
                  const raw = rakeCapText.trim();
                  if (raw === '') {
                    updateSetting('rake_cap', RAKE_INHERIT);
                    return;
                  }
                  const val = parseFloat(raw);
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
                Most That Can Be Raked From One Pot, In Big Blinds. Blank Uses The House Cap For
                Each Stake ($3-$20 Depending On Blinds).{' '}
                {settings.rake_cap < 0 ? 'Currently: House Cap.' : capPreview}
              </small>
            </div>
            {/* 2026-08-18: the "Time Bank (seconds)" field was removed. It
              persisted to clubs.time_bank_seconds, which no engine code has
              ever read — an owner could set it to 15 or to 120 and every table
              behaved identically. A time bank is a flat 20-second grant, 2 per
              street (Bible V8 s6.2); there is nothing per-club left to set. */}
            {/* 2026-09-05, phase 8: the "BBJ Rake" switch was removed, for the
              same reason as the Time Bank field above it. It wrote
              clubs.bbj_rake_enabled, which NOTHING reads - the bad beat jackpot
              engine reads the separate `bbj_enabled` column - so an owner could
              turn it off and every table went on taking BBJ rake. Wiring it
              would decide what players pay, which CLAUDE.md 10.9 reserves to
              Dan; showing it did the one thing worse than not offering the
              control, which is to say it had been used. */}
          </section>
        )}
        {/* Spins — the owner's switch and the wallet behind it.
            Placed here, after Buy-In Limits, because it is the only other
            setting on this page that commits the club's own money. */}
        {clubId && <SpinActivationPanel clubId={clubId} />}

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

        {/* Ownership - Owner Only */}
        {isOwner && (
          <section className="settings-section handover-section">
            <h3>Ownership</h3>
            <div className="danger-item">
              <div className="danger-info">
                <span className="danger-label">Hand Over This Club</span>
                <span className="danger-desc">
                  Another Active Member Becomes The Owner And You Become An Admin. Only You Can Do
                  This, And Only The New Owner Can Undo It.
                </span>
              </div>
              <button
                ref={handoverTriggerRef}
                className="btn btn-secondary"
                onClick={() => {
                  setHandoverTarget('');
                  setHandoverConfirm('');
                  setHandoverError(null);
                  setShowHandoverModal(true);
                  void loadHandoverCandidates();
                }}
              >
                Hand Over Club
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
                <span className="danger-label">Retire This Club</span>
                <span className="danger-desc">
                  End Active Play And Cashier Access While Retaining Members, Games, Financial
                  Journals, And Audit History.
                </span>
              </div>
              <button
                ref={retirementTriggerRef}
                className="btn btn-danger"
                onClick={() => {
                  setShowRetirementModal(true);
                  loadRetirementImpact();
                }}
              >
                Retire Club
              </button>
            </div>
          </section>
        )}

        {isOwner && (
          <button
            className="btn btn-primary save-btn"
            onClick={saveSettings}
            disabled={saving || !hasUnsavedChanges || !!formError}
            /* formError first: blanking the club name greyed the button out
               while the tooltip stayed empty, because there ARE changes - so
               the owner got no explanation at all. The unsaved bar already
               does it in this order. */
            title={formError || (hasUnsavedChanges ? undefined : 'No Changes To Save')}
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

      {/* Handover Confirmation Modal */}
      {showHandoverModal && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={() => !isHandingOver && setShowHandoverModal(false)}
        >
          <div
            className="modal-content handover-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="handover-club-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="handover-club-title">Hand Over {savedClubName}</h3>
            <p>
              The Member You Choose Becomes The Owner Of <strong>{savedClubName}</strong> And Holds
              Every Permission In It. You Become An <strong>Admin</strong>. Only The New Owner Can
              Hand It Back.
            </p>

            {handoverLoading && <p className="delete-impact">Loading Members...</p>}

            {!handoverLoading && handoverCandidates.length === 0 && (
              <p className="delete-impact">
                This Club Has No Other Active Members, So There Is Nobody To Hand It To.
              </p>
            )}

            {!handoverLoading && handoverCandidates.length > 0 && (
              <>
                <label className="handover-label" htmlFor="handover-target">
                  New Owner
                </label>
                <select
                  id="handover-target"
                  className="handover-select"
                  value={handoverTarget}
                  onChange={(e) => setHandoverTarget(e.target.value)}
                  disabled={isHandingOver}
                >
                  <option value="">Choose A Member...</option>
                  {handoverCandidates.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.displayName} ({roleLabelForHandover(c.role)})
                    </option>
                  ))}
                </select>

                {/* Typing the name is the same guard the delete dialog uses. A
                    handover is not destructive, but it is the one action on
                    this page the owner cannot reverse alone. */}
                <label className="handover-label" htmlFor="handover-confirm">
                  Type <strong>{savedClubName}</strong> To Confirm
                </label>
                <input
                  id="handover-confirm"
                  className="handover-input"
                  type="text"
                  value={handoverConfirm}
                  onChange={(e) => setHandoverConfirm(e.target.value)}
                  disabled={isHandingOver}
                  autoComplete="off"
                />
              </>
            )}

            {handoverError && (
              <p className="handover-error" role="alert">
                {handoverError}
              </p>
            )}

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setShowHandoverModal(false)}
                disabled={isHandingOver}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handOverClub}
                disabled={
                  isHandingOver ||
                  !handoverTarget ||
                  handoverConfirm.trim() !== savedClubName.trim()
                }
                title={
                  !handoverTarget
                    ? 'Choose A Member First'
                    : handoverConfirm.trim() !== savedClubName.trim()
                      ? 'Type The Club Name To Confirm'
                      : undefined
                }
              >
                {isHandingOver ? (
                  <>
                    <span className="btn-spinner" /> Handing Over...
                  </>
                ) : (
                  'Hand Over Club'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Retirement Confirmation Modal */}
      {/* Dialog semantics (Dan 2026-08-25). The overlay was an interactive div
          with no role, Escape did nothing, Tab walked straight out into the
          page behind it, and nothing announced this as a modal - on the control
          that changes whether an entire club can operate. */}
      {showRetirementModal && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={() => !isRetiring && setShowRetirementModal(false)}
        >
          <div
            className="modal-content delete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="retire-club-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="retire-club-title">Retire Club</h3>
            <p>
              This Ends Active Play And Cashier Access For <strong>{savedClubName}</strong>. The
              Club, Memberships, Games, Financial Journals, And Audit Records Stay Retained And
              Read-Only.
            </p>
            {impactLoading && <p className="delete-impact">Checking Retirement Readiness...</p>}
            {!impactLoading && retirementImpact && (
              <ul className="delete-impact">
                <li>{retirementImpact.members.toLocaleString()} Membership Records Retained</li>
                <li>{retirementImpact.runningTables.toLocaleString()} Running Tables To Close</li>
                <li>{retirementImpact.activeTournaments.toLocaleString()} Active Tournaments</li>
                <li>
                  {retirementImpact.walletChips.toLocaleString()} Chips Or Credit Across Canonical
                  Accounts
                </li>
                <li>{retirementImpact.diamonds.toLocaleString()} Club Or Member Diamonds</li>
                <li>{retirementImpact.inventoryItems.toLocaleString()} Promo Vault Items</li>
                <li>{retirementImpact.openObligations.toLocaleString()} Open Obligations</li>
              </ul>
            )}
            {!impactLoading && !retirementImpact && (
              <p className="delete-impact delete-impact--blocked">
                Could Not Check Retirement Readiness. Retirement Is Disabled Until That Check
                Succeeds.
                {impactError ? ` ${impactError}` : ''}{' '}
                <button
                  type="button"
                  className="settings-inline-link"
                  onClick={loadRetirementImpact}
                >
                  Check Again
                </button>
              </p>
            )}
            {retirementBlockedReason && (
              <p className="delete-impact delete-impact--blocked" role="alert">
                {retirementBlockedReason}
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
                disabled={isRetiring}
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowRetirementModal(false);
                  setConfirmText('');
                  setRetirementImpact(null);
                }}
                disabled={isRetiring}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleRetireClub}
                disabled={
                  !savedClubName.trim() ||
                  confirmText.trim() !== savedClubName.trim() ||
                  isRetiring ||
                  impactLoading ||
                  !retirementImpact ||
                  !!retirementBlockedReason
                }
                title={retirementBlockedReason || undefined}
              >
                {isRetiring ? 'Retiring...' : 'Retire Club'}
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
      {/* Moved out of inline styles into .conflict-bar (Dan 2026-08-25). It was
          a fixed flex row with no flex-wrap holding ~90 characters plus a
          button inside 90vw - at 375px that is ~338px, so it squashed or
          overflowed. Everything about it duplicated .unsaved-bar, which had
          already been fixed for exactly this. The `bottom` was also inline and
          sat UNDER the bottom nav; both bars now use the shared clearance. */}
      {serverChanged && isOwner && (
        <div className="conflict-bar" role="status">
          <span className="conflict-bar__title">These Settings Changed Elsewhere</span>
          <span className="conflict-bar__body">
            Your Edits Are Still Here. Saving Overwrites The Newer Values.
          </span>
          <button
            className="conflict-bar__action"
            onClick={() => {
              setServerChanged(false);
              loadClubSettings(undefined, { force: true });
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
              // Without this the "These Settings Changed Elsewhere / Your Edits
              // Are Still Here" banner kept warning about edits that had just
              // been thrown away. The save path already clears it.
              setServerChanged(false);
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
    </div>
  );
}
