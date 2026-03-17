/**
 * TableMiniView — Live game thumbnail for Club Arena lobby cards
 * Ported from Hub's TableMiniView.jsx → CA TSX
 *
 * Shows a miniature poker table with:
 *  - Seat positions with player dots (color-coded by state)
 *  - Community cards with deal animations
 *  - Pot display with chip stack SVGs
 *  - Phase labels (PRE-FLOP, FLOP, etc.)
 *  - Winner flash, chat bubbles, emoji reactions
 *  - Theme switching (Green, Blue, Red, Purple)
 *  - Timer ring for active player
 */

import React, { useState } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';

// Card helpers
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUIT_CHARS = ['♣', '♦', '♥', '♠'];
const SUIT_COLORS = ['#B0B3B8', '#E74C3C', '#E74C3C', '#B0B3B8'];

function cardRank(c: number) {
  return RANKS[Math.floor(c / 4)] || '?';
}
function cardSuitChar(c: number) {
  return SUIT_CHARS[c % 4];
}
function cardColor(c: number) {
  return SUIT_COLORS[c % 4];
}

const PHASE_LABELS: Record<string, string> = {
  dealing: 'DEALING',
  preflop: 'PRE-FLOP',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
  showdown: 'SHOWDOWN',
};

const SEAT_POSITIONS: Record<number, [number, number][]> = {
  9: [
    [50, 95],
    [15, 82],
    [5, 55],
    [10, 25],
    [30, 8],
    [50, 2],
    [70, 8],
    [90, 25],
    [95, 55],
  ],
  6: [
    [50, 95],
    [10, 70],
    [10, 25],
    [50, 2],
    [90, 25],
    [90, 70],
  ],
  2: [
    [50, 95],
    [50, 2],
  ],
};

function getSeatPositions(maxSeats: number): [number, number][] {
  const clamped = Math.max(2, Math.min(9, maxSeats));
  return SEAT_POSITIONS[clamped] || SEAT_POSITIONS[9];
}

