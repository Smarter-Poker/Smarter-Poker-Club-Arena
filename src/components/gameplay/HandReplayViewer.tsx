/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAND REPLAY VIEWER — Animated Hand Playback
 * Step-by-step replay of past hands with player actions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { CardImage } from '../table/CardImage';
import { toDeckCards, type DeckCard } from '../../utils/deckCards';
import {
  normaliseStoredHand,
  cardsVisibleAtStage,
  type ReplayAction,
  type ReplayPlayer,
  type ReplayWinner,
} from '../../utils/handHistoryShape';
import styles from './HandReplayViewer.module.css';
import { reportError } from '../../utils/errorReporter';

/* The stored shape of hand_history — the field names, why each one bit, and
   the normaliser that maps them — lives in `src/utils/handHistoryShape.ts`
   and is pinned by `tests/hand-history-shape.test.ts`. */

interface HandData {
  id: string;
  tableName: string;
  gameType: string;
  blinds: string;
  /** Authoritative final pot from `hand_history.pot_size`. */
  finalPot: number;
  communityCards: string[];
  /** Run-it-twice second board, when the hand carries one. */
  secondBoard: string[];
  players: ReplayPlayer[];
  actions: ReplayAction[];
  winners: ReplayWinner[];
  playedAt: string;
}

interface HandReplayViewerProps {
  handId?: string;
  handData?: HandData;
  autoPlay?: boolean;
  onClose?: () => void;
}

