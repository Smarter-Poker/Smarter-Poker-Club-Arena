/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND REPLAY — the animated replay, off the one model  #SMARTERCASINOREALISM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Reached from the table's Previous Hand modal and Hand History panel (REPLAY),
 * and from the Hand Archive page. Two tabs:
 *
 *   REPLAY  — a felt, the seats where they sat, the board as it came, the pot
 *             and each street's bets, stepping through the hand one action at
 *             a time with a scrubber and play / pause. The frames come from
 *             `buildReplayFrames(model)` - see utils/replayFrames.ts for the
 *             four ways the old timeline lied.
 *   RUNDOWN — the same `HandDetailView` the modal and the jackpot popup draw.
 *
 * 2026-09-04 (Previous Hand second sweep): this component used to keep a fifth
 * hand shape of its own (`HandData`), map the service record into it by hand
 * (dropping winners, per-board winners and rake on the way), draw the board
 * once PER SEAT inside the player loop, index the board by step number, and
 * hand `LiveHandReplayer2D` raw engine card strings whose `.suit.charAt` threw
 * the moment the flop came. It renders `record.replay` now - the model built
 * once by HandHistoryService - and nothing else.
 *
 * It NEVER fabricates a hand: a load failure is "Could Not Load This Hand", a
 * missing row is "Hand Not Found", and neither ever draws a stand-in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardImage, CardBack } from '../table/CardImage';
import HandDetailView from '../handdetail/HandDetailView';
import type { HandRecord as ServiceHandRecord } from '../../services/HandHistoryService';
import type { ReplayModel } from '../../utils/handReplay';
import { buildReplayFrames, frameSeats, type ReplayFrame } from '../../utils/replayFrames';
import { blindLabel, gameTypeLabel, money, stamp } from '../../utils/handFormat';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { useAuthUser } from '../../hooks/useAuthUser';
import { reportError } from '../../utils/errorReporter';
import './HandReplay.css';

interface HandReplayProps {
  handId?: string;
  onClose?: () => void;
}

/** How many face-down cards an unrevealed seat shows: the variant's holding. */
function holdingSize(model: ReplayModel): number {
  const shown = model.players.find((p) => p.hole && p.hole.length > 0)?.hole?.length;
  if (shown) return shown;
  const v = String(model.gameVariant || '').toLowerCase();
  if (v.startsWith('plo6')) return 6;
  if (v.startsWith('plo5')) return 5;
  if (v.startsWith('plo') || v.startsWith('flo')) return 4;
  if (v.includes('pineapple')) return 3;
  return 2;
}

/**
 * Where each seat sits around the oval, as percentages of the felt. The hero
 * (or, for an observer, the lowest seat) is at the bottom centre; the others
 * keep their real clockwise order from there. Seats are placed by SEAT NUMBER
 * on a ring the size of the table, never by array index - a six-handed hand on
 * seats 1, 2, 3, 5, 8, 9 draws seat 8 where seat 8 sits.
 */
function seatLayout(
  seats: number[],
  heroSeat: number | null
): Record<number, { x: number; y: number; bx: number; by: number }> {
  const out: Record<number, { x: number; y: number; bx: number; by: number }> = {};
  if (seats.length === 0) return out;
  const maxSeat = Math.max(...seats);
  const ring = maxSeat <= 6 ? 6 : 9;
  const anchor = heroSeat && seats.includes(heroSeat) ? heroSeat : Math.min(...seats);
  for (const seat of seats) {
    const offset = (seat - anchor + ring) % ring;
    const angle = Math.PI / 2 + (offset / ring) * Math.PI * 2;
    const x = 50 + 44 * Math.cos(angle);
    const y = 50 + 40 * Math.sin(angle);
    out[seat] = {
      x,
      y,
      bx: 50 + 26 * Math.cos(angle),
      by: 50 + 22 * Math.sin(angle),
    };
  }
  return out;
}

