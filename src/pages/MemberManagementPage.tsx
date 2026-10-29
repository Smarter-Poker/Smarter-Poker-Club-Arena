/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MEMBER MANAGEMENT - one member, everything about them
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23. The Players tab used to open a bottom sheet with three buttons
 * in it. Tapping a row now opens this instead, because everything an owner or an
 * agent actually wants -- who carries this player, what they have generated, what
 * is in their wallets, who sits beneath them, and what role they should hold --
 * is a page's worth of information and was never going to fit in a sheet.
 *
 * WHAT IT IS BUILT ON. `ca_club_member_detail` and `ca_club_member_downline`,
 * both reached through services/ClubRosterService, which has already turned every
 * PostgREST `numeric` string into a number. Nothing on this page parses a number
 * a second time and nothing here talks to Supabase directly except the two writes
 * that belong to it: the nickname/remark update, and the role change.
 *
 * THE RANGE CONTROL (requirement 5). Overall, 7 Days, or a chosen span. Both date
 * fields are native `<input type="date">` - they are localised, keyboard
 * accessible and on iOS they open the system picker, none of which a hand-rolled
 * calendar grid gets for free. Changing the range re-asks the server; the stats
 * are computed in Postgres against hand_history, so there is nothing to filter
 * client-side even if we wanted to.
 *
 * PROMOTE AND DEMOTE. Ported verbatim in behaviour from the PlayerActionModal
 * that lived at the bottom of ClubMembersPage before the rebuild, comments and
 * all, because the reasoning behind the single write path is the load-bearing
 * part. It is a section of the page now rather than a sheet, but it still asks
 * the server what may be offered, still confirms, and still refuses to guess.
 *
 * A MEMBER WHO IS NOT IN THIS CLUB comes back from the RPC as an object with a
 * null identity and zero stats rather than an error. That renders as "Member Not
 * Found", not as a wall of zeroes that looks like a real, very unlucky player.
 *
 * Palette is ClubMembersPage's, to the token. No green, no purple. Positive
 * money is arena cyan, negative money is --danger-red, and those are the only two
 * colours that carry meaning here beyond the role badge.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { sizedStorageUrl, generateAvatarSvg } from '../utils/avatarGenerator';
import { masterBus } from '../core/MasterBus';
import { useRosterWalletUpdates } from '../hooks/useRosterWalletUpdates';
import { useMasterBusSubscriptions } from '../hooks/useMasterBusSubscription';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useMasterBusBroadcastChannel } from '../hooks/useMasterBusBroadcastChannel';
import { useAuthUser } from '../hooks/useAuthUser';
import { useOnlineNow } from '../hooks/useProfilePresence';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';
import MemberRakebackEditor from '../components/club/MemberRakebackEditor';
import MemberCreditEditor from '../components/club/MemberCreditEditor';
import RoleBadge, { roleColor } from '../components/club/RoleBadge';
import PlayerChangeHistory from '../components/club/PlayerChangeHistory';
import ChipTransferModal from '../components/agent/ChipTransferModal';
import MemberWatchAtTable from '../components/club/MemberWatchAtTable';
import MemberWinLossCard from '../components/club/MemberWinLossCard';
import MemberUplineCard from '../components/club/MemberUplineCard';
import AgentCashoutPanel from '../components/agent/AgentCashoutPanel';
import { useClubPendingCashoutsRead } from '../hooks/useClubPendingCashouts';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { runWithRequestDeadline } from '../utils/requestDeadline';
import { runRosterReadWithRetry } from '../utils/rosterReadReliability';
import { toTitleCase } from '../utils/titleCase';
import { countFigure as count, formatWalletChips } from '../utils/format';
import { playerRecordMoney } from '../utils/playerRecordMoney';
import { memberRangeSearch } from '../utils/memberRangeLink';
import { isUUID } from '../utils/clubIdResolver';
import { ClubNotFoundError, resolveClubUUIDStrict } from '../utils/strictClubIdResolver';
import {
  ROLE_DESCRIPTION,
  isAgentRole,
  isClubStaff,
  normaliseRole,
  roleLabel,
  roleRank,
  type ClubRole,
} from '../types/clubRoles';
import ClubRosterService, {
  MemberAccessDeniedError,
  RANGE_OVERALL,
  lastDaysRange,
  isoDate,
  type MemberDetail,
  type MemberRange,
  type DownlineMember,
} from '../services/ClubRosterService';
import './MemberManagementPage.css';

const MEMBER_CREDENTIAL_ART = `${import.meta.env.BASE_URL}images/club-members/member-credential-v1.webp`;

/* ═══════════════════════════════════════════════════════════════════════════════
   FORMATTING
   ═══════════════════════════════════════════════════════════════════════════════ */

/* Player Record monetary stats retain full cents (owner, 2026-10-28).
   Counts retain countFigure; wallet balances retain formatWalletChips. */

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   THE RANGE CONTROL (requirement 5)
   ═══════════════════════════════════════════════════════════════════════════════ */

type RangeMode = 'overall' | 'week' | 'custom';

const RANGE_LABEL: Record<RangeMode, string> = {
  overall: 'Overall',
  week: '7 Days',
  custom: 'Select',
};

/** The downline list renders this many rows at a time; "Show More" adds another page.
    A 319-strong super agent's tree was reachable only to row 50 before. */
const DOWNLINE_RENDER_CAP = 50;

/* ═══════════════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════════════ */

