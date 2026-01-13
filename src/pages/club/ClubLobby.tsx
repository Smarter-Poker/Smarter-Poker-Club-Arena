/**
 * ♠ CLUB ARENA — Club Lobby Page
 * PokerBros-style club interface with tournaments, tables, and navigation
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { clubService } from '../../services/ClubService';
import { tableService } from '../../services/TableService';
import { tournamentService } from '../../services/TournamentService';
import type { Club, PokerTable, Tournament } from '../../types/database.types';
import './ClubLobby.css';

type GameFilter = 'ALL' | 'Hold\'em' | 'Omaha' | 'Mixed' | 'MTT' | 'Spin-It' | 'SN';

export default function ClubLobby() {
    const { clubId } = useParams<{ clubId: string }>();
    const [club, setClub] = useState<Club | null>(null);
    const [tables, setTables] = useState<PokerTable[]>([]);
    const [tournaments, setTournaments] = useState<Tournament[]>([]);
    const [activeFilter, setActiveFilter] = useState<GameFilter>('ALL');
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!clubId) return;
        loadClubData();
    }, [clubId]);

    const loadClubData = async () => {
        if (!clubId) return;
        setIsLoading(true);
        try {
            const [clubData, tableData, tournamentData] = await Promise.all([
                clubService.getClub(clubId),
                tableService.getClubTables(clubId),
                tournamentService.getTournaments(clubId),
            ]);
            setClub(clubData);
            setTables(tableData);
            setTournaments(tournamentData);
        } catch (error) {
            console.error('Failed to load club:', error);
        }
        setIsLoading(false);
    };

    const filters: GameFilter[] = ['ALL', 'Hold\'em', 'Omaha', 'Mixed', 'MTT', 'Spin-It', 'SN'];

    const filteredTournaments = tournaments.filter(t => {
        if (activeFilter === 'ALL') return true;
        if (activeFilter === 'MTT') return t.type === 'mtt';
        if (activeFilter === 'SN') return t.type === 'sng';
        return true;
    });

    if (isLoading) {
        return (
            <div className="club-lobby loading">
                <div className="loader">Loading Club...</div>
            </div>
        );
    }

    if (!club) {
        return (
            <div className="club-lobby error">
                <h2>Club not found</h2>
                <Link to="/clubs" className="btn btn-primary">Back to Clubs</Link>
            </div>
        );
    }

    return (
        <div className="club-lobby">
            {/* Header */}
            <header className="lobby-header">
                <div className="header-left">
                    <Link to="/clubs" className="back-btn">‹‹</Link>
                    <div className="header-icons">
                        <button className="icon-btn">🎪</button>
                        <button className="icon-btn">🎰</button>
                    </div>
                </div>
                <div className="header-center">
                    <span className="vip-badge">👑 VIP</span>
                </div>
                <div className="header-right">
                    <div className="jackpot-display">
                        <span className="jackpot-label">BAD BEAT</span>
                        <span className="jackpot-amount">000,139,356</span>
                    </div>
                </div>
            </header>

            {/* Club Card */}
            <div className="club-card">
                <div className="club-avatar">
                    <span className="club-logo">♠</span>
                </div>
                <div className="club-info">
                    <h2 className="club-name">{club.name}</h2>
                    <div className="club-meta">
                        <span className="club-id">ID: {club.club_id}</span>
                        <span className="member-count">👤 {(club as any).member_count || 0}</span>
                    </div>
                </div>
                <div className="club-balances">
                    <div className="balance-row">
                        <span className="chip-icon gold">💰</span>
                        <span className="balance-amount">8,992.92</span>
                        <button className="add-btn">+</button>
                    </div>
                    <div className="balance-row">
                        <span className="chip-icon diamond">💎</span>
                        <span className="balance-amount">0.00</span>
                    </div>
                </div>
            </div>

            {/* Contact Banner */}
            <div className="contact-banner">
                <span>Questions or concerns? Contact @Johnnyd44 on telegram</span>
                <div className="union-badge">
                    <span>🌐 UNION</span>
                </div>
            </div>

            {/* Game Type Filters */}
            <div className="filter-tabs">
                {filters.map((filter) => (
                    <button
                        key={filter}
                        className={`filter-tab ${activeFilter === filter ? 'active' : ''}`}
                        onClick={() => setActiveFilter(filter)}
                    >
                        {filter}
                    </button>
                ))}
                <button className="filter-more">▼</button>
            </div>

            {/* Tournament Grid */}
            <div className="tournament-grid">
                {filteredTournaments.length > 0 ? (
                    filteredTournaments.map((tournament) => (
                        <TournamentCard key={tournament.id} tournament={tournament} clubId={clubId!} />
                    ))
                ) : tables.length > 0 ? (
                    tables.map((table) => (
                        <TableCard key={table.id} table={table} clubId={clubId!} />
                    ))
                ) : (
                    <div className="empty-state">
                        <span className="empty-icon">🎰</span>
                        <p>No games available</p>
                        <p className="empty-hint">Check back later for new tables!</p>
                    </div>
                )}
            </div>

            {/* Bottom Navigation */}
            <nav className="bottom-nav">
                <NavItem icon="✉️" label="Messages" />
                <NavItem icon="👥" label="Players" />
                <NavItem icon="💰" label="Cashier" active />
                <NavItem icon="📊" label="Data" />
                <NavItem icon="⚙️" label="Admin" />
                <button className="nav-item close">✕</button>
            </nav>
        </div>
    );
}

