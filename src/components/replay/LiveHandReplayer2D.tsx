import React, { useState, useEffect, useRef, useMemo } from 'react';
import { CardImage } from '../table/CardImage';
import './LiveHandReplayer2D.css';

// Reusing types from HandReplay.tsx
import type { HandData, PlayerAction } from './HandReplay';
import type { Card } from '../../types/database.types';

export interface LiveHandReplayer2DProps {
  handData: HandData;
  currentStep: number;
  totalSteps: number;
}

export function LiveHandReplayer2D({ handData, currentStep, totalSteps }: LiveHandReplayer2DProps) {
  // Pre-calculate timeline states
  const { timeline, seatPositions } = useMemo(() => {
    const is9Max = handData.players.length > 6;
    const maxSeats = is9Max ? 9 : 6;
    // but HandReplay3D had seat mapping. Let's just use simple fixed % based coords for simplicity
    const positions =
      maxSeats === 9
        ? [
            { seatX: 50, seatY: 90, betX: 50, betY: 70 },
            { seatX: 20, seatY: 85, betX: 30, betY: 65 },
            { seatX: 5, seatY: 50, betX: 20, betY: 50 },
            { seatX: 20, seatY: 15, betX: 30, betY: 35 },
            { seatX: 50, seatY: 10, betX: 50, betY: 30 },
            { seatX: 80, seatY: 15, betX: 70, betY: 35 },
            { seatX: 95, seatY: 50, betX: 80, betY: 50 },
            { seatX: 80, seatY: 85, betX: 70, betY: 65 },
            { seatX: 50, seatY: 90, betX: 50, betY: 70 }, // duplicate 9th for simple mapping if needed
          ]
        : [
            { seatX: 50, seatY: 90, betX: 50, betY: 70 },
            { seatX: 10, seatY: 65, betX: 25, betY: 55 },
            { seatX: 10, seatY: 25, betX: 25, betY: 35 },
            { seatX: 50, seatY: 10, betX: 50, betY: 30 },
            { seatX: 90, seatY: 25, betX: 75, betY: 35 },
            { seatX: 90, seatY: 65, betX: 75, betY: 55 },
          ];

    // Build a timeline of states for each step
    const tl = [];

    // Step 1: Preflop (Everyone has cards, no board, no bets yet)
    let currentPot = 0;
    let currentBoard: Card[] = [];
    let currentStreet = 'preflop';
    const playerStates = new Map<string, { folded: boolean; bet: number }>();

    handData.players.forEach((p) => {
      playerStates.set(p.user_id, { folded: false, bet: 0 });
    });

    tl.push({
      street: currentStreet,
      board: [],
      pot: 0,
      playerStates: new Map(playerStates),
      actionDesc: 'Preflop Dealt',
      lastActionPlayerId: null,
      lastActionType: null,
      lastActionAmount: null,
    });

    // Process actions
    let actionIdx = 0;
    while (actionIdx < handData.actions.length) {
      const a = handData.actions[actionIdx];

      // If we crossed a street boundary in the action log (or we infer it)
      if (a.street && a.street !== currentStreet && a.street !== 'pineapple_discard') {
        // Gather pots
        playerStates.forEach((ps) => {
          currentPot += ps.bet;
          ps.bet = 0;
        });
        currentStreet = a.street;

        if (currentStreet === 'flop') currentBoard = handData.community_cards.slice(0, 3);
        else if (currentStreet === 'turn') currentBoard = handData.community_cards.slice(0, 4);
        else if (currentStreet === 'river') currentBoard = handData.community_cards.slice(0, 5);

        tl.push({
          street: currentStreet,
          board: [...currentBoard],
          pot: currentPot,
          playerStates: new Map(playerStates),
          actionDesc: `${currentStreet.toUpperCase()} Dealt`,
          lastActionPlayerId: null,
          lastActionType: null,
          lastActionAmount: null,
        });
      }

      // Apply action
      const ps = playerStates.get(a.player_id);
      let desc = `${handData.players.find((p) => p.user_id === a.player_id)?.username} ${a.action}`;
      if (ps) {
        if (a.action === 'fold') {
          ps.folded = true;
        } else if (a.amount) {
          ps.bet += a.amount;
          desc += ` ${a.amount}`;
        }
      }

      tl.push({
        street: currentStreet,
        board: [...currentBoard],
        pot: currentPot,
        playerStates: new Map(playerStates),
        actionDesc: desc,
        lastActionPlayerId: a.player_id,
        lastActionType: a.action,
        lastActionAmount: a.amount,
      });

      actionIdx++;
    }

    // Final step: Showdown
    playerStates.forEach((ps) => {
      currentPot += ps.bet;
      ps.bet = 0;
    });
    tl.push({
      street: 'showdown',
      board: handData.community_cards,
      pot: currentPot,
      playerStates: new Map(playerStates),
      actionDesc: 'Showdown',
      lastActionPlayerId: null,
      lastActionType: null,
      lastActionAmount: null,
    });

    return { timeline: tl, seatPositions: positions };
  }, [handData]);

  const currentState = timeline[Math.min(currentStep - 1, timeline.length - 1)];

  if (!currentState) return null;

  return (
    <div className="replayer-2d-container">
      <div className="replayer-table-scale-wrapper">
        <div className="replayer-table-felt">
          {/* Board */}
          <div className="replayer-board">
            {currentState.board.map((c, i) => (
              <div key={i} className="replayer-card">
                <CardImage
                  card={{
                    rank: String(c.rank) === '10' ? 'T' : (c.rank as any),
                    suit: c.suit.charAt(0) as any,
                  }}
                  size="sm"
                />
              </div>
            ))}
          </div>

          {/* Pot */}
          <div className="replayer-pot">
            <div className="replayer-pot-pill">
              <span className="replayer-pot-label">POT</span>
              <span className="replayer-pot-amount">{currentState.pot.toLocaleString()}</span>
            </div>
          </div>

          {/* Seats */}
          {handData.players.map((p, i) => {
            const pos = seatPositions[i % seatPositions.length];
            const pState = currentState.playerStates.get(p.user_id);
            const isFolded = pState?.folded;
            const betAmount = pState?.bet || 0;

            return (
              <div
                key={p.user_id}
                className={`replayer-seat ${isFolded ? 'folded' : ''}`}
                style={{ left: `${pos.seatX}%`, top: `${pos.seatY}%` }}
              >
                <div className="replayer-avatar">
                  {p.avatar_url ? (
                    <img src={p.avatar_url} alt="" className="replayer-avatar-img" />
                  ) : (
                    <div className="replayer-avatar-bg" />
                  )}
                  {/* Position Badge */}
                  <div className="replayer-pos-badge">{p.position}</div>
                  {/* Dealer Button */}
                  {p.position === 'BTN' && <div className="replayer-dealer-btn">D</div>}
                </div>

                {/* Action Bubble */}
                {currentState.lastActionPlayerId === p.user_id && currentState.lastActionType && (
                  <div className="replayer-action-bubble">
                    {currentState.lastActionType.toUpperCase()}{' '}
                    {currentState.lastActionAmount ? currentState.lastActionAmount : ''}
                  </div>
                )}

                {/* ALL IN Badge (simulated for showdown or if they went all in) */}
                {currentState.street === 'showdown' && !isFolded && (
                  <div className="replayer-seat-allin-badge">ALL IN</div>
                )}

                <div className="replayer-seat-info">
                  <div className="replayer-seat-name">{p.username}</div>
                  <div className="replayer-seat-stack">
                    {p.result > 0 ? '+' : ''}
                    {p.result}
                  </div>
                </div>

                {/* Equity Percentage under the avatar */}
                {currentState.street === 'showdown' && !isFolded && (
                  <div className={`replayer-seat-equity ${p.result > 0 ? 'winning' : ''}`}>
                    {p.result > 0 ? '100%' : '0%'}
                  </div>
                )}

                {/* Hole Cards (moved up via CSS to avoid covering bottom UI) */}
                {!isFolded && (
                  <div className="replayer-hole-cards">
                    {p.hole_cards.length > 0 ? (
                      p.hole_cards.map((c, ci) => (
                        <div key={ci} className="replayer-card">
                          <CardImage
                            card={{
                              rank: String(c.rank) === '10' ? 'T' : (c.rank as any),
                              suit: c.suit.charAt(0) as any,
                            }}
                            size="xs"
                          />
                        </div>
                      ))
                    ) : (
                      <>
                        <div className="replayer-card back" />
                        <div className="replayer-card back" />
                      </>
                    )}
                  </div>
                )}

                {/* Bet */}
                {betAmount > 0 && (
                  <div
                    className="replayer-bet"
                    style={{ left: `${pos.betX - pos.seatX}%`, top: `${pos.betY - pos.seatY}%` }}
                  >
                    <div className="replayer-bet-chip" />
                    {betAmount.toLocaleString()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="replayer-action-desc">{currentState.actionDesc}</div>
    </div>
  );
}
