/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  USE CLUB OPERATIONS OVERVIEW — one live read for the operator workspace
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * /operations, /finance and /control were link grids: three panels that printed
 * "Live Permission Map" and "Live Systems Remain Authoritative" over zero
 * queries. An operator could not tell from the workspace whether anything was
 * waiting for them; they had to open all twenty-one tools and look.
 *
 * This hook is the client half of `ca_club_operations_overview`. It is
 * deliberately additive: the tools render from the registry whether or not this
 * read succeeds, so a failed or slow overview costs an operator the badges and
 * nothing else. That is why `error` is exposed alongside data instead of
 * replacing the page - a degraded reading must never take the doors away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { isAuthzError } from '../utils/clubDashboard';
import { reportError } from '../utils/errorReporter';
import { useVisibilityRefresh } from './useVisibilityRefresh';

export type ClubOperationsAlertSeverity = 'critical' | 'warning' | 'info';

export interface ClubOperationsAlert {
  id: string;
  severity: ClubOperationsAlertSeverity;
  /** A registry item id from clubOperationsNavigation, never a route. */
  tool: string;
  title: string;
  count: number;
}

export interface ClubOperationsKpis {
  members: number;
  members_pending: number;
  members_new_7d: number;
  online_now: number;
  seated_now: number;
  live_tables: number;
  running_tables: number;
  waiting_tables: number;
  tournaments_registering: number;
  tournaments_running: number;
  hands_today: number;
  /** Finance roles only. Absent for staff without finance access. */
  rake_today?: number;
  club_bank?: number;
  member_chips?: number;
}

export interface ClubOperationsCounts {
  members: number;
  members_pending: number;
  reports_open: number;
  disputes_open: number;
  disputes_aged: number;
  blacklist_active: number;
  blacklist_expired: number;
  chip_requests_pending: number;
  cashouts_pending: number;
  credit_requests_pending: number;
  invoices_open: number | null;
  invoices_overdue: number | null;
  tickets_outstanding: number;
  anti_cheat_flags_open: number;
}

export interface ClubOperationsOverview {
  generated_at: string;
  club: { id: string; name: string; slug: string | null };
  viewer: {
    role: string | null;
    is_platform_staff: boolean;
    can_view_finance: boolean;
    can_control_club: boolean;
  };
  kpis: ClubOperationsKpis;
  counts: ClubOperationsCounts;
  alerts: ClubOperationsAlert[];
  settlement_locked: boolean;
}

export interface ClubOperationsOverviewState {
  overview: ClubOperationsOverview | null;
  loading: boolean;
  /** Set when the read failed. The caller still renders its tools. */
  error: string | null;
  /** True when the database refused the reading (42501) while the client
   *  believes the viewer is staff. Not an error the operator can retry. */
  denied: boolean;
  /** When the numbers currently on screen were read. Survives a failed
   *  refresh, so stale figures can be labelled with their real age instead
   *  of losing their timestamp the moment a poll fails. */
  refreshedAt: number | null;
  refresh: () => void;
}

const POLL_MS = 60_000;
const COALESCE_MS = 2_500;
/** Two consumers mount on /operations - the page and the rail. Inside this
 *  window the second one reuses the first one's answer instead of asking the
 *  database the same question again. */
const SHARE_MS = 15_000;

/** Events proven to be emitted elsewhere in the app (see check-bus-wiring). */
const BUS_EVENTS = [
  'CLUB_UPDATED',
  'CLUB_JOINED',
  'CLUB_LEFT',
  'BALANCE_UPDATED',
  'TABLE_SEATED',
  'TABLE_LEFT',
  'TABLE_CREATED',
  'CHIPS_ADDED',
  'MEMBER_ROLE_CHANGED',
  'SETTLEMENT_CYCLE_COMPLETED',
  'AGENT_UPDATED',
] as const;

const ZERO_COUNTS: ClubOperationsCounts = {
  members: 0,
  members_pending: 0,
  reports_open: 0,
  disputes_open: 0,
  disputes_aged: 0,
  blacklist_active: 0,
  blacklist_expired: 0,
  chip_requests_pending: 0,
  cashouts_pending: 0,
  credit_requests_pending: 0,
  invoices_open: null,
  invoices_overdue: null,
  tickets_outstanding: 0,
  anti_cheat_flags_open: 0,
};

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** PostgREST returns numeric as a string. Every count is normalised here so no
 *  consumer has to remember, and a missing key reads as 0 rather than NaN. */
