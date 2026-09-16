import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchCashGameLobby, type CashGameLobby } from '../../services/cashGameLobby';
import { useUserStore } from '../../stores/useUserStore';
import { isGameGone } from './mustMoveLobbyCopy';

/** A reply belongs to one viewer, game and opening; the newest explicit read wins. */
export function useCashGameLobby(
  gameId: string | null | undefined,
  enabled: boolean,
  pollMs: number,
  refreshKey = 0
) {
  const viewerId = useUserStore((state) => state.user?.id ?? null);
  const session = useMemo(
    () => ({
      active: false,
      read: 0,
      pendingRead: null as number | null,
      action: null as symbol | null,
    }),
    [gameId, enabled, viewerId]
  );
  const [snapshot, setSnapshot] = useState<{
    session: typeof session;
    lobby: CashGameLobby | null;
    error: unknown;
  } | null>(null);
  const [busySession, setBusySession] = useState<typeof session | null>(null);

  useEffect(() => {
    session.active = enabled && Boolean(gameId);
    return () => {
      session.active = false;
      session.read++;
      session.action = null;
    };
  }, [session, enabled, gameId]);

  const load = useCallback(async () => {
    if (!session.active || !gameId) return;
    const read = ++session.read;
    session.pendingRead = read;
    const current = () => session.active && session.read === read;
    try {
      const lobby = await fetchCashGameLobby(gameId);
      if (current()) setSnapshot({ session, lobby, error: null });
    } catch (error) {
      if (!current()) return;
      setSnapshot((previous) => ({
        session,
        // A temporary failure retains only this viewer's current opening.
        lobby: !isGameGone(error) && previous?.session === session ? previous.lobby : null,
        error,
      }));
    } finally {
      // A superseded reply cannot release a newer read's polling hold.
      if (session.pendingRead === read) session.pendingRead = null;
    }
  }, [gameId, session]);

  useEffect(() => {
    if (!enabled || !gameId) return;
    void load();
    const timer = window.setInterval(() => {
      // Let a slow reply finish, and let mutations perform their own confirmation read.
      if (session.pendingRead === null && session.action === null) void load();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, gameId, load, pollMs, refreshKey, session]);

  const beginAction = useCallback(() => {
    // A ref-backed token closes the same-render double-tap window too.
    if (!session.active || session.action) return null;
    const token = Symbol();
    session.action = token;
    session.read++;
    setBusySession(session);
    return {
      isCurrent: () => session.active && session.action === token,
      finish: () => {
        if (session.action !== token) return;
        session.action = null;
        setBusySession((current) => (current === session ? null : current));
      },
    };
  }, [session]);

  const current = snapshot?.session === session ? snapshot : null;
  return {
    lobby: current?.lobby ?? null,
    error: current?.error ?? null,
    busy: busySession === session && session.action !== null,
    load,
    beginAction,
  };
}