function fmtPot(n: number) {
  if (!n || n <= 0) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

let _kfInjected = false;
function ensureKeyframes() {
  if (_kfInjected || typeof document === 'undefined') return;
  _kfInjected = true;
  const s = document.createElement('style');
  s.id = 'mini-view-keyframes';
  s.textContent = `
    @keyframes miniActorPulse { 0%,100%{box-shadow:0 0 0 0 rgba(255,215,0,0.6);} 50%{box-shadow:0 0 0 4px rgba(255,215,0,0.15);} }
    @keyframes miniShimmer { 0%{background-position:-100% 0;} 100%{background-position:200% 0;} }
    @keyframes miniCardDeal { from{opacity:0;transform:scale(0.5) translateY(-5px);} to{opacity:1;transform:scale(1) translateY(0);} }
    @keyframes miniCardFlip { 0%{transform:rotateY(180deg) scale(0.6);opacity:0;} 50%{transform:rotateY(90deg) scale(0.9);opacity:0.7;} 100%{transform:rotateY(0deg) scale(1);opacity:1;} }
    @keyframes miniWinnerFlash { 0%{opacity:0;transform:translate(-50%,-50%) scale(0.5);} 15%{opacity:1;transform:translate(-50%,-50%) scale(1.1);} 85%{opacity:1;transform:translate(-50%,-50%) scale(1);} 100%{opacity:0;transform:translate(-50%,-50%) scale(0.8);} }
  `;
  document.head.appendChild(s);
}

const THEMES = [
  { id: 'green', bg: 'radial-gradient(ellipse, #1a3a1a 30%, #0d1f0d 100%)' },
  { id: 'blue', bg: 'radial-gradient(ellipse, #0a2a4a 30%, #051525 100%)' },
  { id: 'red', bg: 'radial-gradient(ellipse, #4a1515 30%, #250a0a 100%)' },
  { id: 'purple', bg: 'radial-gradient(ellipse, #3a1a4a 30%, #1f0d25 100%)' },
];

interface SeatData {
  occupied?: boolean;
  isActor?: boolean;
  isFolded?: boolean;
  isDealer?: boolean;
  isAllIn?: boolean;
  displayName?: string;
  stack?: number;
  seatIndex?: number;
  avatarUrl?: string;
}

interface MiniState {
  phase?: string;
  communityCards?: number[];
  boards?: number[][];
  potTotal?: number;
  seats?: SeatData[];
  handNumber?: number;
  lastHandResult?: { winnerName: string; amount: number; timestamp: number } | null;
  _fetchedAt?: number;
  [key: string]: any;
}

interface TableMiniViewProps {
  miniState?: MiniState | null;
  maxSeats?: number;
  blinds?: string;
  variant?: string;
  accentColor?: string;
}

export default function TableMiniView({
  miniState,
  maxSeats = 9,
  blinds,
  variant,
  accentColor,
}: TableMiniViewProps) {
  ensureKeyframes();
  const [themeIdx, setThemeIdx] = useState(0);

  useMasterBusSubscription('UI_THEME_CHANGED', (payload: any) => {
    if (payload?.key === 'miniViewTheme' && payload.value !== undefined) {
      setThemeIdx(payload.value);
    }
  });

  if (!miniState) {
    return (
      <div
        style={{
          width: '100%',
          height: 105,
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 8,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 6,
            left: '10%',
            width: '80%',
            height: 84,
            borderRadius: '50%',
            background: 'linear-gradient(90deg, #0d1f0d 25%, #1a3a1a 50%, #0d1f0d 75%)',
            backgroundSize: '200% 100%',
            animation: 'miniShimmer 1.5s ease-in-out infinite',
          }}
        />
      </div>
    );
  }

  const phase = miniState.phase || 'idle';
  const isIdle = phase === 'idle';
  const phaseLabel = PHASE_LABELS[phase] || null;
  const positions = getSeatPositions(maxSeats);
  const seats = miniState.seats || [];
  const potTotal = miniState.potTotal || 0;
  const lastHandResult = miniState.lastHandResult || null;
  const feltBorder = accentColor
    ? `2px solid ${accentColor}66`
    : '2px solid rgba(180, 150, 60, 0.5)';
  const currentTheme = THEMES[themeIdx];

  let boards: number[][] = [];
  if (miniState.boards && miniState.boards.length > 0) boards = miniState.boards;
  else if (miniState.communityCards && miniState.communityCards.length > 0)
    boards = [miniState.communityCards];

  return (
    <div
      style={{
        width: '100%',
        height: 105,
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 8,
        transition: 'opacity 0.5s ease',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: '10%',
          width: '80%',
          height: 84,
          borderRadius: '50%',
          background: currentTheme.bg,
          border: feltBorder,
          boxShadow: 'inset 0 2px 12px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.4)',
        }}
      >
        {/* Theme button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setThemeIdx((themeIdx + 1) % THEMES.length);
          }}
          style={{
            position: 'absolute',
            bottom: 4,
            left: 10,
            zIndex: 10,
            background: 'rgba(0,0,0,0.3)',
            border: 'none',
            borderRadius: '50%',
            width: 14,
            height: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: 8,
            padding: 0,
            opacity: 0.6,
          }}
        >
          🎨
        </button>

        {blinds && (
          <div
            style={{
              position: 'absolute',
              top: 2,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              gap: 3,
              alignItems: 'center',
              zIndex: 3,
              background: 'rgba(0,0,0,0.55)',
              borderRadius: 6,
              padding: '1px 5px',
            }}
          >
            {variant && (
              <span
                style={{
                  fontSize: 5,
                  fontWeight: 800,
                  color: 'rgba(255,255,255,0.45)',
                  textTransform: 'uppercase',
                }}
              >
                {variant}
              </span>
            )}
            <span
              style={{
                fontSize: 7,
                fontWeight: 800,
                color: 'rgba(255,255,255,0.8)',
                fontFamily: '"Orbitron",monospace',
              }}
            >
              {blinds}
            </span>
          </div>
        )}

        {/* Seats */}
        {positions.map((pos, idx) => {
          const seatData = seats[idx];
          if (!seatData) return null;
          const occupied = seatData.occupied;
          const isActor = seatData.isActor;
          const isAllIn = seatData.isAllIn;
          const isFolded = seatData.isFolded;
          const isDealer = seatData.isDealer;

          let dotStyle: React.CSSProperties = {
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.1)',
            position: 'relative',
          };
          if (isActor)
            dotStyle = {
              ...dotStyle,
              width: 10,
              height: 10,
              background: '#FFD700',
              border: '1.5px solid rgba(255,215,0,0.8)',
              animation: 'miniActorPulse 1.5s ease-in-out infinite',
            };
          else if (isAllIn)
            dotStyle = {
              ...dotStyle,
              width: 8,
              height: 8,
              background: '#E74C3C',
              border: '1px solid rgba(231,76,60,0.6)',
            };
          else if (isFolded)
            dotStyle = {
              ...dotStyle,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.06)',
            };
          else if (occupied)
            dotStyle = {
              ...dotStyle,
              width: 8,
              height: 8,
              background: '#2ECC71',
              border: '1px solid rgba(46,204,113,0.6)',
            };

          return (
            <div
              key={idx}
              style={{
                position: 'absolute',
                left: `${pos[0]}%`,
                top: `${pos[1]}%`,
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                zIndex: isActor ? 10 : 2,
              }}
            >
              <div style={dotStyle}>
                {isDealer && occupied && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -8,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      fontSize: 5,
                      fontWeight: 900,
                      color: '#000',
                      background: '#FFD700',
                      borderRadius: 3,
                      padding: '0 2px',
                      lineHeight: '8px',
                    }}
                  >
                    D
                  </span>
                )}
              </div>
              {occupied && (
                <div
                  style={{
                    width: 42,
                    height: 22,
                    marginTop: 4,
                    background: 'rgba(0,0,0,0.7)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 4,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      fontSize: 6,
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.9)',
                      textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      maxWidth: '90%',
                    }}
                  >
                    {seatData.displayName}
                  </span>
                  <span
                    style={{
                      fontSize: 8,
                      fontWeight: 800,
                      color: '#FFD700',
                      fontFamily: '"Orbitron",monospace',
                      marginTop: -1,
                    }}
                  >
                    {isAllIn ? 'All-In' : fmtPot(seatData.stack || 0)}
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {/* Center content */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            zIndex: 1,
            pointerEvents: 'none',
            width: '70%',
          }}
        >
          {isIdle ? (
            <span
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.35)',
                fontStyle: 'italic',
              }}
            >
              Waiting…
            </span>
          ) : (
            <>
              {phaseLabel && (
                <span
                  style={{
                    fontSize: 6,
                    fontWeight: 800,
                    color: 'rgba(255,215,0,0.7)',
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                    fontFamily: '"Orbitron",monospace',
                  }}
                >
                  {phaseLabel}
                </span>
              )}
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }}
              >
                {boards.map((board, bIdx) => (
                  <div
                    key={bIdx}
                    style={{
                      display: 'flex',
                      gap: 2,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {board.map((card, i) => (
                      <div
                        key={i}
                        style={{
                          width: 14,
                          height: 20,
                          borderRadius: 2,
                          background: 'rgba(255,255,255,0.92)',
                          border: '0.5px solid rgba(0,0,0,0.15)',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                          animation: 'miniCardDeal 0.3s ease-out both',
                          animationDelay: `${i * 0.05}s`,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 8,
                            fontWeight: 800,
                            lineHeight: 1,
                            fontFamily: '"Orbitron",monospace',
                            color: cardColor(card),
                          }}
                        >
                          {cardRank(card)}
                        </span>
                        <span
                          style={{
                            fontSize: 6,
                            lineHeight: 1,
                            marginTop: -1,
                            color: cardColor(card),
                          }}
                        >
                          {cardSuitChar(card)}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {potTotal > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 3,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 20 20" style={{ flexShrink: 0 }}>
                    <ellipse
                      cx="10"
                      cy="16"
                      rx="8"
                      ry="3"
                      fill="#C0392B"
                      stroke="#E74C3C"
                      strokeWidth="0.5"
                    />
                    <ellipse
                      cx="10"
                      cy="13"
                      rx="8"
                      ry="3"
                      fill="#27AE60"
                      stroke="#2ECC71"
                      strokeWidth="0.5"
                    />
                    <ellipse
                      cx="10"
                      cy="10"
                      rx="8"
                      ry="3"
                      fill="#2980B9"
                      stroke="#3498DB"
                      strokeWidth="0.5"
                    />
                    <ellipse
                      cx="10"
                      cy="7"
                      rx="8"
                      ry="3"
                      fill="#F39C12"
                      stroke="#F1C40F"
                      strokeWidth="0.5"
                    />
                  </svg>
                  <span
                    style={{
                      fontSize: 7,
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.7)',
                      fontFamily: '"Orbitron",monospace',
                    }}
                  >
                    {fmtPot(potTotal)}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Winner flash */}
        {lastHandResult && Date.now() - lastHandResult.timestamp < 5000 && (
          <div
            key={lastHandResult.timestamp}
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              background: 'rgba(0,0,0,0.85)',
              border: '1px solid rgba(255,215,0,0.5)',
              borderRadius: 8,
              padding: '3px 8px',
              zIndex: 20,
              pointerEvents: 'none',
              animation: 'miniWinnerFlash 4s ease-out forwards',
            }}
          >
            <span style={{ fontSize: 10 }}>🏆</span>
            <span
              style={{
                fontSize: 7,
                fontWeight: 800,
                color: '#FFD700',
                fontFamily: '"Orbitron",monospace',
                textTransform: 'uppercase',
              }}
            >
              {lastHandResult.winnerName}
            </span>
            <span
              style={{
                fontSize: 8,
                fontWeight: 900,
                color: '#39FF14',
                fontFamily: '"Orbitron",monospace',
              }}
            >
              +{fmtPot(lastHandResult.amount)}
            </span>
          </div>
        )}

        {miniState.handNumber != null && miniState.handNumber > 0 && !isIdle && (
          <div
            style={{
              position: 'absolute',
              bottom: 2,
              right: 8,
              fontSize: 5,
              fontWeight: 700,
              color: 'rgba(255,255,255,0.4)',
              fontFamily: 'monospace',
              zIndex: 15,
              background: 'rgba(0,0,0,0.5)',
              border: '0.5px solid rgba(255,255,255,0.2)',
              borderRadius: 3,
              padding: '1px 3px',
            }}
          >
            #{miniState.handNumber}
          </div>
        )}
      </div>
    </div>
  );
}