function Felt({
  model,
  frame,
  heroId,
}: {
  model: ReplayModel;
  frame: ReplayFrame;
  heroId: string | null;
}) {
  const seats = frameSeats(model);
  const hero = model.players.find((p) => p.userId === heroId);
  const layout = useMemo(
    () => seatLayout(seats, hero?.seat ?? null),
    [seats.join(','), hero?.seat]
  );
  const backs = holdingSize(model);
  const winners = new Set(model.showdown.filter((r) => r.isWinner).map((r) => r.seat));
  for (const p of model.players) if (p.won > 0) winners.add(p.seat);

  return (
    <div className="hr-felt" aria-label={frame.caption}>
      <div className="hr-felt__oval" />
      <div className="hr-felt__centre">
        <div className="hr-felt__pot">
          <span className="hr-felt__pot-label">Pot</span>
          <span className="hr-felt__pot-value">{money(frame.pot)}</span>
        </div>
        <div className="hr-felt__boards">
          {[frame.board, ...frame.extraBoards].map((b, bi) => (
            <div className="hr-felt__board" key={bi}>
              {frame.extraBoards.length > 0 && (
                <span className="hr-felt__board-badge">{bi === 0 ? 'Run 1' : `Run ${bi + 1}`}</span>
              )}
              {b.length === 0 ? (
                <span className="hr-felt__board-empty">{bi === 0 ? frame.streetLabel : ''}</span>
              ) : (
                b.map((c, i) => <CardImage key={`${bi}-${i}`} card={c} size="sm" />)
              )}
            </div>
          ))}
        </div>
      </div>

      {model.players.map((p) => {
        const pos = layout[p.seat];
        if (!pos) return null;
        const isHero = p.userId === heroId;
        const isActive = frame.activeSeat === p.seat;
        const isFolded = frame.folded.includes(p.seat);
        const revealed = frame.revealed.includes(p.seat) && p.hole;
        const showPrivate = isHero && !revealed && p.privateHole && p.privateHole.length > 0;
        const bet = frame.committed[p.seat] || 0;
        const stack = frame.stacks[p.seat];
        const isWinner = frame.isShowdown && winners.has(p.seat);
        return (
          <div key={p.seat}>
            <div
              className={`hr-seat${isHero ? ' is-hero' : ''}${isActive ? ' is-active' : ''}${
                isFolded ? ' is-folded' : ''
              }${isWinner ? ' is-winner' : ''}`}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            >
              <div className="hr-seat__cards">
                {revealed
                  ? p.hole!.map((c, i) => <CardImage key={i} card={c} size="xs" />)
                  : showPrivate
                    ? p.privateHole!.map((c, i) => (
                        <CardImage key={i} card={c} size="xs" className="hr-private" />
                      ))
                    : !isFolded &&
                      Array.from({ length: backs }).map((_, i) => <CardBack key={i} size="xs" />)}
              </div>
              <div className="hr-seat__plate">
                <span className="hr-seat__name">{p.username}</span>
                <span className="hr-seat__meta">
                  <span className="hr-seat__pos">{p.position}</span>
                  <span className="hr-seat__stack">
                    {stack === null || stack === undefined ? '' : money(stack)}
                  </span>
                </span>
              </div>
              {isActive && frame.row && (
                <span className={`hr-seat__act hr-seat__act--${frame.row.verb}`}>
                  {frame.row.label}
                </span>
              )}
              {isFolded && !isActive && (
                <span className="hr-seat__act hr-seat__act--fold">Fold</span>
              )}
              {showPrivate && <span className="hr-seat__private">Yours</span>}
            </div>
            {bet > 0 && (
              <div className="hr-bet" style={{ left: `${pos.bx}%`, top: `${pos.by}%` }}>
                {money(bet)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function HandReplay({ handId: propHandId, onClose }: HandReplayProps) {
  // Route-based usage: /replay/<id>
  const pathParts = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
  const routeHandId = pathParts[pathParts.indexOf('replay') + 1];
  const handId = propHandId || routeHandId;
  const { user } = useAuthUser();
  const heroId = user?.id ?? null;

  const [handData, setHandData] = useState<ServiceHandRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  /* "We could not ask" is not the same as "there is no such hand". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<'replay' | 'rundown'>('replay');
  const [step, setStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setIsLoading(true);
      setLoadFailed(false);
      setStep(0);
      setIsPlaying(false);
      try {
        if (!handId) {
          // No handId: nothing to replay. Never invent one.
          if (alive) setHandData(null);
          return;
        }
        const { handHistoryService } = await import('../../services/HandHistoryService');
        const data = await handHistoryService.getHand(handId);
        if (!alive) return;
        /* NOT FOUND lands on null. It used to render a fallback hand here - a
           hand-shaped fiction with invented players and an invented pot - and
           the same fiction again from the catch below. A hand history is the
           evidentiary record of a poker game; inventing one is worse than
           showing nothing. */
        setHandData(data ?? null);
      } catch (error) {
        if (!alive) return;
        reportError(error, 'HandReplay.Failed_to_load_hand');
        setHandData(null);
        setLoadFailed(true);
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [handId]);

  const model = handData?.replay ?? null;
  const frames = useMemo(() => (model ? buildReplayFrames(model) : []), [model]);
  const last = Math.max(0, frames.length - 1);
  const frame = frames[Math.min(step, last)] ?? null;

  // Playback: one frame per beat, the beat scaled by the player's Animation Speed.
  useEffect(() => {
    if (playbackRef.current) clearTimeout(playbackRef.current);
    if (!isPlaying || frames.length === 0) return;
    if (step >= last) {
      setIsPlaying(false);
      return;
    }
    const verb = frame?.row?.verb;
    const beat = (verb ? 900 : 1400) * getAnimationSpeed();
    playbackRef.current = setTimeout(() => setStep((s) => Math.min(last, s + 1)), beat);
    return () => {
      if (playbackRef.current) clearTimeout(playbackRef.current);
    };
  }, [isPlaying, step, last, frames.length, frame?.row?.verb]);

  const togglePlay = useCallback(() => {
    if (step >= last) setStep(0);
    setIsPlaying((p) => !p);
  }, [step, last]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (tab !== 'replay') return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setStep((s) => Math.min(last, s + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setStep((s) => Math.max(0, s - 1));
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
  };

  if (isLoading) {
    return (
      <div className="hand-replay hand-replay--empty" aria-busy="true">
        <div className="hand-replay__spinner" aria-hidden="true" />
        <p className="hand-replay__empty-title">Loading Hand</p>
      </div>
    );
  }

  if (!handData || !model) {
    return (
      <div className="hand-replay hand-replay--empty">
        <p className="hand-replay__empty-title">
          {loadFailed ? 'Could Not Load This Hand' : 'Hand Not Found'}
        </p>
        <p className="hand-replay__empty-body">
          {loadFailed
            ? 'This Is A Loading Problem, Not A Missing Hand. Close And Try Again.'
            : 'This Hand Is Not In The Record.'}
        </p>
        {onClose && (
          <button type="button" className="hr-btn" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    );
  }

  const variant = gameTypeLabel(model.gameVariant) || handData.game_type;
  /* The persisted reveal record: who showed, who mucked, in what order. The
     seat strip under the felt reads it so a mucked hand is labelled as one
     (`player-hand-ranking--mucked`) rather than drawn as "no cards". */
  const revealOf = new Map(handData.players.map((p) => [p.user_id, p.showdown_reveal] as const));
  const foldedIds = new Set(
    model.streets
      .flatMap((st) => st.rows)
      .filter((r) => r.verb === 'fold')
      .map((r) => r.userId)
  );

  return (
    <div className="hand-replay" onKeyDown={onKeyDown} tabIndex={0}>
      <header className="hand-replay__header">
        <div className="hand-replay__titles">
          <span className="hand-replay__eyebrow">
            {handData.table_name || 'Table'} · {blindLabel(model.smallBlind)} /{' '}
            {blindLabel(model.bigBlind)}
            {variant ? ` · ${variant}` : ''}
          </span>
          <h2 className="hand-replay__title">Hand #{handData.hand_number}</h2>
          <span className="hand-replay__when">{stamp(model.playedAt)}</span>
        </div>
        <div className="hand-replay__tabs" role="tablist" aria-label="Replay View">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'replay'}
            className={`hr-tab${tab === 'replay' ? ' hr-tab--active' : ''}`}
            onClick={() => setTab('replay')}
          >
            Replay
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rundown'}
            className={`hr-tab${tab === 'rundown' ? ' hr-tab--active' : ''}`}
            onClick={() => setTab('rundown')}
          >
            Rundown
          </button>
        </div>
      </header>

      {tab === 'rundown' ? (
        <div className="hand-replay__rundown" role="tabpanel">
          <HandDetailView model={model} currentUserId={heroId} badge={variant} />
        </div>
      ) : (
        <div className="hand-replay__stage" role="tabpanel">
          {frame && <Felt model={model} frame={frame} heroId={heroId} />}

          <div className="hand-replay__caption" aria-live="polite">
            <span className="hand-replay__caption-street">{frame?.streetLabel}</span>
            <span className="hand-replay__caption-text">{frame?.caption}</span>
          </div>

          <div className="hand-replay__controls">
            <button
              type="button"
              className="hr-btn hr-btn--icon"
              aria-label="First Step"
              onClick={() => {
                setIsPlaying(false);
                setStep(0);
              }}
              disabled={step === 0}
            >
              &#9198;
            </button>
            <button
              type="button"
              className="hr-btn hr-btn--icon"
              aria-label="Previous Step"
              onClick={() => {
                setIsPlaying(false);
                setStep((s) => Math.max(0, s - 1));
              }}
              disabled={step === 0}
            >
              &#9664;
            </button>
            <button
              type="button"
              className="hr-btn hr-btn--icon hr-btn--play"
              aria-label={isPlaying ? 'Pause' : 'Play'}
              onClick={togglePlay}
            >
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <button
              type="button"
              className="hr-btn hr-btn--icon"
              aria-label="Next Step"
              onClick={() => {
                setIsPlaying(false);
                setStep((s) => Math.min(last, s + 1));
              }}
              disabled={step >= last}
            >
              &#9654;
            </button>
            <button
              type="button"
              className="hr-btn hr-btn--icon"
              aria-label="Last Step"
              onClick={() => {
                setIsPlaying(false);
                setStep(last);
              }}
              disabled={step >= last}
            >
              &#9197;
            </button>
            <div className="hand-replay__scrub">
              <input
                type="range"
                min={0}
                max={last}
                value={Math.min(step, last)}
                aria-label="Replay Position"
                onChange={(e) => {
                  setIsPlaying(false);
                  setStep(Number(e.target.value));
                }}
              />
              <span className="hand-replay__scrub-label">
                {Math.min(step, last) + 1} / {frames.length}
              </span>
            </div>
          </div>

          {/* Who was in it, and how it ended for each of them. */}
          <div className="hand-replay__seats">
            {model.players.map((p) => {
              const reveal = revealOf.get(p.userId);
              const mucked =
                reveal?.mucked === true ||
                (!p.hole && model.showdown.some((r) => r.userId === p.userId));
              const rows = model.showdown.filter(
                (r) => r.userId === p.userId && r.boardIndex === 0
              );
              const high = rows.find((r) => !r.low);
              const low = rows.find((r) => r.low);
              return (
                <div
                  key={p.seat}
                  className={`player-hand-ranking${p.won > 0 ? ' player-hand-ranking--won' : ''}${
                    mucked ? ' player-hand-ranking--mucked' : ''
                  }${p.userId === heroId ? ' player-hand-ranking--hero' : ''}`}
                >
                  <span className="player-hand-ranking__seat">{p.seat}</span>
                  <span className="player-hand-ranking__name">{p.username}</span>
                  <span className="player-hand-ranking__hand">
                    {high?.hole
                      ? `${high.handName}${low ? ` · ${low.handName}` : ''}`
                      : mucked
                        ? 'Mucked'
                        : foldedIds.has(p.userId)
                          ? 'Folded'
                          : p.won > 0
                            ? 'Took The Pot'
                            : ''}
                  </span>
                  <span
                    className={`player-hand-ranking__net${p.net > 0 ? ' is-up' : p.net < 0 ? ' is-down' : ''}`}
                  >
                    {`${p.net > 0 ? '+' : p.net < 0 ? '-' : ''}${money(Math.abs(p.net))}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
