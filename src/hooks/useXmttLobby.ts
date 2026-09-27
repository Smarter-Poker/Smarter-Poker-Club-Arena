import { useCallback, useEffect, useRef, useState } from 'react';
import { resolvePageClubId } from '../utils/resolvePageClubId';
import { readXmttLobby, XMTT_PAGE_SIZE, type XmttFilter } from '../services/xmttLobbyReads';
import { useVisibleRead } from './useVisibleRead';

/** The existing 30-second observation follows the visible account, club and filter. */
export function useXmttLobby(
  userId: string | undefined,
  routeClubId: string | null,
  filter: XmttFilter
) {
  const owner = JSON.stringify([userId, routeClubId]);
  const identity = JSON.stringify([owner, filter]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const [club, setClub] = useState<{ owner: string; id: string | null } | null>(null);
  const [pagination, setPagination] = useState({ identity, limit: XMTT_PAGE_SIZE });
  const limit = pagination.identity === identity ? pagination.limit : XMTT_PAGE_SIZE;
  const [data, setData] = useState<{
    identity: string;
    limit: number;
    value: Awaited<ReturnType<typeof readXmttLobby>>;
  } | null>(null);
  const [error, setError] = useState<{ identity: string; message: string } | null>(null);
  const [pending, setPending] = useState(true);
  const [resolveRetry, setResolveRetry] = useState(0);
  const clubId = club?.owner === owner ? club.id : null;
  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setClub({ owner, id: null });
      return;
    }
    setClub(null);
    void resolvePageClubId(routeClubId ? { routeClubId, allowFallback: false } : { userId })
      .then((id) => {
        if (!cancelled) setClub({ owner, id });
      })
      .catch(() => {
        if (!cancelled) setClub({ owner, id: null });
      });
    return () => {
      cancelled = true;
    };
  }, [owner, userId, routeClubId, resolveRetry]);
  const refresh = useVisibleRead({
    scopeKey: JSON.stringify([identity, clubId, limit]),
    enabled: Boolean(userId && clubId),
    intervalMs: 30_000,
    read: (signal) => readXmttLobby(clubId!, filter, limit, signal),
    onReset: () => {
      setPending(Boolean(clubId));
    },
    onData: (value) => {
      if (currentIdentity.current !== identity) return;
      setData({ identity, limit, value });
      setError(null);
      setPending(false);
    },
    onError: () => {
      if (currentIdentity.current !== identity) return;
      setError({ identity, message: 'Tournament List Unavailable. Please Try Again.' });
      setPending(false);
    },
  });
  const current = data?.identity === identity ? data : null;
  const resolving = Boolean(userId && club?.owner !== owner);
  const message =
    error?.identity === identity
      ? error.message
      : club?.owner === owner && !clubId
        ? 'No Club Found.'
        : null;
  const refreshCurrent = useCallback(() => {
    if (!clubId) setResolveRetry((value) => value + 1);
    else refresh();
  }, [clubId, refresh]);
  return {
    clubId,
    rows: current?.value.rows ?? [],
    total: current?.value.total ?? null,
    counts: current?.value.counts ?? null,
    error: message,
    loading: resolving || (!current && !message && Boolean(userId)),
    pending,
    refresh: refreshCurrent,
    hasMore: Boolean(current && current.value.rows.length < current.value.total),
    loadMore: () => {
      if (pending || !current) return;
      setPagination({ identity, limit: current.limit + XMTT_PAGE_SIZE });
    },
  };
}
