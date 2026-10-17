/**
 * WHO MAY OPEN CLUB DATA, AND HOW MUCH OF IT (Dan 2026-10-17)
 * ============================================================================
 * "CLUB OWNERS SEE EVERYTHING, AGENTS SEE THERE GENERATED STATS + DOWNLINES,
 * REGULAR PLAYER ACCOUNTS DONT SEE THE DATA BUTTON OR PAGES."
 *
 * The answer comes from the database (fn_ca_club_data_scope), the same
 * function ca_club_data_screen enforces, so the footer never offers a door
 * the page would refuse:
 *   'club'      the owner, co-owner, admins (and platform admins)
 *   'downline'  agents of every rank: themselves and their downline
 *   null        everyone else: no Data door, and the page refuses
 *
 * The answer is remembered per account and club for the session, so the
 * footer does not change shape on every page. Until it is known the footer
 * shows the member doors (most accounts are players); an operator's Data
 * door appears as soon as the read lands.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuthUser } from './useAuthUser';
import { isUUID, resolveClubUUID } from '../utils/clubIdResolver';

export type ClubDataScope = 'club' | 'downline' | null;

const memory = new Map<string, ClubDataScope>();
const STORAGE_PREFIX = 'ca.clubDataScope.';

function cacheKey(userId: string, club: string): string {
  return `${userId}:${club}`;
}

export function readCachedClubDataScope(
  userId: string | null | undefined,
  club: string | null | undefined
): ClubDataScope | undefined {
  if (!userId || !club) return undefined;
  const key = cacheKey(userId, club);
  if (memory.has(key)) return memory.get(key);
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (raw === 'club' || raw === 'downline') return raw;
    if (raw === 'none') return null;
  } catch {
    /* storage can be unavailable; the read below answers */
  }
  return undefined;
}

function writeCache(userId: string, club: string, scope: ClubDataScope): void {
  const key = cacheKey(userId, club);
  memory.set(key, scope);
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, scope ?? 'none');
  } catch {
    /* best effort */
  }
}

/** Test seam: forget every remembered answer. */
export function clearClubDataScopeCache(): void {
  memory.clear();
}

export function useClubDataScope(club: string | null | undefined): {
  scope: ClubDataScope;
  known: boolean;
} {
  const { user } = useAuthUser();
  const userId = user?.id ?? null;
  const cached = readCachedClubDataScope(userId, club);
  const [answer, setAnswer] = useState<{ key: string; scope: ClubDataScope } | null>(null);
  const key = userId && club ? cacheKey(userId, club) : null;

  useEffect(() => {
    if (!userId || !club || cached !== undefined) return;
    let dead = false;
    void (async () => {
      try {
        const id = isUUID(club) ? club : await resolveClubUUID(club);
        if (!id || !isUUID(id)) return;
        const { data, error } = await supabase.rpc('fn_ca_club_data_scope', { p_club_id: id });
        if (dead || error) return;
        const scope: ClubDataScope = data === 'club' || data === 'downline' ? data : null;
        writeCache(userId, club, scope);
        setAnswer({ key: cacheKey(userId, club), scope });
      } catch {
        /* unknown stays unknown: the member doors stay up */
      }
    })();
    return () => {
      dead = true;
    };
  }, [userId, club, cached]);

  if (cached !== undefined) return { scope: cached, known: true };
  if (answer && answer.key === key) return { scope: answer.scope, known: true };
  return { scope: null, known: false };
}
