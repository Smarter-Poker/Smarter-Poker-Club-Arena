/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useHandReplayModel — the raw hand row, rebuilt for the shared rundown
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27: "make sure that smarter.poker looks and feels like this with
 * all the same data points and architecture."
 *
 * The table's Previous Hand modal renders off `HandRecord`, which is what
 * `handHistoryAdapter` produces — and that adapter deliberately drops most of
 * what a full rundown needs. Its own comments say so:
 *
 *     pot: 0,     // not stored per street — only the final pot is persisted
 *     stack: 0,   // not stored per hand in hand_history
 *
 * Neither is true any more; both were reconstructible all along, and four more
 * columns the adapter never selected (`button_seat`, `bbj_amount`, `showdown`,
 * `pots`) carry the rest. Rather than widen `HandRecord` and every consumer of
 * it — the panel, the replay player, the share modal, the text exporter — this
 * reads the ONE row the modal is currently showing and hands it to the same
 * `buildReplay()` the jackpot rundown uses.
 *
 * The extra read is cheap and cached per hand id: a player pages through their
 * own session, and RLS already lets them read a hand they were dealt into, so
 * no new grant is involved.
 *
 * `button_seat` matters more than it looks. `HandHistoryService` derives the
 * button from `players[].isButton`, a field NOTHING in the codebase has ever
 * written, so it falls back to seat 1 and every position badge the table draws
 * is wrong. The column has been written correctly the whole time; it was simply
 * never selected. Reading it here is what makes the position column true.
 */

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  buildReplay,
  replayInputFromRow,
  type HandHistoryRowLike,
  type ReplayModel,
} from '../utils/handReplay';
import { reportError } from '../utils/errorReporter';

const COLUMNS = [
  'id',
  'created_at',
  'started_at',
  'hand_number',
  'game_variant',
  'small_blind',
  'big_blind',
  'pot_size',
  'rake_amount',
  'bbj_amount',
  'button_seat',
  'community_cards',
  'community_cards2',
  'community_cards3',
  'rit_boards',
  'players',
  'actions',
  'winners',
  'winners_by_board',
  'hole_cards',
  'showdown',
  'pots',
].join(', ');

export type HandReplayState = 'idle' | 'loading' | 'ready' | 'missing' | 'failed';

export function useHandReplayModel(handId: string | null | undefined): {
  model: ReplayModel | null;
  state: HandReplayState;
} {
  const [model, setModel] = useState<ReplayModel | null>(null);
  const [state, setState] = useState<HandReplayState>('idle');
  // Paging back and forth through a session must not refetch the same hand.
  /* Lazily created. `useRef(new Map())` evaluates its argument on EVERY
     render and throws all but the first away - invisible functionally, but
     this hook lives in a modal the player pages through hand by hand. */
  const cache = useRef<Map<string, ReplayModel> | null>(null);
  if (cache.current === null) cache.current = new Map<string, ReplayModel>();
  /* Bounded. The modal that owns this hook is mounted for the whole session,
     so an unbounded map kept every hand ever paged to. Oldest entry out. */
  const CACHE_MAX = 40;

  useEffect(() => {
    if (!handId) {
      setModel(null);
      setState('idle');
      return;
    }

    const cached = cache.current!.get(handId);
    if (cached) {
      setModel(cached);
      setState('ready');
      return;
    }

    let alive = true;
    setState('loading');
    setModel(null);

    (async () => {
      try {
        const { data, error } = await supabase
          .from('hand_history')
          .select(COLUMNS)
          .eq('id', handId)
          .maybeSingle();

        if (!alive) return;
        if (error) {
          setState('failed');
          reportError(error, 'useHandReplayModel.query');
          return;
        }
        if (!data) {
          setState('missing');
          return;
        }

        // The generated row type resolves to GenericStringError when the column
        // list is built at runtime, so this goes through `unknown` deliberately.
        // ONE MAPPER (2026-09-04): the same row->input mapping HandHistoryService
        // uses, so a column read here is read there and a field added to one
        // cannot be silently absent from the other.
        const built = buildReplay(replayInputFromRow(data as unknown as HandHistoryRowLike));

        if (cache.current!.size >= CACHE_MAX) {
          const oldest = cache.current!.keys().next().value;
          if (oldest !== undefined) cache.current!.delete(oldest);
        }
        cache.current!.set(handId, built);
        setModel(built);
        setState('ready');
      } catch (e) {
        if (!alive) return;
        setState('failed');
        reportError(e, 'useHandReplayModel.threw');
      }
    })();

    return () => {
      alive = false;
    };
  }, [handId]);

  return { model, state };
}

export default useHandReplayModel;
