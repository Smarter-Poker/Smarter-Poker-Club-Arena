/**
 * ♠ CLUB ARENA — Tournament Lobby Page
 * Register and view upcoming tournaments
 */

import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { tournamentService, BLIND_STRUCTURES, PAYOUT_STRUCTURES } from '../services/TournamentService';
import type { Tournament } from '../types/database.types';
import CreateTournamentModal from '../components/club/CreateTournamentModal';
import './TournamentPage.css';
import { supabase, isDemoMode } from '../lib/supabase';
import { useUserStore } from '../stores/useUserStore';

// Default fallback for unauthed (shouldn't happen in real app)
const GUEST_USER = { id: 'guest', username: 'Guest' };

export default function TournamentPage() {
    const { clubId, tournamentId } = useParams();
    const navigate = useNavigate();
    const { user, initDemoUser } = useUserStore();
    const currentUser = user || GUEST_USER;
    const isOwner = true; // Demo logic

    // Auto-login demo user
    useEffect(() => {
        if (!user && isDemoMode) {
            initDemoUser();
        }
    }, [user]);

    const [tournaments, setTournaments] = useState<Tournament[]>([]);
    const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [isRegistered, setIsRegistered] = useState(false);

    // Load tournaments
    useEffect(() => {
        async function loadTournaments() {
            if (!clubId) return;
            setIsLoading(true);
            try {
                const data = await tournamentService.getTournaments(clubId);
                setTournaments(data);

                // If tournamentId provided, select it
                if (tournamentId) {
                    const tourn = data.find(t => t.id === tournamentId);
                    if (tourn) setSelectedTournament(tourn);
                }
            } catch (error) {
                console.error('Failed to load tournaments:', error);
            }
            setIsLoading(false);
        }
        loadTournaments();
    }, [clubId, tournamentId]);

    // Register for tournament
    const handleRegister = async () => {
        if (!selectedTournament) return;
        try {
            await tournamentService.registerPlayer(
                selectedTournament.id,
                currentUser.id,
                currentUser.username
            );
            setIsRegistered(true);

            // Update tournament in list
            setTournaments(prev => prev.map(t =>
                t.id === selectedTournament.id
                    ? { ...t, current_players: t.current_players + 1, prize_pool: t.prize_pool + t.buy_in }
                    : t
            ));
            setSelectedTournament(prev => prev ? {
                ...prev,
                current_players: prev.current_players + 1,
                prize_pool: prev.prize_pool + prev.buy_in,
            } : null);
        } catch (error) {
            alert('Registration failed: ' + (error as Error).message);
        }
    };

    const handleStart = async () => {
        if (!selectedTournament || !clubId) return;
        try {
            await tournamentService.startTournament(selectedTournament.id);
            // Refresh
            const data = await tournamentService.getTournaments(clubId);
            setTournaments(data);
            const updated = data.find(t => t.id === selectedTournament.id);
            if (updated) setSelectedTournament(updated);
        } catch (error) {
            alert('Failed to start: ' + (error as Error).message);
        }
    };

    const handleJoinTable = async () => {
        if (!selectedTournament || !currentUser.id) return;
        try {
            const { data: tables } = await supabase.from('tables').select('id').eq('tournament_id', selectedTournament.id);
            if (!tables?.length) {
                alert('No tables found for this tournament');
                return;
            }

            const tableIds = tables.map(t => t.id);
            const { data: seat } = await supabase.from('table_seats')
                .select('table_id')
                .eq('user_id', currentUser.id)
                .in('table_id', tableIds)
                .maybeSingle();

            if (seat) {
                navigate(`/clubs/${clubId}/table/${seat.table_id}`);
            } else {
                alert('You are registered but not seated. Please wait for the tournament to start fully.');
            }
        } catch (e) { console.error(e); }
    };

    // Unregister
    const handleUnregister = async () => {
        if (!selectedTournament) return;
        try {
            await tournamentService.unregisterPlayer(selectedTournament.id, currentUser.id);
            setIsRegistered(false);

            setTournaments(prev => prev.map(t =>
                t.id === selectedTournament.id
                    ? { ...t, current_players: t.current_players - 1, prize_pool: t.prize_pool - t.buy_in }
                    : t
            ));
            setSelectedTournament(prev => prev ? {
                ...prev,
                current_players: prev.current_players - 1,
                prize_pool: prev.prize_pool - prev.buy_in,
            } : null);
        } catch (error) {
            alert('Unregister failed: ' + (error as Error).message);
        }
    };

    if (isLoading) {
        return (
            <div className="tournament-page">
                <div className="loading">Loading tournaments...</div>
            </div>
        );
    }

    return (
        <div className="tournament-page">
            {/* Header */}
            <div className="tournament-header">
                <div className="header-left">
                    <Link to={`/clubs/${clubId}`} className="back-link">← Back to Club</Link>
                    <h1>🏆 Tournaments</h1>
                </div>
                <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                    + Create Tournament
                </button>
            </div>

            <div className="tournament-content">
                {/* Tournament List */}
                <div className="tournament-list">
                    <h2>Upcoming</h2>
                    {tournaments.length === 0 ? (
                        <div className="empty-state">
                            <p>No tournaments scheduled</p>
                        </div>
                    ) : (
                        tournaments.map(tourn => (
                            <div
                                key={tourn.id}
                                className={`tournament-card ${selectedTournament?.id === tourn.id ? 'selected' : ''}`}
                                onClick={() => setSelectedTournament(tourn)}
                            >
                                <div className="tourn-header">
                                    <span className="tourn-name">{tourn.name}</span>
                                    <span className={`tourn-status ${tourn.status}`}>
                                        {tourn.status === 'registering' ? '🟢 Open' :
                                            tourn.status === 'running' ? '🔴 Running' : '⏳ Soon'}
                                    </span>
                                </div>
                                <div className="tourn-info">
                                    <span className="tourn-type">{tourn.type.toUpperCase()}</span>
                                    <span className="tourn-buyin">${tourn.buy_in} + ${tourn.rake}</span>
                                </div>
                                <div className="tourn-meta">
                                    <span>👥 {tourn.current_players}/{tourn.max_players}</span>
                                    <span>💰 ${tourn.prize_pool}</span>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Tournament Details */}
                <div className="tournament-details">
                    {selectedTournament ? (
                        <>
                            <div className="detail-header">
                                <h2>{selectedTournament.name}</h2>
                                <span className={`status-badge ${selectedTournament.status}`}>
                                    {selectedTournament.status}
                                </span>
                            </div>

                            <div className="detail-stats">
                                <div className="stat">
                                    <span className="stat-label">Buy-in</span>
                                    <span className="stat-value">${selectedTournament.buy_in} + ${selectedTournament.rake}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Starting Stack</span>
                                    <span className="stat-value">{selectedTournament.starting_chips.toLocaleString()}</span>
                                </div>
                                <div className="stat">
                                    <span className="stat-label">Players</span>
                                    <span className="stat-value">{selectedTournament.current_players}/{selectedTournament.max_players}</span>
                                </div>
                                <div className="stat highlight">
                                    <span className="stat-label">Prize Pool</span>
                                    <span className="stat-value gold">${selectedTournament.prize_pool}</span>
                                </div>
                            </div>

                            {/* Blind Structure */}
                            <div className="blind-structure">
                                <h3>Blind Structure</h3>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Level</th>
                                            <th>Blinds</th>
                                            <th>Ante</th>
                                            <th>Duration</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {selectedTournament.blind_structure.slice(0, 5).map((level, i) => (
                                            <tr key={i}>
                                                <td>{level.level}</td>
                                                <td>{level.smallBlind}/{level.bigBlind}</td>
                                                <td>{level.ante || '-'}</td>
                                                <td>{level.durationMinutes} min</td>
                                            </tr>
                                        ))}
                                        {selectedTournament.blind_structure.length > 5 && (
                                            <tr className="more-row">
                                                <td colSpan={4}>+ {selectedTournament.blind_structure.length - 5} more levels</td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            {/* Payout Structure */}
                            <div className="payout-structure">
                                <h3>Payouts</h3>
                                <div className="payout-list">
                                    {selectedTournament.payout_structure.slice(0, 5).map((payout, i) => (
                                        <div key={i} className="payout-item">
                                            <span className="payout-place">
                                                {payout.place === 1 ? '🥇' : payout.place === 2 ? '🥈' : payout.place === 3 ? '🥉' : `${payout.place}th`}
                                            </span>
                                            <span className="payout-percent">{payout.percentage}%</span>
                                            <span className="payout-amount">
                                                ${Math.floor((selectedTournament.prize_pool * payout.percentage) / 100)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="detail-actions">
                                {selectedTournament.status === 'registering' || selectedTournament.status === 'scheduled' ? (
                                    isRegistered ? (
                                        <button className="btn btn-danger btn-block" onClick={handleUnregister}>
                                            Unregister
                                        </button>
                                    ) : (
                                        <button className="btn btn-primary btn-block" onClick={handleRegister}>
                                            Register (${selectedTournament.buy_in + selectedTournament.rake})
                                        </button>
                                    )
                                ) : selectedTournament.status === 'running' ? (
                                    <button
                                        className="btn btn-primary btn-block"
                                        disabled={!isRegistered}
                                        onClick={handleJoinTable}
                                    >
                                        {isRegistered ? 'Go to Table' : 'Tournament in Progress'}
                                    </button>
                                ) : null}

                                {isOwner && (selectedTournament.status === 'registering' || selectedTournament.status === 'scheduled') && (
                                    <button
                                        className="btn btn-warning btn-block"
                                        style={{ marginTop: '1rem' }}
                                        onClick={handleStart}
                                        disabled={selectedTournament.current_players < 2}
                                    >
                                        Start Tournament
                                    </button>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="empty-detail">
                            <div className="empty-icon">🏆</div>
                            <h3>Select a Tournament</h3>
                            <p>Click on a tournament to view details and register.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Create Modal */}
            {showCreateModal && clubId && (
                <CreateTournamentModal
                    clubId={clubId}
                    onClose={() => setShowCreateModal(false)}
                    onSuccess={() => {
                        setShowCreateModal(false);
                        tournamentService.getTournaments(clubId).then(setTournaments);
                    }}
                />
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE TOURNAMENT MODAL
// ═══════════════════════════════════════════════════════════════════════════════

interface CreateModalProps {
    clubId: string;
    onClose: () => void;
    onCreate: (tournament: Tournament) => void;
}

function LegacyCreateTournamentModal({ clubId, onClose, onCreate }: CreateModalProps) {
    const [form, setForm] = useState({
        name: '',
        type: 'sng' as 'sng' | 'mtt',
        buyIn: 10,
        rake: 1,
        startingStack: 1500,
        maxPlayers: 6,
        blindSpeed: 'turbo' as 'turbo' | 'regular' | 'deepStack',
    });

    const handleCreate = async () => {
        if (!form.name) return;

        const payoutKey = form.type === 'sng'
            ? form.maxPlayers === 6 ? 'sng6' : 'sng9'
            : form.maxPlayers <= 10 ? 'mtt10' : form.maxPlayers <= 20 ? 'mtt20' : 'mtt50';

        const tournament = await tournamentService.createTournament(clubId, {
            name: form.name,
            type: form.type,
            buyIn: form.buyIn,
            rake: form.rake,
            startingStack: form.startingStack,
            maxPlayers: form.maxPlayers,
            minPlayers: form.type === 'sng' ? form.maxPlayers : 2,
            blindStructure: BLIND_STRUCTURES[form.blindSpeed],
            payoutStructure: PAYOUT_STRUCTURES[payoutKey],
            lateRegistrationLevels: 0,
            isRebuy: false,
            addOnAvailable: false,
        });

        onCreate(tournament);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={e => e.stopPropagation()}>
                <h2>Create Tournament</h2>

                <div className="form-group">
                    <label>Tournament Name</label>
                    <input
                        type="text"
                        placeholder="Enter name..."
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                    />
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Type</label>
                        <select
                            value={form.type}
                            onChange={e => setForm({ ...form, type: e.target.value as 'sng' | 'mtt' })}
                        >
                            <option value="sng">Sit & Go</option>
                            <option value="mtt">Tournament</option>
                        </select>
                    </div>

                    <div className="form-group">
                        <label>Max Players</label>
                        <select
                            value={form.maxPlayers}
                            onChange={e => setForm({ ...form, maxPlayers: Number(e.target.value) })}
                        >
                            <option value={6}>6 Players</option>
                            <option value={9}>9 Players</option>
                            {form.type === 'mtt' && <option value={20}>20 Players</option>}
                            {form.type === 'mtt' && <option value={50}>50 Players</option>}
                        </select>
                    </div>
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Buy-in</label>
                        <input
                            type="number"
                            min={1}
                            value={form.buyIn}
                            onChange={e => setForm({ ...form, buyIn: Number(e.target.value) })}
                        />
                    </div>

                    <div className="form-group">
                        <label>Rake</label>
                        <input
                            type="number"
                            min={0}
                            value={form.rake}
                            onChange={e => setForm({ ...form, rake: Number(e.target.value) })}
                        />
                    </div>
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Starting Stack</label>
                        <input
                            type="number"
                            min={500}
                            step={500}
                            value={form.startingStack}
                            onChange={e => setForm({ ...form, startingStack: Number(e.target.value) })}
                        />
                    </div>

                    <div className="form-group">
                        <label>Blind Speed</label>
                        <select
                            value={form.blindSpeed}
                            onChange={e => setForm({ ...form, blindSpeed: e.target.value as 'turbo' | 'regular' | 'deepStack' })}
                        >
                            <option value="turbo">Turbo (3 min)</option>
                            <option value="regular">Regular (8 min)</option>
                            <option value="deepStack">Deep Stack (15 min)</option>
                        </select>
                    </div>
                </div>

                <div className="modal-actions">
                    <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
                    <button
                        className="btn btn-primary"
                        onClick={handleCreate}
                        disabled={!form.name}
                    >
                        Create Tournament
                    </button>
                </div>
            </div>
        </div>
    );
}
