/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ HAND DETAIL — the full rundown of a hand that hit the jackpot
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan (2026-08-20): "inside the winners page you should be able to click on any
 * of the recent winners and see a run down of the winning hand."
 *
 * Street by street: who acted, what they did, for how much, and what the pot was
 * after it. Then showdown: every hand that was actually shown, with the five
 * cards that played lit up, the made hand, and what that player was up or down on
 * the pot. Then who got paid what out of the jackpot.
 *
 * Data comes from fn_bbj_hand_detail, which is SECURITY DEFINER and keyed by a
 * bbj_payouts id, because hand_history RLS only lets a player read hands they
 * were dealt into and a public jackpot board has to be readable by everyone.
 *
 * FOUR THINGS THE STORED DATA DOES NOT CONTAIN, handled honestly here:
 *
 * 1. Stack after each action. Only the post-settlement stack is stored, so the
 *    right-hand column is the RUNNING POT, labelled as such. Inventing a stack
 *    curve from the numbers we do have would be fiction.
 * 2. Blind posts. The engine writes them into the pot but not into the action
 *    log, so the two "post" rows at the top of preflop are synthesised from
 *    small_blind / big_blind and the derived blind seats. Without them the
 *    running pot would be short by exactly the blinds.
 *    That reconstruction is then CHECKED against the stored pot_size, and if it
 *    does not reconcile the running-pot column is withdrawn rather than shown
 *    wrong. A number that is quietly off by a blind is worse than no number.
 * 3. Mucked hole cards. They are deliberately never persisted, so a player who
 *    did not show gets no cards, never a guess.
 * 4. Which five cards made each hand. Reconstructed by bestFive() under the
 *    variant's own rules, which also declines to guess on incomplete data.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import CardImage from '../table/CardImage';
import { toDeckCards } from '../../utils/deckCards';
import { bestFive, cardKey } from '../../utils/handEvaluator';
import { derivePositions, smallBlindSeat, bigBlindSeat } from '../../utils/pokerPositions';
import { reportError } from '../../utils/errorReporter';
import './BBJHandDetail.css';

export interface BBJHandDetailProps {
  /** bbj_payouts id — the jackpot hit whose hand this is. */
  payoutId: string;
  /** Returns to the winners list. */
  onBack: () => void;
  /** Highlights the viewer's own rows. Name is the fallback when no id is known. */
  currentUserName?: string | null;
  /** The viewer's user id - unique, unlike a display name. */
  currentUserId?: string | null;
}

interface RawCard {
  rank?: string;
  suit?: string;
}

interface DetailPlayer {
  userId: string;
  username: string;
  playerNumber: string | null;
  avatarUrl: string | null;
  seat: number;
  stack: number | null;
  cards: RawCard[] | null;
}

interface DetailAction {
  seat: number;
  userId: string;
  action: string;
  amount?: number;
  stage: string;
}

interface DetailWinner {
  userId: string;
  amount: number;
  potIndex?: number;
  hand?: { name?: string; ranking?: number } | null;
}

interface DetailRecipient {
  userId: string;
  name: string;
  amount: number;
  role: 'bad_beat' | 'hand_winner' | 'table';
}

interface HandDetail {
  handNumber: number;
  playedAt: string;
  gameVariant: string | null;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount: number | null;
  bbjAmount: number | null;
  buttonSeat: number | null;
  board: RawCard[];
  players: DetailPlayer[];
  actions: DetailAction[];
  winners: DetailWinner[];
  jackpot: {
    payoutId: string;
    total: number;
    badBeatUserId: string | null;
    handWinnerUserId: string | null;
    recipients: DetailRecipient[];
  };
}

/**
 * Streets in dealing order, with how much board is face up by the end of each.
 * `pineapple_discard` rides with preflop; `showdown` gets its own bucket so a
 * `show` action can never fall between two streets and vanish.
 */
const STREETS: Array<{ key: string; label: string; boardTo: number }> = [
  { key: 'preflop', label: 'PreFlop', boardTo: 0 },
  { key: 'flop', label: 'Flop', boardTo: 3 },
  { key: 'turn', label: 'Turn', boardTo: 4 },
  { key: 'river', label: 'River', boardTo: 5 },
  { key: 'showdown', label: 'Showdown', boardTo: 5 },
];

const ACTION_LABEL: Record<string, string> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  bet: 'bet',
  raise: 'raise',
  all_in: 'all in',
  allin: 'all in',
  'all-in': 'all in',
  post: 'post',
  show: 'show',
  muck: 'muck',
  discard: 'discard',
  ante: 'ante',
  straddle: 'straddle',
};

