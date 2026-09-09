/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useTournamentEntries — the field, loaded once, with failure kept separate
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-08-26).
 *
 * `RankingTab` renders the field from PROPS and issues no query of its own, so
 * something above it has to hold the entry list. `TournamentDetails` already
 * does; `TournamentPage`'s running-tournament pane did not - it mounted
 * `TournamentStandings`, which fetched its own copy of the same rows. That
 * component has been retired, and the one piece of it worth keeping is this:
 *
 *   A FAILED QUERY IS NOT AN EMPTY TOURNAMENT.
 *
 * supabase-js RETURNS an error rather than throwing it, so the naive shape
 * (`setEntries(data || [])`, clear the spinner in a `finally`) turns a refused
 * or dropped query into a confident, fully-formed statement about a running
 * event: "Remaining 0", "No Players Yet". That is the estate's single most
 * repeated defect, and it is the reason this hook reports THREE states rather
 * than two:
 *
 *   loading                  we have not asked yet, or the first ask is in
 *                            flight - say nothing about the field;
 *   loadFailed && no rows    we asked and got no answer - say THAT, and never
 *                            print the "none" copy;
 *   loadFailed && rows       a REFRESH failed - keep the last good board on
 *                            screen and mark it as no longer updating;
 *   neither                  the answer is the answer, empty included.
 *
 * ── WHAT KEEPS IT FRESH ──────────────────────────────────────────────────────
 *
 * RankingTab carries its own `tournament_players` subscription and patches
 * chips, status, position and table_id onto whatever it is given, so this hook
 * does NOT need to be realtime for a stack to move. What only a refetch can
 * deliver is a row that did not exist yet - a late registration - so it polls,
 * at the same 30s the retired component used, and skips the poll entirely while
 * the tab is hidden.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useIsMounted } from './useIsMounted';
import { reportError } from '../utils/errorReporter';
import type { TournamentEntry } from '../components/tournament/details/types';

/** How often the field is re-read for rows that did not exist before. */
const POLL_MS = 30000;

export interface UseTournamentEntriesResult {
  entries: TournamentEntry[];
  /** Durable count of every tournament_players row, not the draining seat counter. */
  entryCount: number | null;
  /** True until the first attempt has settled, either way. */
  loading: boolean;
  /** True when the most recent attempt did not come back with an answer. */
  loadFailed: boolean;
  /** Ask again now. Safe to call from an event handler. */
  refresh: () => void;
}

/**
 * The registered field for one tournament.
 *
 * `active` is the gate: pass false and the hook holds no rows and makes no
 * requests, so browsing a lobby of events that are not open costs nothing.
 */
export function useTournamentEntries(
  tournamentId: string | null | undefined,
  active: boolean,
  startingChips = 0
): UseTournamentEntriesResult {
  const isMounted = useIsMounted();
  const [entries, setEntries] = useState<TournamentEntry[]>([]);
  const [entryCount, setEntryCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Bumped by `refresh()`; the effect below watches it. */
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!tournamentId || !active) {
      setEntries([]);
      setEntryCount(null);
      setLoading(false);
      setLoadFailed(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      /**
       * The same projection TournamentDetails uses, because the tabs read the
       * same fields wherever they are mounted. The `profiles` embed rides
       * `fk_tournament_players_user_id_profiles` - one join for the whole
       * list, never one request per player.
       */
      const { data, error, count } = await supabase
        .from('tournament_players')
        .select(
          'id, user_id, username, chips, status, position, prize, table_id, registered_at, rebuys, add_on, profile:profiles!user_id(player_number, avatar_url:arena_avatar_url)',
          { count: 'exact' }
        )
        .eq('tournament_id', tournamentId)
        .order('registered_at', { ascending: true });

      if (cancelled || !isMounted.current) return;

      if (error) {
        reportError(error, 'useTournamentEntries.Failed_to_load_entries');
        setLoadFailed(true);
        setLoading(false);
        return;
      }

      const rows = (data || []) as Record<string, unknown>[];
      const mapped: TournamentEntry[] = rows.map((e) => {
        // PostgREST returns an embedded row as an object but types it as an
        // array in some shapes. Accept both rather than guess.
        const rawProfile = e.profile as
          | { player_number?: string | null; avatar_url?: string | null }
          | { player_number?: string | null; avatar_url?: string | null }[]
          | null
          | undefined;
        const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;
        return {
          id: String(e.id),
          user_id: String(e.user_id),
          username: (e.username as string) || 'Player',
          avatar_url: profile?.avatar_url || null,
          player_code: profile?.player_number ? String(profile.player_number) : null,
          chips: Number(e.chips) || startingChips,
          position: (e.position as number) || undefined,
          prize:
            e.prize !== null && e.prize !== undefined && Number.isFinite(Number(e.prize))
              ? Number(e.prize)
              : undefined,
          status: e.status as TournamentEntry['status'],
          table_id: (e.table_id as string | null) || null,
          created_at: (e.registered_at as string | null) ?? null,
          rebuys: Number(e.rebuys) || 0,
          // `add_on` is a BOOLEAN in production, not a count. Collapse it to
          // 0 or 1 rather than pretend the column records how many.
          add_ons: e.add_on ? 1 : 0,
        };
      });

      setEntries(mapped);
      setEntryCount(typeof count === 'number' ? count : mapped.length);
      setLoadFailed(false);
      setLoading(false);
    };

    void load();

    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void load();
    }, POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      cancelled = true;
      clearInterval(iv);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [tournamentId, active, startingChips, nonce, isMounted]);

  return { entries, entryCount, loading, loadFailed, refresh };
}

export default useTournamentEntries;
