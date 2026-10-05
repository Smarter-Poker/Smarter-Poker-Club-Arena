/**
 * Who of these accounts is online now, by the one definition
 * (fn_profile_presence: the flag AND a heartbeat under five minutes old),
 * re-asked every PRESENCE_RECHECK_MS while mounted so a dot goes dark when its
 * heartbeat goes stale. See src/lib/profilePresence.ts.
 *
 * An account not yet answered, or whose presence cannot be read, is absent
 * from the map; callers treat absent as offline or fall back to an answer the
 * same door gave them earlier (an RPC that applies the same rule).
 */
import { useEffect, useMemo, useState } from 'react';
import { watchProfilePresence, type PresenceAnswer } from '../lib/profilePresence';

const NONE: PresenceAnswer = new Map();

function sameAnswer(a: PresenceAnswer, b: PresenceAnswer): boolean {
  if (a.size !== b.size) return false;
  for (const [id, online] of a) if (b.get(id) !== online || !b.has(id)) return false;
  return true;
}

export function useProfilePresence(
  userIds: readonly (string | null | undefined)[]
): PresenceAnswer {
  const key = useMemo(
    () => [...new Set(userIds.filter((id): id is string => !!id))].sort().join(','),
    [userIds]
  );
  const [answer, setAnswer] = useState<PresenceAnswer>(NONE);

  useEffect(() => {
    if (!key) {
      setAnswer(NONE);
      return;
    }
    const ids = key.split(',');
    return watchProfilePresence(ids, (all) => {
      const mine = new Map<string, boolean>();
      for (const id of ids) if (all.has(id)) mine.set(id, all.get(id) === true);
      setAnswer((prev) => (sameAnswer(prev, mine) ? prev : mine));
    });
  }, [key]);

  return answer;
}

/** One account: online now by the one definition. */
export function useIsProfileOnline(userId: string | null | undefined): boolean {
  const ids = useMemo(() => (userId ? [userId] : []), [userId]);
  return useProfilePresence(ids).get(userId ?? '') === true;
}

/**
 * One account on a row an RPC already answered: the latest re-ask of the
 * presence door, else `loadedAnswer` until that first re-ask lands. Use only
 * where `loadedAnswer` came from the same rule (fn_profile_presence, or an
 * RPC whose is_online is the flag AND a heartbeat under five minutes old) -
 * never the raw profiles.is_online flag.
 */
export function useOnlineNow(userId: string | null | undefined, loadedAnswer: boolean): boolean {
  const ids = useMemo(() => (userId ? [userId] : []), [userId]);
  const live = useProfilePresence(ids).get(userId ?? '');
  return live === undefined ? loadedAnswer === true : live;
}
