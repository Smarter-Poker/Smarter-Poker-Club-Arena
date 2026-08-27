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
import { buildReplay, type ReplayModel } from '../utils/handReplay';
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
  'rit_boards',
  'players',
  'actions',
  'winners',
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
        const row = data as unknown as Record<string, unknown>;
        const built = buildReplay({
          handNumber: (row.hand_number as number) ?? null,
          playedAt: ((row.started_at as string) || (row.created_at as string)) ?? null,
          gameVariant: (row.game_variant as string) ?? null,
          smallBlind: Number(row.small_blind) || 0,
          bigBlind: Number(row.big_blind) || 0,
          potSize: Number(row.pot_size) || 0,
          rakeAmount: Number(row.rake_amount) || 0,
          bbjAmount: Number(row.bbj_amount) || 0,
          buttonSeat: (row.button_seat as number) ?? null,
          board: (row.community_cards as string[]) ?? [],
          // rit_boards is boards 2..N of a run-it-twice; community_cards2 is the
          // second board of a double-board bomb pot. Different features, both
          // extra boards as far as the rundown is concerned.
          extraBoards: [
            ...(((row.rit_boards as string[][]) || []) as string[][]),
            ...(row.community_cards2 ? [row.community_cards2 as string[]] : []),
          ],
          players: (((row.players as unknown[]) || []) as Array<Record<string, unknown>>).map(
            (p) => ({
              userId: String(p.userId ?? ''),
              username: String(p.username ?? 'Player'),
              seat: Number(p.seat),
              stack: p.stack === undefined || p.stack === null ? null : Number(p.stack),
            })
          ),
          actions: (((row.actions as unknown[]) || []) as Array<Record<string, unknown>>).map(
            (a) => ({
              seat: Number(a.seat),
              userId: String(a.userId ?? ''),
              action: String(a.action ?? ''),
              amount: a.amount === undefined || a.amount === null ? 0 : Number(a.amount),
              stage: (a.stage as string) ?? null,
            })
          ),
          winners: (((row.winners as unknown[]) || []) as Array<Record<string, unknown>>).map(
            (w) => ({
              userId: String(w.userId ?? ''),
              amount: Number(w.amount) || 0,
              potIndex: Number(w.potIndex) || 0,
              hand: (w.hand as { name?: string }) ?? null,
            })
          ),
          holeCards: (row.hole_cards as Record<string, never[]>) ?? {},
          showdown: (row.showdown as never[]) ?? null,
          pots: (row.pots as never[]) ?? null,
        });

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
