import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchCashGameLobby, type CashGameLobby } from '../../services/cashGameLobby';
import { isGameGone } from './mustMoveLobbyCopy';

/** A reply belongs to one game and one opening, and the newest read wins. */
export function useCashGameLobby(
  gameId: string | null | undefined,
  enabled: boolean,
  pollMs: number,
  refreshKey = 0
) {
  const session = useMemo(
    () => ({ active: false, read: 0, action: null as symbol | null }),
    [gameId, enabled]
  );
  const [snapshot, setSnapshot] = useState<{
    gameId: string;
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
    const current = () => session.active && session.read === read;
    try {
      const lobby = await fetchCashGameLobby(gameId);
      if (current()) setSnapshot({ gameId, lobby, error: null });
    } catch (error) {
      if (!current()) return;
      setSnapshot((previous) => ({
        gameId,
        // A temporary failure retains this game's last read only.
        lobby: !isGameGone(error) && previous?.gameId === gameId ? previous.lobby : null,
        error,
      }));
    }
  }, [gameId, session]);

  useEffect(() => {
    if (!enabled || !gameId) return;
    void load();
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, gameId, load, pollMs, refreshKey]);

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

  const current = snapshot?.gameId === gameId ? snapshot : null;
  return {
    lobby: current?.lobby ?? null,
    error: current?.error ?? null,
    busy: busySession === session && session.action !== null,
    load,
    beginAction,
  };
}