function normalise(raw: unknown): ClubOperationsOverview | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const club = (row.club || {}) as Record<string, unknown>;
  const viewer = (row.viewer || {}) as Record<string, unknown>;
  const kpis = (row.kpis || {}) as Record<string, unknown>;
  const counts = (row.counts || {}) as Record<string, unknown>;
  const alerts = Array.isArray(row.alerts) ? row.alerts : [];

  const financeKpis: Partial<ClubOperationsKpis> = {};
  if (kpis.rake_today !== undefined) financeKpis.rake_today = num(kpis.rake_today);
  if (kpis.club_bank !== undefined) financeKpis.club_bank = num(kpis.club_bank);
  if (kpis.member_chips !== undefined) financeKpis.member_chips = num(kpis.member_chips);

  return {
    generated_at:
      typeof row.generated_at === 'string' ? row.generated_at : new Date().toISOString(),
    club: {
      id: String(club.id || ''),
      name: typeof club.name === 'string' ? club.name : '',
      slug: typeof club.slug === 'string' ? club.slug : null,
    },
    viewer: {
      role: typeof viewer.role === 'string' ? viewer.role : null,
      is_platform_staff: viewer.is_platform_staff === true,
      can_view_finance: viewer.can_view_finance === true,
      can_control_club: viewer.can_control_club === true,
    },
    kpis: {
      members: num(kpis.members),
      members_pending: num(kpis.members_pending),
      members_new_7d: num(kpis.members_new_7d),
      online_now: num(kpis.online_now),
      seated_now: num(kpis.seated_now),
      live_tables: num(kpis.live_tables),
      running_tables: num(kpis.running_tables),
      waiting_tables: num(kpis.waiting_tables),
      tournaments_registering: num(kpis.tournaments_registering),
      tournaments_running: num(kpis.tournaments_running),
      hands_today: num(kpis.hands_today),
      ...financeKpis,
    },
    counts: {
      ...ZERO_COUNTS,
      members: num(counts.members),
      members_pending: num(counts.members_pending),
      reports_open: num(counts.reports_open),
      disputes_open: num(counts.disputes_open),
      disputes_aged: num(counts.disputes_aged),
      blacklist_active: num(counts.blacklist_active),
      blacklist_expired: num(counts.blacklist_expired),
      chip_requests_pending: num(counts.chip_requests_pending),
      cashouts_pending: num(counts.cashouts_pending),
      credit_requests_pending: num(counts.credit_requests_pending),
      invoices_open: counts.invoices_open === null ? null : num(counts.invoices_open),
      invoices_overdue: counts.invoices_overdue === null ? null : num(counts.invoices_overdue),
      tickets_outstanding: num(counts.tickets_outstanding),
      anti_cheat_flags_open: num(counts.anti_cheat_flags_open),
    },
    alerts: alerts
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        id: String(entry.id || ''),
        severity: (['critical', 'warning', 'info'] as const).includes(
          entry.severity as ClubOperationsAlertSeverity
        )
          ? (entry.severity as ClubOperationsAlertSeverity)
          : 'info',
        tool: String(entry.tool || ''),
        title: typeof entry.title === 'string' ? entry.title : '',
        count: num(entry.count),
      }))
      .filter((entry) => entry.id !== ''),
    settlement_locked: row.settlement_locked === true,
  };
}

/* One in-flight read per club, shared by every consumer. The rail and the
   page mount together; without this they would each poll the same club. */
const inflight = new Map<string, Promise<ClubOperationsOverview>>();
const shared = new Map<string, { at: number; value: ClubOperationsOverview }>();

/** Exported for tests: forget every shared answer. */
export function resetClubOperationsOverviewCache(): void {
  inflight.clear();
  shared.clear();
}

