/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Club Detail Page
 * Complete club management with tables, members, settings, and finances
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import styles from './ClubDetailPage.module.css';
import { isDemoMode } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ClubData {
    id: string;
    clubId: number;
    name: string;
    description: string;
    avatarUrl: string;
    isPublic: boolean;
    requiresApproval: boolean;
    memberCount: number;
    tableCount: number;
    activeTableCount: number;
    createdAt: string;
    settings: ClubSettings;
}

interface ClubSettings {
    defaultRakePercent: number;
    rakeCap: number;
    timeBankSeconds: number;
    allowStraddle: boolean;
    allowRunItTwice: boolean;
    minBuyInBB: number;
    maxBuyInBB: number;
}

interface ClubMember {
    id: string;
    username: string;
    role: 'owner' | 'admin' | 'agent' | 'member';
    chipBalance: number;
    status: 'active' | 'pending' | 'suspended';
    joinedAt: string;
    lastActive?: string;
}

interface ClubTable {
    id: string;
    name: string;
    gameVariant: string;
    stakes: string;
    currentPlayers: number;
    maxPlayers: number;
    status: 'waiting' | 'running' | 'paused';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_CLUB: ClubData = {
    id: 'club-1',
    clubId: 123456,
    name: 'High Stakes Poker Club',
    description: 'Premium poker club for serious players. Daily tournaments and cash games.',
    avatarUrl: '',
    isPublic: true,
    requiresApproval: true,
    memberCount: 156,
    tableCount: 8,
    activeTableCount: 3,
    createdAt: '2025-01-15',
    settings: {
        defaultRakePercent: 5,
        rakeCap: 3,
        timeBankSeconds: 30,
        allowStraddle: true,
        allowRunItTwice: true,
        minBuyInBB: 40,
        maxBuyInBB: 200,
    },
};

const DEMO_MEMBERS: ClubMember[] = [
    { id: '1', username: 'PokerAce', role: 'owner', chipBalance: 25000, status: 'active', joinedAt: '2025-01-15' },
    { id: '2', username: 'TableMaster', role: 'admin', chipBalance: 15000, status: 'active', joinedAt: '2025-01-18' },
    { id: '3', username: 'CardShark99', role: 'agent', chipBalance: 8500, status: 'active', joinedAt: '2025-01-20' },
    { id: '4', username: 'LuckyPlayer', role: 'member', chipBalance: 3200, status: 'active', joinedAt: '2025-02-01' },
    { id: '5', username: 'NewFish', role: 'member', chipBalance: 500, status: 'pending', joinedAt: '2025-02-15' },
];

const DEMO_TABLES: ClubTable[] = [
    { id: 't1', name: 'Main Game', gameVariant: 'NLH', stakes: '1/2', currentPlayers: 6, maxPlayers: 9, status: 'running' },
    { id: 't2', name: 'High Stakes', gameVariant: 'NLH', stakes: '5/10', currentPlayers: 4, maxPlayers: 6, status: 'running' },
    { id: 't3', name: 'PLO Action', gameVariant: 'PLO4', stakes: '2/5', currentPlayers: 0, maxPlayers: 6, status: 'waiting' },
    { id: 't4', name: 'Short Deck', gameVariant: 'SD', stakes: '1/2', currentPlayers: 5, maxPlayers: 6, status: 'running' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const TabButton = ({
    active,
    onClick,
    icon,
    label
}: {
    active: boolean;
    onClick: () => void;
    icon: string;
    label: string;
}) => (
    <button
        className={`${styles.tab} ${active ? styles.activeTab : ''}`}
        onClick={onClick}
    >
        <span>{icon}</span>
        <span>{label}</span>
    </button>
);

const StatCard = ({ value, label, icon }: { value: string | number; label: string; icon: string }) => (
    <div className={styles.statCard}>
        <span className={styles.statIcon}>{icon}</span>
        <div className={styles.statInfo}>
            <span className={styles.statValue}>{value}</span>
            <span className={styles.statLabel}>{label}</span>
        </div>
    </div>
);

const RoleBadge = ({ role }: { role: string }) => {
    const colors: Record<string, string> = {
        owner: '#f59e0b',
        admin: '#3b82f6',
        agent: '#8b5cf6',
        member: '#6b7280',
    };
    return (
        <span className={styles.roleBadge} style={{ backgroundColor: colors[role] || colors.member }}>
            {role.toUpperCase()}
        </span>
    );
};

const StatusBadge = ({ status }: { status: string }) => {
    const colors: Record<string, string> = {
        active: '#10b981',
        pending: '#f59e0b',
        suspended: '#ef4444',
        running: '#10b981',
        waiting: '#6b7280',
        paused: '#f59e0b',
    };
    return (
        <span className={styles.statusBadge} style={{ backgroundColor: colors[status] || '#6b7280' }}>
            {status}
        </span>
    );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function ClubDetailPage() {
    const { clubId } = useParams();
    const [activeTab, setActiveTab] = useState<'overview' | 'tables' | 'members' | 'settings'>('overview');
    const [club, setClub] = useState<ClubData | null>(null);
    const [members, setMembers] = useState<ClubMember[]>([]);
    const [tables, setTables] = useState<ClubTable[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadClubData();
    }, [clubId]);

    const loadClubData = async () => {
        setLoading(true);
        // Demo mode
        await new Promise(r => setTimeout(r, 300));
        setClub(DEMO_CLUB);
        setMembers(DEMO_MEMBERS);
        setTables(DEMO_TABLES);
        setLoading(false);
    };

    if (loading) {
        return (
            <div className={styles.loading}>
                <div className={styles.spinner} />
                <p>Loading club...</p>
            </div>
        );
    }

    if (!club) {
        return (
            <div className={styles.error}>
                <h2>Club Not Found</h2>
                <p>The club you're looking for doesn't exist.</p>
                <Link to="/clubs" className={styles.backLink}>← Back to Clubs</Link>
            </div>
        );
    }

    return (
        <div className={styles.page}>
            {/* Club Header */}
            <header className={styles.header}>
                <div className={styles.clubAvatar}>
                    {club.avatarUrl ? (
                        <img src={club.avatarUrl} alt={club.name} />
                    ) : (
                        <span>{club.name.charAt(0)}</span>
                    )}
                </div>
                <div className={styles.clubInfo}>
                    <h1>{club.name}</h1>
                    <p className={styles.clubId}>Club ID: {club.clubId}</p>
                    <p className={styles.clubDesc}>{club.description}</p>
                </div>
                <div className={styles.headerActions}>
                    <button className={styles.inviteButton}>+ Invite</button>
                    <button className={styles.createTableButton}>🎲 Create Table</button>
                </div>
            </header>

            {/* Quick Stats */}
            <section className={styles.statsRow}>
                <StatCard value={club.memberCount} label="Members" icon="👥" />
                <StatCard value={club.activeTableCount} label="Active Tables" icon="🎯" />
                <StatCard value={`${club.settings.defaultRakePercent}%`} label="Rake" icon="💰" />
                <StatCard value={`${club.settings.timeBankSeconds}s`} label="Time Bank" icon="⏱️" />
            </section>

            {/* Tab Navigation */}
            <nav className={styles.tabNav}>
                <TabButton active={activeTab === 'overview'} onClick={() => setActiveTab('overview')} icon="📊" label="Overview" />
                <TabButton active={activeTab === 'tables'} onClick={() => setActiveTab('tables')} icon="🎲" label="Tables" />
                <TabButton active={activeTab === 'members'} onClick={() => setActiveTab('members')} icon="👥" label="Members" />
                <TabButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon="⚙️" label="Settings" />
            </nav>

            {/* Tab Content */}
            <section className={styles.tabContent}>
                {/* Overview Tab */}
                {activeTab === 'overview' && (
                    <div className={styles.overviewGrid}>
                        {/* Active Tables */}
                        <div className={styles.card}>
                            <h3>🎯 Active Tables</h3>
                            {tables.filter(t => t.status === 'running').length === 0 ? (
                                <p className={styles.emptyText}>No active tables</p>
                            ) : (
                                <div className={styles.tableList}>
                                    {tables.filter(t => t.status === 'running').map(table => (
                                        <Link key={table.id} to={`/table/${table.id}`} className={styles.tableRow}>
                                            <span className={styles.tableName}>{table.name}</span>
                                            <span className={styles.tableVariant}>{table.gameVariant}</span>
                                            <span className={styles.tableStakes}>{table.stakes}</span>
                                            <span className={styles.tablePlayers}>{table.currentPlayers}/{table.maxPlayers}</span>
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Recent Members */}
                        <div className={styles.card}>
                            <h3>👥 Recent Members</h3>
                            <div className={styles.memberList}>
                                {members.slice(0, 5).map(member => (
                                    <div key={member.id} className={styles.memberRow}>
                                        <div className={styles.memberAvatar}>{member.username.charAt(0)}</div>
                                        <span className={styles.memberName}>{member.username}</span>
                                        <RoleBadge role={member.role} />
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Club Rules */}
                        <div className={styles.card}>
                            <h3>📋 Club Rules</h3>
                            <ul className={styles.rulesList}>
                                <li>Minimum buy-in: {club.settings.minBuyInBB} BB</li>
                                <li>Maximum buy-in: {club.settings.maxBuyInBB} BB</li>
                                <li>Rake: {club.settings.defaultRakePercent}% (capped at {club.settings.rakeCap} BB)</li>
                                <li>Straddle: {club.settings.allowStraddle ? 'Allowed' : 'Not allowed'}</li>
                                <li>Run it twice: {club.settings.allowRunItTwice ? 'Allowed' : 'Not allowed'}</li>
                            </ul>
                        </div>
                    </div>
                )}

                {/* Tables Tab */}
                {activeTab === 'tables' && (
                    <div className={styles.tablesContainer}>
                        <div className={styles.tablesHeader}>
                            <h3>All Tables ({tables.length})</h3>
                            <button className={styles.createButton}>+ Create Table</button>
                        </div>
                        <div className={styles.tablesGrid}>
                            {tables.map(table => (
                                <div key={table.id} className={styles.tableCard}>
                                    <div className={styles.tableCardHeader}>
                                        <h4>{table.name}</h4>
                                        <StatusBadge status={table.status} />
                                    </div>
                                    <div className={styles.tableCardBody}>
                                        <div className={styles.tableInfo}>
                                            <span>{table.gameVariant}</span>
                                            <span>{table.stakes}</span>
                                        </div>
                                        <div className={styles.tableSeats}>
                                            {table.currentPlayers}/{table.maxPlayers} players
                                        </div>
                                    </div>
                                    <Link to={`/table/${table.id}`} className={styles.joinButton}>
                                        {table.currentPlayers < table.maxPlayers ? 'Join' : 'Watch'}
                                    </Link>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Members Tab */}
                {activeTab === 'members' && (
                    <div className={styles.membersContainer}>
                        <div className={styles.membersHeader}>
                            <h3>All Members ({members.length})</h3>
                            <input type="search" placeholder="Search members..." className={styles.searchInput} />
                        </div>
                        <table className={styles.membersTable}>
                            <thead>
                                <tr>
                                    <th>Player</th>
                                    <th>Role</th>
                                    <th>Balance</th>
                                    <th>Status</th>
                                    <th>Joined</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {members.map(member => (
                                    <tr key={member.id}>
                                        <td>
                                            <div className={styles.memberCell}>
                                                <div className={styles.memberAvatarSmall}>{member.username.charAt(0)}</div>
                                                {member.username}
                                            </div>
                                        </td>
                                        <td><RoleBadge role={member.role} /></td>
                                        <td className={styles.balanceCell}>{member.chipBalance.toLocaleString()}</td>
                                        <td><StatusBadge status={member.status} /></td>
                                        <td className={styles.dateCell}>{new Date(member.joinedAt).toLocaleDateString()}</td>
                                        <td>
                                            <button className={styles.actionBtn}>⋮</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Settings Tab */}
                {activeTab === 'settings' && (
                    <div className={styles.settingsContainer}>
                        <div className={styles.settingsSection}>
                            <h3>🏠 General</h3>
                            <div className={styles.settingRow}>
                                <label>Club Name</label>
                                <input type="text" defaultValue={club.name} className={styles.textInput} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Description</label>
                                <textarea defaultValue={club.description} className={styles.textArea} rows={3} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Public Club</label>
                                <input type="checkbox" defaultChecked={club.isPublic} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Require Approval</label>
                                <input type="checkbox" defaultChecked={club.requiresApproval} />
                            </div>
                        </div>

                        <div className={styles.settingsSection}>
                            <h3>💰 Rake Settings</h3>
                            <div className={styles.settingRow}>
                                <label>Default Rake %</label>
                                <input type="number" defaultValue={club.settings.defaultRakePercent} min={0} max={10} className={styles.numberInput} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Rake Cap (BB)</label>
                                <input type="number" defaultValue={club.settings.rakeCap} min={0} max={10} className={styles.numberInput} />
                            </div>
                        </div>

                        <div className={styles.settingsSection}>
                            <h3>🎮 Table Defaults</h3>
                            <div className={styles.settingRow}>
                                <label>Min Buy-in (BB)</label>
                                <input type="number" defaultValue={club.settings.minBuyInBB} className={styles.numberInput} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Max Buy-in (BB)</label>
                                <input type="number" defaultValue={club.settings.maxBuyInBB} className={styles.numberInput} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Time Bank (seconds)</label>
                                <input type="number" defaultValue={club.settings.timeBankSeconds} className={styles.numberInput} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Allow Straddle</label>
                                <input type="checkbox" defaultChecked={club.settings.allowStraddle} />
                            </div>
                            <div className={styles.settingRow}>
                                <label>Allow Run It Twice</label>
                                <input type="checkbox" defaultChecked={club.settings.allowRunItTwice} />
                            </div>
                        </div>

                        <button className={styles.saveButton}>Save Changes</button>
                    </div>
                )}
            </section>
        </div>
    );
}
