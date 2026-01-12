/**
 * ♠ CLUB ARENA — Clubs Page
 * Browse, join, and manage clubs (PokerBros style)
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import './ClubsPage.css';

type Tab = 'my-clubs' | 'discover' | 'create';

// Mock data
const MOCK_MY_CLUBS = [
    {
        id: '1',
        clubId: 123456,
        name: 'Ace High Club',
        members: 156,
        online: 23,
        tables: 4,
        isOwner: true,
        avatar: '🏛️',
    },
    {
        id: '2',
        clubId: 789012,
        name: 'Diamond League',
        members: 89,
        online: 12,
        tables: 2,
        isOwner: false,
        avatar: '💎',
    },
    {
        id: '3',
        clubId: 345678,
        name: 'High Rollers',
        members: 234,
        online: 45,
        tables: 8,
        isOwner: false,
        avatar: '🎰',
    },
];

const MOCK_DISCOVER_CLUBS = [
    {
        id: '4',
        clubId: 111222,
        name: 'The Shark Tank',
        members: 567,
        online: 89,
        tables: 12,
        description: 'High stakes action, serious players only.',
        avatar: '🦈',
    },
    {
        id: '5',
        clubId: 333444,
        name: 'Friendly Fishes',
        members: 123,
        online: 34,
        tables: 3,
        description: 'Casual games, all skill levels welcome!',
        avatar: '🐟',
    },
    {
        id: '6',
        clubId: 555666,
        name: 'Tournament Kings',
        members: 890,
        online: 156,
        tables: 15,
        description: 'Daily tournaments with huge prize pools.',
        avatar: '👑',
    },
];

export default function ClubsPage() {
    const [activeTab, setActiveTab] = useState<Tab>('my-clubs');
    const [joinClubId, setJoinClubId] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    const filteredDiscoverClubs = MOCK_DISCOVER_CLUBS.filter(club =>
        club.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="clubs-page">
            {/* Header */}
            <header className="clubs-header">
                <h1>🏛️ Clubs</h1>
                <p>Join private poker communities or create your own.</p>
            </header>

            {/* Tabs */}
            <div className="clubs-tabs">
                <button
                    className={`clubs-tab ${activeTab === 'my-clubs' ? 'active' : ''}`}
                    onClick={() => setActiveTab('my-clubs')}
                >
                    🏠 My Clubs
                </button>
                <button
                    className={`clubs-tab ${activeTab === 'discover' ? 'active' : ''}`}
                    onClick={() => setActiveTab('discover')}
                >
                    🔍 Discover
                </button>
                <button
                    className={`clubs-tab ${activeTab === 'create' ? 'active' : ''}`}
                    onClick={() => setActiveTab('create')}
                >
                    ➕ Create Club
                </button>
            </div>

            {/* Tab Content */}
            <div className="clubs-content">
                {/* My Clubs */}
                {activeTab === 'my-clubs' && (
                    <div className="my-clubs">
                        {MOCK_MY_CLUBS.length > 0 ? (
                            <div className="clubs-grid">
                                {MOCK_MY_CLUBS.map(club => (
                                    <Link to={`/clubs/${club.id}`} key={club.id} className="club-card">
                                        <div className="club-card-header">
                                            <div className="club-avatar">{club.avatar}</div>
                                            <div className="club-info">
                                                <h3>{club.name}</h3>
                                                <span className="club-id">ID: {club.clubId}</span>
                                            </div>
                                            {club.isOwner && <span className="owner-badge">Owner</span>}
                                        </div>
                                        <div className="club-stats">
                                            <div className="club-stat">
                                                <span className="stat-value">{club.members}</span>
                                                <span className="stat-label">Members</span>
                                            </div>
                                            <div className="club-stat">
                                                <span className="stat-value online">{club.online}</span>
                                                <span className="stat-label">Online</span>
                                            </div>
                                            <div className="club-stat">
                                                <span className="stat-value">{club.tables}</span>
                                                <span className="stat-label">Tables</span>
                                            </div>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        ) : (
                            <div className="empty-state">
                                <span className="empty-icon">🏛️</span>
                                <h3>No clubs yet</h3>
                                <p>Join a club or create your own to get started!</p>
                                <button className="btn btn-primary" onClick={() => setActiveTab('discover')}>
                                    Browse Clubs
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Discover */}
                {activeTab === 'discover' && (
                    <div className="discover-clubs">
                        {/* Join by ID */}
                        <div className="join-section">
                            <h3>Join by Club ID</h3>
                            <div className="join-form">
                                <input
                                    type="text"
                                    className="input join-input"
                                    placeholder="Enter 6-digit Club ID"
                                    value={joinClubId}
                                    onChange={(e) => setJoinClubId(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                    maxLength={6}
                                />
                                <button className="btn btn-primary" disabled={joinClubId.length < 6}>
                                    Join Club
                                </button>
                            </div>
                        </div>

                        {/* Search */}
                        <div className="search-section">
                            <h3>Browse Public Clubs</h3>
                            <input
                                type="text"
                                className="input search-input"
                                placeholder="Search clubs..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        {/* Club List */}
                        <div className="clubs-grid">
                            {filteredDiscoverClubs.map(club => (
                                <div key={club.id} className="club-card discover-card">
                                    <div className="club-card-header">
                                        <div className="club-avatar">{club.avatar}</div>
                                        <div className="club-info">
                                            <h3>{club.name}</h3>
                                            <span className="club-id">ID: {club.clubId}</span>
                                        </div>
                                    </div>
                                    <p className="club-description">{club.description}</p>
                                    <div className="club-stats">
                                        <div className="club-stat">
                                            <span className="stat-value">{club.members}</span>
                                            <span className="stat-label">Members</span>
                                        </div>
                                        <div className="club-stat">
                                            <span className="stat-value online">{club.online}</span>
                                            <span className="stat-label">Online</span>
                                        </div>
                                        <div className="club-stat">
                                            <span className="stat-value">{club.tables}</span>
                                            <span className="stat-label">Tables</span>
                                        </div>
                                    </div>
                                    <button className="btn btn-primary" style={{ width: '100%' }}>
                                        Request to Join
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Create Club */}
                {activeTab === 'create' && (
                    <div className="create-club">
                        <div className="create-form-container">
                            <h2>Create Your Club</h2>
                            <p>Start your own private poker community.</p>

                            <form className="create-form">
                                <div className="form-group">
                                    <label>Club Name</label>
                                    <input type="text" className="input" placeholder="Enter club name" />
                                </div>

                                <div className="form-group">
                                    <label>Description</label>
                                    <textarea className="input textarea" placeholder="Describe your club..." rows={3} />
                                </div>

                                <div className="form-group">
                                    <label>Settings</label>
                                    <div className="checkbox-group">
                                        <label className="checkbox-label">
                                            <input type="checkbox" defaultChecked />
                                            <span>Public (visible in discovery)</span>
                                        </label>
                                        <label className="checkbox-label">
                                            <input type="checkbox" />
                                            <span>Require approval for new members</span>
                                        </label>
                                        <label className="checkbox-label">
                                            <input type="checkbox" defaultChecked />
                                            <span>Enable GPS restrictions</span>
                                        </label>
                                    </div>
                                </div>

                                <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }}>
                                    Create Club
                                </button>
                            </form>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
