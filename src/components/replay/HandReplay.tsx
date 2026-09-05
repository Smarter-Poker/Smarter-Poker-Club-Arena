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
 *
 * PHASE 3 2026-09-05 - THE REPLAYER MOVES. Stepping FORWARD one frame plays
 * what happened between the two frames: chips slide from the seat to its bet
 * spot, a new street sweeps the street's bets into the pot, a shown hand
 * flips face-up, a fold goes to the muck, and the pot travels to whoever won
 * it. Each carries the felt's own sound cue (SoundService - never a second
 * sound set). A jump or a scrub moves nothing: motion is owed to a step, and
 * a scrub to the river must not replay every bet on the way. Every duration
 * scales with the player's Animation Speed AND the replay's own rate
 * (half / normal / double, remembered per viewer); neither can switch motion
 * off, and under prefers-reduced-motion the global collapse lands every
 * element on its final frame - the meaning stays, the travel goes.
 *
 * Also on the felt since Phase 3: the dealer button, what the acting seat was
 * FACING (chips to call, pot odds) read off the frame before its decision, and
 * the made-hand label under the viewer's seat (and any revealed seat) street
 * by street. The rules behind all of it are pure, in utils/replayMotion.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardImage, CardBack } from '../table/CardImage';
import type { DeckCard } from '../../utils/deckCards';
import { SqueezeCard, squeezeHostProps, useCardSqueeze } from '../../presentation/cardPresentation';
import HandDetailView from '../handdetail/HandDetailView';
import type { HandRecord as ServiceHandRecord } from '../../services/HandHistoryService';
import type { ReplayModel } from '../../utils/handReplay';
import { buildReplayFrames, frameSeats, type ReplayFrame } from '../../utils/replayFrames';
import {
  REPLAY_RATES,
  facingAt,
  frameCue,
  frameMotion,
  preflopHoleLabel,
  readReplayRate,
  replayBeatMs,
  streetJumps,
  writeReplayRate,
  type FrameMotion,
  type ReplayCue,
  type ReplayRate,
} from '../../utils/replayMotion';
import { blindLabel, gameTypeLabel, money, stamp } from '../../utils/handFormat';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
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
): Record<number, { x: number; y: number; bx: number; by: number; dx: number; dy: number }> {
  const out: Record<
    number,
    { x: number; y: number; bx: number; by: number; dx: number; dy: number }
  > = {};
  if (seats.length === 0) return out;
  const maxSeat = Math.max(...seats);
  const ring = maxSeat <= 6 ? 6 : 9;
  const anchor = heroSeat && seats.includes(heroSeat) ? heroSeat : Math.min(...seats);
  for (const seat of seats) {
    const offset = (seat - anchor + ring) % ring;
    const angle = Math.PI / 2 + (offset / ring) * Math.PI * 2;
    const x = 50 + 44 * Math.cos(angle);
    /* 36, not 40: at 40 the bottom seat's plate ran past the felt's clipped
       edge and its made-hand label (Phase 3) was cut off entirely. */
    const y = 50 + 36 * Math.sin(angle);
    out[seat] = {
      x,
      y,
      bx: 50 + 26 * Math.cos(angle),
      by: 50 + 22 * Math.sin(angle),
      // The dealer button sits between the seat and its bet spot, a little
      // clockwise so it never covers the chips.
      dx: 50 + 40 * Math.cos(angle + 0.3),
      dy: 50 + 30 * Math.sin(angle + 0.3),
    };
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE REPLAY BOARD — and the card it just turned (spec 35, 81, 123)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PHASE 2 2026-09-05. The replay used to swap `<CardImage>` elements in as the
 * step advanced: on the one surface where a player is deliberately STUDYING a
 * hand, the river simply appeared. It reveals through the same squeeze the
 * felt uses now, on the `replay` profile - the slowest and most cinematic of
 * them (spec 118).
 *
 * ITS OWN COMPONENT because the hook has to be called once per board and the
 * boards are a `.map()`. That also gives run-it-twice and bomb-pot boards
 * their own animation keys, which spec 81 asks for by name: two boards of one
 * hand must never share a lane, or run 2's river cancels run 1's.
 *
 * The wrapper around each card is ALWAYS rendered, not only while squeezing.
 * `display: inline-flex` makes it hug the CardImage exactly, so the row's
 * layout is identical either way - a wrapper that appears for one second
 * would reflow the board in the middle of the reveal.
 */
function ReplayBoard({
  cards,
  boardIndex,
  handKey,
  badge,
  empty,
}: {
  cards: DeckCard[];
  boardIndex: number;
  handKey: string;
  badge: React.ReactNode;
  empty: React.ReactNode;
}) {
  const squeeze = useCardSqueeze({
    visibleCount: cards.length,
    handId: handKey,
    surfaceId: `replay:${handKey}`,
    boardIndex,
    mode: 'replay',
  });
  return (
    <div className="hr-felt__board">
      {badge}
      {cards.length === 0
        ? empty
        : cards.map((c, i) => {
            const on = squeeze.index === i && squeeze.profile !== null;
            const host = on ? squeezeHostProps(squeeze.profile!, boardIndex) : null;
            return (
              <div
                key={`${boardIndex}-${i}`}
                className={`hr-felt__card${host ? ` ${host.className}` : ''}`}
                style={host ? host.style : undefined}
                data-rs-profile={host ? host['data-rs-profile'] : undefined}
                data-rs-3d={host ? host['data-rs-3d'] : undefined}
                data-rs-animating={host ? host['data-rs-animating'] : undefined}
              >
                {on ? (
                  <SqueezeCard
                    back={<CardBack size="sm" />}
                    face={<CardImage card={c} size="sm" />}
                  />
                ) : (
                  <CardImage card={c} size="sm" />
                )}
              </div>
            );
          })}
    </div>
  );
}

/**
 * The felt's own cues, by name. One cue per frame stepped into; the gate,
 * priority window and the player's sound setting all live in SoundService.
 */
function playCue(cue: ReplayCue, amount: number, bigBlind: number) {
  switch (cue) {
    case 'deal':
      soundService.playDeal();
      break;
    case 'community':
      soundService.playCommunityCard();
      break;
    case 'chips':
      soundService.playChips();
      break;
    case 'raise':
      soundService.playRaise(amount, bigBlind);
      break;
    case 'check':
      soundService.playCheck();
      break;
    case 'fold':
      soundService.playFold();
      break;
    case 'all_in':
      soundService.playAllIn();
      break;
    case 'discard':
      soundService.playDiscard();
      break;
    case 'show':
      soundService.playShowdown();
      break;
    case 'win':
      soundService.playWin();
      soundService.playPotCollect();
      break;
    default:
      break;
  }
}

/** The seats a pot went to: the showdown's winners, or whoever the record says was paid. */
function winnerSeatsOf(model: ReplayModel): number[] {
  const winners = new Set(model.showdown.filter((r) => r.isWinner).map((r) => Number(r.seat)));
  for (const p of model.players) if (p.won > 0) winners.add(Number(p.seat));
  return [...winners];
}

/** The dealer button's seat: the record's, or the seat the positions name as the button. */
function buttonSeatOf(model: ReplayModel, seats: number[]): number | null {
  if (model.buttonSeat !== null && seats.includes(Number(model.buttonSeat))) {
    return Number(model.buttonSeat);
  }
  const named = model.players.find((p) => p.position === 'BTN');
  return named ? Number(named.seat) : null;
}

/**
 * The made hand a seat's cards show on THIS frame's street: the model's own
 * per-street evaluation (the same evaluator that names the showdown), the
 * showdown's name on the final frame, and before the flop the holding itself.
 */
function madeLabelFor(
  model: ReplayModel,
  frame: ReplayFrame,
  userId: string,
  hole: DeckCard[] | null
): string | null {
  if (!hole || hole.length === 0) return null;
  if (frame.key === 'deal' || frame.streetKey === 'preflop') return preflopHoleLabel(hole);
  const street = model.streets.find((st) => st.key === frame.streetKey);
  const made = street?.madeHands.find((m) => m.userId === userId)?.name;
  if (made) return made;
  if (frame.isShowdown) {
    const row = model.showdown.find((r) => r.userId === userId && r.boardIndex === 0 && !r.low);
    return row?.handName ?? null;
  }
  return null;
}

function Felt({
  model,
  frame,
  prev,
  motion,
  heroId,
}: {
  model: ReplayModel;
  frame: ReplayFrame;
  /** The frame before this one, for what the acting seat was facing. */
  prev: ReplayFrame | null;
  motion: FrameMotion;
  heroId: string | null;
}) {
  const seats = useMemo(() => frameSeats(model), [model]);
  const hero = model.players.find((p) => p.userId === heroId);
  const heroSeat = hero?.seat ?? null;
  const layout = useMemo(() => seatLayout(seats, heroSeat), [seats, heroSeat]);
  const backs = holdingSize(model);
  const winners = useMemo(() => new Set(winnerSeatsOf(model)), [model]);
  const buttonSeat = buttonSeatOf(model, seats);
  const buttonPos = buttonSeat !== null ? layout[buttonSeat] : null;
  const facing = facingAt(prev, frame);
  const potPos = { x: 50, y: 38 };

  return (
    <div
      className="hr-felt"
      aria-label={frame.caption}
      style={{ '--hr-pot-x': `${potPos.x}%`, '--hr-pot-y': `${potPos.y}%` } as React.CSSProperties}
    >
      <div className="hr-felt__oval" />
      <div className="hr-felt__centre">
        <div className={`hr-felt__pot${motion.potTo.length > 0 ? ' hr-felt__pot--award' : ''}`}>
          <span className="hr-felt__pot-label">Pot</span>
          <span className="hr-felt__pot-value">{money(frame.pot)}</span>
        </div>
        <div className="hr-felt__boards">
          {[frame.board, ...frame.extraBoards].map((b, bi) => (
            <ReplayBoard
              key={bi}
              cards={b}
              boardIndex={bi}
              /* Identity for the lane: the hand this replay is showing. A
                 different hand resets every board's lane rather than being
                 taken for a continuation of the last one. */
              handKey={String(model.handNumber ?? model.playedAt ?? 'replay')}
              badge={
                frame.extraBoards.length > 0 ? (
                  <span className="hr-felt__board-badge">
                    {bi === 0 ? 'Run 1' : `Run ${bi + 1}`}
                  </span>
                ) : null
              }
              empty={
                <span className="hr-felt__board-empty">{bi === 0 ? frame.streetLabel : ''}</span>
              }
            />
          ))}
        </div>
      </div>

      {buttonPos && (
        <span
          className="hr-button"
          aria-label={`Dealer Button, Seat ${buttonSeat}`}
          style={{ left: `${buttonPos.dx}%`, top: `${buttonPos.dy}%` }}
        >
          D
        </span>
      )}

      {model.players.map((p) => {
        const pos = layout[p.seat];
        if (!pos) return null;
        const isHero = p.userId === heroId;
        const isActive = frame.activeSeat === p.seat;
        const isFolded = frame.folded.includes(p.seat);
        const revealed = frame.revealed.includes(p.seat) && p.hole;
        /* PHASE 3: the viewer sees their OWN cards from the deal, whether the
           hand went to showdown (`hole`) or not (`privateHole`). Until Phase 3
           a player replaying their own hand watched two card backs in their
           seat until the showdown frame. Everyone else's stay face-down until
           the record shows them. */
        const own = isHero ? (p.hole ?? p.privateHole) : null;
        const showPrivate = !revealed && !!own && own.length > 0;
        const bet = frame.committed[p.seat] || 0;
        const stack = frame.stacks[p.seat];
        const isWinner = frame.isShowdown && winners.has(p.seat);
        const folding = motion.fold === p.seat;
        // A seat whose cards were already face-up (the viewer's own) has nothing to flip.
        const flipping = motion.flip.includes(p.seat) && !isHero;
        const chipsIn = motion.chipsIn === p.seat;
        const sweeping = motion.sweep.includes(p.seat) && prev ? prev.committed[p.seat] || 0 : 0;
        const awarded = motion.potTo.includes(p.seat);
        const known = revealed ? p.hole : showPrivate ? own : null;
        const made = known ? madeLabelFor(model, frame, p.userId, known) : null;
        const isFacing = facing?.seat === p.seat;
        /* Which edge of the felt the seat is near, so the labels that hang
           off a seat hang INWARD. The felt clips; a badge hung outward on the
           cut-off seat was half gone (seen in the Phase 3 harness). */
        const side = `${pos.x > 66 ? ' hr-seat--right' : pos.x < 34 ? ' hr-seat--left' : ''}${
          pos.y > 75 ? ' hr-seat--bottom' : pos.y < 25 ? ' hr-seat--top' : ''
        }`;
        return (
          <div key={p.seat}>
            <div
              className={`hr-seat${side}${isHero ? ' is-hero' : ''}${isActive ? ' is-active' : ''}${
                isFolded ? ' is-folded' : ''
              }${isWinner ? ' is-winner' : ''}`}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            >
              <div
                className={`hr-seat__cards${flipping ? ' hr-seat__cards--flip' : ''}${
                  folding ? ' hr-seat__cards--fold' : ''
                }`}
              >
                {revealed
                  ? p.hole!.map((c, i) => <CardImage key={i} card={c} size="xs" />)
                  : showPrivate
                    ? own!.map((c, i) => (
                        <CardImage key={i} card={c} size="xs" className="hr-private" />
                      ))
                    : (!isFolded || folding) &&
                      Array.from({ length: backs }).map((_, i) => <CardBack key={i} size="xs" />)}
              </div>
              <div className="hr-seat__plate">
                <span className="hr-seat__name">{p.username}</span>
                <span className="hr-seat__meta">
                  <span className="hr-seat__pos">{p.position}</span>
                  <span className={`hr-seat__stack${awarded ? ' hr-seat__stack--grow' : ''}`}>
                    {stack === null || stack === undefined ? '' : money(stack)}
                  </span>
                </span>
              </div>
              {made && <span className="hr-seat__made">{made}</span>}
              {isActive && frame.row && (
                <span className={`hr-seat__act hr-seat__act--${frame.row.verb}`}>
                  {frame.row.label}
                </span>
              )}
              {isFolded && !isActive && (
                <span className="hr-seat__act hr-seat__act--fold">Fold</span>
              )}
              {showPrivate && <span className="hr-seat__private">Yours</span>}
              {isFacing && facing && (
                <span className="hr-facing" aria-label="What This Seat Was Facing">
                  <span className="hr-facing__call">To Call {money(facing.toCall)}</span>
                  <span className="hr-facing__odds">
                    Pot Odds {facing.potOddsPct}% · {facing.ratio}
                  </span>
                </span>
              )}
            </div>
            {bet > 0 && (
              <div
                /* Remounted on the frame the chips arrive, so the slide plays
                   once, from the seat; a bet already sitting there keeps its
                   key and does not move again. */
                key={chipsIn ? `bet-${p.seat}-${frame.key}` : `bet-${p.seat}`}
                className={`hr-bet${chipsIn ? ' hr-bet--in' : ''}`}
                style={
                  {
                    left: `${pos.bx}%`,
                    top: `${pos.by}%`,
                    '--hr-from-x': `${pos.x}%`,
                    '--hr-from-y': `${pos.y}%`,
                  } as React.CSSProperties
                }
              >
                {money(bet)}
              </div>
            )}
            {sweeping > 0 && (
              <div
                key={`sweep-${p.seat}-${frame.key}`}
                className="hr-bet hr-bet--sweep"
                aria-hidden="true"
                style={{ left: `${pos.bx}%`, top: `${pos.by}%` } as React.CSSProperties}
              >
                {money(sweeping)}
              </div>
            )}
            {awarded && p.won > 0 && (
              <div
                key={`award-${p.seat}-${frame.key}`}
                className="hr-pot-fly"
                aria-hidden="true"
                style={
                  {
                    left: `${potPos.x}%`,
                    top: `${potPos.y}%`,
                    '--hr-to-x': `${pos.x}%`,
                    '--hr-to-y': `${pos.y}%`,
                  } as React.CSSProperties
                }
              >
                {money(p.won)}
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
  /* Where we are, and whether we STEPPED here (one frame forward) or jumped.
     Motion and sound are owed to a step; a jump or a scrub shows the frame. */
  const [cursor, setCursor] = useState<{ step: number; motion: boolean }>({
    step: 0,
    motion: false,
  });
  const step = cursor.step;
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState<ReplayRate>(() =>
    readReplayRate(typeof window !== 'undefined' ? window.localStorage : null)
  );
  const playbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const go = useCallback((next: number | ((s: number) => number), motion: boolean) => {
    setCursor((c) => ({ step: typeof next === 'function' ? next(c.step) : next, motion }));
  }, []);
  const chooseRate = useCallback((r: ReplayRate) => {
    setRate(r);
    writeReplayRate(typeof window !== 'undefined' ? window.localStorage : null, r);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setIsLoading(true);
      setLoadFailed(false);
      setCursor({ step: 0, motion: false });
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
  const jumps = useMemo(() => streetJumps(frames), [frames]);
  const winnerSeats = useMemo(() => (model ? winnerSeatsOf(model) : []), [model]);
  const last = Math.max(0, frames.length - 1);
  const at = Math.min(step, last);
  const frame = frames[at] ?? null;
  /* The frame before this one: always available for "what was this seat
     facing", but motion and sound read it only when we stepped here. */
  const prevFrame = at > 0 ? frames[at - 1] : null;
  const motionPrev = cursor.motion ? prevFrame : null;
  const motion = useMemo(
    () => (frame ? frameMotion(motionPrev, frame, winnerSeats) : null),
    [motionPrev, frame, winnerSeats]
  );

  // The cue the frame we stepped into owes, from the felt's own sound set.
  useEffect(() => {
    if (!frame || !motionPrev || !model) return;
    const cue = frameCue(motionPrev, frame);
    if (cue) playCue(cue, Math.abs(frame.row?.amount ?? 0), model.bigBlind);
    // One cue per arrival at a frame, not per re-render of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  // Playback: one frame per beat, scaled by the player's Animation Speed and
  // the replay's own rate. Each tick is a STEP, so it moves and sounds.
  useEffect(() => {
    if (playbackRef.current) clearTimeout(playbackRef.current);
    if (!isPlaying || frames.length === 0) return;
    if (step >= last) {
      setIsPlaying(false);
      return;
    }
    const beat = replayBeatMs(frame, getAnimationSpeed(), rate);
    playbackRef.current = setTimeout(() => go((s) => Math.min(last, s + 1), true), beat);
    return () => {
      if (playbackRef.current) clearTimeout(playbackRef.current);
    };
  }, [isPlaying, step, last, frames.length, frame, rate, go]);

  const togglePlay = useCallback(() => {
    if (step >= last) go(0, false);
    setIsPlaying((p) => !p);
  }, [step, last, go]);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    go((s) => Math.min(last, s + 1), true);
  }, [last, go]);
  const stepBack = useCallback(() => {
    setIsPlaying(false);
    go((s) => Math.max(0, s - 1), false);
  }, [go]);
  const jumpTo = useCallback(
    (index: number) => {
      setIsPlaying(false);
      go(Math.max(0, Math.min(last, index)), false);
    },
    [last, go]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (tab !== 'replay') return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepForward();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepBack();
    } else if (e.key === 'Home') {
      e.preventDefault();
      jumpTo(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      jumpTo(last);
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
    <div
      className="hand-replay"
      onKeyDown={onKeyDown}
      tabIndex={0}
      /* The replay's own rate; every motion duration divides by it in CSS. */
      style={{ '--hr-rate': rate } as React.CSSProperties}
    >
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
          <HandDetailView
            model={model}
            currentUserId={heroId}
            badge={variant}
            viewerFacts={handData.players.find((p) => p.user_id === heroId)?.facts}
          />
        </div>
      ) : (
        <div className="hand-replay__stage" role="tabpanel">
          {frame && motion && (
            <Felt model={model} frame={frame} prev={prevFrame} motion={motion} heroId={heroId} />
          )}

          <div className="hand-replay__caption" aria-live="polite">
            <span className="hand-replay__caption-street">{frame?.streetLabel}</span>
            <span className="hand-replay__caption-text">{frame?.caption}</span>
          </div>

          {/* Street jumps: land on the deal, or the first frame of a street. */}
          <div className="hand-replay__jumps" role="group" aria-label="Jump To Street">
            {jumps.map((j) => {
              const current = j.key === 'deal' ? at === 0 : at > 0 && frame?.streetKey === j.key;
              return (
                <button
                  key={j.key}
                  type="button"
                  className={`hr-jump${current ? ' hr-jump--current' : ''}`}
                  aria-pressed={current}
                  onClick={() => jumpTo(j.index)}
                >
                  {j.label}
                </button>
              );
            })}
          </div>

          <div className="hand-replay__controls">
            <button
              type="button"
              className="hr-btn hr-btn--icon"
              aria-label="First Step"
              onClick={() => jumpTo(0)}
              disabled={step === 0}
            >
              &#9198;
            </button>
            <button
              type="button"
              className="hr-btn hr-btn--icon"
              aria-label="Previous Step"
              onClick={stepBack}
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
              onClick={stepForward}
              disabled={step >= last}
            >
              &#9654;
            </button>
            <button
              type="button"
              className="hr-btn hr-btn--icon"
              aria-label="Last Step"
              onClick={() => jumpTo(last)}
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
                onChange={(e) => jumpTo(Number(e.target.value))}
              />
              <span className="hand-replay__scrub-label">
                {at + 1} / {frames.length}
              </span>
            </div>
            <div className="hand-replay__rate" role="group" aria-label="Replay Speed">
              {REPLAY_RATES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`hr-rate${rate === r ? ' hr-rate--current' : ''}`}
                  aria-pressed={rate === r}
                  aria-label={r === 0.5 ? 'Half Speed' : r === 1 ? 'Normal Speed' : 'Double Speed'}
                  onClick={() => chooseRate(r)}
                >
                  {r === 0.5 ? '½×' : `${r}×`}
                </button>
              ))}
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
