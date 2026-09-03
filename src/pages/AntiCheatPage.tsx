/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Anti-Cheat Dashboard
 *  5 Tabs: Overview | Flags | Events | Collusion | Anomalies
 *  Ported from World Hub native page → Club Arena TSX
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { confirmDialog } from '../components/common/confirmDialog';
import styles from './AntiCheatPage.module.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { fmt, fmtChips, timeAgo } from '../utils/format';
import { isAuthzError } from '../utils/clubDashboard';
import { adminRemovePlayerFromClubTables } from '../services/IntegrityActionService';
import { reportError } from '../utils/errorReporter';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';

type Severity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_MAP: Record<Severity, { bg: string; color: string; label: string }> = {
  critical: { bg: 'rgba(228,30,63,0.15)', color: '#FA383E', label: 'Critical' },
  high: { bg: 'rgba(245,166,35,0.15)', color: '#F5A623', label: 'High' },
  medium: { bg: 'rgba(247,197,42,0.15)', color: '#F7C52A', label: 'Medium' },
  low: { bg: 'rgba(69,153,255,0.15)', color: '#4599FF', label: 'Low' },
};

function SeverityBadge({ severity }: { severity: string }) {
  const sev = SEVERITY_MAP[severity as Severity] || SEVERITY_MAP.low;
  return (
    <span className={styles.severityBadge} style={{ background: sev.bg, color: sev.color }}>
      {sev.label}
    </span>
  );
}

// ── Types ───────────────────────────────────────────────────
/**
 * The columns `anti_cheat_flags` actually has.
 *
 * This interface used to declare `details: Record<string, unknown> | null`,
 * and the review dialog rendered it as the evidence block. That column does
 * not exist on the table - the evidence a flag carries is `reason` - so the
 * block has been `undefined && ...` since it shipped, and no reviewer has ever
 * seen why a flag was raised while deciding what to do about it.
 */
interface AntiCheatFlag {
  id: string;
  player_id: string;
  club_id: string | null;
  table_id: string | null;
  flag_type: string;
  reason: string | null;
  severity: string;
  status: string;
  flagged_at: string;
  created_at?: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_notes?: string | null;
  player?: { display_name?: string };
}

interface AntiCheatEvent {
  id: string;
  player_id: string | null;
  event_type: string;
  details: Record<string, unknown> | null;
  created_at: string;
  player?: { display_name?: string };
}

interface CollusionPair {
  dumper_id: string;
  receiver_id: string;
  pattern_type: string;
  hands_together: number;
  score: number;
  chip_flow_ratio: number;
  severity: string;
  /* Whatever the detector that raised this pair actually recorded. CHIP_DUMP
     writes hands / loser_loss_ratio / pot_volume; WIN_RATE_ANOMALY writes
     bb_per_100 / direction / hands_together. The old UI printed a
     `net_chips_transferred` column that no detector has ever written, so
     COALESCE made it a column of zeroes. */
  evidence: Record<string, unknown> | null;
}

interface CollusionGroup {
  total: number;
  pairs: CollusionPair[];
}

interface CollusionReading {
  analyzed_hands: number;
  club_players: number;
  window_days: number;
  threshold: number;
  cap: number;
  /** Pairs the detector already closed out in this window. Shown so an empty
   *  queue reads as "the screen ran and closed itself" rather than "nothing
   *  was screened". 169,519 of them were auto-cleared on 2026-08-18 when the
   *  detector was fixed at write time to stop raising horse-versus-horse. */
  closed_pairs: number;
  chip_dump: CollusionGroup;
  /** Every pattern that is not CHIP_DUMP. There are seven pattern types and
   *  each row carries its own, so this is not "win rate" - three of the seven
   *  rows currently open on the estate are TIMING_CORRELATION. */
  screening: CollusionGroup;
}

interface Anomaly {
  hand_id: string;
  player_id: string;
  hand_rank: string;
  pot_total: number;
  completed_at: string;
  severity: string;
}

interface Stats {
  open_flags: number;
  blocks_24h: number;
  active_sessions: number;
  by_severity: Record<string, number>;
  by_type: Record<string, number>;
}

/**
 * What the detector actually recorded, in words. CHIP_DUMP writes hands,
 * loser_loss_ratio and pot_volume; WIN_RATE_ANOMALY writes bb_per_100 and
 * direction. Nothing writes net chips transferred, which is why the column
 * that used to sit here always read zero.
 */
