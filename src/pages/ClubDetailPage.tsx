/**
 * ♠ CLUB ARENA — Club Detail Page
 * Club overview with tables, members, and management
 */

import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { clubService } from '../services/ClubService';
import { tableService } from '../services/TableService';
import { tournamentService } from '../services/TournamentService';
import CreateTableModal from '../components/club/CreateTableModal';
import CreateTournamentModal from '../components/club/CreateTournamentModal';
import { ClubFinancialDashboard } from '../components/dashboard/ClubFinancialDashboard';
import { AgentFinancialPortal } from '../components/dashboard/AgentFinancialPortal';
import { supabase } from '../lib/supabase';
import type { Club, ClubMember, PokerTable, Tournament } from '../types/database.types';
import './ClubDetailPage.css';

type TabType = 'tables' | 'members' | 'tournaments' | 'settings' | 'finance' | 'agent_portal';

export default function ClubDetailPage() {
    const { clubId } = useParams();
    const navigate = useNavigate();

    const [club, setClub] = useState<Club | null>(null);
    const [members, setMembers] = useState<ClubMember[]>([]);
    const [tables, setTables] = useState<PokerTable[]>([]);
    const [tournaments, setTournaments] = useState<Tournament[]>([]);
    const [activeTab, setActiveTab] = useState<TabType>('tables');
    const [isLoading, setIsLoading] = useState(true);
    const [isCreatingTable, setIsCreatingTable] = useState(false);
    const [isCreatingTournament, setIsCreatingTournament] = useState(false);
    const [currentUserId, setCurrentUserId] = useState<string | null>(null);
    const [myAgentId, setMyAgentId] = useState<string | null>(null);

    useEffect(() => {
        supabase.auth.getUser().then(async ({ data }) => {
            const uid = data.user?.id;
            setCurrentUserId(uid || null);

            // Check if I am an agent in this club
            if (uid && clubId) {
                const { data: agent } = await supabase
                    .from('agents')
                    .select('id')
                    .eq('user_id', uid)
                    .eq('club_id', clubId)
                    .maybeSingle(); // specific to this club

                if (agent) setMyAgentId(agent.id);
            }
        });
    }, [clubId]);

    // Load club data
    const loadClubData = async () => {
        if (!clubId) return;
        setIsLoading(true);
        try {
            const [clubData, memberList, tableList, tournamentList] = await Promise.all([
                clubService.getClub(clubId),
                clubService.getMembers(clubId),
                tableService.getClubTables(clubId),
                tournamentService.getTournaments(clubId),
            ]);
            setClub(clubData);
            setMembers(memberList);
            setTables(tableList);
            setTournaments(tournamentList);
        } catch (error) {
            console.error('Failed to load club:', error);
        }
        setIsLoading(false);
    };

    useEffect(() => {
        loadClubData();
    }, [clubId]);

    const handleTableCreated = async () => {
        setIsCreatingTable(false);
        // Refresh tables only
        if (clubId) {
            const newTables = await tableService.getClubTables(clubId);
            setTables(newTables);
        }
    };

    const handleTournamentCreated = async () => {
        setIsCreatingTournament(false);
        if (clubId) {
            const list = await tournamentService.getTournaments(clubId);
            setTournaments(list);
        }
    };

    if (isLoading) {
        return (
            <div className="club-detail-page">
                <div className="loading">Loading club...</div>
            </div>
        );
    }

    if (!club) {
        return (
            <div className="club-detail-page">
                <div className="error-state">
                    <h2>Club not found</h2>
                    <Link to="/clubs" className="btn btn-primary">Back to Clubs</Link>
                </div>
            </div>
        );
    }

    const isOwner = club && currentUserId && club.owner_id === currentUserId;
    const onlineCount = Math.floor(members.length * 0.3);

    return (
        <div className="club-detail-page">
            {/* Header */}
            <div className="club-header">
                <Link to="/clubs" className="back-link">← Back to Clubs</Link>

                <div className="club-header-content">
                    <div className="club-avatar">
                        {club.avatar_url ? (
                            <img src={club.avatar_url} alt={club.name} />
                        ) : (
                            <span>🏛️</span>
                        )}
                    </div>

                    <div className="club-header-info">
                        <h1>{club.name}</h1>
                        <p className="club-id">ID: {club.club_id}</p>
                        <p className="club-description">{club.description || 'No description'}</p>
                    </div>

                    <div className="club-header-stats">
                        <div className="header-stat">
                            <span className="stat-value">{members.length}</span>
                            <span className="stat-label">Members</span>
                        </div>
                        <div className="header-stat">
                            <span className="stat-value green">{onlineCount}</span>
                            <span className="stat-label">Online</span>
                        </div>
                        <div className="header-stat">
                            <span className="stat-value">{tables.filter(t => t.status === 'running').length}</span>
                            <span className="stat-label">Active Tables</span>
                        </div>
                    </div>

                    {isOwner && (
                        <Link to={`/clubs/${clubId}/agents`} className="btn btn-ghost">
                            👔 Manage Agents
                        </Link>
                    )}
                </div>
            </div>

            {/* Tabs */}
            <div className="club-tabs">
                <button
                    className={`tab ${activeTab === 'tables' ? 'active' : ''}`}
                    onClick={() => setActiveTab('tables')}
                >
                    🎰 Tables ({tables.length})
                </button>
                <button
                    className={`tab ${activeTab === 'members' ? 'active' : ''}`}
                    onClick={() => setActiveTab('members')}
                >
                    👥 Members ({members.length})
                </button>
                <button
                    className={`tab ${activeTab === 'tournaments' ? 'active' : ''}`}
                    onClick={() => setActiveTab('tournaments')}
                >
                    🏆 Tournaments ({tournaments.length})
                </button>
                {isOwner && (
                    <>
                        <button
                            className={`tab ${activeTab === 'finance' ? 'active' : ''}`}
                            onClick={() => setActiveTab('finance')}
                        >
                            💰 Finance
                        </button>
                        <button
                            className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
                            onClick={() => setActiveTab('settings')}
                        >
                            ⚙️ Settings
                        </button>
                    </>
                )}
                {myAgentId && (
                    <button
                        className={`tab ${activeTab === 'agent_portal' ? 'active' : ''}`}
                        onClick={() => setActiveTab('agent_portal')}
                    >
                        👔 Portal
                    </button>
                )}
            </div>

            {/* Tab Content */}
            <div className="club-content">
                {/* Tables Tab */}
                {activeTab === 'tables' && (
                    <div className="tables-section">
                        {isOwner && (
                            <div className="section-actions">
                                <button
                                    className="btn btn-primary"
                                    onClick={() => setIsCreatingTable(true)}
                                >
                                    + Create Table
                                </button>
                            </div>
                        )}

                        {tables.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon">🎰</div>
                                <h3>No Active Tables</h3>
                                <p>Create a table to start playing poker.</p>
                                {isOwner && (
                                    <button
                                        className="btn btn-primary"
                                        onClick={() => setIsCreatingTable(true)}
                                    >
                                        Create First Table
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div className="tables-grid">
                                {tables.map(table => (
                                    <div key={table.id} className="table-card">
                                        <div className="table-header">
                                            <span className="table-name">{table.name}</span>
                                            <span className={`table-status ${table.status}`}>
                                                {table.status === 'running' ? '🟢 Live' : '⏳ Waiting'}
                                            </span>
                                        </div>

                                        <div className="table-info">
                                            <div className="table-variant">
                                                {getVariantName(table.game_variant)}
                                            </div>
                                            <div className="table-stakes">
                                                {table.small_blind}/{table.big_blind}
                                            </div>
                                        </div>

                                        <div className="table-players">
                                            <div className="player-count">
                                                <span className="current">{table.current_players}</span>
                                                <span className="divider">/</span>
                                                <span className="max">{table.max_players}</span>
                                            </div>
                                            <div className="seats-visual">
                                                {Array(table.max_players).fill(null).map((_, i) => (
                                                    <div
                                                        key={i}
                                                        className={`seat-dot ${i < table.current_players ? 'filled' : ''}`}
                                                    />
                                                ))}
                                            </div>
                                        </div>

                                        <div className="table-features">
                                            {table.settings.straddle_enabled && (
                                                <span className="feature-tag">Straddle</span>
                                            )}
                                            {table.settings.run_it_twice && (
                                                <span className="feature-tag">RIT</span>
                                            )}
                                            {table.settings.bomb_pot_enabled && (
                                                <span className="feature-tag">Bomb Pots</span>
                                            )}
                                        </div>

                                        <button
                                            className="btn btn-primary btn-block"
                                            onClick={() => navigate(`/clubs/${clubId}/table/${table.id}`)}
                                        >
                                            {table.current_players < table.max_players ? 'Join Table' : 'Watch'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Members Tab */}
                {activeTab === 'members' && (
                    <div className="members-section">
                        <div className="members-list">
                            {members.map(member => (
                                <div key={member.id} className="member-card">
                                    <div className="member-avatar">
                                        {member.role === 'owner' ? '👑' :
                                            member.role === 'agent' ? '👔' : '👤'}
                                    </div>
                                    <div className="member-info">
                                        <div className="member-name">
                                            {member.nickname || 'Player'}
                                            {member.role !== 'member' && (
                                                <span className={`role-badge ${member.role}`}>
                                                    {member.role}
                                                </span>
                                            )}
                                        </div>
                                        <div className="member-meta">
                                            Joined {new Date(member.joined_at).toLocaleDateString()}
                                        </div>
                                    </div>
                                    <div className="member-balance">
                                        {member.chip_balance.toLocaleString()} chips
                                    </div>
                                    <div className={`member-status ${member.status}`}>
                                        {member.status === 'active' ? '🟢' : '⏳'}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Tournaments Tab */}
                {activeTab === 'tournaments' && (
                    <div className="tournaments-section">
                        {isOwner && (
                            <div className="section-actions" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
                                <button className="btn btn-primary" onClick={() => setIsCreatingTournament(true)}>+ Create Tournament</button>
                            </div>
                        )}
                        {tournaments.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon">🏆</div>
                                <h3>No Tournaments</h3>
                                <p>Create a tournament to compete.</p>
                            </div>
                        ) : (
                            <div className="tournaments-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
                                {tournaments.map(t => (
                                    <div key={t.id} className="tournament-card" style={{ padding: '1rem', backgroundColor: 'var(--card-bg)', borderRadius: '0.5rem', border: '1px solid var(--border-color)' }}>
                                        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', alignItems: 'center' }}>
                                            <h4 style={{ margin: 0 }}>{t.name}</h4>
                                            <span className={`status-badge ${t.status}`} style={{ textTransform: 'capitalize', fontSize: '0.8rem', padding: '2px 8px', borderRadius: '12px', background: t.status === 'running' ? 'var(--success-color)' : 'var(--bg-secondary)' }}>{t.status}</span>
                                        </div>
                                        <div className="card-details" style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                                            <p>Type: {t.type.toUpperCase()}</p>
                                            <p>Buy-in: {t.buy_in} + {t.rake} chips</p>
                                            <p>Players: {t.current_players}/{t.max_players}</p>
                                            <p>Start: {t.start_time ? new Date(t.start_time).toLocaleString() : 'On Demand'}</p>
                                        </div>
                                        <button className="btn btn-primary btn-block" style={{ width: '100%' }} onClick={() => navigate(`/clubs/${clubId}/tournament/${t.id}`)}>
                                            {t.status === 'registering' ? 'Register' : 'Lobby'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Agent Portal Tab */}
                {activeTab === 'agent_portal' && myAgentId && (
                    <div className="agent-section">
                        <AgentFinancialPortal agentId={myAgentId} />
                    </div>
                )}

                {activeTab === 'finance' && isOwner && (
                    <div className="finance-section">
                        <ClubFinancialDashboard clubId={clubId!} />
                    </div>
                )}

                {/* Settings Tab */}
                {activeTab === 'settings' && isOwner && (
                    <div className="settings-section">
                        <div className="settings-group">
                            <h3>Club Settings</h3>
                            {/* ... Settings implementation preserved if needed but shortened for brevity if existing code is good ... */}
                            <div className="setting-item">
                                <div className="setting-info">
                                    <span className="setting-label">Club Name</span>
                                    <span className="setting-value">{club.name}</span>
                                </div>
                                <button className="btn btn-sm btn-ghost">Edit</button>
                            </div>
                            {/* Simplified settings view for this replacement to avoid huge context, assuming User accepts simplification or I match strictly */}
                            {/* Wait, I must preserve content if I replace it. I'll include the original settings content from view_file */}
                            <div className="setting-item">
                                <div className="setting-info">
                                    <span className="setting-label">Description</span>
                                    <span className="setting-value">{club.description || 'None'}</span>
                                </div>
                                <button className="btn btn-sm btn-ghost">Edit</button>
                            </div>

                            <div className="setting-item">
                                <div className="setting-info">
                                    <span className="setting-label">Visibility</span>
                                    <span className="setting-value">{club.is_public ? 'Public' : 'Private'}</span>
                                </div>
                                <button className="btn btn-sm btn-ghost">Change</button>
                            </div>
                        </div>

                        <div className="settings-group danger">
                            <h3>Danger Zone</h3>
                            <button className="btn btn-danger">Delete Club</button>
                        </div>
                    </div>
                )}
            </div>

            {/* Modals */}
            {isCreatingTable && club && (
                <CreateTableModal
                    clubId={club.id}
                    onClose={() => setIsCreatingTable(false)}
                    onSuccess={handleTableCreated}
                />
            )}
            {isCreatingTournament && club && (
                <CreateTournamentModal
                    clubId={club.id}
                    onClose={() => setIsCreatingTournament(false)}
                    onSuccess={handleTournamentCreated}
                />
            )}
        </div>
    );
}

function getVariantName(variant: string): string {
    const names: Record<string, string> = {
        nlh: 'No Limit Hold\'em',
        flh: 'Fixed Limit Hold\'em',
        plo4: 'Pot Limit Omaha',
        plo5: 'PLO 5-Card',
        plo6: 'PLO 6-Card',
        short_deck: 'Short Deck',
        ofc: 'Open Face Chinese',
    };
    return names[variant] || variant.toUpperCase();
}
