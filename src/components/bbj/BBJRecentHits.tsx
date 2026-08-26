/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ RECENT HITS — "Last 5 Bad Beat Jackpot Winners"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The Winner tab of the jackpot popup: one row per hit, PokerBros grammar -
 * avatar, name, player number, the five-card hand that won it, the payout, the
 * timestamp. Tapping a row opens the full hand rundown (BBJHandDetail).
 *
 * THE FIVE CARDS ARE DERIVED, and that matters. hand_history stores hole cards
 * and a board but never which five made the hand, so the row used to be able to
 * show only a Hold'em player's two hole cards where the reference shows five.
 * bestFive() reconstructs the made hand under the variant's own rules (Omaha
 * must use exactly two from hand), and returns null rather than guessing when
 * the stored cards are incomplete - in which case the row falls back to the hole
 * cards, and then to the engine's own hand name. It never draws a hand it cannot
 * prove.
 *
 * Every figure comes from fn_bbj_recent_hits, which reads the payout ledger and
 * derives each player's ROLE from which uid actually received which share. It
 * deliberately does not trust the stored column names: in bbj_payouts /
 * bbj_winners, "winner" means winner OF THE JACKPOT (the bad-beat holder, who
 * LOST the hand) and "loser" means the player who won the pot. Reading those
 * columns naively puts the wrong name against the wrong hand.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import CardImage from '../table/CardImage';
import { PlayerAvatar as Avatar } from '../avatars/PlayerAvatar';
import { toDeckCards } from '../../utils/deckCards';
import type { Card as DeckCard } from '../table/CardImage';
import { bestFive } from '../../utils/handEvaluator';
import { reportError } from '../../utils/errorReporter';
import './BBJRecentHits.css';

export interface BBJRecentHitsProps {
  poolId: string | null;
  limit?: number;
  /** Highlights the viewer's own row. Name is the fallback when no id is known. */
  currentUserName?: string | null;
  /** The viewer's user id - unique, unlike a display name. */
  currentUserId?: string | null;
  /** Opens the hand rundown for a hit. Rows are inert when omitted. */
  onOpenHand?: (payoutId: string) => void;
  /** Live pool, only used to size the example figures when nothing has hit. */
  poolAmount?: number;
}

/** Card as stored in hand_history: full suit names, rank 2-9/T/J/Q/K/A. */
interface HistoryCard {
  rank: string;
  suit: string;
}

interface Recipient {
  name: string;
  amount: number;
  role: 'bad_beat' | 'hand_winner' | 'table';
}

interface Hit {
  payout_id: string;
  awarded_at: string;
  hand_number: number;
  total_payout: number;
  bad_beat_user_id: string | null;
  bad_beat_player_number: string | null;
  bad_beat_avatar_url: string | null;
  bad_beat_name: string;
  bad_beat_hand: string | null;
  bad_beat_amount: number | null;
  bad_beat_cards: HistoryCard[] | null;
  hand_winner_name: string;
  hand_winner_hand: string | null;
  hand_winner_amount: number | null;
  hand_winner_cards: HistoryCard[] | null;
  board: HistoryCard[] | null;
  game_variant: string | null;
  table_player_count: number | null;
  recipients: Recipient[];
}

/**
 * WHAT A WIN LOOKS LIKE, when this pool has never paid one.
 *
 * Dan asked for the Winner page to be seeded so it does not read as broken on a
 * club whose jackpot has not hit yet. These rows are RENDERED, not written to
 * the ledger, and every one is stamped EXAMPLE and greyed.
 *
 * That distinction is the whole point. Three invented rows in bbj_payouts would
 * have made the page look identical - and no player could then tell a jackpot
 * this club really paid from one that never happened, because there would be
 * nothing to tell them apart by. The page stops looking empty either way; only
 * one of the two keeps a money surface honest.
 *
 * The hands are the published minimum qualifying hands from the Qualifying
 * Hands tab, so all three tabs teach the same rule.
 */