export default function MemberManagementPage() {
  const { clubId: routeClubId, userId: routeUserId } = useParams();
  const [searchParams] = useSearchParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const userId = routeUserId || undefined;

  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();
  const isMountedRef = useIsMounted();

  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);
  const recordRefreshRef = useRef<() => void>(() => {});
  const authorityRefreshRef = useRef<() => void>(() => {});
  const [recordRevision, setRecordRevision] = useState(0);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [downline, setDownline] = useState<DownlineMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // An authority check or explicit retry failed while a
  // record was on screen. The record stays; a banner says it is the previous
  // successful read. Only a read the viewer asked for blanks the page.
  const [refreshFailed, setRefreshFailed] = useState(false);
  // The downline is its own read: its failure only touches its own section.
  const [downlineFailed, setDownlineFailed] = useState(false);
  const recordShownRef = useRef(false);
  const currentDetailRef = useRef(detail);
  currentDetailRef.current = detail;
  // The club or the member does not exist. Distinct from a read that failed:
  // a mistyped slug used to reach the uuid RPC as 22P02 and be shown as
  // "The Member Ledger Did Not Respond", which reads as an outage.
  const [notFound, setNotFound] = useState(false);
  const [myRole, setMyRole] = useState<ClubRole>('player');
  const [myRoleLoaded, setMyRoleLoaded] = useState(false);
  const detailAbortRef = useRef<AbortController | null>(null);
  const [downlineShown, setDownlineShown] = useState(DOWNLINE_RENDER_CAP);

  const [rangeMode, setRangeMode] = useState<RangeMode>('overall');
  const [customFrom, setCustomFrom] = useState<string>(() => isoDate(new Date()));
  const [customTo, setCustomTo] = useState<string>(() => isoDate(new Date()));
  const [range, setRange] = useState<MemberRange>(RANGE_OVERALL);

  type WalletRow = {
    user_id: string;
    can_view_financials: boolean;
    chip_balance: number | null;
    player_wallet: number | null;
    agent_wallet: number | null;
    promo_wallet: number | null;
  };
  const walletScopeKey = `${clubId ?? ''}:${userId ?? ''}:${user?.id ?? ''}`;
  const detailOwnerRef = useRef<string | null>(null);
  const walletRowsRef = useRef<WalletRow[]>([]);
  const toWalletRow = (value: MemberDetail): WalletRow[] =>
    value.identity?.user_id
      ? [
          {
            user_id: value.identity.user_id,
            can_view_financials: value.capabilities.can_view_financials,
            chip_balance: value.wallets?.chip_balance ?? null,
            player_wallet: value.wallets?.player_wallet ?? null,
            agent_wallet: value.wallets?.agent_wallet ?? null,
            promo_wallet: value.wallets?.promo_wallet ?? null,
          },
        ]
      : [];
  walletRowsRef.current =
    detail && detailOwnerRef.current === walletScopeKey ? toWalletRow(detail) : [];
  const applyWalletRow = (value: MemberDetail, row?: WalletRow): MemberDetail => {
    if (!row || value.identity?.user_id !== row.user_id) return value;
    return {
      ...value,
      capabilities: { ...value.capabilities, can_view_financials: row.can_view_financials },
      // A financial denial withdraws the entire financial record, not only its wallet totals.
      ...(!row.can_view_financials
        ? {
            stats: null,
            downline: null,
            identity: value.identity
              ? {
                  ...value.identity,
                  last_login: null,
                  upline_user_id: null,
                  upline_name: null,
                  upline_player_number: null,
                }
              : value.identity,
          }
        : {}),
      wallets:
        row.can_view_financials &&
        row.chip_balance !== null &&
        row.player_wallet !== null &&
        row.agent_wallet !== null &&
        row.promo_wallet !== null
          ? {
              chip_balance: row.chip_balance,
              player_wallet: row.player_wallet,
              agent_wallet: row.agent_wallet,
              promo_wallet: row.promo_wallet,
            }
          : null,
    };
  };
  const accessDenialRef = useRef<{ key: string; revision: number; detail: MemberDetail | null }>({
    key: walletScopeKey,
    revision: 0,
    detail: null,
  });
  if (accessDenialRef.current.key !== walletScopeKey)
    accessDenialRef.current = { key: walletScopeKey, revision: 0, detail: null };
  const applyAccessDenial = (value: MemberDetail, denied: MemberDetail): MemberDetail => ({
    ...value,
    capabilities: {
      ...denied.capabilities,
      can_view_financials:
        value.capabilities.can_view_financials && denied.capabilities.can_view_financials,
      can_view_notes: value.capabilities.can_view_notes && denied.capabilities.can_view_notes,
      can_edit_notes: value.capabilities.can_edit_notes && denied.capabilities.can_edit_notes,
      can_manage_role: value.capabilities.can_manage_role && denied.capabilities.can_manage_role,
    },
    identity: value.identity
      ? {
          ...value.identity,
          ...(!denied.capabilities.can_view_notes ? { nickname: null, remark: null } : {}),
        }
      : value.identity,
  });
  const withdrawRecordAccess = (denied: MemberDetail | null) => {
    if (!isMountedRef.current || accessDenialRef.current.key !== walletScopeKey) return;
    accessDenialRef.current = {
      key: walletScopeKey,
      revision: accessDenialRef.current.revision + 1,
      detail: denied,
    };
    if (!denied || !denied.identity?.user_id) {
      // An authoritative access withdrawal cancels the obsolete read owner.
      detailAbortRef.current?.abort();
      detailOwnerRef.current = null;
      walletRowsRef.current = [];
      setDetail(null);
      setDownline([]);
      setNotFound(true);
      setLoadError(false);
      setLoading(false);
    } else {
      setDetail((current) => (current ? applyAccessDenial(current, denied) : current));
    }
  };
  const walletUpdates = useRosterWalletUpdates(
    walletScopeKey,
    resolvedClubId,
    walletRowsRef,
    (rows) => {
      if (detailOwnerRef.current !== walletScopeKey) return;
      if (rows[0]?.can_view_financials === false) setDownline([]);
      setDetail((current) => (current ? applyWalletRow(current, rows[0]) : current));
    },
    () => toast.error('The Live Wallet Update Could Not Be Loaded.'),
    withdrawRecordAccess
  );
  const walletUpdatesRef = useRef(walletUpdates);
  walletUpdatesRef.current = walletUpdates;
  useMasterBusChannel({
    channelName: resolvedClubId
      ? `member-record-wallet-${resolvedClubId}-${userId}-${user?.id}`
      : null,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    enabled: !!resolvedClubId && !!user?.id,
    onPayload: (value) => {
      if (value?.new) walletUpdates.membership(value.new);
      if (value?.eventType !== 'UPDATE' || value?.new?.user_id === user?.id)
        authorityRefreshRef.current();
    },
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') walletUpdates.refresh(userId);
    },
    onSubscriptionError: () => toast.error('The Live Wallet Connection Could Not Be Established.'),
  });
  useMasterBusBroadcastChannel({
    channelName: resolvedClubId ? `club-roster-wallet:${resolvedClubId}` : null,
    event: 'wallet_changed',
    enabled: !!resolvedClubId && !!user?.id,
    onPayload: (value) => {
      const payload = (value as { payload?: { club_id?: string; user_id?: string } } | null)
        ?.payload;
      if (payload?.club_id === resolvedClubId && payload.user_id === userId)
        walletUpdates.refresh(userId);
    },
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') walletUpdates.refresh(userId);
    },
    onSubscriptionError: () => toast.error('The Live Wallet Connection Could Not Be Established.'),
  });

  useMasterBusBroadcastChannel({
    // The topic policy compares lower-case ids; a pasted upper-case URL id
    // was refused. Player Statistics lower-cases the same way.
    channelName:
      resolvedClubId && userId
        ? `member-record:${resolvedClubId.toLowerCase()}:${userId.toLowerCase()}`
        : null,
    event: 'record_changed',
    enabled: !!resolvedClubId && !!user?.id,
    onPayload: () => authorityRefreshRef.current(),
    onSubscriptionStatus: (status) => {
      if (status === 'SUBSCRIBED') authorityRefreshRef.current();
    },
    onSubscriptionError: () => toast.error('The Live Member Connection Could Not Be Established.'),
  });
  useMasterBusSubscriptions(['CLUB_UPDATED', 'MEMBER_ROLE_CHANGED', 'AGENT_UPDATED'], (payload) => {
    const change = payload as { clubId?: string; userId?: string } | null;
    if (change?.clubId && change.clubId !== resolvedClubId) return;
    if (!change?.clubId && change?.userId && change.userId !== userId && change.userId !== user?.id)
      return;
    authorityRefreshRef.current();
  });

  /* ── Load ───────────────────────────────────────────────────────────────── */

  useEffect(() => {
    setDetail(null);
    setDownline([]);
    setMyRole('player');
    setMyRoleLoaded(false);
    setResolvedClubId(null);
    setNotFound(false);
    setRefreshFailed(false);
    setDownlineFailed(false);
  }, [clubId, userId, user?.id]);

  const loadDetail = useCallback(
    async (activeRange: MemberRange, getIsMounted?: () => boolean, background = false) => {
      detailAbortRef.current?.abort();
      const controller = new AbortController();
      detailAbortRef.current = controller;
      if (!clubId || !userId) {
        if (!getIsMounted || getIsMounted()) {
          setNotFound(true);
          setDetail(null);
          setLoading(false);
        }
        return;
      }
      const live = () =>
        !controller.signal.aborted &&
        (getIsMounted ? getIsMounted() : true) &&
        isMountedRef.current;

      // A background read leaves the error screen (or the record) in place
      // until it has an answer, so a failed refresh cannot flicker the page.
      if (live() && !background) {
        setLoading(true);
        setLoadError(false);
      }
      try {
        // resolveClubUUID never returns falsy: it hands back the raw slug when
        // it cannot resolve, so a `!resolved` guard here was dead and the slug
        // went into p_club_id uuid. Strict resolution names the not-found.
        if (!isUUID(userId)) {
          if (live()) {
            setNotFound(true);
            setDetail(null);
          }
          return;
        }
        let resolved: string;
        try {
          resolved = await resolveClubUUIDStrict(clubId);
        } catch (e) {
          if (e instanceof ClubNotFoundError) {
            if (live()) {
              setNotFound(true);
              setDetail(null);
            }
            return;
          }
          throw e;
        }
        if (!live()) return;
        setNotFound(false);
        setResolvedClubId(resolved);

        const walletSnapshot = walletUpdatesRef.current.snapshot();
        const accessRevision = accessDenialRef.current.revision;
        // Both reads start together, but the downline settles on its own: a
        // downline failure must not blank the member record above it.
        const downlineRead = ClubRosterService.getDownline(
          resolved,
          userId,
          controller.signal
        ).then(
          (rows) => ({ ok: true as const, rows }),
          (error: unknown) => ({ ok: false as const, error })
        );
        const memberDetail = await ClubRosterService.getMemberDetail(
          resolved,
          userId,
          activeRange,
          controller.signal
        );
        const downlineResult = await downlineRead;
        if (!live()) return;
        detailOwnerRef.current = `${clubId ?? ''}:${userId ?? ''}:${user?.id ?? ''}`;
        const reconciledWallets = walletUpdatesRef.current.reconcile(
          toWalletRow(memberDetail),
          walletSnapshot
        );
        let currentDetail = applyWalletRow(memberDetail, reconciledWallets[0]);
        const newerDenial = accessDenialRef.current;
        if (
          newerDenial.key === `${clubId ?? ''}:${userId ?? ''}:${user?.id ?? ''}` &&
          newerDenial.revision > accessRevision
        ) {
          if (!newerDenial.detail) return;
          currentDetail = applyAccessDenial(currentDetail, newerDenial.detail);
        }
        setDetail(currentDetail);
        setLoadError(false);
        setRefreshFailed(false);
        if (!currentDetail.capabilities.can_view_financials) {
          setDownline([]);
          setDownlineFailed(false);
        } else if (downlineResult.ok) {
          setDownline(downlineResult.rows);
          setDownlineFailed(false);
          if (!background) setDownlineShown(DOWNLINE_RENDER_CAP);
        } else {
          // Keep any downline already shown; the section says it is stale.
          reportError(downlineResult.error, 'MemberManagementPage.loadDownline');
          setDownlineFailed(true);
        }
        setRecordRevision((revision) => revision + 1);

        // Whoever is reading decides what this page lets them do. One row, and
        // only for the viewer, so it costs a single indexed lookup.
        if (user?.id) {
          const mine = await runRosterReadWithRetry(
            async (signal) => {
              const result = await supabase
                .from('club_members')
                .select('role')
                .eq('club_id', resolved)
                .eq('user_id', user.id)
                .abortSignal(signal)
                .maybeSingle();
              if (result.error) throw result.error;
              return result.data;
            },
            { attempts: 1, timeoutMs: 8_000, signal: controller.signal }
          );
          if (live()) {
            setMyRole(normaliseRole(mine?.role));
            setMyRoleLoaded(true);
          }
        }
      } catch (error) {
        if (live()) {
          if (error instanceof MemberAccessDeniedError) {
            withdrawRecordAccess(null);
            return;
          }
          reportError(error, 'MemberManagementPage.loadDetail');
          if (background && recordShownRef.current) {
            // Keep the record on screen; the stale banner names the failure.
            setRefreshFailed(true);
          } else {
            setLoadError(true);
            // Only a read the viewer asked for toasts. A background retry that
            // fails again must not toast on every focus or live event.
            if (!background) toast.error('Failed To Load This Member');
          }
        }
      } finally {
        if (live()) setLoading(false);
      }
    },
    [clubId, userId, user?.id, isMountedRef, toast]
  );

  useEffect(() => {
    let mounted = true;
    loadDetail(range, () => mounted);
    return () => {
      mounted = false;
      detailAbortRef.current?.abort();
    };
  }, [loadDetail, range]);

  const reload = useCallback(() => {
    void loadDetail(range);
  }, [loadDetail, range]);

  // Only explicit retries and completed writes reload the record. Ambient
  // events can withdraw authority, but never replace the operator's workspace.
  useEffect(() => {
    const controller = new AbortController();
    const owner = { active: false, queued: false };
    const live = () => !controller.signal.aborted && isMountedRef.current;
    recordRefreshRef.current = () => void loadDetail(range, live, true);
    const checkAuthority = () => {
      if (!resolvedClubId || !userId || !user?.id || !recordShownRef.current) return;
      if (owner.active) {
        owner.queued = true;
        return;
      }
      owner.active = true;
      void (async () => {
        try {
          const accessRevision = accessDenialRef.current.revision;
          const authority = await ClubRosterService.getMemberDetail(
            resolvedClubId,
            userId,
            undefined,
            controller.signal
          );
          if (!live() || owner.queued) return;
          if (accessDenialRef.current.revision > accessRevision) return;
          // Record the denial epoch so an older explicit range read cannot
          // restore permission. Do not apply this response's metrics or identity.
          const prior = accessDenialRef.current.detail;
          const current = currentDetailRef.current ?? prior ?? authority;
          const restricted = {
            ...authority,
            capabilities: {
              ...authority.capabilities,
              can_view_financials:
                current.capabilities.can_view_financials &&
                authority.capabilities.can_view_financials,
              can_view_notes:
                current.capabilities.can_view_notes && authority.capabilities.can_view_notes,
              can_edit_notes:
                current.capabilities.can_edit_notes && authority.capabilities.can_edit_notes,
              can_manage_role:
                current.capabilities.can_manage_role && authority.capabilities.can_manage_role,
            },
          };
          withdrawRecordAccess(restricted);
          const mine = await supabase
            .from('club_members')
            .select('role')
            .eq('club_id', resolvedClubId)
            .eq('user_id', user.id)
            .abortSignal(controller.signal)
            .maybeSingle();
          if (mine.error) throw mine.error;
          if (live() && !owner.queued) {
            setMyRole(normaliseRole(mine.data?.role));
            setMyRoleLoaded(true);
          }
        } catch (error) {
          if (!live()) return;
          if (error instanceof MemberAccessDeniedError) withdrawRecordAccess(null);
          else {
            reportError(error, 'MemberManagementPage.CheckAuthority');
            setRefreshFailed(true);
          }
        } finally {
          owner.active = false;
          if (owner.queued && live()) {
            owner.queued = false;
            checkAuthority();
          }
        }
      })();
    };
    authorityRefreshRef.current = checkAuthority;
    return () => {
      controller.abort();
      recordRefreshRef.current = () => {};
      authorityRefreshRef.current = () => {};
    };
  }, [loadDetail, range, resolvedClubId, userId, user?.id]);

  /* ── Range ──────────────────────────────────────────────────────────────── */

  const chooseRange = useCallback((mode: RangeMode) => {
    setRangeMode(mode);
    if (mode === 'overall') setRange(RANGE_OVERALL);
    if (mode === 'week') setRange(lastDaysRange(7));
    // 'custom' waits for Confirm: re-fetching on every keystroke of a date field
    // would fire three times before the year is finished being typed.
  }, []);

  const confirmCustomRange = useCallback(() => {
    if (!customFrom || !customTo) {
      toast.error('Choose Both A Start And An End Date');
      return;
    }
    if (customFrom > customTo) {
      toast.error('The Start Date Must Come Before The End Date');
      return;
    }
    setRange({ from: customFrom, to: customTo });
  }, [customFrom, customTo, toast]);

  /* ── Derived ────────────────────────────────────────────────────────────── */

  const identity = detail?.identity;
  const found = !notFound && !!identity?.user_id;
  /* ca_club_member_detail answers "seated OR fresh presence"; off a seat it is
     the presence door's answer, re-asked every minute while shown so it goes
     dark when the heartbeat does (presence-has-one-definition law). */
  const onlineNow = useOnlineNow(identity?.user_id, detail?.presence.is_online === true);
  /* Seated is online, exactly as the roster and the status line below say it.
     The re-asked door answers heartbeats only, and a ring lit by it alone
     would light a seated person and not a seated horse (2026-10-05 audit). */
  const avatarLit = detail?.presence.is_seated === true || onlineNow;
  /* CASH OUT REQUESTED (Dan 2026-10-23): "IF THEY GO TO A PLAYERS ACCOUNT,
     THEY SHOULD BE ABLE TO SEE 'CASH OUT REQUESTED'". Read from the viewer's
     own cashout queue (fn_cashout_queue: everything in a club they run, plus
     their downline), so it shows exactly to the people who may pull the chips. */
  const memberUuid = identity?.user_id ?? null;
  const pendingCashouts = useClubPendingCashoutsRead(
    resolvedClubId,
    myRoleLoaded && !!memberUuid && memberUuid !== user?.id
  );
  const cashoutRequested = !!memberUuid && pendingCashouts.playerIds.has(memberUuid);

  const shownDownline = downline.slice(0, downlineShown);
  recordShownRef.current = !loadError && found;

  /* ── Render ─────────────────────────────────────────────────────────────── */

  if (loading && !detail) {
    return (
      <div className="member-mgmt-page">
        <PageHeader onBack={() => navigate(-1)} />
        <PageSkeleton variant="settings" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="member-mgmt-page">
        <PageHeader onBack={() => navigate(-1)} />
        <div className="mm-empty" role="alert">
          <span className="mm-empty__mark" aria-hidden="true">
            ↻
          </span>
          <p className="mm-empty__heading">The Member Ledger Did Not Respond</p>
          <p className="mm-empty__body">
            The Latest Record Could Not Be Verified. Retry Without Leaving This Page.
          </p>
          <button type="button" className="mm-empty__retry" onClick={reload}>
            Retry Member
          </button>
        </div>
        {/* Keep the note owner mounted through a recoverable read failure.
            Financial sections stay absent and edits wait for verification. */}
        <div className="mm-ledger-grid" key={`ledger:${clubId}:${userId}:${user?.id}`}>
          {identity?.user_id && detail?.capabilities.can_view_notes && (
            <NotesEditor
              key={`notes:${resolvedClubId}:${identity.user_id}`}
              clubId={resolvedClubId}
              userId={identity.user_id}
              initialNickname={identity.nickname}
              initialRemark={identity.remark}
              editable={detail.capabilities.can_edit_notes}
              disabled
            />
          )}
        </div>
      </div>
    );
  }

  if (!found) {
    return (
      <div className="member-mgmt-page">
        <PageHeader onBack={() => navigate(-1)} />
        <div className="mm-empty">
          <span className="mm-empty__mark" aria-hidden="true">
            ○
          </span>
          <p className="mm-empty__heading">Member Not Found</p>
          <p className="mm-empty__body">
            This Player Is Not A Member Of This Club, Or You Do Not Have Permission To View Them.
          </p>
        </div>
      </div>
    );
  }

  const stats = detail!.capabilities.can_view_financials ? detail!.stats : null;
  const wallets = detail!.capabilities.can_view_financials ? detail!.wallets : null;
  const counts = detail!.capabilities.can_view_financials ? detail!.downline : null;
  const alias = identity!.alias || 'Unknown';
  const initial = alias[0]?.toUpperCase() ?? '?';

  return (
    <div className="member-mgmt-page">
      <PageHeader onBack={() => navigate(-1)} />

      {refreshFailed && (
        <div className="mm-stale" role="alert">
          <div>
            <span className="mm-stale__status">Member Connection Interrupted</span>
            <p className="mm-stale__body">
              Could Not Refresh This Member. The Record Below Is From The Previous Successful Read.
            </p>
          </div>
          <button
            type="button"
            className="mm-empty__retry"
            onClick={() => recordRefreshRef.current()}
          >
            Try Again
          </button>
        </div>
      )}

      {/* ── Identity ─────────────────────────────────────────────────────── */}

      <section className="mm-credential" aria-labelledby="mm-player-name">
        <img
          className="mm-credential__art"
          src={MEMBER_CREDENTIAL_ART}
          alt=""
          aria-hidden="true"
          width="1672"
          height="941"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
        <div className="mm-credential__shade" aria-hidden="true" />
        <div className="mm-credential__content">
          <span className="mm-eyebrow">Audited Player Credential</span>
          <div className="mm-identity">
            <div className={`mm-avatar${avatarLit ? ' mm-avatar--online' : ''}`}>
              {identity!.avatar_url ? (
                <img
                  src={sizedStorageUrl(identity!.avatar_url!, 96)}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = generateAvatarSvg(
                      userId || 'member',
                      identity!.alias || '?'
                    );
                  }}
                />
              ) : (
                <span>{initial}</span>
              )}
            </div>

            <div className="mm-identity__main">
              <div className="mm-identity__line">
                <RoleBadge role={identity!.role} size="md" showLabel />
                <span
                  className={`mm-presence${
                    detail!.presence.is_seated
                      ? ' mm-presence--seated'
                      : onlineNow
                        ? ' mm-presence--online'
                        : ''
                  }`}
                >
                  {detail!.presence.is_seated ? 'At A Table' : onlineNow ? 'Online Now' : 'Offline'}
                </span>
                {cashoutRequested && (
                  <span className="mm-presence mm-presence--cashout">Cash Out Requested</span>
                )}
              </div>
              <h2 id="mm-player-name" className="mm-alias">
                {alias}
              </h2>
              {identity!.username && <span className="mm-username">{identity!.username}</span>}
            </div>

            <span className="mm-player-id">
              {identity!.player_number ? `ID: ${identity!.player_number}` : 'ID: Not Assigned'}
            </span>
          </div>
          {/* Watch At Table (Dan 2026-10-16): while the player is At A Table the
              record offers the one tap to watch them, in place of its caption. */}
          <MemberWatchAtTable
            clubUuid={resolvedClubId ?? ''}
            memberUserId={identity!.user_id ?? ''}
            seated={detail!.presence.is_seated}
            refreshKey={recordRevision}
            fallback={
              <p className="mm-credential__note">
                Club Identity, Live Presence, Wallet Access, Activity, And Role Authority In One
                Record.
              </p>
            }
          />
        </div>
      </section>

      <div className="mm-ledger-grid" key={`ledger:${clubId}:${userId}:${user?.id}`}>
        {/* ── Cash out requested (Dan 2026-10-23): the request, and the pull ── */}

        {cashoutRequested && resolvedClubId && memberUuid && (
          <div className="mm-cashout-request">
            <AgentCashoutPanel
              key={`cashout:${resolvedClubId}:${memberUuid}`}
              clubId={resolvedClubId}
              playerId={memberUuid}
              eyebrow="Cash Out Requested"
              onCashoutProcessed={() => {
                pendingCashouts.reload();
                recordRefreshRef.current();
              }}
            />
          </div>
        )}

        {/* ── Upline agents (Dan 2026-10-21): every agent above the player ─── */}

        {detail!.capabilities.can_view_financials && resolvedClubId && identity!.user_id && (
          <MemberUplineCard
            key={`upline:${resolvedClubId}:${identity!.user_id}`}
            clubId={resolvedClubId}
            userId={identity!.user_id}
            refreshKey={recordRevision}
          />
        )}

        {/* ── Win / loss (Dan 2026-10-16) ──────────────────────────────────── */}

        {detail!.capabilities.can_view_financials && resolvedClubId && identity!.user_id && (
          <MemberWinLossCard
            key={`winloss:${resolvedClubId}:${identity!.user_id}`}
            clubId={resolvedClubId}
            userId={identity!.user_id}
            refreshKey={recordRevision}
          />
        )}

        {/* ── Nickname and remark ──────────────────────────────────────────── */}

        {detail!.capabilities.can_view_notes && (
          <NotesEditor
            key={`notes:${resolvedClubId}:${identity!.user_id!}`}
            clubId={resolvedClubId}
            userId={identity!.user_id!}
            initialNickname={identity!.nickname}
            initialRemark={identity!.remark}
            editable={detail!.capabilities.can_edit_notes}
          />
        )}

        {/* ── Provenance ───────────────────────────────────────────────────── */}

        <section className="mm-card mm-provenance" aria-labelledby="mm-provenance-title">
          <h2 id="mm-provenance-title" className="mm-card__title">
            Membership Record
          </h2>
          {detail!.capabilities.can_view_financials && (
            <InfoLine label="Last Active" value={formatTimestamp(identity!.last_login)} />
          )}
          <InfoLine label="Joined" value={formatTimestamp(identity!.joined_at)} />
          {/* The RPC nulls upline_name for viewers without financial access;
            printing "None" for them said the player has no upline. */}
          {detail!.capabilities.can_view_financials && (
            <InfoLine
              label="Upline Agent"
              value={
                identity!.upline_name
                  ? identity!.upline_player_number
                    ? `${identity!.upline_name} (ID: ${identity!.upline_player_number})`
                    : identity!.upline_name
                  : 'None'
              }
            />
          )}
          {identity!.home_club_name && (
            <InfoLine label="Home Club" value={identity!.home_club_name} />
          )}
        </section>

        {/* ── Range control (requirement 5) ────────────────────────────────── */}

        {stats && (
          <section className="mm-range" aria-labelledby="mm-range-title">
            <div className="mm-section-heading">
              <h2 id="mm-range-title">Ledger Window</h2>
              <span>Verified Activity Range</span>
            </div>
            <div className="mm-range__tabs" role="group" aria-label="Statistics Date Range">
              {(Object.keys(RANGE_LABEL) as RangeMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={rangeMode === mode ? 'active' : ''}
                  aria-pressed={rangeMode === mode}
                  onClick={() => chooseRange(mode)}
                >
                  {RANGE_LABEL[mode]}
                </button>
              ))}
            </div>

            {rangeMode === 'custom' && (
              <div className="mm-range__custom">
                <label className="mm-date">
                  <span>From</span>
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </label>
                <label className="mm-date">
                  <span>To</span>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </label>
                <button type="button" className="mm-range__confirm" onClick={confirmCustomRange}>
                  Confirm
                </button>
              </div>
            )}

            {/* The caption names the range the numbers BELONG to, which is the
              one the server answered for, not the tab just pressed. While a
              new range loads the figures are dimmed and say so. */}
            <p
              className="mm-range__caption"
              role="status"
              aria-label="Displayed Activity Scope"
              aria-live="polite"
            >
              {loading
                ? 'Loading The Selected Range...'
                : detail!.range.is_overall
                  ? 'Showing All Recorded Activity'
                  : `Showing ${detail!.range.from ?? '?'} To ${detail!.range.to ?? '?'} UTC`}
            </p>
            <p className="mm-range__caption">
              UTC Dates Include Both From And To. Custom Dates Need Confirm.
            </p>
            {rangeMode === 'custom' && (customFrom !== range.from || customTo !== range.to) && (
              <p className="mm-range__draft" role="status">
                Draft Dates Not Applied. Confirm To Update The Displayed Range.
              </p>
            )}
          </section>
        )}

        {/* ── Stats ────────────────────────────────────────────────────────── */}

        {stats && (
          <section
            className={`mm-card mm-stats${loading ? ' mm-stats--busy' : ''}`}
            aria-busy={loading}
          >
            <h2 className="mm-card__title">Activity</h2>
            <details className="mm-metric-guide" aria-label="Activity Metric Definitions">
              <summary>Metric Definitions</summary>
              <p>
                Hand Counts Follow The Club Recorded On The Hand Funding And Rake Receipts. Cash
                Fees Are Cash Game Rake Attributed To This Player; MTT Fees Are Their Tournament
                Entry Fees. Fees Come From The Club Fee Ledgers And Count From The Week Of October
                12, 2026 (Monday Midnight Pacific) Onward, Within The Displayed Range.
              </p>
              <p>
                Total Winnings Is The Cash Net Result, Signed Hand Results Not Wallet Balances. MTT
                Winnings Is Tournament Money: Prizes Paid Minus Buy-Ins In The Displayed UTC Window,
                Matching The Win/Loss Card. Tournament Stack Chips Are Not Counted.
              </p>
              <p>
                Claimed Back Counts Incoming Rakeback And Commission Transactions. Sent Out Counts
                Outgoing Transfer, Send And Distribution Transactions In The Displayed UTC Window.
              </p>
              <p>Fees, Winnings And Transaction Totals Are Club Chip Wallet Amounts.</p>
              <p>
                Overall Means All Currently Recorded Activity. Older Activity May No Longer Be
                Retained. Wallets And Downline Counts Are Current, Not Date-Filtered.
              </p>
            </details>
            {/* The RPC splits hands by tournament_id, and every other pair on
              this card is shown as cash / MTT. "Hands" was the cash half
              labelled as the whole; mtt_hands was fetched and never drawn. */}
            <StatRow label="Cash Hands" value={count(stats.hands)} />
            <StatRow label="MTT Hands" value={count(stats.mtt_hands)} />
            <StatRow label="Cash Fees" value={playerRecordMoney(stats.total_fee)} />
            <StatRow label="MTT Fees" value={playerRecordMoney(stats.mtt_fee)} />
            <StatRow label="Claimed Back" value={playerRecordMoney(stats.claimed_back)} />
            <StatRow label="Sent Out" value={playerRecordMoney(stats.sent_out)} />
            <StatRow
              label="Total Winnings"
              value={playerRecordMoney(stats.total_winnings, true)}
              signed={stats.total_winnings}
            />
            <StatRow
              label="MTT Winnings"
              value={playerRecordMoney(stats.mtt_winnings, true)}
              signed={stats.mtt_winnings}
            />
          </section>
        )}

        {/* ── Wallets ──────────────────────────────────────────────────────── */}

        {wallets && (
          <section className="mm-card mm-stats">
            <h2 className="mm-card__title">Wallets</h2>
            {/* chip_balance and player_wallet are the same club_members row
              read twice; two labels on one number read as two wallets. */}
            <StatRow label="Player Wallet" value={formatWalletChips(wallets.player_wallet)} />
            <StatRow label="Agent Wallet" value={formatWalletChips(wallets.agent_wallet)} />
            <StatRow label="Promo Wallet" value={formatWalletChips(wallets.promo_wallet)} />
          </section>
        )}

        {/* ── Downline ─────────────────────────────────────────────────────── */}

        {counts && (
          <section className="mm-card mm-stats">
            <h2 className="mm-card__title">Downline</h2>
            <StatRow label="Downlines Direct" value={count(counts.downline_direct)} />
            <StatRow label="Downlines Total" value={count(counts.downline_total)} />

            {downlineFailed && (
              <p className="mm-downline__note" role="status">
                {downline.length > 0
                  ? 'Could Not Refresh The Downline. Showing The Previous Successful Read.'
                  : 'The Downline List Could Not Be Loaded.'}
                <button
                  type="button"
                  className="mm-downline__show-more"
                  onClick={() => recordRefreshRef.current()}
                >
                  Try Again
                </button>
              </p>
            )}

            {shownDownline.length > 0 && (
              <div className="mm-downline">
                {shownDownline.map((d) => (
                  <button
                    key={d.user_id}
                    type="button"
                    className="mm-downline__row"
                    onClick={() => navigate(`/clubs/${clubId}/members/${d.user_id}`)}
                    aria-label={`Open ${d.alias}, ${roleLabel(d.role)}`}
                  >
                    <RoleBadge role={d.role} size="sm" />
                    <span className="mm-downline__names">
                      <span className="mm-downline__alias">{d.alias}</span>
                      {d.username && d.username.toLowerCase() !== d.alias.toLowerCase() && (
                        <span className="mm-downline__username">{d.username}</span>
                      )}
                    </span>
                    {d.player_number && (
                      <span className="mm-downline__number">No. {d.player_number}</span>
                    )}
                    <span className="mm-downline__fees" title="Fees Generated">
                      {playerRecordMoney(d.total_fees)}
                    </span>
                    <span className="mm-downline__open" aria-hidden="true">
                      ›
                    </span>
                  </button>
                ))}
                {downline.length > shownDownline.length && (
                  <p className="mm-downline__more">
                    Showing {count(shownDownline.length)} Of {count(downline.length)}
                    <button
                      type="button"
                      className="mm-downline__show-more"
                      onClick={() => setDownlineShown((n) => n + DOWNLINE_RENDER_CAP)}
                    >
                      Show{' '}
                      {count(Math.min(DOWNLINE_RENDER_CAP, downline.length - shownDownline.length))}{' '}
                      More
                    </button>
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── Role ─────────────────────────────────────────────────────────── */}

        {(detail!.capabilities.can_manage_role ||
          (detail!.capabilities.can_view_financials && isAgentRole(myRole))) &&
          myRoleLoaded &&
          identity!.home_club_id && (
            <RoleSection
              key={`roles:${identity!.home_club_id}:${identity!.user_id!}`}
              resolvedClubId={identity!.home_club_id}
              targetUserId={identity!.user_id!}
              targetName={alias}
              targetRole={identity!.role}
              myRole={myRole}
              onRoleChanged={reload}
            />
          )}

        {resolvedClubId && user?.id && detail!.capabilities.access === 'staff' && (
          <section className="mm-card">
            <PlayerChangeHistory
              key={`history:${resolvedClubId}:${identity!.user_id}:${user.id}`}
              clubId={resolvedClubId}
              playerId={identity!.user_id!}
              viewerId={user.id}
              enabled={true}
            />
          </section>
        )}

        {/* ── Navigation rows ──────────────────────────────────────────────── */}

        <nav className="mm-nav">
          {detail!.capabilities.can_view_financials && (
            <button
              type="button"
              className="mm-nav__row"
              onClick={() => navigate(`/clubs/${clubId}/promo-vault?player=${identity!.user_id}`)}
            >
              <span className="mm-nav__copy">
                <span className="mm-nav__label">Promo Vault</span>
                <span className="mm-nav__detail">Review This Player's Promotional Credits</span>
              </span>
              <span className="mm-nav__chevron" aria-hidden="true">
                ›
              </span>
            </button>
          )}
          {detail!.capabilities.can_view_financials && (
            <button
              type="button"
              className="mm-nav__row"
              onClick={() =>
                navigate(
                  `/clubs/${clubId}/members/${identity!.user_id}/statistics?${memberRangeSearch(rangeMode, range)}`
                )
              }
            >
              <span className="mm-nav__copy">
                <span className="mm-nav__label">Player Statistics</span>
                <span className="mm-nav__detail">Open The Full Performance Instrument Board</span>
              </span>
              <span className="mm-nav__chevron" aria-hidden="true">
                ›
              </span>
            </button>
          )}
        </nav>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   HEADER
   ═══════════════════════════════════════════════════════════════════════════════ */

function PageHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="mm-header">
      <button type="button" className="mm-back" onClick={onBack} aria-label="Go Back">
        ‹
      </button>
      <h1 className="mm-title">Player Record</h1>
      {/* A spacer so the title is optically centred without absolute positioning,
          which would overlap the back button on a 320px screen. */}
      <span className="mm-header__spacer" aria-hidden="true" />
    </header>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   NICKNAME AND REMARK
   ═══════════════════════════════════════════════════════════════════════════════

   Saved on blur rather than on every keystroke: a remark is a sentence, and
   thirty writes per sentence is thirty chances for one of them to lose a race
   with the next.

   A FAILED SAVE NEVER DISCARDS WHAT WAS TYPED. The input keeps the user's text,
   the row is marked unsaved, and a toast says so - the alternative, snapping
   back to the last known server value, throws away the only copy of something
   somebody just wrote.
   ═══════════════════════════════════════════════════════════════════════════════ */

function NotesEditor({
  clubId,
  userId,
  initialNickname,
  initialRemark,
  editable,
  disabled = false,
}: {
  clubId: string | null;
  userId: string;
  initialNickname: string | null;
  initialRemark: string | null;
  editable: boolean;
  disabled?: boolean;
}) {
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [nickname, setNickname] = useState(initialNickname ?? '');
  const [remark, setRemark] = useState(initialRemark ?? '');
  const [nicknameUnsaved, setNicknameUnsaved] = useState(false);
  const [remarkUnsaved, setRemarkUnsaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveUnconfirmed, setSaveUnconfirmed] = useState(false);

  // The saved values, so a blur that changed nothing does not write anything.
  const savedRef = useRef({
    nickname: initialNickname ?? '',
    remark: initialRemark ?? '',
  });
  const draftRef = useRef({
    nickname: initialNickname ?? '',
    remark: initialRemark ?? '',
  });
  const savingRef = useRef(false);
  const queuedSaveRef = useRef(false);
  // An unknown acknowledgement retains the original payload and receipt key.
  const pendingNoteRef = useRef<{ nickname: string; remark: string; requestId: string } | null>(
    null
  );

  useEffect(() => {
    // A range refresh may carry another editor's newer notes. Keep local
    // unsaved fields and unresolved operation payloads until explicitly saved.
    const incoming = { nickname: initialNickname ?? '', remark: initialRemark ?? '' };
    const previous = savedRef.current;
    const draft = draftRef.current;
    if (!pendingNoteRef.current && !savingRef.current) {
      if (draft.nickname === previous.nickname) {
        draft.nickname = incoming.nickname;
        setNickname(incoming.nickname);
      }
      if (draft.remark === previous.remark) {
        draft.remark = incoming.remark;
        setRemark(incoming.remark);
      }
      savedRef.current = incoming;
    }
    setNicknameUnsaved(draft.nickname !== savedRef.current.nickname);
    setRemarkUnsaved(draft.remark !== savedRef.current.remark);
  }, [initialNickname, initialRemark, userId]);

  const save = useCallback(async () => {
    if (!clubId || disabled) return;
    if (savingRef.current) {
      queuedSaveRef.current = true;
      return;
    }
    const draft = pendingNoteRef.current ?? { ...draftRef.current, requestId: crypto.randomUUID() };
    if (savedRef.current.nickname === draft.nickname && savedRef.current.remark === draft.remark)
      return;

    savingRef.current = true;
    setSaving(true);
    try {
      pendingNoteRef.current = draft;
      const result = await ClubRosterService.updateMemberNotes(
        clubId,
        userId,
        draft.nickname,
        draft.remark,
        draft.requestId
      );
      pendingNoteRef.current = null;
      if (isMountedRef.current) setSaveUnconfirmed(false);
      const persisted = {
        nickname: result.nickname ?? '',
        remark: result.remark ?? '',
      };
      savedRef.current = persisted;
      if (!isMountedRef.current) return;
      // The server trims and nulls empties. If the draft is still what was
      // sent, the normalised text IS the draft now; otherwise the user typed
      // more meanwhile and that newer text stays marked unsaved. Before this,
      // "Bob " saved as "Bob" toasted "Saved" and lit "Not Saved Yet" for ever.
      if (draftRef.current.nickname === draft.nickname) {
        draftRef.current.nickname = persisted.nickname;
        setNickname(persisted.nickname);
        setNicknameUnsaved(false);
      } else {
        setNicknameUnsaved(draftRef.current.nickname !== persisted.nickname);
      }
      if (draftRef.current.remark === draft.remark) {
        draftRef.current.remark = persisted.remark;
        setRemark(persisted.remark);
        setRemarkUnsaved(false);
      } else {
        setRemarkUnsaved(draftRef.current.remark !== persisted.remark);
      }
      toast.success('Member Notes Saved');
    } catch (e) {
      queuedSaveRef.current = false; // Unknown writes require an explicit retry of the same receipt.
      reportError(e, 'MemberManagementPage.saveNotes');
      if (!isMountedRef.current) return;
      setSaveUnconfirmed(true);
      setNicknameUnsaved(savedRef.current.nickname !== draftRef.current.nickname);
      setRemarkUnsaved(savedRef.current.remark !== draftRef.current.remark);
      toast.error(safeErrorMessage(e, 'Could Not Save. Your Text Is Still Here'));
    } finally {
      savingRef.current = false;
      if (isMountedRef.current) setSaving(false);
      if (isMountedRef.current && queuedSaveRef.current) {
        queuedSaveRef.current = false;
        queueMicrotask(() => void save());
      }
    }
  }, [clubId, disabled, isMountedRef, toast, userId]);

  const discardButtonRef = useRef<HTMLButtonElement>(null);

  const discardDraft = useCallback(() => {
    const saved = savedRef.current;
    draftRef.current = { ...saved };
    setNickname(saved.nickname);
    setRemark(saved.remark);
    setNicknameUnsaved(false);
    setRemarkUnsaved(false);
  }, []);

  if (!editable) {
    return (
      <section className="mm-card mm-notes" aria-labelledby="mm-notes-title">
        <h2 id="mm-notes-title" className="mm-card__title">
          Club Notes
        </h2>
        <InfoLine label="Nickname" value={nickname || 'None'} />
        <InfoLine label="Remark" value={remark || 'None'} />
      </section>
    );
  }

  return (
    <section className="mm-card mm-notes" aria-labelledby="mm-notes-title">
      <h2 id="mm-notes-title" className="mm-card__title">
        Club Notes
      </h2>
      <label className="mm-field">
        <span className="mm-field__label">Nickname</span>
        <input
          type="text"
          value={nickname}
          aria-label="Nickname"
          disabled={disabled}
          maxLength={64}
          placeholder={toTitleCase('enter the nickname here...')}
          onChange={(e) => {
            setNickname(e.target.value);
            draftRef.current.nickname = e.target.value;
            setNicknameUnsaved(savedRef.current.nickname !== e.target.value);
          }}
          onBlur={(event) => {
            // Moving to Revert must not start a write before its click or keyboard activation.
            if (event.relatedTarget !== discardButtonRef.current) void save();
          }}
        />
        {nicknameUnsaved && <span className="mm-field__unsaved">Not Saved Yet</span>}
      </label>

      <label className="mm-field">
        <span className="mm-field__label">Remark</span>
        <input
          type="text"
          value={remark}
          aria-label="Remark"
          disabled={disabled}
          maxLength={240}
          placeholder={toTitleCase('enter remark here...')}
          onChange={(e) => {
            setRemark(e.target.value);
            draftRef.current.remark = e.target.value;
            setRemarkUnsaved(savedRef.current.remark !== e.target.value);
          }}
          onBlur={(event) => {
            // Moving to Revert must not start a write before its click or keyboard activation.
            if (event.relatedTarget !== discardButtonRef.current) void save();
          }}
        />
        {remarkUnsaved && <span className="mm-field__unsaved">Not Saved Yet</span>}
      </label>

      <div className="mm-notes__actions">
        <span className="mm-notes__status" role="status" aria-live="polite">
          {saving
            ? 'Saving Through The Audited Club Ledger...'
            : saveUnconfirmed
              ? 'Save Outcome Is Unconfirmed. Retry The Same Request.'
              : nicknameUnsaved || remarkUnsaved
                ? 'Changes Are Still Local To This Device.'
                : 'Notes Match The Audited Club Record.'}
        </span>
        <button
          type="button"
          className="mm-notes__discard"
          ref={discardButtonRef}
          onPointerDown={(event) => {
            // Keep pointer activation from blurring the draft before Revert runs.
            event.preventDefault();
          }}
          onClick={discardDraft}
          disabled={disabled || saving || saveUnconfirmed || (!nicknameUnsaved && !remarkUnsaved)}
        >
          Revert
        </button>
        <button
          type="button"
          className="mm-notes__save"
          onClick={() => void save()}
          disabled={disabled || saving || (!saveUnconfirmed && !nicknameUnsaved && !remarkUnsaved)}
        >
          {saving ? 'Saving...' : 'Save Notes'}
        </button>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PROMOTE AND DEMOTE

   Ported from the PlayerActionModal that used to sit at the bottom of
   ClubMembersPage. The behaviour and the reasoning are unchanged; only the
   container is - it is a section of the page now, not a bottom sheet.
   ═══════════════════════════════════════════════════════════════════════════════ */

export function RoleSection({
  resolvedClubId,
  targetUserId,
  targetName,
  targetRole,
  myRole,
  onRoleChanged,
}: {
  resolvedClubId: string;
  targetUserId: string;
  targetName: string;
  targetRole: ClubRole;
  myRole: ClubRole;
  onRoleChanged: () => void;
}) {
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const [promoting, setPromoting] = useState(false);
  const [editingRakeback, setEditingRakeback] = useState(false);
  const [editingCredit, setEditingCredit] = useState(false);
  const [confirmRole, setConfirmRole] = useState<ClubRole | null>(null);
  const roleConfirmationRef = useRef<HTMLDivElement>(null);
  const roleButtonsRef = useRef(new Map<ClubRole, HTMLButtonElement>());
  const cancelledRoleRef = useRef<ClubRole | null>(null);
  useEffect(() => {
    // Choosing or cancelling a role removes the focused button from the DOM.
    // Keep keyboard navigation in the same role interaction after each render.
    if (confirmRole) {
      roleConfirmationRef.current
        ?.querySelector<HTMLElement>(
          'input:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"])'
        )
        ?.focus();
    } else if (cancelledRoleRef.current) {
      roleButtonsRef.current.get(cancelledRoleRef.current)?.focus();
      cancelledRoleRef.current = null;
    }
  }, [confirmRole, editingRakeback]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // A percentage, not a fraction. Blank on purpose: a rate that arrives
  // pre-filled is a rate nobody chose. The promoter sets the agent's own rate
  // only; what the agent gives their players is the agent's to set
  // (Dan, 2026-10-15), from their agent dashboard.
  const [commissionPct, setCommissionPct] = useState('');
  // The operator chooses the funding agreement with the role and rate.
  const [funding, setFunding] = useState<'prepaid' | 'credit' | ''>('');
  const [creditLimit, setCreditLimit] = useState('');

  // ───────────────────────────────────────────────────────────────────────────
  // FUND THEM NOW?
  // ───────────────────────────────────────────────────────────────────────────
  // A promotion assigns the TERMS - commission, rakeback, prepaid or a credit
  // line. It does not put a single chip in the agent wallet. A credit LIMIT is
  // authorization, never an automatic transfer. The owner must deliberately
  // send chips through the audited club-bank cashier when they want to fund the
  // wallet; this prompt merely offers that separate action.
  //
  // Asked rather than done. Funding somebody is a transfer of chips and it is
  // not implied by choosing their commission rate, so this offers the step and
  // takes "Not Now" for an answer.
  const [fundPrompt, setFundPrompt] = useState<{ role: ClubRole } | null>(null);
  const [showFundModal, setShowFundModal] = useState(false);

  // CA-18 BUG FIX: the 1.2s "show success then refresh" timer was fire-and-forget.
  // If the user left the screen before 1.2s, the component unmounted and the
  // callback fired on a dead component tree.
  const roleChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (roleChangeTimerRef.current) clearTimeout(roleChangeTimerRef.current);
    };
  }, []);

  // The server decides what may be offered. fn_club_grantable_roles is the
  // rule; this asks it rather than guessing, so the buttons on screen and the
  // write that follows cannot disagree - and "is this player in my downline",
  // which the client has no way to answer, is answered where the tree lives.
  const [promotableRoles, setPromotableRoles] = useState<ClubRole[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [rolesLoadFailed, setRolesLoadFailed] = useState(false);
  const [rolesLoadAttempt, setRolesLoadAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    (async () => {
      setRolesLoading(true);
      setRolesLoadFailed(false);
      try {
        const roles = await ClubRosterService.getGrantableRoles(
          resolvedClubId,
          targetUserId,
          controller.signal
        );
        if (!live) return;
        setPromotableRoles(roles);
      } catch (e) {
        if (live) reportError(e, 'MemberManagementPage.grantable_roles');
        // Offering nothing is the safe direction to be wrong in: the user is
        // told, rather than shown a button the server will refuse.
        if (live) {
          setPromotableRoles([]);
          setRolesLoadFailed(true);
        }
      } finally {
        if (live) setRolesLoading(false);
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
    // targetRole is a dependency because the answer changes once the role does:
    // after promoting a player to agent, "agent" must stop being on offer.
  }, [resolvedClubId, targetUserId, targetRole, myRole, rolesLoadAttempt]);

  const canManage = promotableRoles.length > 0 && targetRole !== 'owner';

  const noRolesReason = rolesLoadFailed
    ? 'Role Options Could Not Be Loaded. Retry To Check Them Again.'
    : targetRole === 'owner'
      ? 'The Club Owner Cannot Be Changed From Here.'
      : roleRank(myRole) <= roleRank('sub_agent')
        ? 'Your Role Does Not Allow Changing Anyone Else’s.'
        : 'You Can Only Change The Role Of Players In Your Own Downline.';

  const handlePromote = async (newRole: ClubRole) => {
    setPromoting(true);
    setError('');
    setSuccess('');

    // THE RATE IS CHOSEN HERE OR IT IS NOT CHOSEN AT ALL.
    //
    // Dan, 2026-08-31: "MAKE SURE THAT RAKE BACK PERCENTAGES ARE ASSIGNED WHEN
    // CREATING THEM (CO-OWNERS AND ADMINS GET NO RAKE BACK)."
    //
    // This screen used to send the role and nothing else, and the server
    // invented a pair of rates - 50/30 for a super agent, 30/20 for the other
    // two - that nobody had agreed to, and applied them only when the agents
    // row did not already exist. fn_club_set_member_role now refuses an agent
    // role that arrives without a rate, so the two fields below are the whole
    // point of the confirm step rather than decoration on it.
    //
    // Dan, 2026-10-15: the owner assigns the AGENT's rate, which covers the
    // agent's own account and every sub agent under them; "THE AGENT ASSIGNS
    // WHAT THEY WANT TO GIVE THEIR PLAYERS, THIS SHOULDN'T BE DONE BY THE PERSON
    // PROMOTING THEM." So no player rakeback is sent; the server starts it at 0
    // and the agent sets it on their own dashboard (fn_agent_set_player_rakeback).
    let rates:
      | {
          p_commission_rate: number;
          p_is_prepaid: boolean;
          p_credit_limit: number;
        }
      | undefined;
    if (isAgentRole(newRole)) {
      const comm = Number(commissionPct);
      if (commissionPct.trim() === '') {
        setError('Enter The Agent Rakeback Percentage.');
        setPromoting(false);
        return;
      }
      if (!Number.isFinite(comm) || comm < 0 || comm > 70) {
        setError('The Agent Rakeback Must Be Between 0 And 70 Percent.');
        setPromoting(false);
        return;
      }
      if (!funding) {
        setError('Choose Prepaid Or A Credit Line.');
        setPromoting(false);
        return;
      }
      const limit = Number(creditLimit);
      if (
        funding === 'credit' &&
        (creditLimit.trim() === '' || !Number.isSafeInteger(limit) || limit <= 0)
      ) {
        setError('Enter A Credit Limit In Whole Chips Greater Than Zero.');
        setPromoting(false);
        return;
      }
      // The database stores a fraction. The field asks for a percentage.
      rates = {
        p_commission_rate: comm / 100,
        p_is_prepaid: funding === 'prepaid',
        p_credit_limit: funding === 'credit' ? limit : 0,
      };
    }

    try {
      // ONE WRITE PATH. This used to fall back to
      // `.from('club_members').update({ role })` whenever the RPC errored,
      // which skipped every rule the RPC enforces - a club admin could appoint
      // a co-owner, or promote outside their downline, by making one request
      // fail. A trigger on club_members now refuses that update outright, so
      // the fallback could not work even if someone put it back.
      const { data, error: rpcError } = await runWithRequestDeadline(
        (signal) =>
          supabase
            .rpc('fn_club_set_member_role', {
              p_club_id: resolvedClubId,
              p_user_id: targetUserId,
              p_role: newRole,
              ...(rates ?? {}),
            })
            .abortSignal(signal),
        { timeoutMs: 40_000 }
      );
      if (rpcError) throw rpcError;

      const result = data as { success?: boolean; error?: string } | null;
      if (!result?.success) throw new Error(result?.error || 'Role Change Refused');

      if (!isMountedRef.current) return;
      setSuccess(`${targetName} Is Now ${roleLabel(newRole)}`);
      setConfirmRole(null);
      toast.success(`${targetName} Is Now ${roleLabel(newRole)}`);

      // Listeners filter on payload.clubId === <uuid>; every other emitter
      // sends the resolved uuid, and this one sent the route slug.
      masterBus.emit('CLUB_UPDATED', { clubId: resolvedClubId });
      const agentRoles: ClubRole[] = ['super_agent', 'agent', 'sub_agent'];
      if (agentRoles.includes(newRole) || agentRoles.includes(targetRole)) {
        masterBus.emit('AGENT_UPDATED', { clubId: resolvedClubId, agentId: targetUserId });
      }
      masterBus.emit('MEMBER_ROLE_CHANGED', {
        clubId: resolvedClubId,
        userId: targetUserId,
        newRole,
        previousRole: targetRole,
      });

      // An agent who has just been given terms and no chips is the state this
      // phase exists to stop shipping quietly. Offer the funding step - but only
      // when the wallet really is empty, so re-grading an agent who is already
      // carrying float does not ask a question with an obvious answer.
      if (isAgentRole(newRole)) {
        let float_: number | null = null;
        try {
          const { data: agentRow, error: balanceError } = await runWithRequestDeadline(
            (signal) =>
              supabase
                .from('agents')
                .select('agent_wallet_balance')
                .eq('club_id', resolvedClubId)
                .eq('user_id', targetUserId)
                .abortSignal(signal)
                .maybeSingle(),
            { timeoutMs: 8_000 }
          );
          // Bound and acted on rather than discarded. supabase-js returns the
          // failure, it does not throw one, so an unbound `error` here would
          // read a missing row and a denied read as the same thing: zero. That
          // is the wrong direction to be silent in - "their wallet is empty" is
          // exactly the claim this prompt makes to the person's face.
          if (balanceError) throw balanceError;
          float_ = Number(agentRow?.agent_wallet_balance ?? 0) || 0;
        } catch (e) {
          // A balance we cannot read is not a reason to withhold the offer, and
          // not a reason to fail a promotion that already succeeded. Ask anyway:
          // the transfer screen reads the real number itself.
          reportError(e, 'MemberManagementPage.fundPromptBalance');
        }
        if (!isMountedRef.current) return;
        if (float_ === null || float_ <= 0) {
          setFundPrompt({ role: newRole });
          return; // The prompt owns what happens next, including the refresh.
        }
      }

      if (roleChangeTimerRef.current) clearTimeout(roleChangeTimerRef.current);
      roleChangeTimerRef.current = setTimeout(() => {
        roleChangeTimerRef.current = null;
        onRoleChanged();
      }, 1200);
    } catch (err) {
      if (isMountedRef.current) setError(safeErrorMessage(err, 'Failed To Update Role'));
    } finally {
      if (isMountedRef.current) setPromoting(false);
    }
  };

  return (
    <section className="mm-card mm-roles">
      <h2 className="mm-card__title">Role</h2>

      <div className="mm-roles__current">
        <span className="mm-roles__current-label">Current</span>
        <span className="mm-roles__current-value" style={{ color: roleColor(targetRole) }}>
          {roleLabel(targetRole)}
        </span>
      </div>

      {/* The offer. It takes the place of the role controls while it is up,
          because the promotion is already done and the only question left is
          whether to fund it now. */}
      {isAgentRole(targetRole) &&
        ['owner', 'co_owner', 'admin'].includes(myRole) &&
        !editingCredit &&
        !editingRakeback &&
        !confirmRole &&
        !fundPrompt && (
          <button
            type="button"
            className="mm-roles__confirm-no"
            disabled={promoting || rolesLoading || rolesLoadFailed}
            onClick={() => {
              setError('');
              setSuccess('');
              setEditingCredit(true);
            }}
          >
            Edit Credit Line
          </button>
        )}
      {editingCredit ? (
        <MemberCreditEditor
          key={`${resolvedClubId}:${targetUserId}:${targetRole}`}
          clubId={resolvedClubId}
          userId={targetUserId}
          role={targetRole}
          onClose={() => setEditingCredit(false)}
          onSaved={() => {
            setEditingCredit(false);
            setSuccess('Credit Line Updated');
            toast.success('Credit Line Updated');
            onRoleChanged();
          }}
        />
      ) : editingRakeback ? (
        <MemberRakebackEditor
          key={targetRole}
          clubId={resolvedClubId}
          userId={targetUserId}
          role={targetRole}
          onClose={() => {
            cancelledRoleRef.current = targetRole;
            setEditingRakeback(false);
          }}
          onSaved={() => {
            setEditingRakeback(false);
            setSuccess('Rakeback Updated');
            toast.success('Rakeback Updated');
            onRoleChanged();
          }}
        />
      ) : fundPrompt ? (
        <div className="mm-roles__fund">
          <p className="mm-roles__fund-title">
            {targetName} Is Now {roleLabel(fundPrompt.role)}
          </p>
          <p className="mm-roles__fund-note">
            Review Their Agent Wallet And Send Chips If Funding Is Needed. Fund Them Now?
          </p>
          <div className="mm-roles__confirm-actions">
            <button
              type="button"
              className="mm-roles__confirm-yes"
              onClick={() => setShowFundModal(true)}
            >
              Send Chips
            </button>
            <button
              type="button"
              className="mm-roles__confirm-no"
              onClick={() => {
                setFundPrompt(null);
                onRoleChanged();
              }}
            >
              Not Now
            </button>
          </div>
        </div>
      ) : rolesLoading ? (
        <p className="mm-roles__note">Checking What You May Grant...</p>
      ) : !canManage ? (
        <>
          <button
            type="button"
            className="mm-roles__option mm-roles__option--current"
            aria-current="true"
            ref={(button) => {
              if (button) roleButtonsRef.current.set(targetRole, button);
              else roleButtonsRef.current.delete(targetRole);
            }}
            disabled={rolesLoadFailed || !(targetRole === 'player' || isAgentRole(targetRole))}
            onClick={() => setEditingRakeback(true)}
          >
            <RoleBadge role={targetRole} size="sm" />
            <span className="mm-roles__option-main">
              <span className="mm-roles__option-name">{roleLabel(targetRole)} (Current)</span>
              <span className="mm-roles__option-desc">
                {toTitleCase(ROLE_DESCRIPTION[targetRole])}
              </span>
            </span>
          </button>
          <p className="mm-roles__note">{noRolesReason}</p>
          {rolesLoadFailed && (
            <button
              type="button"
              className="mm-roles__confirm-no"
              onClick={() => setRolesLoadAttempt((attempt) => attempt + 1)}
            >
              Retry Role Options
            </button>
          )}
        </>
      ) : confirmRole ? (
        <div className="mm-roles__confirm" ref={roleConfirmationRef}>
          <p>
            Change <strong>{targetName}</strong> To{' '}
            <strong style={{ color: roleColor(confirmRole) }}>{roleLabel(confirmRole)}</strong>?
          </p>

          {isAgentRole(confirmRole) && (
            <div className="mm-roles__rates">
              <p className="mm-roles__rates-note">
                Set The Deal Now. The Server Will Not Accept An Agent Without One.
              </p>
              <label className="mm-field">
                <span className="mm-field__label">Agent Rakeback Percent (0 To 70)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={70}
                  step={1}
                  value={commissionPct}
                  placeholder="E.G. 40"
                  onChange={(e) => setCommissionPct(e.target.value)}
                  disabled={promoting}
                />
              </label>
              <p className="mm-roles__rates-note">
                This Rate Covers The Agent Account And Every Sub Agent Under Them. The Agent Sets
                The Rakeback Their Players Receive From Their Agent Dashboard.
              </p>
              <label className="mm-field">
                <span className="mm-field__label">Funding</span>
                <select
                  className="mm-assign__select"
                  value={funding}
                  disabled={promoting}
                  onChange={(event) => setFunding(event.target.value as typeof funding)}
                >
                  <option value="">Choose Prepaid Or A Credit Line</option>
                  <option value="prepaid">Prepaid</option>
                  <option value="credit">Credit Line</option>
                </select>
              </label>
              {funding === 'credit' && (
                <label className="mm-field">
                  <span className="mm-field__label">Credit Limit In Chips</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={creditLimit}
                    disabled={promoting}
                    onChange={(event) => setCreditLimit(event.target.value)}
                  />
                </label>
              )}
              <p className="mm-roles__rates-note">
                A Credit Line Authorizes Borrowing. It Does Not Transfer Chips.
              </p>

              <p className="mm-roles__rates-note">
                The Agent Rakeback Cannot Exceed The Upline They Report To.
              </p>
            </div>
          )}

          {isClubStaff(confirmRole) && (
            <p className="mm-roles__rates-note">
              This Role Earns No Rakeback. Any Rate This Member Carries Is Set To Zero.
            </p>
          )}

          <div className="mm-roles__confirm-actions">
            <button
              type="button"
              className="mm-roles__confirm-yes"
              onClick={() => void handlePromote(confirmRole)}
              disabled={promoting}
            >
              {promoting ? 'Updating...' : 'Confirm'}
            </button>
            <button
              type="button"
              className="mm-roles__confirm-no"
              onClick={() => {
                cancelledRoleRef.current = confirmRole;
                setConfirmRole(null);
              }}
              disabled={promoting}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mm-roles__list">
          {Array.from(new Set([...promotableRoles, targetRole])).map((role) => (
            <button
              key={role}
              type="button"
              ref={(button) => {
                if (button) roleButtonsRef.current.set(role, button);
                else roleButtonsRef.current.delete(role);
              }}
              className={`mm-roles__option${role === targetRole ? ' mm-roles__option--current' : ''}`}
              onClick={() => {
                setError('');
                if (role === targetRole) {
                  setEditingRakeback(true);
                  return;
                }
                setCommissionPct('');
                setFunding('');
                setCreditLimit('');
                setConfirmRole(role);
              }}
              aria-current={role === targetRole ? 'true' : undefined}
              disabled={
                promoting || (role === targetRole && !(role === 'player' || isAgentRole(role)))
              }
            >
              <RoleBadge role={role} size="sm" />
              <span className="mm-roles__option-main">
                <span className="mm-roles__option-name" style={{ color: roleColor(role) }}>
                  {roleLabel(role)}
                  {role === targetRole ? ' (Current)' : ''}
                </span>
                <span className="mm-roles__option-desc">{toTitleCase(ROLE_DESCRIPTION[role])}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="mm-roles__error">{error}</p>}
      {success && <p className="mm-roles__success">{success}</p>}

      {/* The transfer screen itself, aimed at the person just promoted. It
          reads the real balances and routes the send by role, so nothing about
          the money is re-decided here. */}
      {showFundModal && (
        <ChipTransferModal
          isOpen={showFundModal}
          clubId={resolvedClubId}
          recipientId={targetUserId}
          onClose={() => {
            setShowFundModal(false);
            setFundPrompt(null);
            onRoleChanged();
          }}
          onTransferComplete={() => {
            toast.success(`${targetName} Has Been Funded.`);
            masterBus.emit('AGENT_UPDATED', { clubId: resolvedClubId, agentId: targetUserId });
          }}
        />
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SMALL PARTS
   ═══════════════════════════════════════════════════════════════════════════════ */

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="mm-info">
      <span className="mm-info__label">{label}</span>
      <span className="mm-info__value">{value}</span>
    </div>
  );
}

/**
 * `signed` is the raw number behind `value`, supplied only for figures that can
 * legitimately go below zero. Positive reads arena cyan and negative reads
 * --danger-red; there is no green in this product, so "up" is the primary colour
 * rather than a second hue nobody else uses.
 */
function StatRow({ label, value, signed }: { label: string; value: string; signed?: number }) {
  const tone =
    signed === undefined || signed === 0 ? '' : signed > 0 ? ' mm-stat--up' : ' mm-stat--down';

  return (
    <div className={`mm-stat${tone}`}>
      <span className="mm-stat__label">{label}</span>
      <span className="mm-stat__value">{value}</span>
    </div>
  );
}
