/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BBJ HAND DETAIL — the full rundown of a hand that hit the jackpot
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan (2026-08-20): "inside the winners page you should be able to click on any
 * of the recent winners and see a run down of the winning hand."
 * Dan (2026-08-27): "you need to fill in all the hand details and payouts, like
 * all the data that we see and use inside of previous hands."
 *
 * This component is now only three things: fetch, the BBJP Winners box, and the
 * back button. The rundown itself is `HandDetailView`, rendered off the model
 * `buildReplay()` produces — the same component and the same reconstruction the
 * table's Previous Hand uses, so the two cannot drift apart again. Everything
 * that used to live here (street walking, blind synthesis, the running pot, the
 * showdown evaluation) moved into `src/utils/handReplay.ts`, where it is
 * covered by tests against real production rows.
 *
 * Data comes from fn_bbj_hand_detail, which is SECURITY DEFINER and keyed by a
 * bbj_payouts id, because hand_history RLS only lets a player read hands they
 * were dealt into and a public jackpot board has to be readable by everyone.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import HandDetailView from '../handdetail/HandDetailView';
import { buildReplay, titleCase } from '../../utils/handReplay';
import type { StoredCard } from '../../utils/deckCards';
import { reportError } from '../../utils/errorReporter';
import './BBJHandDetail.css';
import { gameTypeLabel, money, stamp } from '../../utils/handFormat';

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

interface DetailPlayer {
  userId: string;
  username: string;
  playerNumber: string | null;
  avatarUrl: string | null;
  seat: number;
  stack: number | null;
  cards: StoredCard[] | null;
}

interface DetailRecipient {
  userId: string;
  name: string;
  playerNumber?: string | null;
  amount: number;
  role: 'bad_beat' | 'hand_winner' | 'table';
}

interface HandDetail {
  /**
   * False when the hand itself is gone and only the payout ledger survives.
   *
   * 24 of the 29 real jackpots on this platform are in that state: the pruner
   * deleted their hands before `20260827d_jackpot_hands_are_never_pruned`
   * stopped it, and `bbj_payouts.hand_id` was NULL so nothing can rebuild
   * them. They used to render a dead end — "The Full Hand For This Jackpot Is
   * No Longer Available." — even though we still know both hands, both names,
   * the pool at the moment it hit, and every player who was paid.
   */
  handAvailable?: boolean;
  handNumber: number;
  playedAt: string;
  /** Summary-only fields, present when handAvailable is false. */
  badBeatName?: string | null;
  badBeatHand?: string | null;
  handWinnerName?: string | null;
  handWinnerHand?: string | null;
  poolAtHit?: number | null;
  tablePlayerCount?: number | null;
  gameVariant: string | null;
  smallBlind: number;
  bigBlind: number;
  potSize: number;
  rakeAmount: number | null;
  bbjAmount: number | null;
  buttonSeat: number | null;
  board: StoredCard[];
  extraBoards?: StoredCard[][] | null;
  players: DetailPlayer[];
  actions: Array<{ seat: number; userId: string; action: string; amount?: number; stage: string }>;
  winners: Array<{ userId: string; amount: number; potIndex?: number; hand?: { name?: string } }>;
  showdown?: Array<{
    user_id: string;
    seat: number;
    mucked: boolean;
    hand_name?: string;
    reveal_order?: number;
  }> | null;
  pots?: Array<{ index?: number; amount?: number }> | null;
  /** Which jackpot paid this hand: main, or mini (2026-09-11). Absent on older payloads means main. */
  kind?: 'main' | 'mini' | string | null;
  jackpot: {
    payoutId: string;
    /** Same as the top-level `kind`, carried on the box the summary card reads. */
    kind?: 'main' | 'mini' | string | null;
    total: number;
    badBeatUserId: string | null;
    handWinnerUserId: string | null;
    recipients: DetailRecipient[];
  };
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <div className="bbjhd__head">
      <button className="bbjhd__back" onClick={onBack} aria-label="Back To Winners">
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

  const model = useMemo(() => {
    if (!detail || detail.handAvailable === false) return null;
    return buildReplay({
      handNumber: detail.handNumber,
      playedAt: detail.playedAt,
      gameVariant: detail.gameVariant,
      smallBlind: detail.smallBlind,
      bigBlind: detail.bigBlind,
      potSize: detail.potSize,
      rakeAmount: detail.rakeAmount,
      bbjAmount: detail.bbjAmount,
      buttonSeat: detail.buttonSeat,
      board: detail.board,
      extraBoards: detail.extraBoards ?? null,
      players: detail.players,
      actions: detail.actions,
      winners: detail.winners,
      // fn_bbj_hand_detail already resolves each player's revealed holding onto
      // players[].cards, so the map is rebuilt here rather than fetched twice.
      holeCards: Object.fromEntries(
        (detail.players || [])
          .filter((p) => Array.isArray(p.cards) && p.cards.length > 0)
          .map((p) => [p.userId, p.cards as StoredCard[]])
      ),
      showdown: detail.showdown ?? null,
      pots: detail.pots ?? null,
    });
  }, [detail]);

