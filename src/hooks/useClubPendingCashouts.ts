/**
 * PENDING CASH OUT REQUESTS, AS THE VIEWER MAY SEE THEM (Dan 2026-10-23)
 *
 * "OWNERS, CO OWNERS OR ADMINS SHOULD BE ABLE TO SEE ALL CASH OUT REQUESTS AND
 * PULL THOSE CHIPS. THEY SHOULDN'T GET THE NOTIFICATION, BUT IF THEY GO TO A
 * PLAYERS ACCOUNT, THEY SHOULD BE ABLE TO SEE 'CASH OUT REQUESTED'."
 *
 * The scope is the server's, never this hook's: `fn_cashout_queue` returns the
 * requests assigned to the viewer, anyone in the viewer's downline, and every
 * request in a club where the viewer is owner, co-owner or admin. The hook only
 * reads that answer and keeps it fresh (realtime on the club's cashout rows,
 * plus the balance and mutation bus events every cashier surface already
 * raises). Nothing here moves chips: approval stays in AgentCashoutPanel's
 * prepared, idempotent operation path.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cashoutService, type CashoutRequest } from '../services/CashoutService';
import { useAuthUser } from './useAuthUser';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';
import { useMasterBusChannel } from './useMasterBusChannel';

export interface ClubPendingCashouts {
  requests: CashoutRequest[];
  /** Players with a pending request, for the roster flag. */
  playerIds: ReadonlySet<string>;
  loaded: boolean;
  reload: () => void;
}

const NONE: ReadonlySet<string> = new Set();
const EMPTY: CashoutRequest[] = [];

/**
 * The queue without its own realtime subscription: it re-reads on the bus
 * events and on focus. The member record uses this one; the request panel it
 * shows carries its own realtime subscription.
 */
export function useClubPendingCashoutsRead(
  clubUuid: string | null | undefined,
  enabled: boolean
): ClubPendingCashouts {
  const { user } = useAuthUser();
  const viewerId = user?.id ?? null;
  const scope = enabled && clubUuid && viewerId ? `${viewerId}:${clubUuid}` : null;
  const [state, setState] = useState<{ scope: string | null; requests: CashoutRequest[] }>({
    scope: null,
    requests: [],
  });
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!scope || !clubUuid || !viewerId) return;
    const mine = ++generation.current;
    try {
      const rows = await cashoutService.getAgentPendingCashouts(viewerId, clubUuid);
      if (mine === generation.current) setState({ scope, requests: rows });
    } catch (err) {
      // A failed read keeps the last good answer for this scope; it never
      // invents an empty queue for a scope it could not read.
      reportError(err, 'useClubPendingCashouts.load');
    }
  }, [scope, clubUuid, viewerId]);

  // Bus events (a request, cancellation or approval anywhere on this client)
  // and window focus re-read; several in a burst collapse into one read.
  useEffect(() => {
    if (!scope) return;
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    };
    const offBalance = masterBus.subscribe('BALANCE_UPDATED', soon);
    const offMutation = masterBus.subscribe('DATA_MUTATED', soon);
    window.addEventListener('focus', soon);
    return () => {
      generation.current++;
      if (timer) clearTimeout(timer);
      offBalance?.();
      offMutation?.();
      window.removeEventListener('focus', soon);
    };
  }, [scope, load]);

  const requests = state.scope === scope && scope ? state.requests : EMPTY;
  const playerIds = useMemo<ReadonlySet<string>>(
    () => (requests.length ? new Set(requests.map((r) => r.playerId)) : NONE),
    [requests]
  );

  return {
    requests,
    playerIds,
    loaded: state.scope === scope && scope !== null,
    reload: () => void load(),
  };
}

/** The queue plus realtime on the club's cashout rows (the cashier). */
export function useClubPendingCashouts(
  clubUuid: string | null | undefined,
  enabled: boolean
): ClubPendingCashouts {
  const { user } = useAuthUser();
  const read = useClubPendingCashoutsRead(clubUuid, enabled);
  const scope = enabled && clubUuid && user?.id ? `${user.id}:${clubUuid}` : null;
  // Requests made from other devices arrive through the club's cashout rows.
  useMasterBusChannel({
    channelName: scope ? `club-pending-cashouts:${scope}` : null,
    table: 'cashout_requests',
    filter: clubUuid ? `club_id=eq.${clubUuid}` : null,
    event: '*',
    enabled: !!scope,
    onPayload: () => read.reload(),
  });
  return read;
}
