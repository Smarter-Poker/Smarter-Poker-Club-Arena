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
 * THE AVATAR IS THE CLUB AVATAR (Dan, 2026-08-27: "you need to use there club
 * avatar as the image, not there profile pics"). fn_bbj_recent_hits serves
 * profiles.arena_avatar_url - Club Arena's own column, library art, the same
 * one the felt reads - and never profiles.avatar_url, which is the social
 * media photo and is not this app's to display. That arrives as a Hub-relative
 * path like /avatars/table/vip_spartan@2x.webp, so it goes through
 * getAvatarWithFallback exactly as SeatSlot does: absolute Hub origin (so it
 * also resolves in local dev), and a deterministic monogram when a winner has
 * not picked one.
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
import { toDeckCards } from '../../utils/deckCards';
import type { Card as DeckCard } from '../table/CardImage';
import { bestFive } from '../../utils/handEvaluator';
import { getAvatarWithFallback } from '../../utils/avatarGenerator';
import { titleCase } from '../../utils/handReplay';
import { reportError } from '../../utils/errorReporter';
import './BBJRecentHits.css';
import { gameTypeLabel, money, stamp } from '../../utils/handFormat';

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
  /** How many jackpots this pool has paid in total, not just on this page. */
  total_hits?: number | null;
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

/**
 * Dan 2026-08-27: "double the size of the current avatar, and remove the circle
 * frame. avatars should display here like they do on the table with no
 * background. remove the 1 pill tag at the bottom."
 *
 * So this row no longer uses PlayerAvatar, which draws a circular crop, a VIP
 * ring, a presence dot and the level badge that pill came from. The library art
 * is a free-standing bust with its own transparency — the felt renders it as a
 * bare <img> and so does this, at 96px against the old 48. DOUBLE, which is what
 * was asked for: it was drawn at 60 for a week, and 60 is not double 48.
 *
 * The number must match the CSS box (.bbj-hits__avatar). It has now been wrong
 * twice - 96 against a 76px box, then 76 against a 60px box - each time
 * over-fetching the image AND writing intrinsic width/height attributes that
 * disagree with what is rendered. tests/unit/bbjAvatarSize.test.ts reads both
 * files and fails if they part company again.
 */
const BBJ_AVATAR_PX = 96;

/**
 * jsonb arrives parsed, but this renders money - never let a shape surprise
 * throw inside the map and blank the whole panel.
 */
function normalize(data: unknown): Hit[] {
  return ((data || []) as Hit[]).map((h) => ({
    ...h,
    recipients: Array.isArray(h.recipients) ? h.recipients : [],
    board: Array.isArray(h.board) ? h.board : [],
    bad_beat_cards: Array.isArray(h.bad_beat_cards) ? h.bad_beat_cards : null,
    hand_winner_cards: Array.isArray(h.hand_winner_cards) ? h.hand_winner_cards : null,
  }));
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
  /**
   * PAGING. The list ended at `limit` and said nothing about the rest.
   *
   * `fn_bbj_recent_hits` capped at 25 with no cursor, so the 26th jackpot a
   * club ever paid was unreachable from the product entirely; on top of that
   * the popup asked for 5 and the page for 10, so a pool with 24 hits showed
   * ten and gave no hint the other fourteen existed. The RPC now takes a
   * keyset cursor and returns `total_hits`, which is what lets this offer
   * another page only when there genuinely is one.
   */
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);
  /**
   * Bumped by a live `bbj_winners` INSERT.
   *
   * AUDIT 2026-08-27: every other BBJ surface was already live — the table's
   * pool ticker, BBJTicker, BadBeatJackpotPage's toast — and this one, the list
   * a player actually opens after a jackpot lands, was the only mount-only
   * fetch on the feature. Its effect keyed on [poolId, limit], and neither
   * changes when a hit arrives, so the rows sat stale until the component
   * unmounted. The pool number above it would tick up while the list under it
   * still showed the previous five winners.
   */
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!poolId) return;
    const channel = supabase
      .channel(`bbj-recent-hits-${poolId}`)
      /* FILTERED. The channel NAME was scoped to the pool and the subscription
         was not, so every jackpot anywhere on the platform - any club, any
         union - forced a full refetch of this pool's list. Both sibling
         surfaces (BBJTicker, BadBeatJackpotPage) already filter on pool_id. */
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'bbj_winners',
          filter: `pool_id=eq.${poolId}`,
        },
        () => setRevision((r) => r + 1)
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [poolId]);

  useEffect(() => {
    if (!poolId) return;
    let alive = true;
    /* A NEW POOL IS NOT THE OLD POOL'S ROWS.
       `hits` was only ever assigned on success, so switching clubs left the
       previous club's winners and payout figures mounted - and because
       `hits !== null` the skeleton never showed, so there was no visible moment
       of loading to suggest they were stale. `failed` had the mirror problem:
       nothing ever set it back to false, so one transient RPC error stuck the
       panel on its error message for the life of the component, including
       through the realtime refetch after a real jackpot landed. */
    setHits(null);
    setTotal(null);
    setFailed(false);
    setMoreFailed(false);
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
        const rows = normalize(data);
        setHits(rows);
        setTotal(rows[0]?.total_hits ?? rows.length);
        setMoreFailed(false);
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
  }, [poolId, limit, revision]);

  /**
   * The next page, appended.
   *
   * The cursor is the OLDEST row currently held, passed as the pair
   * (awarded_at, payout_id) - a timestamp alone would silently skip a jackpot
   * if two ever shared a microsecond, and on a money surface that is the one
   * failure mode worth two parameters to rule out.
   *
   * A page that fails does NOT clear what is already on screen: the rows the
   * player is reading stay, and the button says the extra ones could not be
   * fetched.
   */
  const loadMore = async () => {
    const held = hits || [];
    const last = held[held.length - 1];
    if (!poolId || !last || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const { data, error } = await supabase.rpc('fn_bbj_recent_hits', {
        p_pool_id: poolId,
        p_limit: Math.max(limit, 10),
        p_before: last.awarded_at,
        p_before_id: last.payout_id,
      });
      if (error) {
        setMoreFailed(true);
        reportError(error, 'BBJRecentHits.more_failed');
        return;
      }
      const rows = normalize(data);
      if (rows.length > 0) {
        // Guard the append against a duplicate: a jackpot landing between the
        // two calls shifts nothing here (the cursor is anchored to a row, not
        // an offset), but a retry or a double tap could.
        const seen = new Set(held.map((h) => h.payout_id));
        setHits([...held, ...rows.filter((r) => !seen.has(r.payout_id))]);
      }
      if (rows[0]?.total_hits != null) setTotal(rows[0].total_hits);
    } catch (e) {
      setMoreFailed(true);
      reportError(e, 'BBJRecentHits.more_threw');
    } finally {
      setLoadingMore(false);
    }
  };

  // Reconstructing a made hand walks up to 150 combinations per row. Cheap, but
  // there is no reason to redo it on every keystroke-level re-render.
  const shown = useMemo(() => {
    return (hits || []).map((hit) => {
      const hole = toDeckCards(hit.bad_beat_cards);
      const board = toDeckCards(hit.board);
      const made = bestFive(hole, board, hit.game_variant);
      const winnerHole = toDeckCards(hit.hand_winner_cards);
      const winnerMade = bestFive(winnerHole, board, hit.game_variant);
      return {
        hit,
        cards: made ? made.cards : hole,
        /**
         * THE HAND THAT BEAT IT. `fn_bbj_recent_hits` has always returned
         * `hand_winner_cards`, `hand_winner_hand` and `hand_winner_name`, and
         * this row rendered none of them — so a list headed "Bad Beat Jackpot
         * Winners" showed the losing hand and left out the beat that made it
         * a jackpot at all.
         */
        beatBy: winnerMade ? winnerMade.cards : winnerHole,
        beatByLabel: titleCase(hit.hand_winner_hand || winnerMade?.name || ''),
        // Prefer what the engine actually recorded; fall back to what we derived.
        // Title Cased per the house rule, so "Four of a Kind" reads
        // "Four Of A Kind" the way every other label on this surface does.
        label: titleCase(hit.bad_beat_hand || made?.name || 'Qualifying Hand'),
      };
    });
  }, [hits]);

  /**
   * A NULL POOL IS A STATE, NOT A REASON TO DRAW NOTHING.
   *
   * This returned null, so a player who opened the jackpot popup before the
   * pool id resolved — or on a club with no pool row at all — got the header,
   * the tab strip, and an empty box. Indistinguishable from a broken feature,
   * which is exactly how the whole thing gets reported.
   */
  if (!poolId) {
    return (
      <div className="bbj-hits">
        <div className="bbj-hits__empty">
          No Jackpot Pool For This Club Yet.
          <span className="bbj-hits__empty-sub">Winners Appear Here Once The Pool Is Running.</span>
        </div>
      </div>
    );
  }

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
        {/* NOT "Last 3 Bad Beat Jackpot Winners". That is a factual claim that
            this club has paid three jackpots, printed above three invented
            players with plausible dates and a real chip figure. The rows are
            illustrations of the rule; the caption and the per-row tag now say
            so, which is what the doc-comment at the top of this file has
            always claimed was happening. */}
        <div className="bbj-hits__caption">What A Winning Hand Looks Like</div>
        <p className="bbj-hits__examplenote">
          No Jackpot Has Been Paid On This Pool Yet. These Are Examples.
        </p>
        {EXAMPLE_HITS.map((ex) => (
          <div
            className="bbj-hits__row is-example"
            key={ex.id}
            role="img"
            aria-label={`Example Only: ${ex.hand}`}
          >
            <img
              className="bbj-hits__avatar"
              src={getAvatarWithFallback(null, ex.id, ex.name, BBJ_AVATAR_PX)}
              alt=""
              aria-hidden="true"
              loading="lazy"
              width={BBJ_AVATAR_PX}
              height={BBJ_AVATAR_PX}
            />
            <div className="bbj-hits__who">
              <span className="bbj-hits__name">
                {ex.name}
                <span className="bbj-hits__tag">EXAMPLE</span>
              </span>
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
      {/* The caption stated a count as though it were the whole history. It is
          a page, so it says which page of what. */}
      <div className="bbj-hits__caption">
        {total && total > hits.length
          ? `Bad Beat Jackpot Winners (${hits.length} Of ${total})`
          : `Last ${hits.length} Bad Beat Jackpot ${hits.length === 1 ? 'Winner' : 'Winners'}`}
      </div>

      {shown.map(({ hit, cards, label, beatBy, beatByLabel }) => {
        // Id first: two players can share a display name, and lighting up the
        // wrong row on a money surface is not a cosmetic mistake.
        const isYou = currentUserId
          ? hit.bad_beat_user_id === currentUserId
          : !!currentUserName &&
            String(hit.bad_beat_name || '').toLowerCase() === currentUserName.toLowerCase();
        const clickable = !!onOpenHand;
        const amount = hit.bad_beat_amount ?? hit.total_payout;
        const gameType = gameTypeLabel(hit.game_variant);

        return (
          <div
            className={`bbj-hits__row${isYou ? ' is-you' : ''}${clickable ? ' is-clickable' : ''}`}
            key={hit.payout_id}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-label={
              clickable
                ? `${hit.bad_beat_name} won ${money(amount, 0)} with ${label}` +
                  (beatByLabel ? `, beaten by ${hit.hand_winner_name} with ${beatByLabel}` : '') +
                  '. Open the hand.'
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
            <img
              className="bbj-hits__avatar"
              src={getAvatarWithFallback(
                hit.bad_beat_avatar_url,
                hit.bad_beat_user_id || hit.payout_id,
                hit.bad_beat_name,
                BBJ_AVATAR_PX
              )}
              alt=""
              aria-hidden="true"
              loading="lazy"
              width={BBJ_AVATAR_PX}
              height={BBJ_AVATAR_PX}
            />

            <div className="bbj-hits__who">
              <span className="bbj-hits__name">
                {hit.bad_beat_name}
                {isYou && <span className="bbj-hits__you">YOU</span>}
              </span>
              <span className="bbj-hits__id">{hit.bad_beat_player_number || ''}</span>
            </div>

            <div className="bbj-hits__hand">
              {cards.length > 0 && (
                <div className="bbj-hits__cards" title={label}>
                  {cards.map((card, i) => (
                    <CardImage key={`${hit.payout_id}-${i}`} card={card} size="xs" />
                  ))}
                </div>
              )}
              <span className="bbj-hits__handname">{label}</span>

              {beatBy.length > 0 && (
                <div className="bbj-hits__beat">
                  <span className="bbj-hits__beat-label">Lost To</span>
                  <div className="bbj-hits__cards" title={beatByLabel}>
                    {beatBy.map((card, i) => (
                      <CardImage key={`${hit.payout_id}-w-${i}`} card={card} size="xs" />
                    ))}
                  </div>
                  <span className="bbj-hits__beat-name">
                    {hit.hand_winner_name}
                    {beatByLabel ? ` - ${beatByLabel}` : ''}
                  </span>
                </div>
              )}
            </div>

            <div className="bbj-hits__right">
              {gameType && <span className="bbj-hits__gametype">{gameType}</span>}
              <span className="bbj-hits__amt">+ {money(amount)}</span>
              <span className="bbj-hits__when">{stamp(hit.awarded_at)}</span>
            </div>
          </div>
        );
      })}

      {total !== null && hits.length < total && (
        <button
          type="button"
          className="bbj-hits__more"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore
            ? 'Loading'
            : moreFailed
              ? 'Could Not Load More. Tap To Retry'
              : `Show More (${total - hits.length} Older)`}
        </button>
      )}

      {onOpenHand && <p className="bbj-hits__hint">Tap A Winner To See The Hand.</p>}
    </div>
  );
}

export default BBJRecentHits;