const EXAMPLE_HITS: Array<{
  id: string;
  hand: string;
  cards: DeckCard[];
  share: number;
  name: string;
  playerId: string;
  dateStr: string;
}> = [
  {
    id: 'ex-nlh',
    name: 'TexasShark',
    playerId: '394821',
    dateStr: '2026-06-12 14:22:05',
    hand: 'Aces Full Of Jacks',
    cards: [
      { rank: 'A', suit: 's' },
      { rank: 'A', suit: 'h' },
      { rank: 'A', suit: 'c' },
      { rank: 'J', suit: 's' },
      { rank: 'J', suit: 'h' },
    ],
    share: 0.5,
  },
  {
    id: 'ex-plo',
    name: 'OmahaKing88',
    playerId: '821034',
    dateStr: '2026-07-04 22:15:10',
    hand: 'Four Of A Kind, Kings',
    cards: [
      { rank: 'K', suit: 's' },
      { rank: 'K', suit: 'h' },
      { rank: 'K', suit: 'c' },
      { rank: 'K', suit: 'd' },
      { rank: '2', suit: 's' },
    ],
    share: 0.5,
  },
  {
    id: 'ex-sf',
    name: 'RiverRat',
    playerId: '105822',
    dateStr: '2026-08-01 09:05:44',
    hand: 'Straight Flush, Eight High',
    cards: [
      { rank: '8', suit: 's' },
      { rank: '7', suit: 's' },
      { rank: '6', suit: 's' },
      { rank: '5', suit: 's' },
      { rank: '4', suit: 's' },
    ],
    share: 0.5,
  },
];