export default function HandReplayViewer({
  handId,
  handData: propHandData,
  autoPlay = false,
  onClose,
}: HandReplayViewerProps) {
  const [hand, setHand] = useState<HandData | null>(propHandData || null);
  const [loading, setLoading] = useState(!propHandData);
  /* A failed load is NOT "Hand Not Found". Conflating the two is what let the
     PGRST200 and the 42703 sit unnoticed: the component rendered a calm,
     plausible empty state over a query that had errored. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [currentPot, setCurrentPot] = useState(0);
  const [visibleActions, setVisibleActions] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearStaggerTimers = () => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = [];
  };

  /* These timeouts were never cancelled. Autoplay at 3X through a 20-action
     hand queued one per action per step change, all of them calling setState
     after the modal had closed. */
  useEffect(() => clearStaggerTimers, []);

  useEffect(() => {
    if (!hand) return;
    clearStaggerTimers();
    staggerTimersRef.current = hand.actions
      .map((_, i) =>
        i <= currentStep
          ? setTimeout(() => setVisibleActions((prev) => new Set(prev).add(i)), i * 40)
          : null
      )
      .filter((t): t is ReturnType<typeof setTimeout> => t !== null);
  }, [hand, currentStep]);

  useEffect(() => {
    if (handId && !propHandData) {
      void loadHand();
    }
  }, [handId]);

  useEffect(() => {
    if (!isPlaying || !hand) return;
    const interval = setInterval(
      () => {
        setCurrentStep((prev) => {
          if (prev >= hand.actions.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      },
      1500 / Math.max(playSpeed, 0.25)
    );
    return () => clearInterval(interval);
  }, [isPlaying, hand, playSpeed]);

  /** hand_history.table_id has no FK to `tables` (see loadHand), so the name
      is fetched separately. A hand whose table has since been removed keeps
      its replay and simply shows the fallback. */
  const resolveTableName = async (tableId: string | null | undefined): Promise<string> => {
    if (!tableId) return 'Table';
    const { data, error } = await supabase
      .from('tables')
      .select('name')
      .eq('id', tableId)
      .maybeSingle();
    if (error) {
      reportError(error, 'HandReplayViewer.resolveTableName');
      return 'Table';
    }
    return (data as { name?: string } | null)?.name ?? 'Table';
  };

  const loadHand = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      /* 2026-08-19: this read `hands`, a table with ZERO rows ever, so hand
         replay could never load a hand — it silently rendered nothing. The
         server-authoritative engine writes hand_history.

         2026-08-22: that fix said "the table name is resolved through the FK",
         but hand_history.table_id HAS NO FK, so `tables:table_id ( name )`
         returned 400 PGRST200 on every call and `if (!error && data)` quietly
         rendered nothing all over again — the same silent-empty failure, one
         step further along.

         An FK is the WRONG fix here and was not added. hand_history is 10 GB /
         1.5M rows and its rows deliberately OUTLIVE the ephemeral `tables` row
         they reference: a foreign key would assert an invariant this schema
         does not hold, and ON DELETE CASCADE would erase hand history every
         time a table closed. The name is resolved with a second, tiny lookup
         instead.

         2026-08-23: the query was right by then and the MAPPING was not. Every
         field below was read under a name the row does not use. See the shape
         note at the top of this file. */
      const { data, error } = await supabase
        .from('hand_history')
        .select(
          `
                    id,
                    game_variant,
                    small_blind,
                    big_blind,
                    pot_size,
                    community_cards,
                    players,
                    actions,
                    winners,
                    created_at,
                    table_id
                `
        )
        .eq('id', handId)
        .maybeSingle();

      if (error) {
        reportError(error, 'HandReplayViewer.loadHand');
        setLoadFailed(true);
        return;
      }
      if (!data) return; // genuinely no such hand

      const d = data as Record<string, unknown>;
      const sb = (d.small_blind as number | null) ?? null;
      const bb = (d.big_blind as number | null) ?? null;

      const { players, actions, winners, secondBoard } = normaliseStoredHand(
        d.players,
        d.actions,
        d.winners
      );

      setHand({
        id: String(d.id),
        tableName: await resolveTableName(d.table_id as string | null),
        gameType: (d.game_variant as string) || '',
        blinds: sb != null && bb != null ? `${sb}/${bb}` : '',
        finalPot: Number(d.pot_size ?? 0),
        communityCards: Array.isArray(d.community_cards) ? (d.community_cards as string[]) : [],
        secondBoard,
        players,
        actions,
        winners,
        playedAt: String(d.created_at ?? ''),
      });
    } catch (error) {
      reportError(error, 'HandReplayViewer.Failed_to_load_hand');
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  /* Community cards are stored as "Khearts"/"Tspades", not "Kh"/"Ts".
     `toDeckCards` is the one normaliser for that; the hand-rolled parser this
     replaced did `slice(-1)` and produced { rank: "Kheart", suit: "s" }. */
  const boardCards: DeckCard[] = useMemo(
    () => toDeckCards(hand?.communityCards),
    [hand?.communityCards]
  );
  const secondBoardCards: DeckCard[] = useMemo(
    () => toDeckCards(hand?.secondBoard),
    [hand?.secondBoard]
  );

  const [visibleCards, setVisibleCards] = useState<DeckCard[]>([]);

  const updateBoard = useCallback(() => {
    if (!hand) return;
    const actionsUpToStep = hand.actions.slice(0, currentStep + 1);

    /* A running total, and honestly labelled as one. Measured over 40 hands on
       2026-08-23: the sum of action amounts does not reconcile to pot_size in
       either direction — blinds and antes are not in the action stream, and
       rake is already out of pot_size. The authoritative figure is shown at
       the end of the hand instead of pretending this one is it. */
    setCurrentPot(actionsUpToStep.reduce((sum, a) => sum + (a.amount || 0), 0));

    const lastAction = actionsUpToStep[actionsUpToStep.length - 1];
    const reveal = lastAction ? cardsVisibleAtStage(lastAction.stage) : 0;
    setVisibleCards(boardCards.slice(0, reveal));
  }, [hand, currentStep, boardCards]);

  useEffect(() => {
    updateBoard();
  }, [updateBoard]);

  const atEnd = !!hand && currentStep >= hand.actions.length - 1;

  const stepForward = () => {
    if (!hand || currentStep >= hand.actions.length - 1) return;
    setCurrentStep((prev) => prev + 1);
  };

  const stepBackward = () => {
    if (currentStep < 0) return;
    setCurrentStep((prev) => prev - 1);
  };

  const togglePlay = () => setIsPlaying((p) => !p);

  const reset = () => {
    setCurrentStep(-1);
    setIsPlaying(false);
    /* Without this the stagger never replays: every index stayed in the set. */
    setVisibleActions(new Set());
  };

  const skipToEnd = () => {
    if (!hand) return;
    setCurrentStep(hand.actions.length - 1);
    setIsPlaying(false);
  };

  const formatAmount = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const getActionDisplay = (action: ReplayAction): { text: string; color: string } => {
    switch (action.verb) {
      case 'fold':
        return { text: 'Folds', color: '#6b7280' };
      case 'check':
        return { text: 'Checks', color: '#3b82f6' };
      case 'call':
        return { text: `Calls ${formatAmount(action.amount)}`, color: '#10b981' };
      case 'bet':
        return { text: `Bets ${formatAmount(action.amount)}`, color: '#f59e0b' };
      case 'raise':
        return { text: `Raises To ${formatAmount(action.amount)}`, color: '#ef4444' };
      /* Stored as all_in, not all-in. The hyphen meant 236,898 all-ins fell to
         `default` and rendered the raw token in white. */
      case 'all_in':
        return { text: `All-In ${formatAmount(action.amount)}`, color: '#a855f7' };
      /* Draw and pineapple games. 74,631 of these had no case at all. */
      case 'discard':
        return { text: 'Discards', color: '#94a3b8' };
      default:
        return { text: action.verb, color: '#ffffff' };
    }
  };

  if (loading) {
    return (
      <div className={styles.viewer}>
        <div className={styles.loading}>Loading Hand...</div>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className={styles.viewer}>
        <div className={styles.error}>
          Could Not Load This Hand. Please Try Again.
          {onClose && (
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close replay">
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!hand) {
    return (
      <div className={styles.viewer}>
        <div className={styles.error}>Hand Not Found</div>
      </div>
    );
  }

  const currentAction = currentStep >= 0 ? hand.actions[currentStep] : null;

  return (
    <div className={styles.viewer}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.handInfo}>
          <h3>Hand Replay</h3>
          <span className={styles.subtitle}>
            {[hand.tableName, hand.blinds, hand.gameType].filter(Boolean).join(' • ')}
          </span>
        </div>
        {onClose && (
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close replay">
            ✕
          </button>
        )}
      </div>

      {/* Board */}
      <div className={styles.board}>
        <div className={styles.communityCards}>
          {visibleCards.length > 0 ? (
            visibleCards.map((card, i) => (
              <div key={`${card.rank}${card.suit}-${i}`} className={styles.cardWrapper}>
                <CardImage card={card} size="sm" />
              </div>
            ))
          ) : (
            <span className={styles.noCards}>Preflop</span>
          )}
        </div>

        {/* Run it twice: the second board, once the hand has run out */}
        {atEnd && secondBoardCards.length > 0 && (
          <div className={styles.communityCards}>
            {secondBoardCards.map((card, i) => (
              <div key={`rit-${card.rank}${card.suit}-${i}`} className={styles.cardWrapper}>
                <CardImage card={card} size="sm" />
              </div>
            ))}
          </div>
        )}

        <div className={styles.potDisplay}>
          {atEnd
            ? `Pot: ${formatAmount(hand.finalPot)}`
            : `Pot So Far: ${formatAmount(currentPot)}`}
        </div>
      </div>

      {/* Current Action */}
      {currentAction && (
        <div className={styles.actionDisplay}>
          <span className={styles.actionPlayer}>{currentAction.playerName}</span>
          <span
            className={styles.actionText}
            style={{ color: getActionDisplay(currentAction).color }}
          >
            {getActionDisplay(currentAction).text}
          </span>
        </div>
      )}

      {/* Action History */}
      <div className={styles.history}>
        {hand.actions.slice(0, currentStep + 1).map((action, i) => (
          <div
            key={i}
            className={`${styles.historyItem} ${i === currentStep ? styles.current : ''}`}
            style={{
              opacity: visibleActions.has(i) ? 1 : 0,
              transform: visibleActions.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <span className={styles.historyPlayer}>{action.playerName}</span>
            <span style={{ color: getActionDisplay(action).color }}>
              {getActionDisplay(action).text}
            </span>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        <button onClick={reset} title="Reset" aria-label="Reset replay">
          ⏮
        </button>
        <button onClick={stepBackward} title="Step Back" aria-label="Step back one action">
          ⏪
        </button>
        <button
          onClick={togglePlay}
          className={styles.playBtn}
          aria-label={isPlaying ? 'Pause replay' : 'Play replay'}
        >
          {isPlaying ? '▮' : '▶'}
        </button>
        <button onClick={stepForward} title="Step Forward" aria-label="Step forward one action">
          ⏩
        </button>
        <button onClick={skipToEnd} title="Skip to End" aria-label="Skip to end of hand">
          ⏭
        </button>

        <div className={styles.speedControl}>
          <span>Speed:</span>
          <select
            value={playSpeed}
            onChange={(e) => setPlaySpeed(Number(e.target.value))}
            aria-label="Playback speed"
          >
            <option value={0.5}>0.5X</option>
            <option value={1}>1X</option>
            <option value={2}>2X</option>
            <option value={3}>3X</option>
          </select>
        </div>
      </div>

      {/* Progress Bar */}
      <div className={styles.progress}>
        <div
          className={styles.progressFill}
          style={{
            width: `${hand.actions.length > 0 ? ((currentStep + 1) / hand.actions.length) * 100 : 0}%`,
          }}
        />
      </div>

      {/* Winners (at end) */}
      {atEnd && hand.winners.length > 0 && (
        <div className={styles.winners}>
          {hand.winners
            .map((w) => {
              /* Winners are keyed by userId. The old lookup compared
                 `p.id === w.playerId` — neither field exists, so it matched
                 undefined against undefined and named the first player in the
                 array as the winner of every hand. */
              const madeHand = w.handName ? ` (${w.handName})` : '';
              return `${w.playerName} Wins ${formatAmount(w.amount)}${madeHand}`;
            })
            .join(', ')}
        </div>
      )}
    </div>
  );
}
