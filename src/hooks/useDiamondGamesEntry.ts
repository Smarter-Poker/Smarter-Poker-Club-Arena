/**
 * THE DOOR, READ ONCE (Dan 2026-09-10): "when a player is out of chips or
 * doesn't have enough to rebuy into a tournament or rebuy into a cash game,
 * they be prompted to play diamonds to chips. there also needs to be a button
 * for this inside the club lobby."
 *
 * Both of those need the same answer: does this club's host have a game open,
 * is this player a member of it, and do they hold enough diamonds to get in.
 * One RPC (fn_diamond_games_entry), read when the moment arrives - a buy-in
 * modal opening, a lobby painting - and not before. `enabled` is how a modal
 * says "not yet": no club, no request.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import DiamondGamesService, { type DiamondGamesEntry } from '../services/DiamondGamesService';
import { reportError } from '../utils/errorReporter';

export function useDiamondGamesEntry(clubId: string | null | undefined, enabled = true) {
  const [entry, setEntry] = useState<DiamondGamesEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!clubId || !enabled) return;
    setLoading(true);
    try {
      const next = await DiamondGamesService.entry(clubId);
      if (alive.current) setEntry(next.ok ? next : null);
    } catch (err) {
      /* A door that cannot be read is a door that is not offered: the player
         still sees the balance and the refusal that brought them here. */
      reportError(err, 'useDiamondGamesEntry');
      if (alive.current) setEntry(null);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [clubId, enabled]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  return { entry, loading, refresh };
}

export default useDiamondGamesEntry;
