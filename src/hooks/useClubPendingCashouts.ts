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

export interface ClubPendingCashouts {
  requests: CashoutRequest[];
  /** Players with a pending request, for the roster flag. */
  playerIds: ReadonlySet<string>;
  loaded: boolean;
  reload: () => void;
}

const NONE: ReadonlySet<string> = new Set();
const EMPTY: CashoutRequest[] = [];

export function useClubPendingCashouts(
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

  useEffect(() => {
    if (!scope || !clubUuid) return;
    void load();
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', () => void load(), 500);
    const unsubMutation = masterBus.subscribeDebounced('DATA_MUTATED', () => void load(), 500);
    const channelKey = `club-pending-cashouts-${scope}`;
    masterBus
      .getOrCreateChannel(channelKey)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cashout_requests', filter: `club_id=eq.${clubUuid}` },
        () => void load()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR' && err)
          reportError(err?.message || err, 'useClubPendingCashouts.channel');
      });
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      generation.current++;
      unsubBalance();
      unsubMutation();
      masterBus.removeRegisteredChannel(channelKey);
      window.removeEventListener('focus', onFocus);
    };
  }, [scope, clubUuid, load]);

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
