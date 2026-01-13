/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⏸️ TOURNAMENT BREAK SCREEN — Break Timer Overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Full-screen overlay during tournament breaks:
 * - Countdown timer
 * - Current standings
 * - Badge level info
 * - Average stack display
 */

import React, { useState, useEffect, useMemo } from 'react';
import './TournamentBreakScreen.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TournamentPlayer {
    playerId: string;
    playerName: string;
    avatar?: string;
    stack: number;
    rank: number;
    isCurrentUser?: boolean;
}

export interface BlindLevel {
    level: number;
    smallBlind: number;
    bigBlind: number;
    ante?: number;
    duration: number; // minutes
}

export interface TournamentBreakScreenProps {
    isVisible: boolean;
    breakTimeRemaining: number; // seconds
    tournamentName: string;
    currentLevel: number;
    nextLevel: BlindLevel;
    playersRemaining: number;
    totalPlayers: number;
    averageStack: number;
    topPlayers: TournamentPlayer[];
    myPlayer?: TournamentPlayer;
    prizePool: number;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatStack(amount: number): string {
    if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `${(amount / 1000).toFixed(0)}K`;
    return amount.toLocaleString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TournamentBreakScreen({
    isVisible,
    breakTimeRemaining,
    tournamentName,
    currentLevel,
    nextLevel,
    playersRemaining,
    totalPlayers,
    averageStack,
    topPlayers,
    myPlayer,
    prizePool,
    currency = '',
}: TournamentBreakScreenProps) {
    const [displayTime, setDisplayTime] = useState(breakTimeRemaining);

    // Update countdown
    useEffect(() => {
        setDisplayTime(breakTimeRemaining);
    }, [breakTimeRemaining]);

    useEffect(() => {
        if (!isVisible || displayTime <= 0) return;

        const timer = setInterval(() => {
            setDisplayTime((t) => Math.max(0, t - 1));
        }, 1000);

        return () => clearInterval(timer);
    }, [isVisible, displayTime]);

    // Progress to next level
    const progressPercent = useMemo(() => {
        return Math.max(0, displayTime / (nextLevel.duration * 60)) * 100;
    }, [displayTime, nextLevel.duration]);

    if (!isVisible) return null;

    return (
        <div className="break-screen">
            <div className="break-screen__content">
                {/* Header */}
                <div className="break-screen__header">
                    <span className="break-screen__badge">⏸️ BREAK</span>
                    <h1 className="break-screen__title">{tournamentName}</h1>
                </div>

                {/* Timer */}
                <div className="break-screen__timer-container">
                    <div className="break-screen__timer-ring">
                        <svg viewBox="0 0 100 100">
                            <circle className="break-screen__ring-bg" cx="50" cy="50" r="45" />
                            <circle
                                className="break-screen__ring-fill"
                                cx="50"
                                cy="50"
                                r="45"
                                strokeDasharray={`${progressPercent * 2.83} 283`}
                            />
                        </svg>
                        <div className="break-screen__timer-text">
                            <span className="break-screen__time">{formatTime(displayTime)}</span>
                            <span className="break-screen__time-label">until next level</span>
                        </div>
                    </div>
                </div>

                {/* Next Level Info */}
                <div className="break-screen__next-level">
                    <span className="break-screen__section-title">Next Level: {nextLevel.level}</span>
                    <div className="break-screen__blinds">
                        <span className="break-screen__blind-value">
                            {formatStack(nextLevel.smallBlind)}/{formatStack(nextLevel.bigBlind)}
                        </span>
                        {nextLevel.ante && nextLevel.ante > 0 && (
                            <span className="break-screen__ante">Ante: {formatStack(nextLevel.ante)}</span>
                        )}
                    </div>
                </div>

                {/* Stats Grid */}
                <div className="break-screen__stats">
                    <div className="break-screen__stat">
                        <span className="break-screen__stat-value">{playersRemaining}</span>
                        <span className="break-screen__stat-label">Players Left</span>
                        <span className="break-screen__stat-sub">of {totalPlayers}</span>
                    </div>
                    <div className="break-screen__stat">
                        <span className="break-screen__stat-value">{formatStack(averageStack)}</span>
                        <span className="break-screen__stat-label">Average Stack</span>
                        <span className="break-screen__stat-sub">{Math.round(averageStack / nextLevel.bigBlind)} BB</span>
                    </div>
                    <div className="break-screen__stat">
                        <span className="break-screen__stat-value">{currency}{formatStack(prizePool)}</span>
                        <span className="break-screen__stat-label">Prize Pool</span>
                    </div>
                </div>

                {/* My Position */}
                {myPlayer && (
                    <div className="break-screen__my-position">
                        <span className="break-screen__section-title">Your Position</span>
                        <div className="break-screen__my-info">
                            <div className="break-screen__my-rank">
                                <span className="break-screen__rank-number">#{myPlayer.rank}</span>
                                <span className="break-screen__rank-of">of {playersRemaining}</span>
                            </div>
                            <div className="break-screen__my-stack">
                                <span className="break-screen__stack-value">{formatStack(myPlayer.stack)}</span>
                                <span className="break-screen__stack-bb">{Math.round(myPlayer.stack / nextLevel.bigBlind)} BB</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Leaders */}
                <div className="break-screen__leaders">
                    <span className="break-screen__section-title">Chip Leaders</span>
                    <div className="break-screen__leader-list">
                        {topPlayers.slice(0, 5).map((player) => (
                            <div
                                key={player.playerId}
                                className={`break-screen__leader ${player.isCurrentUser ? 'break-screen__leader--me' : ''}`}
                            >
                                <span className="break-screen__leader-rank">#{player.rank}</span>
                                <span className="break-screen__leader-name">{player.playerName}</span>
                                <span className="break-screen__leader-stack">{formatStack(player.stack)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default TournamentBreakScreen;
