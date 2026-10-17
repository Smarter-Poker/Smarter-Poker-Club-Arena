import { useEffect, useRef, useState } from 'react';
import ClubRosterService, {
  type RosterMember,
  type WinLossFigure,
  type WinLossPeriod,
} from '../services/ClubRosterService';
import { reportError } from '../utils/errorReporter';

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
 * is still loading (or could not be read).
 */
export function useRosterWinLoss(
  clubId: string | null,
  members: RosterMember[],
  period: WinLossPeriod,
  enabled: boolean
): Map<string, WinLossFigure> {
  const cacheRef = useRef(new Map<string, Map<string, WinLossFigure>>());
  const askedRef = useRef(new Map<string, Set<string>>());
  const [version, setVersion] = useState(0);

  // A different club or viewer starts from nothing.
  useEffect(() => {
    cacheRef.current = new Map();
    askedRef.current = new Map();
    setVersion((v) => v + 1);
  }, [clubId]);

  useEffect(() => {
    if (!enabled || !clubId) return;
    const asked = askedRef.current.get(period) ?? new Set<string>();
    askedRef.current.set(period, asked);
    const pending = members
      .filter((member) => member.can_view_financials && !asked.has(member.user_id))
      .map((member) => member.user_id);
    if (pending.length === 0) return;
    pending.forEach((id) => asked.add(id));

    const controller = new AbortController();
    const club = clubId;
    // Started inside a promise so even a synchronous throw lands in the catch:
    // a figure that cannot be read must never take the roster down with it.
    Promise.resolve()
      .then(() => ClubRosterService.getMembersWinLoss(club, pending, period, controller.signal))
      .then((rows) => {
        if (controller.signal.aborted) return;
        const window = cacheRef.current.get(period) ?? new Map<string, WinLossFigure>();
        rows.forEach((figure, id) => window.set(id, figure));
        cacheRef.current.set(period, window);
        setVersion((v) => v + 1);
      })
      .catch((error) => {
        // Let a later render ask again rather than leaving these rows blank.
        pending.forEach((id) => asked.delete(id));
        if (!controller.signal.aborted) reportError(error, 'useRosterWinLoss.Load');
      });
    return () => {
      controller.abort();
      // An aborted batch never landed: forget that it was asked.
      pending.forEach((id) => {
        if (!cacheRef.current.get(period)?.has(id)) asked.delete(id);
      });
    };
  }, [clubId, members, period, enabled]);

  // `version` is what tells React the cache moved.
  void version;
  return cacheRef.current.get(period) ?? EMPTY;
}

const EMPTY = new Map<string, WinLossFigure>();
