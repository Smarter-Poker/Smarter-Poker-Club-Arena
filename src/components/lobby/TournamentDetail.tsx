/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🏆 TOURNAMENT DETAIL — Lobby View
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Detailed view of a specific tournament.
 * - Structure (Blinds, Payouts)
 * - Registered Players
 * - Register/Unregister actions
 */

import React, { useState } from 'react';
import './TournamentDetail.css';

export interface TournamentInfo {
    id: string;
    name: string;
    status: 'registering' | 'running' | 'completed' | 'cancelled';
    buyIn: number;
    fee: number;
    chipStack: number;
    blindInterval: number; // minutes
    registeredCount: number;
    maxPlayers: number;
    prizePool: number;
    startTime: string;
    description?: string;
}

export interface PlayerEntry {
    id: string;
    name: string;
    chipCount?: number;
}

export interface TournamentDetailProps {
    isOpen: boolean;
    onClose: () => void;
    tournament: TournamentInfo;
    players: PlayerEntry[];
    currency?: string;
    isRegistered: boolean;
    onRegister: () => void;
    onUnregister: () => void;
}

export function TournamentDetail({
    isOpen,
    onClose,
    tournament,
    players,
    currency = '💎',
    isRegistered,
    onRegister,
    onUnregister,
}: TournamentDetailProps) {
    const [activeTab, setActiveTab] = useState<'info' | 'players' | 'structure'>('info');

    if (!isOpen) return null;

    return (
        <div className="tourney-overlay" onClick={onClose}>
            <div className="tourney-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="tourney-header">
                    <div className="tourney-title-col">
                        <h2 className="tourney-name">{tournament.name}</h2>
                        <span className={`status-badge status-${tournament.status}`}>
                            {tournament.status.toUpperCase()}
                        </span>
                    </div>
                    <button className="tourney-close" onClick={onClose}>×</button>
                </div>

                {/* Hero Info */}
                <div className="tourney-hero">
                    <div className="hero-stat">
                        <span className="hero-label">Buy-In</span>
                        <span className="hero-val">{currency}{tournament.buyIn} + {tournament.fee}</span>
                    </div>
                    <div className="hero-stat">
                        <span className="hero-label">Prize Pool</span>
                        <span className="hero-val highlight">{currency}{tournament.prizePool.toLocaleString()}</span>
                    </div>
                    <div className="hero-stat">
                        <span className="hero-label">Players</span>
                        <span className="hero-val">{tournament.registeredCount} / {tournament.maxPlayers}</span>
                    </div>
                    <div className="hero-stat">
                        <span className="hero-label">Start Time</span>
                        <span className="hero-val">{new Date(tournament.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                </div>

                {/* Tabs */}
                <div className="tourney-tabs">
                    <button
                        className={`tourney-tab ${activeTab === 'info' ? 'active' : ''}`}
                        onClick={() => setActiveTab('info')}
                    >
                        Info
                    </button>
                    <button
                        className={`tourney-tab ${activeTab === 'players' ? 'active' : ''}`}
                        onClick={() => setActiveTab('players')}
                    >
                        Players ({players.length})
                    </button>
                    <button
                        className={`tourney-tab ${activeTab === 'structure' ? 'active' : ''}`}
                        onClick={() => setActiveTab('structure')}
                    >
                        Structure
                    </button>
                </div>

                {/* Content */}
                <div className="tourney-content">
                    {activeTab === 'info' && (
                        <div className="info-section">
                            <p className="description">{tournament.description || "No description provided."}</p>
                            <div className="info-grid">
                                <div className="info-row">
                                    <span>Starting Stack</span>
                                    <strong>{tournament.chipStack.toLocaleString()} chips</strong>
                                </div>
                                <div className="info-row">
                                    <span>Blind Levels</span>
                                    <strong>{tournament.blindInterval} minutes</strong>
                                </div>
                                <div className="info-row">
                                    <span>Late Reg</span>
                                    <strong>Level 8</strong>
                                </div>
                                <div className="info-row">
                                    <span>Re-Entry</span>
                                    <strong>Unlimited (until late reg)</strong>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'players' && (
                        <div className="players-list">
                            <table className="players-table">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Player</th>
                                        <th>Chips</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {players.map((p, i) => (
                                        <tr key={p.id}>
                                            <td>{i + 1}</td>
                                            <td>{p.name}</td>
                                            <td>{p.chipCount ? p.chipCount.toLocaleString() : tournament.chipStack.toLocaleString()}</td>
                                        </tr>
                                    ))}
                                    {players.length === 0 && (
                                        <tr><td colSpan={3} className="empty-msg">No players registered yet.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {activeTab === 'structure' && (
                        <div className="structure-list">
                            <div className="structure-row header">
                                <span>Level</span>
                                <span>Blinds</span>
                                <span>Ante</span>
                            </div>
                            {[1, 2, 3, 4, 5, 6].map(lvl => (
                                <div key={lvl} className="structure-row">
                                    <span>{lvl}</span>
                                    <span>{100 * lvl}/{200 * lvl}</span>
                                    <span>{200 * lvl}</span>
                                </div>
                            ))}
                            <div className="structure-note">... and so on based on configuration.</div>
                        </div>
                    )}
                </div>

                {/* Footer Action */}
                <div className="tourney-footer">
                    {isRegistered ? (
                        <button className="tourney-btn unregister" onClick={onUnregister}>Unregister</button>
                    ) : (
                        <button
                            className="tourney-btn register"
                            onClick={onRegister}
                            disabled={tournament.status !== 'registering'}
                        >
                            {tournament.status === 'registering' ? `Register Now (${currency}${tournament.buyIn + tournament.fee})` : 'Registration Closed'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

export default TournamentDetail;
