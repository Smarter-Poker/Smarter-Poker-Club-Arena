/**
 * ♠ CLUB ARENA — Hand Replay Viewer
 * premium-style hand history replay with timeline scrubbing
 */

import { useState, useEffect, useRef, Suspense } from 'react';
import type { Card, CardSuit, CardRank } from '../../types/database.types';
import { CardImage } from '../table/CardImage';
import { LiveHandReplayer2D } from './LiveHandReplayer2D';
import type { Card as CardImageCard } from '../table/CardImage';
import './HandReplay.css';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { lazyWithRetry } from '../../utils/lazyWithRetry';

// Lazy-load HandReplay3D — Three.js is large and only needed when 3D tab is opened
const HandReplay3D = lazyWithRetry(() => import('./HandReplay3D'));

export interface PlayerAction {
  player_id: string;
  street?: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | 'discard';
  amount?: number;
  timestamp: number;
}

/**
 * The verbs a player CHOOSES. `hand_history.actions` also carries forced money
 * — sb, bb, ante, straddle, post — and the returned uncalled bet, all recorded
 * since 2026-08-27 so a hand can be rebuilt. None of them is a decision, so
 * none of them belongs in a replay's action timeline.
 */
const VOLUNTARY_ACTIONS = new Set<string>([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'all_in',
  'discard',
]);

interface HandPlayer {
  seat: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  position: 'UTG' | 'MP' | 'CO' | 'BTN' | 'SB' | 'BB';
  hole_cards: Card[];
  final_hand?: string; // "Two Pair", "One Pair", etc.
  result: number; // +/- chips
  is_winner: boolean;
  /** SHOWDOWN POLISH 2026-08-25: the persisted reveal record (see
      HandHistoryService.HandPlayer.showdown_reveal). */
  showdown_reveal?: {
    reveal_order: number;
    mucked: boolean;
    hand_name?: string;
    hand_description?: string;
  };
}

export interface HandData {
  id: string;
  serial_number: string;
  played_at: string;
  hand_number: number;
  total_hands: number;
  main_pot: number;
  community_cards: Card[];
  /** Round 2 (double board): board 2, absent on single-board hands. */
  community_cards2?: Card[];
  /** TRIPLE-BOARD BOMB POT 2026-08-27: board 3, absent below three boards. */
  community_cards3?: Card[];
  /** BOMB POT FACTS (spec §20): trigger reason / ante / boards / variant. */
  bomb_pot?: {
    trigger_reason?: string;
    ante_amount?: number;
    board_count?: number;
    variant?: string;
  } | null;
  /**
   * COMPLETENESS PASS 2026-08-26: Run It Twice boards 2..N in run order
   * (board 1 is community_cards). Dealt AFTER the all-in locked, so they
   * render only once the replay reaches the river step.
   */
  rit_boards?: Card[][];
  players: HandPlayer[];
  actions: PlayerAction[];
}

interface HandReplayProps {
  handId?: string;
  handData?: HandData;
  onClose?: () => void;
}

// Helper to convert full suit name to abbreviation for CardImage
const SUIT_ABBREV: Record<string, CardImageCard['suit']> = {
  hearts: 'h',
  diamonds: 'd',
  clubs: 'c',
  spades: 's',
  h: 'h',
  d: 'd',
  c: 'c',
  s: 's',
};

// Normalize rank for CardImage ('10' → 'T')
function normalizeRank(rank: string): CardImageCard['rank'] {
  if (rank === '10') return 'T';
  return rank as CardImageCard['rank'];
}

/**
 * Convert a stored card to CardImage form.
 *
 * COMPLETENESS PASS 2026-08-26: production `hand_history.community_cards`
 * rows store ENGINE STRINGS ('8spades', '10hearts'), not {rank, suit}
 * objects — verified against a live row. This function only handled the
 * object form, so `card.rank` came back undefined and CardImage fell back
 * to its Ace-of-Spades placeholder for every board card in a replayed
 * hand_history row. Both forms are handled now (rit_boards uses the same
 * string format).
 */
function toCardImage(card: Card | string): CardImageCard {
  if (typeof card === 'string') {
    const m = /^(10|[2-9TJQKA])(hearts|diamonds|clubs|spades|[hdcs])$/.exec(card);
    if (m) {
      return { rank: normalizeRank(m[1]), suit: SUIT_ABBREV[m[2]] || 's' };
    }
    // Unparseable string — let CardImage's own guard warn and fall back.
    return { rank: 'A', suit: 's' };
  }
  return {
    rank: normalizeRank(card.rank),
    suit: SUIT_ABBREV[card.suit] || 's',
  };
}