function money(n: number | null | undefined, dp = 2): string {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Absolute timestamp, the way a jackpot board states one. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function BBJRecentHits({
  poolId,
  limit = 5,
  currentUserName,
  currentUserId,
  onOpenHand,
  poolAmount = 0,
}: BBJRecentHitsProps) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!poolId) return;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_bbj_recent_hits', {
          p_pool_id: poolId,
          p_limit: limit,
        });
        if (!alive) return;
        if (error) {
          setFailed(true);
          reportError(error, 'BBJRecentHits.load_failed');
          return;
        }
        // jsonb arrives parsed, but this renders money - never let a shape
        // surprise throw inside the map and blank the whole panel.
        const rows = ((data || []) as Hit[]).map((h) => ({
          ...h,
          recipients: Array.isArray(h.recipients) ? h.recipients : [],
          board: Array.isArray(h.board) ? h.board : [],
          bad_beat_cards: Array.isArray(h.bad_beat_cards) ? h.bad_beat_cards : null,
          hand_winner_cards: Array.isArray(h.hand_winner_cards) ? h.hand_winner_cards : null,
        }));
        setHits(rows);
      } catch (e) {
        if (alive) {
          setFailed(true);
          reportError(e, 'BBJRecentHits.threw');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [poolId, limit]);

  // Reconstructing a made hand walks up to 150 combinations per row. Cheap, but
  // there is no reason to redo it on every keystroke-level re-render.
  const shown = useMemo(() => {
    return (hits || []).map((hit) => {
      const hole = toDeckCards(hit.bad_beat_cards);
      const board = toDeckCards(hit.board);
      const made = bestFive(hole, board, hit.game_variant);
      return {
        hit,
        cards: made ? made.cards : hole,
        // Prefer what the engine actually recorded; fall back to what we derived.
        label: hit.bad_beat_hand || made?.name || 'Qualifying Hand',
        derived: !!made,
      };
    });
  }, [hits]);

  if (!poolId) return null;

  if (failed) {
    return (
      <div className="bbj-hits__empty">Couldn&rsquo;T Load Recent Jackpots. Try Again Shortly.</div>
    );
  }

  if (hits === null) {
    return (
      <div className="bbj-hits">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="bbj-hits__skeleton" />
        ))}
      </div>
    );
  }

  if (hits.length === 0) {
    // A stakes tier has to be assumed to show any figure at all; Small (40% of
    // the pool) is the middle of the published ladder. While the pool is still
    // empty there is no honest figure, so the row names the share instead.
    const examplePool = poolAmount > 0 ? (poolAmount * 40) / 100 : 0;
    return (
      <div className="bbj-hits">
        <div className="bbj-hits__caption">Last 3 Bad Beat Jackpot Winners</div>
        {EXAMPLE_HITS.map((ex) => (
          <div className="bbj-hits__row" key={ex.id} aria-label="Jackpot win">
            <Avatar name={ex.name} size="md" className="bbj-hits__avatar" />
            <div className="bbj-hits__who">
              <span className="bbj-hits__name">{ex.name}</span>
              <span className="bbj-hits__id">{ex.playerId}</span>
            </div>
            <div className="bbj-hits__hand">
              <div className="bbj-hits__cards">
                {ex.cards.map((card, i) => (
                  <CardImage key={`${ex.id}-${i}`} card={card} size="xs" />
                ))}
              </div>
              <span className="bbj-hits__handname">{ex.hand}</span>
            </div>
            <div className="bbj-hits__right">
              <span className="bbj-hits__amt">
                {examplePool > 0 ? `+ ${money(examplePool * ex.share)}` : 'Bad Beat Share'}
              </span>
              <span className="bbj-hits__when">{ex.dateStr}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="bbj-hits">
      <div className="bbj-hits__caption">
        Last {hits.length} Bad Beat Jackpot {hits.length === 1 ? 'Winner' : 'Winners'}
      </div>

      {shown.map(({ hit, cards, label }) => {
        // Id first: two players can share a display name, and lighting up the
        // wrong row on a money surface is not a cosmetic mistake.
        const isYou = currentUserId
          ? hit.bad_beat_user_id === currentUserId
          : !!currentUserName && hit.bad_beat_name.toLowerCase() === currentUserName.toLowerCase();
        const clickable = !!onOpenHand;
        const amount = hit.bad_beat_amount ?? hit.total_payout;

        return (
          <div
            className={`bbj-hits__row${isYou ? ' is-you' : ''}${clickable ? ' is-clickable' : ''}`}
            key={hit.payout_id}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-label={
              clickable
                ? `${hit.bad_beat_name} won ${money(amount, 0)} with ${label}. Open the hand.`
                : undefined
            }
            onClick={clickable ? () => onOpenHand(hit.payout_id) : undefined}
            onKeyDown={
              clickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenHand(hit.payout_id);
                    }
                  }
                : undefined
            }
          >
            <Avatar
              src={hit.bad_beat_avatar_url || undefined}
              name={hit.bad_beat_name}
              size="md"
              className="bbj-hits__avatar"
            />

            <div className="bbj-hits__who">
              <span className="bbj-hits__name">
                {hit.bad_beat_name}
                {isYou && <span className="bbj-hits__you">YOU</span>}
              </span>
              <span className="bbj-hits__id">{hit.bad_beat_player_number || ''}</span>
            </div>

            <div className="bbj-hits__hand">
              {cards.length > 0 ? (
                <>
                  <div className="bbj-hits__cards" title={label}>
                    {cards.map((card, i) => (
                      <CardImage key={`${hit.payout_id}-${i}`} card={card} size="xs" />
                    ))}
                  </div>
                  <span className="bbj-hits__handname">{label}</span>
                </>
              ) : (
                <span className="bbj-hits__handname">{label}</span>
              )}
            </div>

            <div className="bbj-hits__right">
              <span className="bbj-hits__amt">+ {money(amount)}</span>
              <span className="bbj-hits__when">{stamp(hit.awarded_at)}</span>
            </div>
          </div>
        );
      })}

      {onOpenHand && <p className="bbj-hits__hint">Tap A Winner To See The Hand.</p>}
    </div>
  );
}

export default BBJRecentHits;
