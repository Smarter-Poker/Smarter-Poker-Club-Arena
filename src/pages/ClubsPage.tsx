/**
 * 🎰 CLUB ENGINE — Clubs Page
 * Browse and manage clubs
 */

import { useState } from 'react';
import styles from './ClubsPage.module.css';

type Tab = 'discover' | 'my-clubs' | 'create';

// Mock clubs data
const MOCK_MY_CLUBS = [
    {
        id: '1',
        club_id: 123456,
        name: 'Ace High Club',
        member_count: 156,
        is_owner: true,
        online_players: 23,
        tables_running: 4,
    },
    {
        id: '2',
        club_id: 789012,
        name: 'Diamond League',
        member_count: 89,
        is_owner: false,
        online_players: 12,
        tables_running: 2,
    },
];

export default function ClubsPage() {
    const [activeTab, setActiveTab] = useState<Tab>('my-clubs');
    const [joinClubId, setJoinClubId] = useState('');

    return (
        <div className={styles.page}>
            {/* Header */}
            <header className={styles.header}>
                <h1 className={styles.title}>🏛️ Clubs</h1>
                <p className={styles.subtitle}>Join private poker communities or create your own.</p>
            </header>

            {/* Tabs */}
            <div className={styles.tabs}>
                <button
                    className={`${styles.tab} ${activeTab === 'discover' ? styles.active : ''}`}
                    onClick={() => setActiveTab('discover')}
                >
                    🔍 Discover
                </button>
                <button
                    className={`${styles.tab} ${activeTab === 'my-clubs' ? styles.active : ''}`}
                    onClick={() => setActiveTab('my-clubs')}
                >
                    🏛️ My Clubs
                </button>
                <button
                    className={`${styles.tab} ${activeTab === 'create' ? styles.active : ''}`}
                    onClick={() => setActiveTab('create')}
                >
                    ➕ Create Club
                </button>
            </div>

            {/* Tab Content */}
            <div className={styles.content}>
                {/* Discover Tab */}
                {activeTab === 'discover' && (
                    <div className={styles.discoverTab}>
                        <div className={styles.joinSection}>
                            <h3>Join a Club</h3>
                            <p>Enter a 6-digit Club ID to join an existing club.</p>
                            <div className={styles.joinForm}>
                                <input
                                    type="text"
                                    placeholder="Club ID (e.g., 123456)"
                                    value={joinClubId}
                                    onChange={(e) => setJoinClubId(e.target.value)}
                                    className={styles.joinInput}
                                    maxLength={6}
                                />
                                <button className="btn btn-primary" disabled={joinClubId.length < 6}>
                                    Join Club
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* My Clubs Tab */}
                {activeTab === 'my-clubs' && (
                    <div className={styles.myClubsTab}>
                        {MOCK_MY_CLUBS.length > 0 ? (
                            <div className={styles.clubsGrid}>
                                {MOCK_MY_CLUBS.map(club => (
                                    <div key={club.id} className={styles.clubCard}>
                                        <div className={styles.clubHeader}>
                                            <div className={styles.clubAvatar}>🏛️</div>
                                            <div className={styles.clubInfo}>
                                                <h3 className={styles.clubName}>{club.name}</h3>
                                                <span className={styles.clubId}>ID: {club.club_id}</span>
                                            </div>
                                            {club.is_owner && (
                                                <span className={styles.ownerBadge}>Owner</span>
                                            )}
                                        </div>
                                        <div className={styles.clubStats}>
                                            <div className={styles.clubStat}>
                                                <span className={styles.statValue}>{club.member_count}</span>
                                                <span className={styles.statLabel}>Members</span>
                                            </div>
                                            <div className={styles.clubStat}>
                                                <span className={styles.statValue}>{club.online_players}</span>
                                                <span className={styles.statLabel}>Online</span>
                                            </div>
                                            <div className={styles.clubStat}>
                                                <span className={styles.statValue}>{club.tables_running}</span>
                                                <span className={styles.statLabel}>Tables</span>
                                            </div>
                                        </div>
                                        <button className="btn btn-primary" style={{ width: '100%' }}>
                                            Enter Club
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className={styles.emptyState}>
                                <span className={styles.emptyIcon}>🏛️</span>
                                <h3>No clubs yet</h3>
                                <p>Join an existing club or create your own to get started.</p>
                            </div>
                        )}
                    </div>
                )}

                {/* Create Club Tab */}
                {activeTab === 'create' && (
                    <div className={styles.createTab}>
                        <div className={styles.createForm}>
                            <h3>Create Your Club</h3>
                            <p>Start your own private poker community.</p>

                            <div className={styles.formGroup}>
                                <label className={styles.label}>Club Name</label>
                                <input
                                    type="text"
                                    placeholder="Enter club name"
                                    className={styles.input}
                                />
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.label}>Description</label>
                                <textarea
                                    placeholder="Describe your club..."
                                    className={styles.textarea}
                                    rows={3}
                                />
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.label}>Settings</label>
                                <div className={styles.checkboxGroup}>
                                    <label className={styles.checkbox}>
                                        <input type="checkbox" defaultChecked />
                                        <span>Public (anyone can find)</span>
                                    </label>
                                    <label className={styles.checkbox}>
                                        <input type="checkbox" />
                                        <span>Require approval for new members</span>
                                    </label>
                                </div>
                            </div>

                            <button className="btn btn-primary btn-lg" style={{ width: '100%' }}>
                                Create Club
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
