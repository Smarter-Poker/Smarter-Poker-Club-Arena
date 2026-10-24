import { useEffect, useRef, useState } from 'react';
import ClubRosterService, {
  type RosterMember,
  type WinLossFigure,
  type WinLossPeriod,
} from '../services/ClubRosterService';
import { reportError } from '../utils/errorReporter';
import { computeRosterRetryDelay } from '../utils/rosterReadReliability';
import { useChicagoStatsDay } from './useChicagoStatsDay';

/**
 * The figures for one window, plus the members whose figures could not be read.
 * A member in `unavailable` without a figure prints "Unavailable" instead of
 * "..."; a member with a figure keeps its last verified value. Kept as a Map so
 * existing callers read it unchanged.
 */
export class RosterWinLossFigures extends Map<string, WinLossFigure> {
  readonly unavailable: ReadonlySet<string>;

  constructor(
    entries?: Iterable<readonly [string, WinLossFigure]> | null,
    unavailable: Iterable<string> = []
  ) {
    super(entries ?? undefined);
    this.unavailable = new Set(unavailable);
  }
}

/** First retry after a failed read, then doubling with jitter up to the cap. */
export const WIN_LOSS_RETRY_BASE_MS = 5_000;
export const WIN_LOSS_RETRY_MAX_MS = 60_000;

/**
 * Win / loss for the roster rows that are loaded (Dan 2026-10-16).
 *
 * The roster arrives a page at a time, so this asks ca_club_members_win_loss
 * only for members it has not asked about yet in the chosen window, in batches
 * of up to 100, and keeps every window it has already loaded so flipping
 * between Today / This Week / This Month / Overall does not refetch. Only rows
 * the roster itself marks can_view_financials are asked for; the RPC applies
 * the same access rule again.
 *
 * Returns the figures for the current window. A member missing from the map
 * is still loading, unless it is listed in `unavailable`: its read failed and
 * is retried on a backoff, so the row never sits on "..." for ever.
 */
export function useRosterWinLoss(
  clubId: string | null,
  members: RosterMember[],
  period: WinLossPeriod,
  enabled: boolean,
  refreshRevision?: number,
  viewerId?: string
): RosterWinLossFigures {
  const cacheRef = useRef(new Map<string, RosterWinLossFigures>());
  const askedRef = useRef(new Map<string, Set<string>>());
  const loadedAtRef = useRef(new Map<string, number>());
  const failuresRef = useRef(new Map<string, number>());
  const ownerRef = useRef({ scope: '', revision: refreshRevision, epoch: 0 });
  const [version, setVersion] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const day = useChicagoStatsDay();
  const scope = `${clubId ?? ''}:${viewerId ?? ''}:${enabled}:${day}`;
  // Rotate during render: an old viewer must never receive even one cached
  // render, and a late promise cannot become current after an A/B/A switch.
  if (ownerRef.current.scope !== scope) {
    ownerRef.current = { scope, revision: refreshRevision, epoch: ownerRef.current.epoch + 1 };
    cacheRef.current = new Map();
    askedRef.current = new Map();
    loadedAtRef.current = new Map();
    failuresRef.current = new Map();
  } else if (ownerRef.current.revision !== refreshRevision) {
    ownerRef.current = { scope, revision: refreshRevision, epoch: ownerRef.current.epoch + 1 };
    askedRef.current = new Map();
    loadedAtRef.current = new Map();
  }
  const owner = ownerRef.current;
  const allowed = new Set(
    members.filter((row) => row.can_view_financials).map((row) => row.user_id)
  );
  // Withdraw revoked/off-page rows from every period, not just the visible one.
  for (const [window, values] of cacheRef.current) {
    if (
      [...values.keys()].some((id) => !allowed.has(id)) ||
      [...values.unavailable].some((id) => !allowed.has(id))
    ) {
      cacheRef.current.set(
        window,
        new RosterWinLossFigures(
          [...values].filter(([id]) => allowed.has(id)),
          [...values.unavailable].filter((id) => allowed.has(id))
        )
      );
    }
  }
  for (const asked of askedRef.current.values()) {
    for (const id of asked) if (!allowed.has(id)) asked.delete(id);
  }

  useEffect(() => {
    if (!enabled || !clubId) return;
    // Legacy callers retain on-render age expiry. Event-owned callers explicitly
    // invalidate every period and do not wait for an arbitrary freshness TTL.
    const loadedAt = loadedAtRef.current.get(period);
    if (
      refreshRevision === undefined &&
      loadedAt !== undefined &&
      Date.now() - loadedAt > WIN_LOSS_TTL_MS
    ) {
      askedRef.current.delete(period);
      loadedAtRef.current.delete(period);
    }
    const asked = askedRef.current.get(period) ?? new Set<string>();
    askedRef.current.set(period, asked);
    const pending = members
      .filter((member) => member.can_view_financials && !asked.has(member.user_id))
      .map((member) => member.user_id);
    if (pending.length === 0) return;
    pending.forEach((id) => asked.add(id));

    const controller = new AbortController();
    let completed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !controller.signal.aborted && ownerRef.current === owner;
    Promise.resolve()
      .then(() => {
        if (!current()) return null;
        return ClubRosterService.getMembersWinLoss(clubId, pending, period, controller.signal);
      })
      .then((rows) => {
        if (!current() || !rows) return;
        const previous = cacheRef.current.get(period);
        const values = new Map(previous);
        // A successful omission is an authoritative access withdrawal, unlike
        // a failed transport, which retains the last verified values.
        pending.forEach((id) => values.delete(id));
        rows.forEach((figure, id) => {
          if (pending.includes(id)) values.set(id, figure);
        });
        completed = true;
        failuresRef.current.delete(period);
        cacheRef.current.set(
          period,
          new RosterWinLossFigures(
            values,
            [...(previous?.unavailable ?? [])].filter((id) => !pending.includes(id))
          )
        );
        if (!loadedAtRef.current.has(period)) loadedAtRef.current.set(period, Date.now());
        setVersion((v) => v + 1);
      })
      .catch((error) => {
        pending.forEach((id) => asked.delete(id));
        if (!current()) return;
        reportError(error, 'useRosterWinLoss.Load');
        completed = true;
        // Say so, keep any verified figure, and ask again on a backoff.
        const previous = cacheRef.current.get(period);
        cacheRef.current.set(
          period,
          new RosterWinLossFigures(previous ?? [], [...(previous?.unavailable ?? []), ...pending])
        );
        const failures = failuresRef.current.get(period) ?? 0;
        failuresRef.current.set(period, failures + 1);
        setVersion((v) => v + 1);
        retryTimer = setTimeout(
          () => {
            if (ownerRef.current === owner) setRetryTick((tick) => tick + 1);
          },
          computeRosterRetryDelay(failures, WIN_LOSS_RETRY_BASE_MS, WIN_LOSS_RETRY_MAX_MS)
        );
      });
    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      // Even a refresh of an already-cached row must be eligible after abort.
      if (!completed) pending.forEach((id) => asked.delete(id));
    };
  }, [clubId, members, period, enabled, refreshRevision, viewerId, owner, retryTick]);

  void version;
  return enabled ? (cacheRef.current.get(period) ?? EMPTY) : EMPTY;
}

const EMPTY = new RosterWinLossFigures();

/** How long a loaded window is trusted before the roster asks again. */
export const WIN_LOSS_TTL_MS = 2 * 60 * 1000;
