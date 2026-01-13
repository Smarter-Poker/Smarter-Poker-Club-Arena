/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🏆 TOURNAMENT LIST — Scheduled Tournaments Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium tournament lobby list with:
 * - Start time countdown
 * - Registration status
 * - Prize pool display
 * - Structure info
 */

import React, { useState, useMemo, useEffect } from 'react';
import './TournamentList.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type TournamentStatus = 'SCHEDULED' | 'REGISTERING' | 'LATE_REG' | 'RUNNING' | 'BREAK' | 'FINAL_TABLE' | 'COMPLETED' | 'CANCELLED';
export type TournamentType = 'MTT' | 'SNG' | 'SATELLITE' | 'FREEROLL';

export interface Tournament {
    id: string;
    name: string;
    type: TournamentType;
    variant: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6';
    buyIn: number;
    fee: number;
    prizePool: number;
    guaranteed: number;
    startTime: Date;
    lateRegEndTime?: Date;
    status: TournamentStatus;
    registeredPlayers: number;
    maxPlayers: number;
    minPlayers: number;
    startingStack: number;
    blindLevelMinutes: number;
    isRebuy: boolean;
    isKnockout: boolean;
    isPrivate: boolean;
    clubName?: string;
}

export interface TournamentListProps {
    tournaments: Tournament[];
    onRegister: (tournamentId: string) => void;
    onUnregister: (tournamentId: string) => void;
    onViewDetails: (tournamentId: string) => void;
    registeredTournamentIds?: string[];
    isLoading?: boolean;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatAmount(amount: number, currency: string = ''): string {
    if (amount >= 1000000) {
        return `${currency}${(amount / 1000000).toFixed(1)}M`;
    }
    if (amount >= 1000) {
        return `${currency}${(amount / 1000).toFixed(1)}K`;
    }
    return `${currency}${amount.toLocaleString()}`;
}

function formatCountdown(ms: number): string {
    if (ms <= 0) return 'Now';

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface TournamentRowProps {
    tournament: Tournament;
    isRegistered: boolean;
    onRegister: () => void;
    onUnregister: () => void;
    onViewDetails: () => void;
    currency: string;
}

function TournamentRow({
    tournament,
    isRegistered,
    onRegister,
    onUnregister,
    onViewDetails,
    currency,
}: TournamentRowProps) {
    const [countdown, setCountdown] = useState('');

    // Update countdown every second
    useEffect(() => {
        const updateCountdown = () => {
            const now = Date.now();
            const start = new Date(tournament.startTime).getTime();
            setCountdown(formatCountdown(start - now));
        };

        updateCountdown();
        const interval = setInterval(updateCountdown, 1000);
        return () => clearInterval(interval);
    }, [tournament.startTime]);

    const canRegister = ['SCHEDULED', 'REGISTERING', 'LATE_REG'].includes(tournament.status);
    const isFull = tournament.registeredPlayers >= tournament.maxPlayers;
    const isGuaranteed = tournament.guaranteed > 0;
    const totalBuyIn = tournament.buyIn + tournament.fee;

    // Status badge color
    const statusColor = useMemo(() => {
        switch (tournament.status) {
            case 'REGISTERING': return '#3FB950';
            case 'LATE_REG': return '#FFB800';
            case 'RUNNING': return '#1877F2';
            case 'FINAL_TABLE': return '#A855F7';
            case 'COMPLETED': return '#6E7681';
            case 'CANCELLED': return '#F85149';
            default: return '#8B949E';
        }
    }, [tournament.status]);

    return (
        <div className="tournament-row" onClick={onViewDetails}>
            {/* Tournament Info */}
            <div className="tournament-row__info">
                <div className="tournament-row__header">
                    <span className={`tournament-row__type tournament-row__type--${tournament.type.toLowerCase()}`}>
                        {tournament.type}
                    </span>
                    <span className="tournament-row__name">{tournament.name}</span>
                    {tournament.isKnockout && <span className="tournament-row__badge">KO</span>}
                    {tournament.isRebuy && <span className="tournament-row__badge">R</span>}
                    {tournament.isPrivate && <span className="tournament-row__private">🔒</span>}
                </div>
                <div className="tournament-row__meta">
                    <span className="tournament-row__variant">{tournament.variant}</span>
                    <span className="tournament-row__structure">{tournament.blindLevelMinutes}min levels</span>
                    {tournament.clubName && <span className="tournament-row__club">• {tournament.clubName}</span>}
                </div>
            </div>

            {/* Start Time */}
            <div className="tournament-row__time">
                <span className="tournament-row__countdown">{countdown}</span>
                <span className="tournament-row__start-time">{formatTime(new Date(tournament.startTime))}</span>
            </div>

            {/* Buy-In */}
            <div className="tournament-row__buyin">
                <span className="tournament-row__buyin-total">
                    {formatAmount(totalBuyIn, currency)}
                </span>
                {tournament.fee > 0 && (
                    <span className="tournament-row__buyin-breakdown">
                        {formatAmount(tournament.buyIn, currency)}+{formatAmount(tournament.fee, currency)}
                    </span>
                )}
            </div>

            {/* Prize Pool */}
            <div className="tournament-row__prize">
                <span className={`tournament-row__prize-amount ${isGuaranteed ? 'tournament-row__prize-amount--gtd' : ''}`}>
                    {formatAmount(Math.max(tournament.prizePool, tournament.guaranteed), currency)}
                </span>
                {isGuaranteed && tournament.prizePool < tournament.guaranteed && (
                    <span className="tournament-row__gtd-badge">GTD</span>
                )}
            </div>

            {/* Players */}
            <div className="tournament-row__players">
                <span className="tournament-row__player-count">
                    {tournament.registeredPlayers}
                    <span className="tournament-row__player-max">/{tournament.maxPlayers}</span>
                </span>
                <span
                    className="tournament-row__status"
                    style={{ color: statusColor }}
                >
                    {tournament.status.replace('_', ' ')}
                </span>
            </div>

            {/* Actions */}
            <div className="tournament-row__actions" onClick={(e) => e.stopPropagation()}>
                {canRegister && !isFull && !isRegistered && (
                    <button className="tournament-row__register-btn" onClick={onRegister}>
                        Register
                    </button>
                )}
                {isRegistered && canRegister && (
                    <button className="tournament-row__unregister-btn" onClick={onUnregister}>
                        Unregister
                    </button>
                )}
                {isRegistered && tournament.status === 'RUNNING' && (
                    <button className="tournament-row__open-btn" onClick={onViewDetails}>
                        Open
                    </button>
                )}
                {isFull && !isRegistered && canRegister && (
                    <span className="tournament-row__full">Full</span>
                )}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TournamentList({
    tournaments,
    onRegister,
    onUnregister,
    onViewDetails,
    registeredTournamentIds = [],
    isLoading = false,
    currency = '',
}: TournamentListProps) {
    // Group tournaments by status
    const groupedTournaments = useMemo(() => {
        const running = tournaments.filter((t) => ['RUNNING', 'BREAK', 'FINAL_TABLE'].includes(t.status));
        const registering = tournaments.filter((t) => ['SCHEDULED', 'REGISTERING', 'LATE_REG'].includes(t.status));
        const completed = tournaments.filter((t) => ['COMPLETED', 'CANCELLED'].includes(t.status));

        return { running, registering, completed };
    }, [tournaments]);

    if (isLoading) {
        return (
            <div className="tournament-list tournament-list--loading">
                <div className="tournament-list__skeleton">
                    {[...Array(4)].map((_, i) => (
                        <div key={i} className="tournament-list__skeleton-row" />
                    ))}
                </div>
            </div>
        );
    }

    if (tournaments.length === 0) {
        return (
            <div className="tournament-list tournament-list--empty">
                <div className="tournament-list__empty-state">
                    <span className="tournament-list__empty-icon">🏆</span>
                    <span className="tournament-list__empty-text">No tournaments scheduled</span>
                    <span className="tournament-list__empty-hint">Check back later for upcoming events</span>
                </div>
            </div>
        );
    }

    return (
        <div className="tournament-list">
            {/* Header */}
            <div className="tournament-list__header">
                <div className="tournament-list__column tournament-list__column--info">Tournament</div>
                <div className="tournament-list__column tournament-list__column--time">Starts In</div>
                <div className="tournament-list__column tournament-list__column--buyin">Buy-In</div>
                <div className="tournament-list__column tournament-list__column--prize">Prize</div>
                <div className="tournament-list__column tournament-list__column--players">Players</div>
                <div className="tournament-list__column tournament-list__column--actions">Actions</div>
            </div>

            {/* Running Section */}
            {groupedTournaments.running.length > 0 && (
                <div className="tournament-list__section">
                    <div className="tournament-list__section-header">
                        <span className="tournament-list__section-indicator tournament-list__section-indicator--live" />
                        Running ({groupedTournaments.running.length})
                    </div>
                    {groupedTournaments.running.map((tournament) => (
                        <TournamentRow
                            key={tournament.id}
                            tournament={tournament}
                            isRegistered={registeredTournamentIds.includes(tournament.id)}
                            onRegister={() => onRegister(tournament.id)}
                            onUnregister={() => onUnregister(tournament.id)}
                            onViewDetails={() => onViewDetails(tournament.id)}
                            currency={currency}
                        />
                    ))}
                </div>
            )}

            {/* Registering Section */}
            {groupedTournaments.registering.length > 0 && (
                <div className="tournament-list__section">
                    <div className="tournament-list__section-header">
                        <span className="tournament-list__section-indicator tournament-list__section-indicator--open" />
                        Upcoming ({groupedTournaments.registering.length})
                    </div>
                    {groupedTournaments.registering.map((tournament) => (
                        <TournamentRow
                            key={tournament.id}
                            tournament={tournament}
                            isRegistered={registeredTournamentIds.includes(tournament.id)}
                            onRegister={() => onRegister(tournament.id)}
                            onUnregister={() => onUnregister(tournament.id)}
                            onViewDetails={() => onViewDetails(tournament.id)}
                            currency={currency}
                        />
                    ))}
                </div>
            )}

            {/* Footer */}
            <div className="tournament-list__footer">
                <span className="tournament-list__count">
                    {tournaments.length} tournament{tournaments.length !== 1 ? 's' : ''} •{' '}
                    {tournaments.reduce((sum, t) => sum + t.registeredPlayers, 0)} players registered
                </span>
            </div>
        </div>
    );
}

export default TournamentList;
