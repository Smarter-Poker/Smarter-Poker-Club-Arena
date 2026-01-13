/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎬 HAND REPLAY PLAYER — Visual Hand Replay (PokerBros-Style)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Full visual hand replay with:
 * - Animated card dealing
 * - Action-by-action playback
 * - Play/pause/scrubber controls
 * - Speed control
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import './HandReplayPlayer.css';
import type { ShareableHand, ShareableCard, ShareableAction } from './ShareHand';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ReplayState = 'IDLE' | 'PLAYING' | 'PAUSED' | 'COMPLETE';
export type ReplaySpeed = 0.5 | 1 | 1.5 | 2;

interface ReplayStep {
    type: 'DEAL_HOLE' | 'POST_BLIND' | 'ACTION' | 'DEAL_FLOP' | 'DEAL_TURN' | 'DEAL_RIVER' | 'SHOWDOWN' | 'AWARD_POT';
    seat?: number;
    action?: ShareableAction;
    cards?: ShareableCard[];
    card?: ShareableCard;
    amount?: number;
    delay: number; // ms before next step
}

export interface HandReplayPlayerProps {
    hand: ShareableHand;
    autoPlay?: boolean;
    onComplete?: () => void;
    onShare?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUIT_SYMBOLS: Record<string, string> = {
    h: '♥',
    d: '♦',
    c: '♣',
    s: '♠',
};

const SUIT_COLORS: Record<string, string> = {
    h: '#F85149',
    d: '#1877F2',
    c: '#3FB950',
    s: '#E4E6EB',
};

function formatCard(card: ShareableCard): string {
    return `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

// Position labels for display
const POSITION_NAMES = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'MP+1', 'HJ', 'CO'];

// Generate replay steps from hand data
function generateReplaySteps(hand: ShareableHand): ReplayStep[] {
    const steps: ReplayStep[] = [];
    const baseDelay = 800;

    // Deal hole cards
    for (const player of hand.players) {
        if (player.cards) {
            steps.push({
                type: 'DEAL_HOLE',
                seat: player.seat,
                cards: player.cards,
                delay: 200,
            });
        }
    }
    steps.push({ type: 'DEAL_HOLE', delay: 500 }); // Pause after dealing

    // Preflop actions
    for (const action of hand.preflop) {
        steps.push({
            type: 'ACTION',
            seat: action.seat,
            action,
            delay: baseDelay,
        });
    }

    // Flop
    if (hand.flop) {
        steps.push({
            type: 'DEAL_FLOP',
            cards: hand.flop.cards,
            delay: 600,
        });
        for (const action of hand.flop.actions) {
            steps.push({
                type: 'ACTION',
                seat: action.seat,
                action,
                delay: baseDelay,
            });
        }
    }

    // Turn
    if (hand.turn) {
        steps.push({
            type: 'DEAL_TURN',
            card: hand.turn.card,
            delay: 600,
        });
        for (const action of hand.turn.actions) {
            steps.push({
                type: 'ACTION',
                seat: action.seat,
                action,
                delay: baseDelay,
            });
        }
    }

    // River
    if (hand.river) {
        steps.push({
            type: 'DEAL_RIVER',
            card: hand.river.card,
            delay: 600,
        });
        for (const action of hand.river.actions) {
            steps.push({
                type: 'ACTION',
                seat: action.seat,
                action,
                delay: baseDelay,
            });
        }
    }

    // Showdown
    const shownPlayers = hand.players.filter(p => p.cards && p.isWinner);
    if (shownPlayers.length > 0) {
        steps.push({
            type: 'SHOWDOWN',
            delay: 1000,
        });
    }

    // Award pot
    for (const winner of hand.winners) {
        steps.push({
            type: 'AWARD_POT',
            seat: winner.seat,
            amount: winner.amount,
            delay: 800,
        });
    }

    return steps;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function HandReplayPlayer({
    hand,
    autoPlay = true,
    onComplete,
    onShare,
}: HandReplayPlayerProps) {
    const [state, setState] = useState<ReplayState>('IDLE');
    const [currentStep, setCurrentStep] = useState(0);
    const [speed, setSpeed] = useState<ReplaySpeed>(1);
    const [showControls, setShowControls] = useState(true);

    // Current display state
    const [visibleCards, setVisibleCards] = useState<Record<number, ShareableCard[]>>({});
    const [board, setBoard] = useState<ShareableCard[]>([]);
    const [pot, setPot] = useState(0);
    const [activeAction, setActiveAction] = useState<{ seat: number; text: string } | null>(null);
    const [winningSeats, setWinningSeats] = useState<number[]>([]);

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Generate steps
    const steps = useMemo(() => generateReplaySteps(hand), [hand]);
    const progress = steps.length > 0 ? (currentStep / steps.length) * 100 : 0;

    // Execute a step
    const executeStep = useCallback((stepIndex: number) => {
        if (stepIndex >= steps.length) {
            setState('COMPLETE');
            onComplete?.();
            return;
        }

        const step = steps[stepIndex];

        switch (step.type) {
            case 'DEAL_HOLE':
                if (step.seat !== undefined && step.cards) {
                    setVisibleCards(prev => ({
                        ...prev,
                        [step.seat!]: step.cards!,
                    }));
                }
                break;

            case 'ACTION':
                if (step.action) {
                    const actionText = step.action.amount
                        ? `${step.action.action} $${step.action.amount}`
                        : step.action.action;
                    setActiveAction({ seat: step.seat!, text: actionText });
                    if (step.action.amount) {
                        setPot(prev => prev + step.action!.amount!);
                    }
                }
                break;

            case 'DEAL_FLOP':
                if (step.cards) {
                    setBoard(step.cards);
                    setActiveAction(null);
                }
                break;

            case 'DEAL_TURN':
                if (step.card) {
                    setBoard(prev => [...prev, step.card!]);
                    setActiveAction(null);
                }
                break;

            case 'DEAL_RIVER':
                if (step.card) {
                    setBoard(prev => [...prev, step.card!]);
                    setActiveAction(null);
                }
                break;

            case 'SHOWDOWN':
                setActiveAction(null);
                break;

            case 'AWARD_POT':
                if (step.seat !== undefined) {
                    setWinningSeats(prev => [...prev, step.seat!]);
                }
                break;
        }

        setCurrentStep(stepIndex + 1);
    }, [steps, onComplete]);

    // Play loop
    useEffect(() => {
        if (state !== 'PLAYING') return;
        if (currentStep >= steps.length) {
            setState('COMPLETE');
            return;
        }

        const step = steps[currentStep];
        const delay = step.delay / speed;

        timerRef.current = setTimeout(() => {
            executeStep(currentStep);
        }, delay);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [state, currentStep, speed, steps, executeStep]);

    // Auto-play on mount
    useEffect(() => {
        if (autoPlay && state === 'IDLE') {
            setState('PLAYING');
        }
    }, [autoPlay, state]);

    // Controls
    const handlePlayPause = useCallback(() => {
        if (state === 'PLAYING') {
            setState('PAUSED');
        } else if (state === 'PAUSED' || state === 'COMPLETE') {
            if (state === 'COMPLETE') {
                // Reset
                setCurrentStep(0);
                setVisibleCards({});
                setBoard([]);
                setPot(0);
                setActiveAction(null);
                setWinningSeats([]);
            }
            setState('PLAYING');
        } else {
            setState('PLAYING');
        }
    }, [state]);

    const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const targetStep = Math.floor((parseInt(e.target.value) / 100) * steps.length);
        setCurrentStep(targetStep);
        // Re-execute up to this step
        // For simplicity, just jump (full implementation would re-simulate)
    }, [steps.length]);

    // Hide controls after delay
    useEffect(() => {
        if (state === 'PLAYING') {
            const timer = setTimeout(() => setShowControls(false), 3000);
            return () => clearTimeout(timer);
        } else {
            setShowControls(true);
        }
    }, [state, currentStep]);

    return (
        <div
            className="replay-player"
            onMouseMove={() => setShowControls(true)}
            onClick={handlePlayPause}
        >
            {/* Table Background */}
            <div className="replay-player__table">
                {/* Players */}
                <div className="replay-player__seats">
                    {hand.players.map((player, idx) => {
                        const angle = (idx / hand.players.length) * 360 - 90;
                        const isActive = activeAction?.seat === player.seat;
                        const isWinner = winningSeats.includes(player.seat);
                        const cards = visibleCards[player.seat];

                        return (
                            <div
                                key={player.seat}
                                className={`replay-player__seat ${isActive ? 'replay-player__seat--active' : ''} ${isWinner ? 'replay-player__seat--winner' : ''}`}
                                style={{
                                    '--angle': `${angle}deg`,
                                } as React.CSSProperties}
                            >
                                <div className="replay-player__player-info">
                                    <span className="replay-player__name">{player.name}</span>
                                    <span className="replay-player__stack">${player.stack.toLocaleString()}</span>
                                </div>

                                {/* Hole Cards */}
                                {cards && (
                                    <div className="replay-player__hole-cards">
                                        {cards.map((card, ci) => (
                                            <span
                                                key={ci}
                                                className="replay-player__card"
                                                style={{ color: SUIT_COLORS[card.suit] }}
                                            >
                                                {formatCard(card)}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                {/* Action Chip */}
                                {isActive && activeAction && (
                                    <div className="replay-player__action-chip">
                                        {activeAction.text}
                                    </div>
                                )}

                                {/* Winner Badge */}
                                {isWinner && (
                                    <div className="replay-player__winner-badge">🏆</div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Board */}
                <div className="replay-player__board">
                    {board.map((card, idx) => (
                        <span
                            key={idx}
                            className="replay-player__board-card"
                            style={{ color: SUIT_COLORS[card.suit] }}
                        >
                            {formatCard(card)}
                        </span>
                    ))}
                </div>

                {/* Pot */}
                {pot > 0 && (
                    <div className="replay-player__pot">
                        Pot: ${pot.toLocaleString()}
                    </div>
                )}
            </div>

            {/* Controls Overlay */}
            <div className={`replay-player__controls ${showControls ? 'replay-player__controls--visible' : ''}`} onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="replay-player__header">
                    <span className="replay-player__game-info">
                        {hand.variant} {hand.stakes}
                    </span>
                    {onShare && (
                        <button className="replay-player__share-btn" onClick={onShare}>
                            🔗 Share
                        </button>
                    )}
                </div>

                {/* Bottom Controls */}
                <div className="replay-player__bottom">
                    <button className="replay-player__play-btn" onClick={handlePlayPause}>
                        {state === 'PLAYING' ? '⏸' : state === 'COMPLETE' ? '⟳' : '▶'}
                    </button>

                    <input
                        type="range"
                        className="replay-player__scrubber"
                        min={0}
                        max={100}
                        value={progress}
                        onChange={handleSeek}
                    />

                    <div className="replay-player__speed">
                        {[0.5, 1, 1.5, 2].map((s) => (
                            <button
                                key={s}
                                className={`replay-player__speed-btn ${speed === s ? 'replay-player__speed-btn--active' : ''}`}
                                onClick={() => setSpeed(s as ReplaySpeed)}
                            >
                                {s}x
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default HandReplayPlayer;
