/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📊 PLAYER STATS POPUP — Click on Player to See Stats
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Player stats popover showing:
 * - Session stats
 * - Player notes
 * - VPIP/PFR/3B stats
 * - Actions (add note, report)
 */

import React, { useState, useCallback } from 'react';
import './PlayerStats.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlayerStatistics {
    handsPlayed: number;
    vpip?: number; // Voluntarily Put $ In Pot %
    pfr?: number; // Pre-Flop Raise %
    threeBet?: number; // 3-Bet %
    aggression?: number; // Aggression factor
    wtsd?: number; // Went to Showdown %
    wsd?: number; // Won at Showdown %
}

export interface PlayerSessionStats {
    buyIn: number;
    currentStack: number;
    handsPlayed: number;
    biggestPot: number;
    timeAtTable: number; // minutes
}

export interface PlayerNote {
    id: string;
    text: string;
    color: string;
    createdAt: Date;
}

export interface PlayerStatsProps {
    isOpen: boolean;
    onClose: () => void;
    playerId: string;
    playerName: string;
    avatar?: string;
    stats?: PlayerStatistics;
    sessionStats?: PlayerSessionStats;
    notes?: PlayerNote[];
    onAddNote?: (playerId: string, note: string, color: string) => void;
    onReport?: (playerId: string) => void;
    position: { x: number; y: number };
    isCurrentUser?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatProfit(buyIn: number, currentStack: number): string {
    const profit = currentStack - buyIn;
    if (profit >= 0) return `+$${profit.toLocaleString()}`;
    return `-$${Math.abs(profit).toLocaleString()}`;
}

const NOTE_COLORS = ['#F85149', '#FFB800', '#3FB950', '#1877F2', '#A371F7', '#8B949E'];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function PlayerStats({
    isOpen,
    onClose,
    playerId,
    playerName,
    avatar,
    stats,
    sessionStats,
    notes = [],
    onAddNote,
    onReport,
    position,
    isCurrentUser = false,
}: PlayerStatsProps) {
    const [showNoteInput, setShowNoteInput] = useState(false);
    const [noteText, setNoteText] = useState('');
    const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]);

    // Handle add note
    const handleAddNote = useCallback(() => {
        if (noteText.trim() && onAddNote) {
            onAddNote(playerId, noteText.trim(), noteColor);
            setNoteText('');
            setShowNoteInput(false);
        }
    }, [playerId, noteText, noteColor, onAddNote]);

    if (!isOpen) return null;

    const profit = sessionStats
        ? formatProfit(sessionStats.buyIn, sessionStats.currentStack)
        : null;
    const isProfitable = sessionStats
        ? sessionStats.currentStack >= sessionStats.buyIn
        : false;

    return (
        <div className="player-stats-overlay" onClick={onClose}>
            <div
                className="player-stats"
                style={{ left: position.x, top: position.y }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="player-stats__header">
                    <div className="player-stats__avatar">
                        {avatar ? (
                            <img src={avatar} alt="" />
                        ) : (
                            <span>{playerName[0]?.toUpperCase()}</span>
                        )}
                    </div>
                    <div className="player-stats__info">
                        <span className="player-stats__name">
                            {playerName}
                            {isCurrentUser && <span className="player-stats__you">(You)</span>}
                        </span>
                        {sessionStats && (
                            <span className="player-stats__time">
                                At table {formatTime(sessionStats.timeAtTable)}
                            </span>
                        )}
                    </div>
                    <button className="player-stats__close" onClick={onClose}>×</button>
                </div>

                {/* Session Stats */}
                {sessionStats && (
                    <div className="player-stats__session">
                        <div className="player-stats__session-row">
                            <span className="player-stats__session-label">Stack</span>
                            <span className="player-stats__session-value">
                                ${sessionStats.currentStack.toLocaleString()}
                            </span>
                        </div>
                        <div className="player-stats__session-row">
                            <span className="player-stats__session-label">Session P/L</span>
                            <span className={`player-stats__session-value ${isProfitable ? 'player-stats__session-value--positive' : 'player-stats__session-value--negative'}`}>
                                {profit}
                            </span>
                        </div>
                        <div className="player-stats__session-row">
                            <span className="player-stats__session-label">Hands</span>
                            <span className="player-stats__session-value">{sessionStats.handsPlayed}</span>
                        </div>
                    </div>
                )}

                {/* HUD Stats */}
                {stats && stats.handsPlayed >= 10 && (
                    <div className="player-stats__hud">
                        <span className="player-stats__hud-title">Stats ({stats.handsPlayed} hands)</span>
                        <div className="player-stats__hud-grid">
                            <div className="player-stats__hud-stat">
                                <span className="player-stats__hud-value">{stats.vpip ?? '-'}%</span>
                                <span className="player-stats__hud-label">VPIP</span>
                            </div>
                            <div className="player-stats__hud-stat">
                                <span className="player-stats__hud-value">{stats.pfr ?? '-'}%</span>
                                <span className="player-stats__hud-label">PFR</span>
                            </div>
                            <div className="player-stats__hud-stat">
                                <span className="player-stats__hud-value">{stats.threeBet ?? '-'}%</span>
                                <span className="player-stats__hud-label">3-Bet</span>
                            </div>
                            <div className="player-stats__hud-stat">
                                <span className="player-stats__hud-value">{stats.aggression?.toFixed(1) ?? '-'}</span>
                                <span className="player-stats__hud-label">AF</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Notes */}
                {!isCurrentUser && (
                    <div className="player-stats__notes">
                        <div className="player-stats__notes-header">
                            <span className="player-stats__notes-title">Notes</span>
                            {onAddNote && !showNoteInput && (
                                <button className="player-stats__add-note" onClick={() => setShowNoteInput(true)}>
                                    + Add
                                </button>
                            )}
                        </div>

                        {showNoteInput && (
                            <div className="player-stats__note-input">
                                <input
                                    type="text"
                                    placeholder="Add a note..."
                                    value={noteText}
                                    onChange={(e) => setNoteText(e.target.value)}
                                    autoFocus
                                />
                                <div className="player-stats__note-colors">
                                    {NOTE_COLORS.map((color) => (
                                        <button
                                            key={color}
                                            className={`player-stats__color-btn ${noteColor === color ? 'player-stats__color-btn--active' : ''}`}
                                            style={{ background: color }}
                                            onClick={() => setNoteColor(color)}
                                        />
                                    ))}
                                </div>
                                <div className="player-stats__note-actions">
                                    <button className="player-stats__note-cancel" onClick={() => setShowNoteInput(false)}>
                                        Cancel
                                    </button>
                                    <button className="player-stats__note-save" onClick={handleAddNote}>
                                        Save
                                    </button>
                                </div>
                            </div>
                        )}

                        {notes.length > 0 && (
                            <div className="player-stats__notes-list">
                                {notes.map((note) => (
                                    <div key={note.id} className="player-stats__note" style={{ borderLeftColor: note.color }}>
                                        {note.text}
                                    </div>
                                ))}
                            </div>
                        )}

                        {notes.length === 0 && !showNoteInput && (
                            <span className="player-stats__no-notes">No notes yet</span>
                        )}
                    </div>
                )}

                {/* Actions */}
                {!isCurrentUser && onReport && (
                    <div className="player-stats__actions">
                        <button className="player-stats__report" onClick={() => onReport(playerId)}>
                            🚩 Report Player
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

export default PlayerStats;