export function evidenceSummary(pair: { evidence?: Record<string, unknown> | null }): string {
  const e = pair.evidence || {};
  const num = (key: string): number | null => {
    const raw = e[key];
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const parts: string[] = [];
  const loss = num('loser_loss_ratio');
  if (loss !== null) parts.push(`Loss Ratio ${(loss * 100).toFixed(0)}%`);
  const pot = num('pot_volume');
  if (pot !== null) parts.push(`Pot Volume ${fmt(pot)}`);
  const bb = num('bb_per_100');
  if (bb !== null) parts.push(`${bb.toFixed(1)} BB Per 100`);
  const close = num('close_ratio');
  if (close !== null) parts.push(`Close Actions ${(close * 100).toFixed(0)}%`);
  if (typeof e.direction === 'string' && e.direction) parts.push(`Direction ${e.direction}`);
  return parts.length > 0 ? parts.join(' \u00b7 ') : 'No Evidence Recorded';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function AntiCheatPage() {
  const { user } = useAuthUser();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  /**
   * THE ROUTE PARAM WINS.
   *
   * This page resolved its club from ?club= or, failing that, whichever
   * club_members row came back first - which is right for the legacy global
   * URL and wrong the moment it is opened from a club's own operations rail.
   * Phase 7 gives it clubs/:clubId/anti-cheat, so the club being looked at is
   * now stated in the URL and must take precedence over a guess.
   */
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();

  // ── State ─────────────────────────────────────────────
  const [tab, setTab] = useState<'overview' | 'flags' | 'events' | 'collusion' | 'anomalies'>(
    'overview'
  );
  const [loading, setLoading] = useState(true);
  const [clubId, setClubId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  /* An integrity page that cannot read must say so. "Nothing found" and "the
     read failed" used to render identically here, and the second one printed
     the words "Club Is Clean". */
  const [loadError, setLoadError] = useState<string | null>(null);

  // Overview
  const [stats, setStats] = useState<Stats | null>(null);

  // Flags
  const [flags, setFlags] = useState<AntiCheatFlag[]>([]);
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const [flagFilter, setFlagFilter] = useState('open');

  // Events
  const [events, setEvents] = useState<AntiCheatEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);

  // Collusion
  const [collusion, setCollusion] = useState<CollusionReading | null>(null);
  const [collusionLoaded, setCollusionLoaded] = useState(false);

  // Anomalies
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [anomaliesLoaded, setAnomaliesLoaded] = useState(false);

  // Review Modal
  const [reviewTarget, setReviewTarget] = useState<AntiCheatFlag | null>(null);
  const [reviewStatus, setReviewStatus] = useState('reviewed');
  const [reviewNotes, setReviewNotes] = useState('');

  const mountedRef = useIsMounted();

  const loadingRef = useRef(false);

  // ── Load Stats ──────────────────────────────────────────
  const loadStats = useCallback(
    async (cId?: string) => {
      const targetClub = cId || clubId;
      if (!targetClub) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        setLoading(true);
        const { data, error } = await retryFetch(
          () =>
            supabase
              .rpc('get_anti_cheat_stats', {
                p_club_id: targetClub,
              })
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );
        if (error) throw error;
        if (mountedRef.current) setStats(data || null);
      } catch (err: unknown) {
        /* A read that failed and a club with nothing to report used to look
           identical: this fallback painted six zeros, and the panel below
           renders "Club Is Clean" whenever open_flags is 0. An operator cannot
           tell a quiet club from a broken page, so now it says which it is. */
        reportError(err, 'AntiCheatPage.Stats_load_failed');
        if (mountedRef.current) {
          setStats(null);
          setLoadError(
            isAuthzError(err)
              ? 'Integrity Review Is Restricted To Club Owners And Administrators'
              : 'The Integrity Readings Could Not Be Loaded'
          );
        }
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [clubId]
  );

  // ── Load Flags ──────────────────────────────────────────
  const loadFlags = useCallback(
    async (status?: string) => {
      if (!clubId) return;
      try {
        /* anti_cheat_flags grants `authenticated` one policy - read the flags
           raised against YOURSELF - so a direct club read returned nothing to
           the operator no matter what club_id was passed. All fourteen rows on
           the estate also carry club_id NULL and table_id NULL: they are
           multi_account flags about a person, with nothing to derive a club
           from. fn_club_anti_cheat_flags scopes them the way phase 1 scoped a
           player report - your flag when the flagged player is your member -
           inside a definer function, so the table itself stays closed. */
        const filterStatus = status || flagFilter;
        const { data, error } = await supabase.rpc('fn_club_anti_cheat_flags', {
          p_club_id: clubId,
          p_status: filterStatus,
          p_limit: 50,
        });
        if (error) throw error;

        // Batch-fetch player profiles (no FK hint needed)
        if (data && data.length > 0) {
          const playerIds = [
            ...new Set(data.map((f: AntiCheatFlag) => f.player_id).filter(Boolean)),
          ];
          const playerNames: Record<string, string> = {};
          if (playerIds.length > 0) {
            try {
              const { data: profiles } = await supabase
                .from('profiles')
                .select(`id, ${PLAYER_NAME_COLUMNS}`)
                .in('id', playerIds);
              if (profiles) {
                for (const p of profiles) playerNames[p.id] = playerDisplayName(p);
              }
            } catch (e) {
              reportError(e, 'AntiCheatPage.Set');
              /* non-critical */
            }
          }
          if (mountedRef.current) {
            setFlags(
              data.map((f: AntiCheatFlag) => ({
                ...f,
                player: { display_name: playerNames[f.player_id] },
              }))
            );
            setFlagsLoaded(true);
          }
        } else if (mountedRef.current) {
          setFlags([]);
          setFlagsLoaded(true);
        }
      } catch (err: unknown) {
        console.warn(
          '[AntiCheat] Flags load failed:',
          err instanceof Error ? err.message : String(err)
        );
        if (mountedRef.current) {
          setFlags([]);
          setFlagsLoaded(true);
        }
      }
    },
    [clubId, flagFilter]
  );

  // ── Load Events ──────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data, error } = await supabase
        .from('anti_cheat_events')
        .select('*, player_id')
        .eq('club_id', clubId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      // Batch-fetch player profiles (no FK hint needed)
      if (data && data.length > 0) {
        const playerIds = [
          ...new Set(data.map((e: AntiCheatEvent) => e.player_id).filter(Boolean)),
        ];
        const playerNames: Record<string, string> = {};
        if (playerIds.length > 0) {
          try {
            const { data: profiles } = await supabase
              .from('profiles')
              .select(`id, ${PLAYER_NAME_COLUMNS}`)
              .in('id', playerIds);
            if (profiles) {
              for (const p of profiles) playerNames[p.id] = playerDisplayName(p);
            }
          } catch (e) {
            reportError(e, 'AntiCheatPage.Set');
            /* non-critical */
          }
        }
        if (mountedRef.current) {
          setEvents(
            data.map((e: AntiCheatEvent) => ({
              ...e,
              player: { display_name: e.player_id ? playerNames[e.player_id] : undefined },
            }))
          );
          setEventsLoaded(true);
        }
      } else if (mountedRef.current) {
        setEvents([]);
        setEventsLoaded(true);
      }
    } catch (err: unknown) {
      console.warn(
        '[AntiCheat] Events load failed:',
        err instanceof Error ? err.message : String(err)
      );
      if (mountedRef.current) {
        setEvents([]);
        setEventsLoaded(true);
      }
    }
  }, [clubId]);

  // ── Load Collusion ──────────────────────────────────────
  const loadCollusion = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .rpc('detect_collusion_pairs', {
              p_club_id: clubId,
              p_threshold: 0.75,
              p_min_hands: 5,
            })
            .then((r) => r),
        { maxRetries: 2, isMountedRef: mountedRef }
      );
      if (error) throw error;
      if (mountedRef.current) {
        setCollusion((data || null) as CollusionReading | null);
        setCollusionLoaded(true);
      }
    } catch (err: unknown) {
      reportError(err, 'AntiCheatPage.Collusion_load_failed');
      if (mountedRef.current) {
        setCollusion(null);
        setCollusionLoaded(true);
        setLoadError(
          isAuthzError(err)
            ? 'Integrity Review Is Restricted To Club Owners And Administrators'
            : 'The Collusion Screen Could Not Be Loaded'
        );
      }
    }
  }, [clubId]);

  /* A pair the operator has looked at and cleared. collusion_tracking carries
     status / reviewed_by / notes and nothing in this app has ever written them,
     so a screened pair came back every single load with no way to work the
     queue down. */
  const dismissPair = useCallback(
    async (pair: CollusionPair) => {
      if (!clubId) return;
      if (
        !(await confirmDialog({
          title: 'Clear This Pair',
          message:
            'Mark this pair as reviewed and clear it from the screen? It will return if the detector raises it again in a later scan.',
          confirmText: 'Clear Pair',
        }))
      )
        return;
      setProcessing(true);
      try {
        const { data, error } = await supabase.rpc('fn_ca_dismiss_collusion_pair', {
          p_club_id: clubId,
          p_player_a: pair.dumper_id,
          p_player_b: pair.receiver_id,
          p_note: null,
        });
        if (error) throw error;
        const outcome = (data || {}) as { ok?: boolean; updated?: number };
        if (!outcome.ok) throw new Error('That pair could not be cleared.');
        toast.success(`Cleared ${fmt(outcome.updated || 0)} Screening Rows.`);
        setCollusionLoaded(false);
        void loadCollusion();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setProcessing(false);
      }
    },
    [clubId, loadCollusion, toast]
  );

  // ── Load Anomalies ──────────────────────────────────────
  const loadAnomalies = useCallback(async () => {
    if (!clubId) return;
    try {
      const { data, error } = await retryFetch(
        () =>
          supabase
            .rpc('detect_suspicious_plays', {
              p_club_id: clubId,
              p_limit: 500,
            })
            .then((r) => r),
        { maxRetries: 2, isMountedRef: mountedRef }
      );
      if (error) throw error;
      if (mountedRef.current) {
        setAnomalies(data || []);
        setAnomaliesLoaded(true);
      }
    } catch (err: unknown) {
      console.warn(
        '[AntiCheat] Anomalies load failed:',
        err instanceof Error ? err.message : String(err)
      );
      if (mountedRef.current) {
        setAnomalies([]);
        setAnomaliesLoaded(true);
      }
    }
  }, [clubId]);

  // ── Initial Load ──────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    let isMounted = true;

    const init = async () => {
      const qClub = routeClubId || searchParams.get('club') || searchParams.get('clubId');
      let targetClub = qClub;

      if (!targetClub) {
        const { data: mem } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();
        targetClub = mem?.club_id || null;
      }

      /* THE PAGE USED TO SET THE ROUTE PARAM STRAIGHT INTO clubId.
         Club routes are addressed by slug (deep-stack-society-11192), and every
         read on this page passes clubId into a uuid argument or an .eq on a
         uuid column, so Postgres answered 22P02 invalid input syntax for type
         uuid and every catch block below turned that into an empty state. The
         page has shown six zeros and "Club Is Clean" on every slug URL since it
         shipped. The realtime filter twenty lines down already resolved it. */
      let resolvedClub: string | null = null;
      if (targetClub) {
        try {
          resolvedClub = await resolveClubUUID(targetClub);
        } catch (resolveError) {
          reportError(resolveError, 'AntiCheatPage.Club_resolve_failed');
          resolvedClub = null;
        }
      }

      if (resolvedClub && isMounted) {
        setClubId(resolvedClub);
        loadStats(resolvedClub);
      } else if (isMounted) {
        toast.error('No club found.');
        setLoadError('This Club Could Not Be Identified');
        setLoading(false);
      }
    };

    init();
    return () => {
      isMounted = false;
    };
  }, [user, searchParams, routeClubId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Lazy Tab Loading ──────────────────────────────────────
  useEffect(() => {
    if (!clubId) return;
    if (tab === 'flags' && !flagsLoaded) loadFlags();
    if (tab === 'events' && !eventsLoaded) loadEvents();
    if (tab === 'collusion' && !collusionLoaded) loadCollusion();
    if (tab === 'anomalies' && !anomaliesLoaded) loadAnomalies();
  }, [
    tab,
    clubId,
    flagsLoaded,
    eventsLoaded,
    collusionLoaded,
    anomaliesLoaded,
    loadFlags,
    loadEvents,
    loadCollusion,
    loadAnomalies,
  ]);

  // ── Reload flags when filter changes ──────────────────────
  useEffect(() => {
    if (flagsLoaded && clubId) loadFlags(flagFilter);
  }, [flagFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Visibility Refresh ────────────────────────────────────
  useVisibilityRefresh(async () => {
    if (!clubId) return;
    loadStats(clubId);
  });

  // ── Realtime Listeners (debounced) ─────────────────────────
  useEffect(() => {
    if (!clubId) return;

    const unsubs = [
      // ANTI_CHEAT_FLAG_CREATED listener removed 2026-08-28: nothing emits it
      // on the client bus (flags are created server-side), so it never fired.
      masterBus.subscribeDebounced(
        'PLAYER_KICKED',
        () => {
          loadStats(clubId);
        },
        500
      ),
      // Phase 4: Cross-page sync (ported from World Hub anti-cheat.js)
      masterBus.subscribeDebounced('TABLE_CREATED', () => loadStats(clubId), 500),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', () => loadStats(clubId), 500),
    ];

    return () => unsubs.forEach((u) => u());
  }, [clubId, loadStats]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `anti-cheat-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'anti_cheat_flags',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            loadStats(clubId);
            setFlagsLoaded(false);
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'anti_cheat_events',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => setEventsLoaded(false)
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'AntiCheatPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[AntiCheatPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[AntiCheatPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadStats]);

  // ── Actions ────────────────────────────────────────────────
  const reviewFlag = async () => {
    if (!reviewTarget || !clubId) return;
    setProcessing(true);
    try {
      /* This used to be a client UPDATE against a table with no UPDATE policy
         for `authenticated`: PostgREST answered 204, zero rows, no error, and
         the toast below claimed the decision had been recorded. It never had
         been. The RPC returns { ok } and a zero-row write is a failure. */
      const { data, error } = await supabase.rpc('fn_review_anti_cheat_flag', {
        p_club_id: clubId,
        p_flag_id: reviewTarget.id,
        p_status: reviewStatus,
        p_notes: reviewNotes || null,
      });
      if (error) throw error;
      const outcome = (data || {}) as { ok?: boolean; reason?: string };
      if (!outcome.ok) {
        throw new Error(
          outcome.reason === 'flag_not_in_this_club'
            ? 'That flag does not belong to this club.'
            : 'The review could not be recorded.'
        );
      }

      toast.success(`Flag ${reviewStatus} successfully.`);
      setReviewTarget(null);
      setReviewNotes('');
      setFlagsLoaded(false);
      loadFlags();
      loadStats(clubId);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };

  /**
   * REMOVING A PLAYER IS THE ENGINE'S JOB, AND IT ALREADY HAD ONE.
   *
   * This used to stamp `left_at` and status 'kicked' straight onto table_seats.
   * That is the exact write CLAUDE.md 11.5 exists to forbid: closing a seat
   * without going through a cash-out destroys the stack sitting in it, and the
   * `ca_seat_stack_exits` trigger files every such exit as a critical
   * reconciliation failure. It also never had a tableId - every call site
   * passed only a player - so the seat branch was skipped entirely and the
   * compensating anti_cheat_events insert was refused by RLS (service-role
   * only). Nothing was removed, nothing was logged, and the operator was told
   * "Player removed."
   *
   * POST /admin/kick on the engine has done this correctly since Round 68: it
   * verifies club-admin from the caller's own token, auto-folds a player who is
   * mid-hand, cashes the stack out between hands, and writes the
   * anti_cheat_events audit row itself. This finds the tables the player is
   * actually sitting at in THIS club and asks the engine to remove them.
   */
  const kickPlayer = async (playerId: string) => {
    if (!clubId) return;
    setProcessing(true);
    try {
      const { data: seats, error: seatError } = await supabase
        .from('table_seats')
        .select('table_id, tables!inner(club_id, status)')
        .eq('user_id', playerId)
        .is('left_at', null)
        .eq('tables.club_id', clubId);
      if (seatError) throw seatError;

      const tableIds = [
        ...new Set(((seats || []) as Array<{ table_id: string }>).map((row) => row.table_id)),
      ];
      if (tableIds.length === 0) {
        toast.info('This Player Is Not Seated At Any Table In This Club.');
        return;
      }

      if (
        !(await confirmDialog({
          title: 'Remove Player From Play',
          message: `Remove this player from ${tableIds.length} live table${
            tableIds.length === 1 ? '' : 's'
          }? Their stack is cashed out to their club wallet and the removal is recorded against your account.`,
          confirmText: 'Remove Player',
          variant: 'danger',
        }))
      )
        return;

      const outcome = await adminRemovePlayerFromClubTables(
        tableIds,
        playerId,
        'Anti-cheat review - removed by club admin'
      );
      if (outcome.removed === 0) {
        throw new Error(outcome.firstError || 'The engine did not remove this player.');
      }
      if (outcome.failed > 0) {
        toast.warning(
          `Removed From ${fmt(outcome.removed)} Of ${fmt(tableIds.length)} Tables. ${
            outcome.firstError || ''
          }`.trim()
        );
      } else {
        toast.success(`Player Removed From ${fmt(outcome.removed)} Table(s).`);
      }
      masterBus.emit('PLAYER_KICKED', { clubId: clubId ?? '', userId: playerId });
      setEventsLoaded(false);
      loadStats(clubId);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };

  // ── Refresh All ────────────────────────────────────────────
  const handleRefresh = () => {
    if (!clubId) return;
    loadStats(clubId);
    setFlagsLoaded(false);
    setEventsLoaded(false);
    setCollusionLoaded(false);
    setAnomaliesLoaded(false);
  };

  // ── Loading ────────────────────────────────────────────────
  if (loading && !stats) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className={styles.page}>
      {/* ── Page Header ──────────────────────────────── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            Anti-Cheat Dashboard
            {stats && stats.open_flags > 0 && (
              <span className={styles.badgeRed}>{stats.open_flags} Open</span>
            )}
          </h1>
        </div>
        <div className={styles.headerActions}>
          <Link to="/" className={styles.btnGhost}>
            Lobby
          </Link>
          <Link to="/admin" className={styles.btnGhost}>
            ⚙ Admin
          </Link>
          <button onClick={handleRefresh} className={styles.btnGhost}>
            ↻ Refresh
          </button>
          <button
            className={styles.btnGhost}
            onClick={() => {
              try {
                if (tab === 'flags' && flags.length > 0) {
                  exportToCSV(flags, 'anti_cheat_flags.csv', [
                    { key: 'severity', label: 'Severity' },
                    { key: 'flag_type', label: 'Type' },
                    { key: 'reason', label: 'Reason' },
                    { key: 'status', label: 'Status' },
                    { key: 'player_id', label: 'Player ID' },
                    { key: 'flagged_at', label: 'Flagged At' },
                    { key: 'review_notes', label: 'Review Notes' },
                  ]);
                } else if (tab === 'events' && events.length > 0) {
                  exportToCSV(events, 'anti_cheat_events.csv', [
                    { key: 'event_type', label: 'Type' },
                    { key: 'player_id', label: 'Player ID' },
                    { key: 'created_at', label: 'Time' },
                  ]);
                } else if (
                  tab === 'collusion' &&
                  collusion &&
                  collusion.chip_dump.pairs.length + collusion.screening.pairs.length > 0
                ) {
                  /* The old export carried a Net Chips column that no detector
                     has ever written, so every row said 0.00. */
                  exportToCSV(
                    [...collusion.chip_dump.pairs, ...collusion.screening.pairs].map((pair) => ({
                      ...pair,
                      evidence_summary: evidenceSummary(pair),
                    })),
                    'collusion_pairs.csv',
                    [
                      { key: 'pattern_type', label: 'Pattern' },
                      { key: 'dumper_id', label: 'Player A' },
                      { key: 'receiver_id', label: 'Player B' },
                      { key: 'hands_together', label: 'Hands Together' },
                      { key: 'score', label: 'Score' },
                      { key: 'severity', label: 'Severity' },
                      { key: 'evidence_summary', label: 'Evidence' },
                    ]
                  );
                } else if (tab === 'anomalies' && anomalies.length > 0) {
                  exportToCSV(anomalies, 'anomalies.csv', [
                    { key: 'player_id', label: 'Player ID' },
                    { key: 'hand_rank', label: 'Hand Rank' },
                    { key: 'pot_total', label: 'Pot' },
                    { key: 'severity', label: 'Severity' },
                    { key: 'completed_at', label: 'Time' },
                  ]);
                } else {
                  toast.info?.('No data to export from this tab');
                }
              } catch (e) {
                reportError(e, 'AntiCheatPage');
                /* silent */
              }
            }}
          >
            Export
          </button>
        </div>
      </header>

      {/* ── Review Flag Modal ────────────────────────── */}
      {reviewTarget && (
        <div className={styles.modalOverlay} onClick={() => !processing && setReviewTarget(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>Review Flag</h2>
            <div className={styles.modalBody}>
              <div className={styles.reviewHeader}>
                <SeverityBadge severity={reviewTarget.severity} />
                <span className={styles.flagType}>{reviewTarget.flag_type}</span>
              </div>
              <p className={styles.reviewPlayer}>
                Player:{' '}
                {reviewTarget.player?.display_name ||
                  reviewTarget.player_id?.substring(0, 8) ||
                  '-'}
              </p>
              <pre className={styles.detailsBlock}>
                {reviewTarget.reason || 'This Flag Was Raised Without A Stated Reason'}
              </pre>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Action</label>
              <select
                className={styles.formSelect}
                value={reviewStatus}
                onChange={(e) => setReviewStatus(e.target.value)}
              >
                <option value="reviewed">Mark Reviewed</option>
                <option value="dismissed">Dismiss</option>
                <option value="actioned">Actioned</option>
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>Notes (Optional)</label>
              <input
                className={styles.formInput}
                placeholder="Add Review Notes..."
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
              />
            </div>
            <div className={styles.modalActions}>
              <button
                onClick={() => setReviewTarget(null)}
                className={styles.btnGhost}
                disabled={processing}
              >
                Cancel
              </button>
              <button onClick={reviewFlag} className={styles.btnPrimary} disabled={processing}>
                {processing ? 'Submitting...' : 'Submit Review'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────── */}
      <nav className={styles.tabNav}>
        {[
          { id: 'overview' as const, label: 'Overview' },
          { id: 'flags' as const, label: 'Flags', badge: stats?.open_flags || 0 },
          { id: 'events' as const, label: 'Events' },
          { id: 'collusion' as const, label: 'Collusion' },
          { id: 'anomalies' as const, label: 'Anomalies' },
        ].map((t) => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge ? <span className={styles.tabBadge}>{t.badge}</span> : null}
          </button>
        ))}
      </nav>

      {/* ═══════════════ TAB: OVERVIEW ════════════════ */}
      {tab === 'overview' && (
        <div className={styles.section}>
          {!stats && loading ? (
            <PageSkeleton variant="list" />
          ) : !stats ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyText}>
                {loadError || 'The Integrity Readings Could Not Be Loaded'}
              </span>
            </div>
          ) : (
            <>
              <div className={styles.statsGrid}>
                <div className={styles.statCard}>
                  <div className={styles.statValueRed}>{fmt(stats.open_flags)}</div>
                  <div className={styles.statLabel}>Open Flags</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueGold}>{fmt(stats.blocks_24h)}</div>
                  <div className={styles.statLabel}>Enforcement (24H)</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueGreen}>{fmt(stats.active_sessions)}</div>
                  <div className={styles.statLabel}>Players Seated Now</div>
                </div>
              </div>

              {/* Severity Breakdown */}
              {Object.keys(stats.by_severity || {}).length > 0 && (
                <div className={styles.subsection}>
                  <h3 className={styles.subsectionTitle}>Flags By Severity</h3>
                  <div className={styles.statsGrid}>
                    {Object.entries(stats.by_severity).map(([sev, count]) => {
                      const st = SEVERITY_MAP[sev as Severity] || {};
                      return (
                        <div
                          key={sev}
                          className={styles.statCard}
                          style={{ borderLeft: `3px solid ${st.color || '#6B7280'}` }}
                        >
                          <div className={styles.statValue} style={{ color: st.color }}>
                            {fmt(count)}
                          </div>
                          <div className={styles.statLabel} style={{ textTransform: 'capitalize' }}>
                            {sev}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Flags by Type */}
              {Object.keys(stats.by_type || {}).length > 0 && (
                <div className={styles.subsection}>
                  <h3 className={styles.subsectionTitle}>Flags By Type</h3>
                  <div className={styles.tableScroll}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(stats.by_type)
                          .sort((a, b) => b[1] - a[1])
                          .map(([type, count]) => (
                            <tr key={type}>
                              <td style={{ fontWeight: 600 }}>{type}</td>
                              <td>{fmt(count)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {stats.open_flags === 0 && (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>✓</span>
                  <span className={styles.emptyText}>
                    No Open Integrity Flags Against Members Of This Club
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: FLAGS ═══════════════════ */}
      {tab === 'flags' && (
        <div className={styles.section}>
          <div className={styles.filterBar}>
            {['open', 'reviewed', 'dismissed', 'actioned', 'all'].map((f) => (
              <button
                key={f}
                className={flagFilter === f ? styles.btnPrimary : styles.btnGhost}
                onClick={() => setFlagFilter(f)}
                style={{ textTransform: 'capitalize' }}
              >
                {f}
              </button>
            ))}
          </div>

          {!flagsLoaded ? (
            <PageSkeleton variant="list" />
          ) : flags.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>▸</span>
              <span className={styles.emptyText}>No Flags Match The Filter "{flagFilter}"</span>
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Type</th>
                    <th>Player</th>
                    <th>Reason</th>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td style={{ fontWeight: 600 }}>{f.flag_type}</td>
                      <td>{f.player?.display_name || f.player_id?.substring(0, 8) || '-'}</td>
                      <td className={styles.detailsCell}>{f.reason || 'No Reason Recorded'}</td>
                      <td className={styles.timeCell}>{timeAgo(f.flagged_at)}</td>
                      <td>
                        <span
                          className={`${styles.statusBadge} ${f.status === 'open' ? styles.statusOpen : ''}`}
                        >
                          {f.status}
                        </span>
                      </td>
                      <td>
                        <div className={styles.actionBtns}>
                          {f.status === 'open' && (
                            <button
                              onClick={() => {
                                setReviewTarget(f);
                                setReviewStatus('reviewed');
                                setReviewNotes('');
                              }}
                              className={styles.btnSmallGold}
                            >
                              Review
                            </button>
                          )}
                          <button
                            onClick={() => kickPlayer(f.player_id)}
                            className={styles.btnSmallDanger}
                            disabled={processing}
                          >
                            Kick
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: EVENTS ══════════════════ */}
      {tab === 'events' && (
        <div className={styles.section}>
          {!eventsLoaded ? (
            <PageSkeleton variant="list" />
          ) : events.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>▦</span>
              <span className={styles.emptyText}>No Anti-Cheat Events Recorded Yet</span>
            </div>
          ) : (
            <>
              <h3 className={styles.subsectionTitle}>Recent Events ({events.length})</h3>
              <div className={styles.tableScroll}>
                <table className={styles.dataTable}>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Player</th>
                      <th>Details</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev, i) => (
                      <tr key={ev.id || i}>
                        <td>
                          <span
                            className={`${styles.eventTypeBadge} ${
                              ev.event_type.includes('kicked')
                                ? styles.eventDanger
                                : ev.event_type.includes('blocked')
                                  ? styles.eventWarning
                                  : ''
                            }`}
                          >
                            {ev.event_type}
                          </span>
                        </td>
                        <td>
                          {ev.player?.display_name || ev.player_id?.substring(0, 8) || 'System'}
                        </td>
                        <td className={styles.detailsCell}>
                          {ev.details ? JSON.stringify(ev.details).substring(0, 80) : '-'}
                        </td>
                        <td className={styles.timeCell}>{timeAgo(ev.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: COLLUSION ═══════════════ */}
      {tab === 'collusion' && (
        <div className={styles.section}>
          {!collusionLoaded ? (
            <PageSkeleton variant="list" />
          ) : !collusion ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyText}>
                {loadError || 'The Collusion Screen Could Not Be Loaded'}
              </span>
            </div>
          ) : (
            <>
              <div className={styles.statsGrid}>
                <div className={styles.statCard}>
                  <div className={styles.statValueBlue}>{fmt(collusion.analyzed_hands)}</div>
                  <div className={styles.statLabel}>Hands Analyzed</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueRed}>{fmt(collusion.chip_dump.total)}</div>
                  <div className={styles.statLabel}>Chip Dump Pairs</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueGold}>{fmt(collusion.screening.total)}</div>
                  <div className={styles.statLabel}>Other Signals Open</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValue}>{fmt(collusion.club_players)}</div>
                  <div className={styles.statLabel}>Players Screened</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValue}>{fmt(collusion.closed_pairs)}</div>
                  <div className={styles.statLabel}>Already Closed</div>
                </div>
              </div>

              {/*
                TWO DETECTORS WRITE INTO ONE TABLE AND THEY DO NOT MEAN THE SAME
                THING. CHIP_DUMP is one-directional chip flow - what this tab's
                copy has always claimed to show, and what an operator can act
                on. WIN_RATE_ANOMALY is a win-rate outlier: on the largest club
                on the estate it accounts for 5,588 of the 5,591 pairs in the
                window, so presenting the two as one list turned an actionable
                queue of three into a wall nobody could work.
              */}
              <h3 className={styles.subsectionTitle}>Suspected Chip Dumping</h3>
              <p className={styles.subsectionDesc}>
                One-Directional Chip Flow Between Two Players Who Sat At This Club, Scored At Or
                Above {Math.round(collusion.threshold * 100)} Over The Last {collusion.window_days}{' '}
                Days.
              </p>
              {collusion.chip_dump.pairs.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyText}>
                    No Chip Dumping Is Awaiting Review Across {fmt(collusion.analyzed_hands)} Hands
                  </span>
                </div>
              ) : (
                <div className={styles.tableScroll}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>Severity</th>
                        <th>Loser To Winner</th>
                        <th>Hands</th>
                        <th>Score</th>
                        <th>Evidence</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {collusion.chip_dump.pairs.map((pair) => (
                        <tr key={`${pair.dumper_id}-${pair.receiver_id}`}>
                          <td>
                            <SeverityBadge severity={pair.severity} />
                          </td>
                          <td>
                            <span className={styles.collusionFlow}>
                              <span className={styles.dumper}>
                                {pair.dumper_id.substring(0, 8)}
                              </span>
                              <span className={styles.arrow}>&rarr;</span>
                              <span className={styles.receiver}>
                                {pair.receiver_id.substring(0, 8)}
                              </span>
                            </span>
                          </td>
                          <td style={{ fontWeight: 600 }}>{fmt(pair.hands_together)}</td>
                          <td style={{ fontWeight: 700 }}>{fmt(pair.score)}</td>
                          <td className={styles.detailsCell}>{evidenceSummary(pair)}</td>
                          <td>
                            <div className={styles.actionBtns}>
                              <button
                                onClick={() => kickPlayer(pair.dumper_id)}
                                className={styles.btnSmallDanger}
                                disabled={processing}
                              >
                                Remove Loser
                              </button>
                              <button
                                onClick={() => kickPlayer(pair.receiver_id)}
                                className={styles.btnSmallDanger}
                                disabled={processing}
                              >
                                Remove Winner
                              </button>
                              <button
                                onClick={() => dismissPair(pair)}
                                className={styles.btnSmall}
                                disabled={processing}
                              >
                                Clear
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3 className={styles.subsectionTitle}>Other Screening Signals</h3>
              <p className={styles.subsectionDesc}>
                Screening Signals, Not Findings: Win Rate Outliers, Timing Correlation, Soft Play
                And The Rest, Each Row Naming Its Own Pattern. {fmt(collusion.screening.total)}{' '}
                Awaiting Review
                {collusion.screening.total > collusion.screening.pairs.length
                  ? `, Showing The Top ${fmt(collusion.screening.pairs.length)}`
                  : ''}
                .
              </p>
              {collusion.screening.pairs.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyText}>
                    No Screening Signal Is Awaiting Review In This Window
                  </span>
                </div>
              ) : (
                <div className={styles.tableScroll}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>Severity</th>
                        <th>Pattern</th>
                        <th>Pair</th>
                        <th>Hands Together</th>
                        <th>Score</th>
                        <th>Evidence</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {collusion.screening.pairs.map((pair) => (
                        <tr key={`${pair.dumper_id}-${pair.receiver_id}-${pair.pattern_type}`}>
                          <td>
                            <SeverityBadge severity={pair.severity} />
                          </td>
                          <td style={{ fontWeight: 600 }}>
                            {String(pair.pattern_type).replace(/_/g, ' ')}
                          </td>
                          <td>
                            <span className={styles.collusionFlow}>
                              <span className={styles.dumper}>
                                {pair.dumper_id.substring(0, 8)}
                              </span>
                              <span className={styles.arrow}>&rarr;</span>
                              <span className={styles.receiver}>
                                {pair.receiver_id.substring(0, 8)}
                              </span>
                            </span>
                          </td>
                          <td style={{ fontWeight: 600 }}>{fmt(pair.hands_together)}</td>
                          <td style={{ fontWeight: 700 }}>{fmt(pair.score)}</td>
                          <td className={styles.detailsCell}>{evidenceSummary(pair)}</td>
                          <td>
                            <button
                              onClick={() => dismissPair(pair)}
                              className={styles.btnSmall}
                              disabled={processing}
                            >
                              Clear
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ═══════════════ TAB: ANOMALIES ═══════════════ */}
      {tab === 'anomalies' && (
        <div className={styles.section}>
          {!anomaliesLoaded ? (
            <PageSkeleton variant="list" />
          ) : (
            <>
              <div className={styles.statsGrid}>
                {/*
                  THIS TAB SAID SOMETHING THE QUERY BEHIND IT NEVER MEASURED.
                  detect_suspicious_plays returns the WINNERS of pots at or
                  above forty big blinds, ranked by pot size over blind level.
                  The page called them "Players Who Folded Strong Hands On The
                  River" and stamped every row with a Folded Strong Hand badge.
                  Its severity buckets are high at 100 big blinds and medium at
                  60, so the Critical tile could never be anything but zero.
                */}
                <div className={styles.statCard}>
                  <div className={styles.statValueRed}>{fmt(anomalies.length)}</div>
                  <div className={styles.statLabel}>Outsized Pots</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValue} style={{ color: '#FA383E' }}>
                    {fmt(anomalies.filter((a) => a.severity === 'high').length)}
                  </div>
                  <div className={styles.statLabel}>100 Big Blinds Or More</div>
                </div>
                <div className={styles.statCard}>
                  <div className={styles.statValueGold}>
                    {fmt(anomalies.filter((a) => a.severity === 'medium').length)}
                  </div>
                  <div className={styles.statLabel}>60 Big Blinds Or More</div>
                </div>
              </div>

              {anomalies.length === 0 ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon}>◎</span>
                  <span className={styles.emptyText}>
                    No Pot Reached Forty Big Blinds In The Last Thirty Days
                  </span>
                </div>
              ) : (
                <>
                  <h3 className={styles.subsectionTitle}>Outsized Pots And Who Won Them</h3>
                  <p className={styles.subsectionDesc}>
                    Every Pot At Or Above Forty Big Blinds In The Last Thirty Days, Largest Relative
                    To The Blind Level First. A Big Pot Is Not A Finding On Its Own.
                  </p>
                  <div className={styles.tableScroll}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>Size</th>
                          <th>Winner</th>
                          <th>Outcome</th>
                          <th>Winning Hand</th>
                          <th>Pot Size</th>
                          <th>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {anomalies.map((a, i) => (
                          <tr key={`${a.hand_id}-${a.player_id}-${i}`}>
                            <td>
                              <SeverityBadge severity={a.severity} />
                            </td>
                            <td>{a.player_id.substring(0, 8)}</td>
                            <td>
                              <span className={styles.foldedBadge}>Won The Pot</span>
                            </td>
                            <td className={styles.handRank}>
                              {String(a.hand_rank).replace(/_/g, ' ')}
                            </td>
                            <td style={{ fontWeight: 600 }}>{fmtChips(a.pot_total)}</td>
                            <td className={styles.timeCell}>{timeAgo(a.completed_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