const ROLE_LABEL: Record<DetailRecipient['role'], string> = {
  bad_beat: 'Bad beat',
  hand_winner: 'Won the hand',
  table: 'At the table',
};

/** Anything the engine did not name gets its own bucket, never dropped. */
function normalizeStage(stage: string | null | undefined): string {
  const s = String(stage || 'preflop').toLowerCase();
  if (s === 'pineapple_discard') return 'preflop';
  return STREETS.some((x) => x.key === s) ? s : 'preflop';
}

function money(n: number | null | undefined, dp = 2): string {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function stamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Stakes print as typed: 0.05/0.1, not 0.05/0.10. */
function blindLabel(n: number): string {
  return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <div className="bbjhd__head">
      <button className="bbjhd__back" onClick={onBack} aria-label="Back to winners">
        &lsaquo;
      </button>
      <span className="bbjhd__title">HAND DETAIL</span>
    </div>
  );
}

export function BBJHandDetail({
  payoutId,
  onBack,
  currentUserName,
  currentUserId,
}: BBJHandDetailProps) {
  const [detail, setDetail] = useState<HandDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setDetail(null);
    (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_bbj_hand_detail', {
          p_payout_id: payoutId,
        });
        if (!alive) return;
        if (error) {
          setState('failed');
          reportError(error, 'BBJHandDetail.load_failed');
          return;
        }
        if (!data) {
          // The hand aged out of retention, or the jackpot predates hand
          // logging. Say so plainly instead of rendering an empty shell.
          setState('missing');
          return;
        }
        setDetail(data as HandDetail);
        setState('ready');
      } catch (e) {
        if (!alive) return;
        setState('failed');
        reportError(e, 'BBJHandDetail.threw');
      }
    })();
    return () => {
      alive = false;
    };
  }, [payoutId]);

  /**
   * Everything derived from the hand, in one pass, memoised so scrolling and
   * re-renders do not re-walk the action log or re-run the evaluator.
   */
  const model = useMemo(() => {
    if (!detail) return null;

    const players = Array.isArray(detail.players) ? detail.players : [];
    const byUser = new Map(players.map((p) => [p.userId, p]));
    const bySeat = new Map(players.map((p) => [p.seat, p]));
    const seats = players.map((p) => p.seat);
    const positions = derivePositions(seats, detail.buttonSeat);
    const sbSeat = smallBlindSeat(seats, detail.buttonSeat);
    const bbSeat = bigBlindSeat(seats, detail.buttonSeat);
    const board = toDeckCards(detail.board);

    // Blind posts are not in the action log; synthesise them so the running pot
    // and every player's contribution are the real numbers.
    const posts: Array<{ seat: number; amount: number; label: string; potAfter: number }> = [];
    const contributed = new Map<string, number>();
    const add = (userId: string | undefined, amount: number) => {
      if (!userId) return;
      contributed.set(userId, (contributed.get(userId) || 0) + amount);
    };

    let pot = 0;
    if (sbSeat !== null && Number(detail.smallBlind) > 0) {
      pot += Number(detail.smallBlind);
      posts.push({ seat: sbSeat, amount: Number(detail.smallBlind), label: 'SB', potAfter: pot });
      add(bySeat.get(sbSeat)?.userId, Number(detail.smallBlind));
    }
    if (bbSeat !== null && Number(detail.bigBlind) > 0) {
      pot += Number(detail.bigBlind);
      posts.push({ seat: bbSeat, amount: Number(detail.bigBlind), label: 'BB', potAfter: pot });
      add(bySeat.get(bbSeat)?.userId, Number(detail.bigBlind));
    }

    const rawActions = (Array.isArray(detail.actions) ? detail.actions : []).filter(
      (a) => a && a.userId !== 'system'
    );
    const actions = rawActions.map((a) => {
      const amt = Number(a.amount) || 0;
      pot += amt;
      add(a.userId, amt);
      return { a, amount: amt, potAfter: pot, stage: normalizeStage(a.stage) };
    });

    // Does the reconstruction agree with what the engine banked? If not, the
    // per-row pot is not trustworthy and is withdrawn rather than shown wrong.
    const storedPot = Number(detail.potSize) || 0;
    const potReconciles = storedPot > 0 && Math.abs(pot - storedPot) < 0.02;

    const wonByUser = new Map<string, number>();
    const engineHandName = new Map<string, string>();
    (Array.isArray(detail.winners) ? detail.winners : []).forEach((w) => {
      if (!w?.userId) return;
      wonByUser.set(w.userId, (wonByUser.get(w.userId) || 0) + (Number(w.amount) || 0));
      if (w.hand?.name) engineHandName.set(w.userId, w.hand.name);
    });

    const showdown = players
      .filter((p) => Array.isArray(p.cards) && p.cards.length > 0)
      .map((p) => {
        const hole = toDeckCards(p.cards);
        const made = bestFive(hole, board, detail.gameVariant);
        const playing = new Set((made?.cards || []).map(cardKey));
        return {
          player: p,
          hole,
          playing,
          handName: engineHandName.get(p.userId) || made?.name || '',
          net: (wonByUser.get(p.userId) || 0) - (contributed.get(p.userId) || 0),
        };
      })
      // The bad-beat hand is the story - lead with it.
      .sort((x, y) => {
        const bb = detail.jackpot?.badBeatUserId;
        if (x.player.userId === bb) return -1;
        if (y.player.userId === bb) return 1;
        return y.net - x.net;
      });

    const streets = STREETS.map((street, i) => ({
      ...street,
      actions: actions.filter((x) => x.stage === street.key),
      posts: street.key === 'preflop' ? posts : [],
      cards: board.slice(i === 0 ? 0 : STREETS[i - 1].boardTo, street.boardTo),
    })).filter((s) => s.actions.length > 0 || s.posts.length > 0 || s.cards.length > 0);

    return {
      players,
      byUser,
      bySeat,
      positions,
      board,
      streets,
      showdown,
      potReconciles,
      storedPot,
      recipients: Array.isArray(detail.jackpot?.recipients) ? detail.jackpot.recipients : [],
    };
  }, [detail]);

  if (state === 'loading') {
    return (
      <div className="bbjhd">
        <Header onBack={onBack} />
        <div className="bbjhd__skeletons">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="bbjhd__skeleton" />
          ))}
        </div>
      </div>
    );
  }

  if (state !== 'ready' || !detail || !model) {
    return (
      <div className="bbjhd">
        <Header onBack={onBack} />
        <div className="bbjhd__empty">
          {state === 'missing'
            ? 'The full hand for this jackpot is no longer available.'
            : 'Could not load this hand. Try again shortly.'}
        </div>
      </div>
    );
  }

  // Id first where we have one - display names are not unique.
  const isYou = (name: string, userId?: string | null) => {
    if (currentUserId && userId) return userId === currentUserId;
    return !!currentUserName && name.toLowerCase() === currentUserName.toLowerCase();
  };

  const rake = Number(detail.rakeAmount) || 0;
  const bbjFee = Number(detail.bbjAmount) || 0;

  return (
    <div className="bbjhd">
      <Header onBack={onBack} />

      <div className="bbjhd__meta">
        <span className="bbjhd__meta-when">{stamp(detail.playedAt)}</span>
        <span className="bbjhd__meta-stakes">
          {blindLabel(detail.smallBlind)} / {blindLabel(detail.bigBlind)}
        </span>
        <span className="bbjhd__meta-sn">SN: {detail.handNumber}</span>
      </div>

      <div className="bbjhd__colkey">
        <span>Player</span>
        <span>Action</span>
        <span>{model.potReconciles ? 'Pot after' : ''}</span>
      </div>

      <div className="bbjhd__streets">
        {model.streets.map((street) => {
          const streetPot =
            street.actions.length > 0
              ? street.actions[street.actions.length - 1].potAfter
              : street.posts.length > 0
                ? street.posts[street.posts.length - 1].potAfter
                : 0;

          return (
            <section className="bbjhd__street" key={street.key}>
              <header className="bbjhd__street-head">
                <span className="bbjhd__street-name">{street.label}</span>
                {street.cards.length > 0 && (
                  <span className="bbjhd__street-board">
                    {street.cards.map((card, i) => (
                      <CardImage key={`${street.key}-${i}`} card={card} size="xs" />
                    ))}
                  </span>
                )}
                {model.potReconciles && streetPot > 0 && (
                  <span className="bbjhd__street-pot">{money(streetPot)}</span>
                )}
              </header>

              {street.posts.map((p, i) => {
                const player = model.bySeat.get(p.seat);
                return (
                  <div className="bbjhd__row" key={`post-${p.label}-${i}`}>
                    <span className="bbjhd__pos">{p.label}</span>
                    <span className={`bbjhd__name${isYou(player?.username || '', player?.userId) ? ' is-you' : ''}`}>
                      {player?.username || 'Player'}
                    </span>
                    <span className="bbjhd__act bbjhd__act--post">{p.label.toLowerCase()}</span>
                    <span className="bbjhd__amt">{money(p.amount)}</span>
                    <span className="bbjhd__pot">
                      {model.potReconciles ? money(p.potAfter) : ''}
                    </span>
                  </div>
                );
              })}

              {street.actions.map(({ a, amount, potAfter }, i) => {
                const player = model.byUser.get(a.userId) || model.bySeat.get(a.seat);
                const verb = String(a.action || '').toLowerCase();
                return (
                  <div className="bbjhd__row" key={`${street.key}-a-${i}`}>
                    <span className="bbjhd__pos">{model.positions[a.seat] || ''}</span>
                    <span className={`bbjhd__name${isYou(player?.username || '', player?.userId) ? ' is-you' : ''}`}>
                      {player?.username || 'Player'}
                    </span>
                    <span className={`bbjhd__act bbjhd__act--${verb.replace(/[^a-z_]/g, '')}`}>
                      {ACTION_LABEL[verb] || verb}
                    </span>
                    <span className="bbjhd__amt">{amount > 0 ? money(amount) : ''}</span>
                    <span className="bbjhd__pot">
                      {model.potReconciles ? money(potAfter) : ''}
                    </span>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      <div className="bbjhd__potline">
        <span>Pot</span>
        <span>Main ({money(model.storedPot)})</span>
      </div>

      {(rake > 0 || bbjFee > 0) && (
        <div className="bbjhd__drop">
          {rake > 0 && (
            <span>
              Rake <strong>{money(rake)}</strong>
            </span>
          )}
          {bbjFee > 0 && (
            <span>
              Jackpot fee <strong>{money(bbjFee)}</strong>
            </span>
          )}
          <span className="bbjhd__drop-note">taken from the pot</span>
        </div>
      )}

      {model.showdown.length > 0 && (
        <section className="bbjhd__showdown">
          <header className="bbjhd__section-head">Showdown</header>
          {model.showdown.map(({ player, hole, playing, handName, net }) => {
            const isBadBeat = player.userId === detail.jackpot?.badBeatUserId;
            return (
              <div className={`bbjhd__sd${isBadBeat ? ' is-badbeat' : ''}`} key={player.userId}>
                <div className="bbjhd__sd-top">
                  <span className="bbjhd__pos">{model.positions[player.seat] || ''}</span>
                  <span className={`bbjhd__name${isYou(player.username, player.userId) ? ' is-you' : ''}`}>
                    {player.username}
                  </span>
                  {isBadBeat && <span className="bbjhd__sd-tag">BAD BEAT</span>}
                  <span className="bbjhd__sd-hand">{handName}</span>
                  <span className={`bbjhd__sd-net${net >= 0 ? ' is-up' : ' is-down'}`}>
                    {net >= 0 ? '+' : '-'}
                    {money(Math.abs(net))}
                  </span>
                </div>
                <div className="bbjhd__sd-cards">
                  {hole.map((card, i) => (
                    <CardImage
                      key={`h-${player.userId}-${i}`}
                      card={card}
                      size="sm"
                      className={playing.has(cardKey(card)) ? 'bbjhd-plays' : 'bbjhd-idle'}
                    />
                  ))}
                  {model.board.length > 0 && <span className="bbjhd__sd-sep" aria-hidden="true" />}
                  {model.board.map((card, i) => (
                    <CardImage
                      key={`b-${player.userId}-${i}`}
                      card={card}
                      size="sm"
                      className={playing.has(cardKey(card)) ? 'bbjhd-plays' : 'bbjhd-idle'}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {model.showdown.some((s) => s.playing.size > 0) && (
            <p className="bbjhd__sd-legend">The five cards that played are lit.</p>
          )}
        </section>
      )}

      {model.recipients.length > 0 && (
        <section className="bbjhd__jackpot">
          <header className="bbjhd__section-head">
            Jackpot paid
            <span className="bbjhd__jackpot-total">{money(detail.jackpot.total)}</span>
          </header>
          {model.recipients.map((r, i) => (
            <div className={`bbjhd__pay bbjhd__pay--${r.role}`} key={`${r.userId}-${i}`}>
              <span className={`bbjhd__name${isYou(r.name, r.userId) ? ' is-you' : ''}`}>{r.name}</span>
              <span className="bbjhd__pay-role">{ROLE_LABEL[r.role]}</span>
              <span className="bbjhd__pay-amt">+{money(r.amount)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export default BBJHandDetail;
