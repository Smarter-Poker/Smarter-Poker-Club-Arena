import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { handHistoryService } from '../../services/HandHistoryService';
import { PositionAnalysis, OddsDisplay, ShareableHighlight } from '../../components/hand-replayer';
import { CardImage } from '../../components/table/CardImage';
import type { Card } from '../../components/table/CardImage';
import HandReplay3D from '../../components/replay/HandReplay3D';
import type { ReplaySnapshot } from '../../types/engine/handReplay';
import './HandReplayerPage.css';
import { reportError } from '../../utils/errorReporter';

interface HandAction {
  player: string;
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
  amount?: number;
  timestamp: number;
}

interface HandData {
  id: string;
  table_name: string;
  game_type: string;
  stakes: string;
  pot: number;
  community_cards: string[];
  players: {
    seat: number;
    name: string;
    avatar?: string;
    stack: number;
    cards?: string[];
    is_winner?: boolean;
  }[];
  actions: HandAction[];
  played_at: string;
  winner?: string;
}

export default function HandReplayerPage() {
  const { handId } = useParams<{ handId: string }>();
  const [hand, setHand] = useState<HandData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shareLabel, setShareLabel] = useState<'Share' | 'Link copied' | 'Copy failed'>('Share');
  const [currentStep, setCurrentStep] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [activeTab, setActiveTab] = useState<'replay' | 'analysis'>('replay');
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('3d');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const overlayRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    let isMounted = true;
    if (handId) {
      loadHand(() => isMounted);
    }
    return () => {
      isMounted = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [handId]);

  useEffect(() => {
    document.title = 'Hand Replay | Club Arena';
  }, [hand]);

  const loadHand = async (getIsMounted?: () => boolean) => {
    try {
      const record = await handHistoryService.getHand(handId!);
      if (getIsMounted && !getIsMounted()) return;
      if (!record) {
        setHand(null);
        return;
      }

      const winnerPlayer = record.players.find((p) => p.is_winner);
      const mapped: HandData = {
        id: record.id,
        table_name: record.table_name,
        game_type: record.game_type,
        stakes: record.stakes,
        pot: record.main_pot + (record.side_pots || []).reduce((s, v) => s + v, 0),
        community_cards: (record.community_cards || []).map((c) =>
          typeof c === 'string' ? c : `${c}`
        ),
        players: record.players.map((p) => ({
          seat: p.seat,
          name: p.username || p.user_id.slice(0, 8),
          avatar: p.avatar_url || undefined,
          stack: p.result,
          cards: p.hole_cards?.length
            ? p.hole_cards.map((c) => (typeof c === 'string' ? c : `${c}`))
            : undefined,
          is_winner: p.is_winner,
        })),
        actions: record.actions.map((a, idx) => {
          const player = record.players.find((p) => p.user_id === a.player_id);
          return {
            player: player?.username || a.player_id.slice(0, 8),
            // Already `all_in` as stored; the old ternary tested a spelling
            // nothing produces and only worked by falling through.
            action: a.action as HandAction['action'],
            amount: a.amount,
            timestamp: idx,
          };
        }),
        played_at: record.played_at,
        winner: winnerPlayer?.username || undefined,
      };

      setHand(mapped);
    } catch (error) {
      if (getIsMounted && !getIsMounted()) return;
      reportError(error, 'HandReplayerPage.Failed_to_load_hand');
    }
    if (getIsMounted && !getIsMounted()) return;
    setLoading(false);
  };

  const togglePlay = () => {
    if (isPlaying) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      intervalRef.current = setInterval(() => {
        setCurrentStep((prev) => {
          if (hand && prev >= hand.actions.length - 1) {
            clearInterval(intervalRef.current!);
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 1500);
    }
  };

  const rewind = () => {
    setCurrentStep(0);
    setIsPlaying(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
  };

  const forward = () => {
    if (hand && currentStep < hand.actions.length - 1) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const parseCard = (cardStr: string): Card => {
    let rank = cardStr.slice(0, -1);
    const suit = cardStr.slice(-1) as Card['suit'];
    if (rank === '10') rank = 'T';
    return { rank: rank as Card['rank'], suit };
  };

  const shareUrl = `https://smarter.poker/hub/club-arena/share/hand/${handId}`;

  const heroPlayer = useMemo(() => {
    if (!hand) return null;
    return hand.players.find((p) => p.cards) || null;
  }, [hand]);

  const boardByStreet = useMemo(() => {
    if (!hand) return { flop: [], turn: [], river: [] };
    const flop = hand.community_cards.slice(0, 3);
    const turn = hand.community_cards.slice(0, 4);
    const river = hand.community_cards.slice(0, 5);
    return { flop, turn, river };
  }, [hand]);

  const currentBoard = useMemo(() => {
    if (!hand) return [];
    if (currentStep < 4) return [];
    if (currentStep < 6) return boardByStreet.flop;
    if (currentStep < 8) return boardByStreet.turn;
    return boardByStreet.river;
  }, [currentStep, boardByStreet, hand]);

  const actionSummary = useMemo(() => {
    if (!hand) return '';
    const actionCounts: Record<string, number> = {};
    hand.actions.forEach((a) => {
      actionCounts[a.action] = (actionCounts[a.action] || 0) + 1;
    });
    return Object.entries(actionCounts)
      .map(([action, count]) => `${count}x ${action}`)
      .join(', ');
  }, [hand]);

  const currentSnapshot = useMemo((): ReplaySnapshot | null => {
    if (!hand) return null;

    const currentBetAmounts: Record<string, number> = {};
    const foldedPlayers: Record<string, boolean> = {};
    let currentPot = 0;

    for (let i = 0; i <= currentStep; i++) {
      const a = hand.actions[i];
      if (!a) continue;
      if (a.action === 'fold') foldedPlayers[a.player] = true;
      if (a.amount) {
        currentBetAmounts[a.player] = a.amount;
        currentPot += a.amount;
      }
    }

    const isEndOfHand = currentStep === hand.actions.length - 1;

    return {
      stepIndex: currentStep,
      totalSteps: hand.actions.length,
      stage: currentStep < 4 ? 'preflop' : currentStep < 6 ? 'flop' : 'river',
      pot: hand.pot > 0 ? hand.pot : currentPot,
      communityCards: currentBoard,
      players: hand.players.map((p) => ({
        userId: p.name,
        username: p.name,
        stack: p.stack,
        bet: currentBetAmounts[p.name] || 0,
        cards: p.cards || ['??', '??'],
        isFolded: !!foldedPlayers[p.name],
        isAllIn: false,
        seat: p.seat,
        isWinner: p.is_winner,
      })),
      currentAction: hand.actions[currentStep]
        ? {
            type: 'action',
            playerId: hand.actions[currentStep].player,
            action: hand.actions[currentStep].action,
            amount: hand.actions[currentStep].amount,
          }
        : null,
      isPlaying,
      isEndOfHand,
    };
  }, [hand, currentStep, currentBoard, isPlaying]);

  if (loading) {
    return (
      <div className="hand-replayer loading">
        <div className="loader-spinner" />
        <p>Loading Hand Replay...</p>
      </div>
    );
  }

  if (!hand) {
    return (
      <div className="hand-replayer error">
        <h2>Hand Not Found</h2>
        <p>This Hand May Have Expired Or Been Removed.</p>
      </div>
    );
  }

  return (
    <>
      <div className="hand-replayer">
        <div className="replayer-bg" />

        <div className="replayer-header-controls">
          <button
            className="sound-toggle"
            onClick={() => setSoundEnabled(!soundEnabled)}
            aria-label={soundEnabled ? 'Turn Sound Off' : 'Turn Sound On'}
          >
            {soundEnabled ? 'ON' : 'OFF'}
          </button>
          <div className="view-toggle">
            <button
              className={`view-btn ${viewMode === '3d' ? 'active' : ''}`}
              onClick={() => setViewMode('3d')}
            >
              3D
            </button>
            <button
              className={`view-btn ${viewMode === '2d' ? 'active' : ''}`}
              onClick={() => setViewMode('2d')}
            >
              2D
            </button>
          </div>
        </div>

        <div className="replayer-tabs">
          <button
            className={`hand-replayer-page__tab-btn ${activeTab === 'replay' ? 'active' : ''}`}
            onClick={() => setActiveTab('replay')}
          >
            ▶ Replay
          </button>
          <button
            className={`hand-replayer-page__tab-btn ${activeTab === 'analysis' ? 'active' : ''}`}
            onClick={() => setActiveTab('analysis')}
          >
            Analysis
          </button>
        </div>

        {activeTab === 'replay' && (
          <>
            {viewMode === '3d' ? (
              <div
                className="replay-3d-container"
                style={{
                  position: 'relative',
                  width: '100%',
                  height: '500px',
                  marginBottom: '20px',
                }}
              >
                <HandReplay3D
                  active={true}
                  seatCount={hand.players.length || 6}
                  snapshot={currentSnapshot || undefined}
                  onSeatPositionsUpdate={(positions) => {
                    // Direct DOM manipulation to avoid 60FPS React state updates
                    Object.entries(positions).forEach(([seatStr, pos]) => {
                      const seatIdx = parseInt(seatStr, 10);
                      const el = overlayRefs.current[seatIdx];
                      if (el) {
                        el.style.left = `${pos.x}px`;
                        el.style.top = `${pos.y}px`;
                      }
                    });
                  }}
                />

                {/* Overlay Action Bubbles & Player Names */}
                {hand.players.map((p) => {
                  const actionAtStep =
                    hand.actions[currentStep]?.player === p.name ? hand.actions[currentStep] : null;

                  return (
                    <div
                      key={p.name}
                      ref={(el) => {
                        overlayRefs.current[p.seat] = el;
                      }}
                      style={{
                        position: 'absolute',
                        left: '-9999px', // Initial hidden state until first update
                        top: '-9999px',
                        transform: 'translate(-50%, -50%)',
                        pointerEvents: 'none',
                        textAlign: 'center',
                        textShadow: '0 2px 4px rgba(0,0,0,0.8)',
                        zIndex: 10,
                      }}
                    >
                      <div
                        style={{
                          background: 'rgba(0,0,0,0.6)',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          color: '#fff',
                          fontSize: '12px',
                        }}
                      >
                        {p.name}
                      </div>
                      {actionAtStep && (
                        <div
                          className="action-bubble"
                          style={{
                            marginTop: '4px',
                            animation: 'animationsFadeInUp 0.3s forwards',
                          }}
                        >
                          {actionAtStep.action.toUpperCase()}
                          {actionAtStep.amount ? ` ${actionAtStep.amount}` : ''}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="replay-table">
                <div className="table-felt">
                  <div className="table-center">
                    <div className="game-info">
                      <span className="game-type">{hand.game_type}</span>
                      <span className="stakes">{hand.stakes}</span>
                    </div>
                    <div className="pot-display">
                      <span className="pot-label">POT</span>
                      <span className="pot-amount">{hand.pot.toLocaleString()}</span>
                    </div>
                    <div className="community-cards">
                      {currentBoard.map((card, idx) => (
                        <div key={idx} className="card">
                          <CardImage card={parseCard(card)} size="sm" />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {hand.players.map((player, idx) => (
                  <div
                    key={player.seat}
                    className={`player-seat seat-${player.seat} ${player.is_winner ? 'winner' : ''}`}
                  >
                    <div className="player-avatar">{player.avatar || player.name.charAt(0)}</div>
                    <div className="player-info-pod">
                      <span className="player-name">{player.name}</span>
                      {player.stack !== undefined && (
                        <span className="player-stack">{player.stack.toLocaleString()}</span>
                      )}
                    </div>
                    {player.cards && (
                      <div className="player-cards">
                        {player.cards.map((card, cIdx) => (
                          <div key={cIdx} className="hole-card">
                            <CardImage card={parseCard(card)} size="xs" />
                          </div>
                        ))}
                      </div>
                    )}
                    {hand.actions[currentStep]?.player === player.name && (
                      <div className="action-bubble">
                        {(hand.actions[currentStep]?.action || '').toUpperCase()}
                        {hand.actions[currentStep].amount && ` ${hand.actions[currentStep].amount}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="playback-controls">
              <button className="ctrl-btn" onClick={rewind}>
                ⏮
              </button>
              <button className="ctrl-btn play" onClick={togglePlay}>
                {isPlaying ? '▮▮' : '▶'}
              </button>
              <button className="ctrl-btn" onClick={forward}>
                ⏭
              </button>
            </div>

            <div className="action-timeline-container">
              <input
                type="range"
                className="timeline-scrubber"
                min={0}
                max={hand.actions.length - 1}
                value={currentStep}
                onChange={(e) => {
                  setCurrentStep(Number(e.target.value));
                  if (isPlaying) {
                    setIsPlaying(false);
                    if (intervalRef.current) clearInterval(intervalRef.current);
                  }
                }}
              />
              <div className="action-timeline-ticks">
                {hand.actions.map((action, idx) => (
                  <div
                    key={idx}
                    className={`timeline-step ${idx <= currentStep ? 'active' : ''}`}
                    onClick={() => {
                      setCurrentStep(idx);
                      if (isPlaying) {
                        setIsPlaying(false);
                        if (intervalRef.current) clearInterval(intervalRef.current);
                      }
                    }}
                    title={`${action.player}: ${action.action} ${action.amount || ''}`}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {activeTab === 'analysis' && hand && (
          <div className="analysis-container">
            <div className="analysis-grid">
              {heroPlayer && (
                <>
                  <div className="analysis-panel">
                    <PositionAnalysis
                      position="BTN"
                      totalSeats={hand.players.length}
                      seatIndex={heroPlayer.seat}
                      dealerSeat={0}
                    />
                  </div>
                  <div className="analysis-panel">
                    <OddsDisplay
                      holeCards={heroPlayer.cards || []}
                      boardCards={currentBoard}
                      potSize={hand.pot}
                      isHero={true}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="analysis-highlight">
              <ShareableHighlight
                handId={hand.id}
                playerName={heroPlayer?.name || 'Hero'}
                playerCards={heroPlayer?.cards || []}
                boardCards={hand.community_cards}
                potSize={hand.pot}
                result={heroPlayer?.is_winner ? 'win' : 'loss'}
                actionSummary={actionSummary}
                playedAt={hand.played_at}
              />
            </div>
          </div>
        )}

        <button
          className="share-btn"
          onClick={() => {
            void (async () => {
              try {
                if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
                  await navigator.share({ url: shareUrl, title: 'Check Out This Hand!' });
                  return;
                }
                await navigator.clipboard.writeText(shareUrl);
                setShareLabel('Link copied');
                setTimeout(() => setShareLabel('Share'), 2000);
              } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') return;
                setShareLabel('Copy failed');
                setTimeout(() => setShareLabel('Share'), 2000);
              }
            })();
          }}
        >
          {shareLabel}
        </button>

        <div className="replayer-branding">
          <span>♠ Club Arena</span>
        </div>
      </div>
    </>
  );
}