// Position badge colors
function getPositionColor(position: string): string {
  switch (position) {
    case 'BTN':
      return '#10b981';
    case 'SB':
      return '#3b82f6';
    case 'BB':
      return '#f97316';
    case 'UTG':
      return '#ef4444';
    case 'MP':
      return '#8b5cf6';
    case 'CO':
      return '#22c55e';
    default:
      return '#6b7280';
  }
}

export default function HandReplay({
  handId: propHandId,
  handData: initialData,
  onClose,
}: HandReplayProps) {
  // Support both prop-based and route-based usage
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const pathParts = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
  const routeHandId = pathParts[pathParts.indexOf('replay') + 1];
  const handId = propHandId || routeHandId;

  const [handData, setHandData] = useState<HandData | null>(initialData || null);
  const [activeTab, setActiveTab] = useState<'summary' | 'detail' | '3d'>('summary');
  const [is3DActive, setIs3DActive] = useState(false);
  const [isLoading, setIsLoading] = useState(!initialData);
  /* "We could not ask" is not the same as "there is no such hand". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [totalSteps, setTotalSteps] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(false);
  const totalStepsRef = useRef(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const toast = useToast();

  const playbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Controls entrance animation
  useEffect(() => {
    setControlsVisible(false);
    const timer = setTimeout(() => setControlsVisible(true), 200);
    return () => clearTimeout(timer);
  }, [isLoading]);

  useEffect(() => {
    // Always load demo data for now (or fetch from API when handId is provided)
    loadHandData();
  }, [handId]);

  useEffect(() => {
    if (handData) {
      let stages = 1; // preflop
      let currentStreet = 'preflop';
      for (const a of handData.actions) {
        if (a.street && a.street !== currentStreet && a.street !== 'pineapple_discard') {
          stages++;
          currentStreet = a.street;
        }
        stages++;
      }
      stages++; // showdown
      setTotalSteps(stages);
      totalStepsRef.current = stages;
    }
  }, [handData]);

  // Cleanup interval on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (playbackRef.current) clearInterval(playbackRef.current);
    };
  }, []);

  const loadHandData = async () => {
    setIsLoading(true);
    setLoadFailed(false);
    try {
      if (handId) {
        // Fetch real hand data from API
        const { handHistoryService } = await import('../../services/HandHistoryService');
        const data = await handHistoryService.getHand(handId);
        if (data) {
          // Map to HandData format
          setHandData({
            id: data.id,
            serial_number: data.serial_number,
            played_at: data.played_at,
            hand_number: data.hand_number,
            total_hands: data.total_hands,
            main_pot: data.main_pot,
            community_cards: data.community_cards,
            community_cards2: data.community_cards2 ?? [],
            community_cards3: data.community_cards3 ?? [],
            bomb_pot: data.bomb_pot ?? null,
            // COMPLETENESS PASS 2026-08-26: Run It Twice boards 2..N (board
            // 1 is community_cards) — rendered as RUN rows at showdown.
            rit_boards: data.rit_boards ?? [],
            players: data.players.map((p) => ({
              seat: p.seat,
              user_id: p.user_id,
              username: p.username,
              avatar_url: p.avatar_url,
              position: p.position as HandPlayer['position'],
              hole_cards: p.hole_cards,
              final_hand: p.final_hand,
              result: p.result,
              is_winner: p.is_winner,
              showdown_reveal: p.showdown_reveal,
            })),
            /* FORCED MONEY IS NOT A REPLAYED ACTION (2026-08-27).
               The engine now records the blinds, antes, straddles and the
               returned uncalled bet in `actions`, which is what makes a hand
               rebuildable — see server/src/engine/HandController.ts postBlinds.
               The replay animates a player DECIDING something, and nobody
               decides to post a blind, so those rows are filtered here rather
               than widened into PlayerAction. The hand rundown, which does
               want them, reads the row directly. */
            actions: data.actions
              .filter((a) => VOLUNTARY_ACTIONS.has(a.action))
              .map((a) => ({
                player_id: a.player_id,
                action: a.action as PlayerAction['action'],
                amount: a.amount,
                street: (a as { street?: string }).street as 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER',
                timestamp: a.timestamp,
              })),
          });
        } else {
          /* NOT FOUND. It used to render `getFallbackHandData()` here — a
             hand-shaped fiction with invented players, invented hole cards and
             an invented pot — and the same fiction again from the catch below.

             This component is reachable from two live surfaces: "replay last
             hand" at a real table (TableModalsLayer) and the routed hand
             history page. So any load failure showed a player a hand that
             never happened, indistinguishable from their own history. A hand
             history is the evidentiary record of a poker game; inventing one
             is worse than showing nothing by every measure that matters. */
          setHandData(null);
        }
      } else {
        // No handId: nothing to replay. Never invent one.
        setHandData(null);
      }
    } catch (error) {
      reportError(error, 'HandReplay.Failed_to_load_hand');
      setHandData(null);
      setLoadFailed(true);
    }
    setIsLoading(false);
  };

  const handlePlay = () => {
    if (isPlaying) {
      if (playbackRef.current) clearInterval(playbackRef.current);
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      playbackRef.current = setInterval(() => {
        setCurrentStep((prev) => {
          if (prev >= totalStepsRef.current) {
            if (playbackRef.current) clearInterval(playbackRef.current);
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 1500);
    }
  };

  const handleStepChange = (step: number) => {
    setCurrentStep(step);
    if (playbackRef.current) clearInterval(playbackRef.current);
    setIsPlaying(false);
  };

  const handlePrev = () => {
    if (currentStep > 1) setCurrentStep((prev) => prev - 1);
  };

  const handleNext = () => {
    if (currentStep < totalSteps) setCurrentStep((prev) => prev + 1);
  };

  const handleShare = async () => {
    const shareUrl = `https://smarter.poker/hub/club-arena/replay/${handData?.id}`;
    const shareText = `Check out this hand I played on Club Arena! #PlayPoker`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Club Arena Hand Replay',
          text: shareText,
          url: shareUrl,
        });
      } catch (err) {
        reportError(err, 'HandReplay.Error');
        copyToClipboard(shareUrl);
      }
    } else {
      copyToClipboard(shareUrl);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Link copied to clipboard!');
  };

  const formatDate = (date: string) => {
    return new Date(date)
      .toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      .replace(',', '');
  };

  // Round 2 (double board): the same street-slice logic for either board.
  const sliceForStep = (cards: Card[]) => {
    switch (currentStep) {
      case 1:
        return [];
      case 2:
        return cards.slice(0, 3);
      case 3:
        return cards.slice(0, 4);
      default:
        return cards;
    }
  };

  // Get visible community cards based on current step
  const getVisibleCommunityCards = () => {
    if (!handData) return [];
    switch (currentStep) {
      case 1:
        return []; // preflop
      case 2:
        return handData.community_cards.slice(0, 3); // flop
      case 3:
        return handData.community_cards.slice(0, 4); // turn
      case 4:
        return handData.community_cards; // river
      default:
        return handData.community_cards;
    }
  };

  if (isLoading) {
    return (
      <div className="hand-replay loading">
        <div className="loader-spinner" />
        <p>Loading Hand...</p>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="hand-replay error">
        <p>Could Not Load This Hand</p>
        <button onClick={() => void loadHandData()}>Retry</button>
        {onClose && <button onClick={onClose}>Close</button>}
      </div>
    );
  }

  if (!handData) {
    return (
      <div className="hand-replay error">
        <p>Hand Not Found</p>
        {onClose && <button onClick={onClose}>Close</button>}
      </div>
    );
  }

  return (
    <div className="hand-replay">
      {/* Header */}
      <header className="replay-header">
        <h1>HAND DETAIL</h1>
        <div className="header-actions">
          {/* STAR REMOVED 2026-08-20. It had no onClick, and there is nothing
              behind it: no favourites table, no is_starred column, no service
              method anywhere in the repo. HandReplay IS rendered (the table's
              replay modal and HandHistoryPage), so players saw a favourite
              affordance on their own hands and pressing it did nothing. A
              favourites feature needs somewhere to store them first. */}
          <button className="action-btn play" onClick={handlePlay}>
            {isPlaying ? '▮' : '▶'}
          </button>
        </div>
      </header>

      {/* Meta Info */}
      <div className="replay-meta">
        <span className="meta-date">{formatDate(handData.played_at)}</span>
        <span className="meta-hand">
          {handData.hand_number} / {handData.total_hands}
        </span>
        <span className="meta-sn">SN: {handData.serial_number}</span>
      </div>

      {/* Share Button */}
      <div className="share-row">
        <button className="share-btn" onClick={handleShare}>
          Share
        </button>
      </div>

      {/* Main Pot */}
      <div className="main-pot">
        <span>Main Pot : </span>
        <span className="pot-amount">{handData.main_pot.toLocaleString()}</span>
      </div>

      {/* Players Table */}
      {activeTab === 'summary' && (
        <div className="players-table">
          {/* SHOWDOWN POLISH 2026-08-25: when the reveal record exists, list
            the showdown participants in the order the table revealed them —
            aggressor first, then clockwise — with everyone else after. */}
          {[...handData.players]
            .sort((a, b) => {
              const ao = a.showdown_reveal?.reveal_order ?? 99;
              const bo = b.showdown_reveal?.reveal_order ?? 99;
              return ao - bo || a.seat - b.seat;
            })
            .map((player) => (
              <div
                key={player.user_id}
                className={`player-row ${player.is_winner ? 'winner' : ''}`}
              >
                {/* Name & Position */}
                <div className="player-info">
                  <span className="player-name">{player.username}</span>
                  <span
                    className="player-position"
                    style={{ backgroundColor: getPositionColor(player.position) }}
                  >
                    {player.position}
                  </span>
                </div>

                {/* Hole Cards */}
                <div className="player-hole-cards">
                  {player.hole_cards.length > 0 ? (
                    player.hole_cards.map((card, idx) => (
                      <div key={idx} className="card">
                        <CardImage card={toCardImage(card)} size="xs" />
                      </div>
                    ))
                  ) : (
                    <>
                      <div className="card back" />
                      <div className="card back" />
                    </>
                  )}
                </div>

                {/* Hand Ranking (if shown) — SHOWDOWN POLISH 2026-08-25: prefer
                the persisted reveal record (name + description), fall back to
                the winner's hand name; a mucked participant reads MUCKED, with
                no hand identity, exactly as the table showed it. */}
                {player.showdown_reveal?.mucked ? (
                  <div className="player-hand-ranking player-hand-ranking--mucked">Mucked</div>
                ) : player.showdown_reveal?.hand_name || player.final_hand ? (
                  <div className="player-hand-ranking">
                    {player.showdown_reveal?.hand_name || player.final_hand}
                    {player.showdown_reveal?.hand_description && (
                      <span className="player-hand-description">
                        {' '}
                        {player.showdown_reveal.hand_description}
                      </span>
                    )}
                  </div>
                ) : null}

                {/* BOMB POT FACTS (spec §20, 2026-08-28): the frozen trigger
                    record, so a replay says what KIND of hand this was. */}
                {handData.bomb_pot && (
                  <div
                    className="replay-bomb-facts"
                    style={{
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap',
                      margin: '2px 0 6px',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      color: '#ffcf7d',
                    }}
                  >
                    <span>BOMB POT</span>
                    {(handData.bomb_pot.board_count ?? 1) >= 2 && (
                      <span>
                        {(handData.bomb_pot.board_count ?? 2) >= 3
                          ? 'TRIPLE BOARD'
                          : 'DOUBLE BOARD'}
                      </span>
                    )}
                    {handData.bomb_pot.variant && (
                      <span>{handData.bomb_pot.variant.toUpperCase()}</span>
                    )}
                    {(handData.bomb_pot.ante_amount ?? 0) > 0 && (
                      <span>{`ANTE ${handData.bomb_pot.ante_amount}`}</span>
                    )}
                    {handData.bomb_pot.trigger_reason && (
                      <span>
                        {/* 2026-08-29: was `.replace(/_/g,' ').toUpperCase()`,
                            which printed the raw DB enum at the player — "EVERY
                            N HANDS", "ONCE PER ORBIT", "BOMB POT ONLY", "MANUAL
                            NEXT HAND". Two of those are engineering
                            identifiers, not English, and "EVERY N HANDS" names
                            a variable nobody outside this codebase has ever
                            seen. The lobby already maps the same four values to
                            readable labels (lobbyEntries.ts); this is the
                            replay saying the same thing the lobby says. */}
                        {(
                          {
                            every_n_hands: 'SCHEDULED',
                            once_per_orbit: 'EVERY ORBIT',
                            timed: 'ON THE CLOCK',
                            bomb_pot_only: 'BOMB POT TABLE',
                            manual_next_hand: 'CALLED BY THE HOST',
                          } as Record<string, string>
                        )[String(handData.bomb_pot.trigger_reason)] ??
                          String(handData.bomb_pot.trigger_reason).replace(/_/g, ' ').toUpperCase()}
                      </span>
                    )}
                  </div>
                )}

                {/* Community Cards (repeated per row for visual) */}
                <div className="community-cards-row">
                  {getVisibleCommunityCards().map((card, idx) => (
                    <div key={idx} className="card small">
                      <CardImage card={toCardImage(card)} size="xs" />
                    </div>
                  ))}
                </div>
                {/* Round 2 (double board): board 2 under board 1, same street slice */}
                {(handData.community_cards2?.length ?? 0) > 0 && (
                  <div className="community-cards-row">
                    {sliceForStep(handData.community_cards2!).map((card, idx) => (
                      <div key={`b2-${idx}`} className="card small">
                        <CardImage card={toCardImage(card)} size="xs" />
                      </div>
                    ))}
                  </div>
                )}
                {/* TRIPLE-BOARD BOMB POT 2026-08-27: board 3, same slice. */}
                {(handData.community_cards3?.length ?? 0) > 0 && (
                  <div className="community-cards-row">
                    {sliceForStep(handData.community_cards3!).map((card, idx) => (
                      <div key={`b3-${idx}`} className="card small">
                        <CardImage card={toCardImage(card)} size="xs" />
                      </div>
                    ))}
                  </div>
                )}
                {/* COMPLETENESS PASS 2026-08-26: Run It Twice boards 2..N.
                    Dealt AFTER the all-in locked, so they exist only from
                    the river step onward — gated on board 1's slice being
                    complete, labeled by run. */}
                {(handData.rit_boards?.length ?? 0) > 0 &&
                  getVisibleCommunityCards().length >= 5 &&
                  handData.rit_boards!.map((board, bi) => (
                    <div className="community-cards-row" key={`rit-${bi}`}>
                      <span className="replay-run-badge">RUN {bi + 2}</span>
                      {board.map((card, idx) => (
                        <div key={`rit-${bi}-${idx}`} className="card small">
                          <CardImage card={toCardImage(card)} size="xs" />
                        </div>
                      ))}
                    </div>
                  ))}

                {/* Result */}
                <div className={`player-result ${player.result >= 0 ? 'positive' : 'negative'}`}>
                  {player.result >= 0 ? '+' : ''}
                  {player.result.toLocaleString()}
                  <br />
                  <span className="result-label">Main Pot</span>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Playback Controls */}
      <div
        className="playback-controls"
        style={{
          opacity: controlsVisible ? 1 : 0,
          transform: controlsVisible ? 'translateY(0)' : 'translateY(10px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <span className="step-display">
          {currentStep}/{totalSteps}
        </span>
      </div>

      <div
        className="playback-slider-row"
        style={{
          opacity: controlsVisible ? 1 : 0,
          transform: controlsVisible ? 'translateY(0)' : 'translateY(10px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          transitionDelay: '0.05s',
        }}
      >
        <button className="nav-arrow" onClick={handlePrev} disabled={currentStep <= 1}>
          ◀
        </button>
        <input
          type="range"
          className="playback-slider"
          min={1}
          max={totalSteps}
          value={currentStep}
          onChange={(e) => handleStepChange(Number(e.target.value))}
        />
        <button className="nav-arrow" onClick={handleNext} disabled={currentStep >= totalSteps}>
          ▶
        </button>
      </div>

      {/* Tab Switcher */}
      <div className="replay-tabs">
        <button
          className={`replay-tab ${activeTab === 'summary' ? 'active' : ''}`}
          onClick={() => setActiveTab('summary')}
        >
          Hand Summary
        </button>
        <button
          className={`replay-tab ${activeTab === 'detail' ? 'active' : ''}`}
          onClick={() => setActiveTab('detail')}
        >
          Hand Detail
        </button>
        <button
          className={`replay-tab ${activeTab === '3d' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('3d');
            setIs3DActive(true);
          }}
        >
          3D Replay
        </button>
      </div>

      {/* 2D Live Replayer */}
      {activeTab === 'detail' && (
        <LiveHandReplayer2D handData={handData} currentStep={currentStep} totalSteps={totalSteps} />
      )}

      {/* 3D Replay Panel */}
      {activeTab === '3d' && (
        <div
          style={{ height: '400px', marginTop: '12px', borderRadius: '12px', overflow: 'hidden' }}
        >
          <Suspense
            fallback={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: '#b0b3b8',
                }}
              >
                Loading 3D Viewer...
              </div>
            }
          >
            <HandReplay3D
              active={is3DActive}
              seatCount={handData ? (Math.max(handData.players.length, 2) as 2 | 6 | 9) : 6}
              feltColor="#0d5f2f"
              orbitControls
              speed={1}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

export { HandReplay };
