/**
 * THE FLOOR, KEPT WARM. One read of fn_diamond_game_floor on mount, again
 * every half minute while the page is open, and again the moment this
 * player's own round lands (the page calls refresh()), so a win shows on the
 * floor before the toast has faded. Nothing here is a cron: it is the page
 * asking for the picture while somebody is looking at it, and it stops when
 * they leave.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import DiamondGamesService, { type GameFloor } from '../services/DiamondGamesService';
import { reportError } from '../utils/errorReporter';

const REFRESH_MS = 30_000;

export function useGameFloor(clubUuid: string | null, limit = 20) {
  const [floor, setFloor] = useState<GameFloor | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!clubUuid) return;
    try {
      const next = await DiamondGamesService.floor(clubUuid, limit);
      if (alive.current && next.ok) setFloor(next);
    } catch (err) {
      reportError(err, 'useGameFloor');
    }
  }, [clubUuid, limit]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  return { floor, refresh };
}
