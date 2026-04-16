/**
 * ♠ CLUB ARENA — Hand Replayer Page
 * premium-style shareable hand replay with social meta tags
 * URL: /share/hand/:handId
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { handHistoryService } from '../../services/HandHistoryService';
import { PositionAnalysis, OddsDisplay, ShareableHighlight } from '../../components/hand-replayer';
import { CardImage } from '../../components/table/CardImage';
import type { Card } from '../../components/table/CardImage';
import './HandReplayerPage.css';
import { reportError } from '../../utils/errorReporter';

const playerSeatAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(10px)',
  animation: `fadeInUp 0.5s ease-out ${index * 70}ms forwards`,
});

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
  const [currentStep, setCurrentStep] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [showAnalysis, setShowAnalysis] = useState(true);
  const [activeTab, setActiveTab] = useState<'replay' | 'analysis'>('replay');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Set document title for this page
  useEffect(() => {
    document.title = 'Hand Replay | Club Arena';
    // Note: OG meta tags should be set server-side for proper social sharing
  }, [hand]);

  const loadHand = async (getIsMounted?: () => boolean) => {
    try {
      const record = await handHistoryService.getHand(handId!);

      if (getIsMounted && !getIsMounted()) return;

      if (!record) {
        setHand(null);
        return;
      }

      // Map HandRecord → HandData for the replayer UI
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
            action: a.action === 'all-in' ? 'all_in' : (a.action as HandAction['action']),
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

  // Find hero player (first player with cards visible)
  const heroPlayer = useMemo(() => {
    if (!hand) return null;
    return hand.players.find((p) => p.cards) || null;
  }, [hand]);

  // Get boards at different streets for odds display
  const boardByStreet = useMemo(() => {
    if (!hand) return { flop: [], turn: [], river: [] };
    const flop = hand.community_cards.slice(0, 3);
    const turn = hand.community_cards.slice(0, 4);
    const river = hand.community_cards.slice(0, 5);
    return { flop, turn, river };
  }, [hand]);

  // Get current board for odds display
  const currentBoard = useMemo(() => {
    if (!hand) return [];
    if (currentStep < 4) return boardByStreet.flop;
    if (currentStep < 6) return boardByStreet.turn;
    return boardByStreet.river;
  }, [currentStep, boardByStreet, hand]);

  // Determine action summary for shareable highlight
  const actionSummary = useMemo(() => {
    if (!hand) return '';
    const actionCounts: Record<string, number> = {};
    hand.actions.forEach((a) => {
      actionCounts[a.action] = (actionCounts[a.action] || 0) + 1;
    });
    const actions = Object.entries(actionCounts)
      .map(([action, count]) => `${count}x ${action}`)
      .join(', ');
    return actions;
  }, [hand]);

  if (loading) {
    return (
      <div className="hand-replayer loading">
        <div className="loader-spinner" />
        <p>Loading hand replay...</p>
      </div>
    );
  }

  if (!hand) {
    return (
      <div className="hand-replayer error">
        <h2>Hand Not Found</h2>
        <p>This hand may have expired or been removed.</p>
      </div>
    );
  }

  return (
    <>
      <div className="hand-replayer">
        {/* Background pattern */}
        <div className="replayer-bg" />

        {/* Sound toggle */}
        <button className="sound-toggle" onClick={() => setSoundEnabled(!soundEnabled)}>
          {soundEnabled ? 'ON' : 'OFF'}
        </button>

        {/* Tab navigation */}
        <div className="replayer-tabs">
          <button
            className={`tab-btn ${activeTab === 'replay' ? 'active' : ''}`}
            onClick={() => setActiveTab('replay')}
          >
            ▶ Replay
          </button>
          <button
            className={`tab-btn ${activeTab === 'analysis' ? 'active' : ''}`}
            onClick={() => setActiveTab('analysis')}
          >
            Analysis
          </button>
        </div>

        {/* Replay view */}
        {activeTab === 'replay' && (
          <>
            {/* Table */}
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
                  {/* Community cards */}
                  <div className="community-cards">
                    {hand.community_cards.map((card, idx) => (
                      <div key={idx} className="card">
                        <CardImage card={parseCard(card)} deckStyle="4color" size="sm" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Player seats */}
              {hand.players.map((player, idx) => (
                <div
                  key={player.seat}
                  style={playerSeatAnimationStyle(idx)}
                  className={`player-seat seat-${player.seat} ${player.is_winner ? 'winner' : ''}`}
                >
                  <div className="player-avatar">{player.avatar || player.name.charAt(0)}</div>
                  <div className="player-info-pod">
                    <span className="player-name">{player.name}</span>
                    <span className="player-stack">{player.stack.toLocaleString()}</span>
                  </div>
                  {player.cards && (
                    <div className="player-cards">
                      {player.cards.map((card, cIdx) => (
                        <div key={cIdx} className="hole-card">
                          <CardImage card={parseCard(card)} deckStyle="4color" size="xs" />
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Action bubble for current step */}
                  {hand.actions[currentStep]?.player === player.name && (
                    <div className="action-bubble">
                      {(hand.actions[currentStep]?.action || '').toUpperCase()}
                      {hand.actions[currentStep].amount && ` ${hand.actions[currentStep].amount}`}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Playback controls */}
            <div className="playback-controls">
              <button className="ctrl-btn" onClick={rewind}>
                ⏮
              </button>
              <button className="ctrl-btn play" onClick={togglePlay}>
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button className="ctrl-btn" onClick={forward}>
                ⏭
              </button>
            </div>

            {/* Action timeline */}
            <div className="action-timeline">
              {hand.actions.map((action, idx) => (
                <div key={idx} className={`timeline-step ${idx <= currentStep ? 'active' : ''}`} />
              ))}
            </div>
          </>
        )}

        {/* Analysis view */}
        {activeTab === 'analysis' && hand && (
          <div className="analysis-container">
            {/* Position and odds panels */}
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

            {/* Shareable highlight */}
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

        {/* Share button */}
        <button
          className="share-btn"
          onClick={() => navigator.share?.({ url: shareUrl, title: 'Check out this hand!' })}
        >
          📤 Share
        </button>

        {/* Club Arena branding */}
        <div className="replayer-branding">
          <span>♠ Club Arena</span>
        </div>
      </div>
    </>
  );
}