// Tournament Card Component
function TournamentCard({ tournament, clubId }: { tournament: Tournament; clubId: string }) {
    const getTypeLabel = (type: string) => {
        switch (type) {
            case 'mtt': return 'XMTT';
            case 'sng': return 'SNG';
            default: return type.toUpperCase();
        }
    };

    const formatDate = (date: string | null) => {
        if (!date) return 'TBD';
        return new Date(date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    return (
        <Link to={`/club/${clubId}/tournament/${tournament.id}`} className="tournament-card">
            <div className="card-header">
                <div className="trophy-icon">🏆</div>
                <div className="seats-badge">9 Max</div>
            </div>
            <div className="card-body">
                <div className="buyin-row">
                    <span className="buyin-label">Buy-in</span>
                    <span className="buyin-amount">{tournament.buy_in}</span>
                </div>
                <div className="timer-row">
                    <span className="timer-icon">⏱️</span>
                    <span className="timer-value">10min</span>
                </div>
            </div>
            <div className="card-footer">
                <span className={`type-badge ${tournament.type}`}>{getTypeLabel(tournament.type)}</span>
                <span className="variant-badge">NLH</span>
            </div>
            <div className="card-name">
                <span className="prize-icon">💰</span>
                <span className="tournament-name">{tournament.name}</span>
            </div>
            <div className="card-date">{formatDate(tournament.start_time ?? null)}</div>
        </Link>
    );
}

// Table Card Component
function TableCard({ table, clubId }: { table: PokerTable; clubId: string }) {
    return (
        <Link to={`/club/${clubId}/table/${table.id}`} className="table-card">
            <div className="card-header">
                <div className="table-icon">🎴</div>
                <div className="seats-badge">{table.max_players} Max</div>
            </div>
            <div className="card-body">
                <h3 className="table-name">{table.name}</h3>
                <div className="stakes">{table.stakes}</div>
                <div className="players-count">
                    {table.current_players}/{table.max_players} players
                </div>
            </div>
            <div className="card-footer">
                <span className="variant-badge">{table.game_variant.toUpperCase()}</span>
                <span className={`status-badge ${table.status}`}>{table.status}</span>
            </div>
        </Link>
    );
}

// Nav Item Component
function NavItem({ icon, label, active = false }: { icon: string; label: string; active?: boolean }) {
    return (
        <button className={`nav-item ${active ? 'active' : ''}`}>
            <span className="nav-icon">{icon}</span>
            <span className="nav-label">{label}</span>
        </button>
    );
}
