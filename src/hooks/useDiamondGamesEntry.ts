import { useCallback, useEffect, useRef, useState } from 'react';
import DiamondGamesService, { type DiamondGamesEntry } from '../services/DiamondGamesService';
import { reportError } from '../utils/errorReporter';
import { useAuthUser } from './useAuthUser';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';

/**
 * Coming back to the tab fires focus and visibilitychange together, and a
 * player flicking between tabs fires them again and again. Neither moves a
 * balance, so a return inside this long after the last read is answered by the
 * read already on screen. fn_diamond_games_entry ran 4,709 times in three days
 * of test traffic before this.
 */
export const RETURN_FRESH_MS = 15_000;
/** A settled hand can land several wallet events at once: one read answers the burst. */
export const EVENT_COALESCE_MS = 250;

/** Account-scoped, event-driven eligibility. Unknown balances never mean bust. */
export function useDiamondGamesEntry(clubId: string | null | undefined, enabled = true) {
  const { user } = useAuthUser();
  const scope = `${user?.id ?? ''}:${clubId ?? ''}:${enabled}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [snapshot, setSnapshot] = useState<{ scope: string; entry: DiamondGamesEntry | null }>({
    scope,
    entry: null,
  });
  const [loading, setLoading] = useState(false);
  const alive = useRef(true),
    generation = useRef(0);
  // The club this hook last read, as the server knows it (its UUID).
  const resolved = useRef<string | null>(null);
  // When the last read set off, so a tab return can tell whether it is news.
  const lastRead = useRef(0);
  const refresh = useCallback(async () => {
    if (!clubId || !user?.id || !enabled) return;
    const g = ++generation.current;
    lastRead.current = Date.now();
    setLoading(true);
    try {
      // Callers pass whatever their route carries: a UUID, a club code or a
      // slug ("shark-club"). The server takes the UUID; a slug sent as-is was
      // refused with 22P02 on every read, so the Diamonds-to-Chips door and the
      // bust prompt never learned the player's balance.
      const club = await resolveClubUUID(clubId);
      resolved.current = club;
      const next = await DiamondGamesService.entry(club);
      if (alive.current && currentScope.current === scope && generation.current === g)
        setSnapshot({ scope, entry: next.ok ? next : null });
    } catch (err) {
      reportError(err, 'useDiamondGamesEntry');
      if (alive.current && currentScope.current === scope && generation.current === g)
        setSnapshot({ scope, entry: null });
    } finally {
      if (alive.current && currentScope.current === scope && generation.current === g)
        setLoading(false);
    }
  }, [clubId, enabled, user?.id, scope]);
  useEffect(() => {
    alive.current = true;
    let burst: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      void refresh();
    };
    // A wallet or seat event always reads, once per burst.
    const soon = () => {
      if (burst !== null) return;
      burst = setTimeout(() => {
        burst = null;
        read();
      }, EVENT_COALESCE_MS);
    };
    const returned = () => {
      if (Date.now() - lastRead.current < RETURN_FRESH_MS) return;
      read();
    };
    const visible = () => {
      if (!document.hidden) returned();
    };
    read();
    const off = [
      masterBus.subscribe('BALANCE_UPDATED', (event) => {
        if (typeof event.payload.userId === 'string' && event.payload.userId !== user?.id) return;
        const club = event.payload.clubId;
        if (typeof club === 'string' && club !== clubId && club !== resolved.current) return;
        soon();
      }),
      masterBus.subscribe('DIAMOND_BALANCE_CHANGED', soon),
      masterBus.subscribe('TABLE_LEFT', (event) => {
        if (!event.payload.userId || event.payload.userId === user?.id) soon();
      }),
    ];
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false;
      ++generation.current;
      if (burst !== null) clearTimeout(burst);
      off.forEach((stop) => stop());
      window.removeEventListener('focus', returned);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh, user?.id, clubId]);
  return { entry: snapshot.scope === scope ? snapshot.entry : null, loading, refresh };
}
export default useDiamondGamesEntry;
