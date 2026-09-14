import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

type AuthIdentity = { isAuthenticated: boolean; userId?: string | null };
type RosterResult = { data: { table_id?: string | null } | null; error: unknown };
export interface TournamentRebalanceOptions {
  tableId?: string;
  userId: string;
  routeTableId?: string;
  embeddedTableId?: string;
  subscribeAuth: (listener: (identity: AuthIdentity) => void) => () => void;
  readRoster: (tournamentId: string, userId: string) => PromiseLike<RosterResult>;
  onTableInfoUpdate?: (update: { movedToTableId: string }) => void;
  navigate: (path: string, options: { replace: boolean }) => void;
  refresh: () => void;
  report: (error: unknown) => void;
}

/** Owns only the direct rebalance read and its publication lifetime. */
export function useTournamentRebalance(options: TournamentRebalanceOptions) {
  const { tableId, userId, routeTableId, embeddedTableId, subscribeAuth } = options;
  const owner = useMemo(() => Symbol('rebalance owner'), [tableId, userId]);
  const latest = useRef<TournamentRebalanceOptions | null>(null);
  const scope = useRef<{
    tableId?: string;
    userId: string;
    routeTableId?: string;
    embeddedTableId?: string;
    accountId: string;
    authEventSeen: boolean;
    owner: symbol;
  } | null>(null);
  const request = useRef(0);
  const lifetime = useRef({ alive: false, generation: 0 });

  // Render may suspend or be abandoned. Only a committed render can publish
  // callbacks or change the scope of an already committed roster read.
  useLayoutEffect(() => {
    latest.current = options;
    const previous = scope.current;
    if (
      !previous ||
      previous.owner !== owner ||
      previous.tableId !== tableId ||
      previous.userId !== userId ||
      previous.routeTableId !== routeTableId ||
      previous.embeddedTableId !== embeddedTableId
    ) {
      scope.current = {
        tableId,
        userId,
        routeTableId,
        embeddedTableId,
        owner,
        accountId: previous?.authEventSeen ? previous.accountId : userId,
        authEventSeen: previous?.authEventSeen ?? false,
      };
    }
  });
  useLayoutEffect(() => {
    lifetime.current = { alive: true, generation: lifetime.current.generation + 1 };
    return () => {
      // A fresh setup must never revive reads from a prior setup (StrictMode
      // and hidden/revealed trees can replay effects without a new render).
      lifetime.current = { alive: false, generation: lifetime.current.generation + 1 };
      request.current += 1;
    };
  }, [owner]);
  useLayoutEffect(() => {
    let active = true;
    const unsubscribe = subscribeAuth((identity) => {
      if (!active || !scope.current) return;
      scope.current = {
        ...scope.current,
        accountId: identity.isAuthenticated ? identity.userId || 'guest' : 'guest',
        authEventSeen: true,
      };
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [subscribeAuth]);

  return useCallback(
    async (tournamentId: string | null | undefined, isSourceEffectCurrent: () => boolean) => {
      const captured = scope.current;
      const generation = lifetime.current.generation;
      const ownsSource = () =>
        captured !== null &&
        captured.owner === owner &&
        lifetime.current.alive &&
        lifetime.current.generation === generation &&
        isSourceEffectCurrent() &&
        scope.current === captured &&
        captured.tableId === tableId &&
        captured.userId === userId &&
        captured.accountId === userId &&
        (Boolean(captured.embeddedTableId) || captured.routeTableId === tableId);
      if (!captured || !ownsSource()) return;
      const currentRequest = ++request.current;
      const isCurrent = () => ownsSource() && request.current === currentRequest;
      try {
        if (userId && tournamentId) {
          const { data, error } = await latest.current!.readRoster(tournamentId, userId);
          if (!isCurrent()) return;
          if (error) throw error;
          if (data?.table_id && data.table_id !== tableId) {
            if (captured.embeddedTableId) {
              latest.current!.onTableInfoUpdate?.({ movedToTableId: data.table_id });
            } else if (captured.routeTableId === tableId) {
              latest.current!.navigate(`/table/${data.table_id}`, { replace: true });
            }
          } else if (data?.table_id === tableId) {
            latest.current!.refresh();
          }
        } else if (isCurrent()) {
          latest.current!.refresh();
        }
      } catch (error) {
        if (!isCurrent()) return;
        latest.current!.report(error);
        latest.current!.refresh();
      }
    },
    [owner, tableId, userId]
  );
}