  /** Player numbers, so the payout box can print (ID:xxxxxx) like the reference. */
  const numberOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of detail?.players || []) if (p.playerNumber) m.set(p.userId, p.playerNumber);
    return m;
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

  if (state !== 'ready' || !detail) {
    return (
      <div className="bbjhd">
        <Header onBack={onBack} />
        <div className="bbjhd__empty">
          {state === 'missing'
            ? 'This Jackpot Could Not Be Found.'
            : 'Could Not Load This Hand. Try Again Shortly.'}
        </div>
      </div>
    );
  }

  const recipients = Array.isArray(detail.jackpot?.recipients) ? detail.jackpot.recipients : [];

  const payoutBox = (
    <section className="hdv__bbjp">
      <header className="hdv__bbjp-head">
        {(detail.kind ?? detail.jackpot?.kind) === 'mini' ? 'Mini BBJP Winners' : 'BBJP Winners'}
        {/* The box lists shares and never showed what they are shares OF.
            `jackpot.total` has been in the payload the whole time. */}
        <span className="hdv__bbjp-total">{money(detail.jackpot?.total)}</span>
      </header>
      {recipients.map((r, i) => {
        const you = currentUserId
          ? r.userId === currentUserId
          : !!currentUserName &&
            String(r.name || '').toLowerCase() === currentUserName.toLowerCase();
        const id = numberOf.get(r.userId) || r.playerNumber || '';
        return (
          <div className="hdv__bbjp-row" key={`${r.userId}-${i}`}>
            <span className={`hdv__bbjp-name${you ? ' is-you' : ''}`}>{r.name}</span>
            <span className="hdv__bbjp-id">{id ? `(ID:${id})` : ''}</span>
            <span className="hdv__bbjp-amt">+{money(r.amount)}</span>
          </div>
        );
      })}
    </section>
  );

  /**
   * THE HAND IS GONE, BUT THE JACKPOT IS NOT.
   *
   * This used to be a dead end — one grey sentence and nothing else — and it
   * is what 24 of the 29 real jackpots on this platform show, because the
   * pruner deleted their hands before `20260827d` stopped it and
   * `bbj_payouts.hand_id` was NULL so nothing can rebuild them.
   *
   * Everything below is real, stored, and was being withheld for no reason:
   * both hands, both names, the pool at the moment it hit, and every player
   * who was paid and how much. The one thing missing is the street-by-street
   * action, and this says exactly that rather than implying the whole record
   * is gone.
   */
  if (!model) {
    return (
      <div className="bbjhd">
        <Header onBack={onBack} />

        <div className="bbjhd__meta">
          <span className="bbjhd__meta-when">{stamp(detail.playedAt)}</span>
          {detail.tablePlayerCount ? (
            <span className="bbjhd__meta-stakes">{detail.tablePlayerCount} Dealt In</span>
          ) : null}
          <span className="bbjhd__meta-sn">SN: {detail.handNumber}</span>
        </div>

        <section className="bbjhd__summary">
          <div className="bbjhd__summary-row">
            <span className="bbjhd__summary-label">Bad Beat</span>
            <span className="bbjhd__summary-name">{detail.badBeatName || 'Player'}</span>
            <span className="bbjhd__summary-hand">{titleCase(detail.badBeatHand || '')}</span>
          </div>
          <div className="bbjhd__summary-row">
            <span className="bbjhd__summary-label">Beaten By</span>
            <span className="bbjhd__summary-name">{detail.handWinnerName || 'Player'}</span>
            <span className="bbjhd__summary-hand">{titleCase(detail.handWinnerHand || '')}</span>
          </div>
          {detail.poolAtHit ? (
            <div className="bbjhd__summary-row">
              <span className="bbjhd__summary-label">Jackpot</span>
              <span className="bbjhd__summary-name">Pool At The Hit</span>
              <span className="bbjhd__summary-hand">{money(detail.poolAtHit)}</span>
            </div>
          ) : null}
        </section>

        {recipients.length > 0 ? payoutBox : null}

        <p className="bbjhd__retention">
          The Hand Itself Was Not Kept. Jackpot Hands Are Retained From 2026-08-27 Onward.
        </p>
      </div>
    );
  }

  return (
    <div className="bbjhd">
      <Header onBack={onBack} />
      <HandDetailView
        model={model}
        currentUserId={currentUserId}
        currentUserName={currentUserName}
        badge={gameTypeLabel(detail.gameVariant)}
        badBeatUserId={detail.jackpot?.badBeatUserId ?? null}
        footer={recipients.length > 0 ? payoutBox : null}
      />
    </div>
  );
}

export default BBJHandDetail;