async function readOverview(clubUUID: string, force: boolean): Promise<ClubOperationsOverview> {
  if (!force) {
    const cached = shared.get(clubUUID);
    if (cached && Date.now() - cached.at < SHARE_MS) return cached.value;
  }
  const pending = inflight.get(clubUUID);
  if (pending) return pending;

  const request = (async () => {
    const { data, error: rpcError } = await supabase.rpc('ca_club_operations_overview', {
      p_club_id: clubUUID,
    });
    if (rpcError) throw rpcError;
    const next = normalise(data);
    if (!next) throw new Error('The club operations overview returned no readable payload.');
    shared.set(clubUUID, { at: Date.now(), value: next });
    return next;
  })();

  inflight.set(clubUUID, request);
  try {
    return await request;
  } finally {
    inflight.delete(clubUUID);
  }
}

/**
 * @param clubUUID the resolved club UUID. Pass null while it is unknown; the
 *   hook stays idle rather than sending a slug to a uuid argument.
 */
export function useClubOperationsOverview(
  clubUUID: string | null | undefined
): ClubOperationsOverviewState {
  const [overview, setOverview] = useState<ClubOperationsOverview | null>(null);
  const [loading, setLoading] = useState(Boolean(clubUUID));
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const requestRef = useRef(0);
  const clubRef = useRef<string | null>(null);

  /**
   * @param silent do not show the loading state (a background refresh).
   * @param force skip the 15s shared answer. A bus event says something just
   *   changed, so reusing a cached read would leave the badge stale for up to
   *   SHARE_MS after the very action that changed it - which is the whole
   *   point of listening to the bus.
   */
  const load = useCallback(
    async ({ silent = false, force = true }: { silent?: boolean; force?: boolean } = {}) => {
      if (!clubUUID) return;
      const requestId = ++requestRef.current;
      if (!silent) setLoading(true);
      try {
        const next = await readOverview(clubUUID, force);
        // A later request has already answered. Dropping this one keeps an
        // out-of-order reply from overwriting fresher numbers.
        if (requestId !== requestRef.current) return;
        setOverview(next);
        setDenied(false);
        setError(null);
        setRefreshedAt(Date.now());
      } catch (loadError) {
        if (requestId !== requestRef.current) return;
        if (isAuthzError(loadError)) {
          setDenied(true);
          setOverview(null);
          setError(null);
        } else {
          reportError(loadError, 'ClubOperationsOverview.Load_failed');
          setError('Live club readings are unavailable right now.');
        }
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [clubUUID]
  );

  // A club change must not leave the previous club's numbers on screen for a
  // beat: they are indistinguishable from this club's numbers.
  useEffect(() => {
    if (clubRef.current !== (clubUUID || null)) {
      clubRef.current = clubUUID || null;
      requestRef.current += 1;
      setOverview(null);
      setDenied(false);
      setError(null);
      setRefreshedAt(null);
      setLoading(Boolean(clubUUID));
    }
  }, [clubUUID]);

  useEffect(() => {
    if (!clubUUID) return;
    let disposed = false;
    let coalesce: ReturnType<typeof setTimeout> | null = null;

    // The first read of a mount may reuse a sibling's answer from the last
    // fifteen seconds; that is what stops the page and the rail asking twice.
    void load({ force: false });

    const poll = setInterval(() => {
      if (!disposed && document.visibilityState === 'visible') {
        void load({ silent: true, force: false });
      }
    }, POLL_MS);

    const nudge = () => {
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        if (!disposed) void load({ silent: true, force: true });
      }, COALESCE_MS);
    };
    const unsubs = BUS_EVENTS.map((event) => masterBus.subscribe(event, nudge));

    return () => {
      disposed = true;
      clearInterval(poll);
      if (coalesce) clearTimeout(coalesce);
      unsubs.forEach((unsub) => unsub());
    };
  }, [clubUUID, load]);

  const revalidate = useCallback(() => {
    void load({ silent: true, force: true });
  }, [load]);
  useVisibilityRefresh(revalidate);

  const refresh = useCallback(() => {
    void load({ force: true });
  }, [load]);

  return useMemo(
    () => ({ overview, loading, error, denied, refreshedAt, refresh }),
    [denied, error, loading, overview, refresh, refreshedAt]
  );
}
