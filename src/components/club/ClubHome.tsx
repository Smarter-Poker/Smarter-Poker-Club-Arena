/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🏠 CLUB HOME — Management Dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The main dashboard for a specific club.
 * - Overview stats (Members, Chips, Tables)
 * - Quick actions (Create Table, Add Member, Settings)
 * - Recent Activity feed
 */

import React from 'react';
import './ClubHome.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ClubStats {
    memberCount: number;
    onlineCount: number;
    activeTables: number;
    totalChips: number;
    jackpotBalance: number;
}

export interface ClubActivity {
    id: string;
    type: 'game_start' | 'game_end' | 'member_join' | 'jackpot_hit';
    message: string;
    time: string; // e.g., "2m ago"
}

export interface ClubHomeProps {
    clubName: string;
    clubId: string;
    ownerName: string;
    level: number;
    stats: ClubStats;
    activities: ClubActivity[];
    onCreateTable: () => void;
    onManageMembers: () => void;
    onClubSettings: () => void;
    onCashier: () => void;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ClubHome({
    clubName,
    clubId,
    ownerName,
    level,
    stats,
    activities,
    onCreateTable,
    onManageMembers,
    onClubSettings,
    onCashier,
    currency = '💎',
}: ClubHomeProps) {
    return (
        <div className="club-home">
            {/* Hero Section */}
            <div className="club-home__hero">
                <div className="club-home__avatar-large">
                    {clubName.substring(0, 2).toUpperCase()}
                </div>
                <div className="club-home__info">
                    <h1 className="club-home__title">{clubName}</h1>
                    <div className="club-home__meta">
                        <span className="club-home__id">ID: {clubId}</span>
                        <span className="club-home__owner">Owner: {ownerName}</span>
                        <span className="club-home__level">Level {level}</span>
                    </div>
                </div>
                <div className="club-home__actions">
                    <button className="club-home__btn club-home__btn--primary" onClick={onCreateTable}>
                        + New Table
                    </button>
                    <button className="club-home__btn" onClick={onClubSettings}>
                        ⚙️ Settings
                    </button>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="club-home__stats">
                <div className="club-stat-card">
                    <span className="club-stat-card__label">Members</span>
                    <span className="club-stat-card__value">
                        {stats.onlineCount} <span className="club-stat-card__sub">/ {stats.memberCount}</span>
                    </span>
                </div>
                <div className="club-stat-card">
                    <span className="club-stat-card__label">Active Tables</span>
                    <span className="club-stat-card__value">{stats.activeTables}</span>
                </div>
                <div className="club-stat-card">
                    <span className="club-stat-card__label">Total Chips</span>
                    <span className="club-stat-card__value">{currency}{stats.totalChips.toLocaleString()}</span>
                </div>
                <div className="club-stat-card club-stat-card--highlight">
                    <span className="club-stat-card__label">Jackpot</span>
                    <span className="club-stat-card__value">{currency}{stats.jackpotBalance.toLocaleString()}</span>
                </div>
            </div>

            <div className="club-home__content">
                {/* Quick Menu */}
                <div className="club-home__menu">
                    <h3 className="club-home__section-title">Management</h3>
                    <div className="club-menu-grid">
                        <button className="club-menu-item" onClick={onManageMembers}>
                            <span className="club-menu-item__icon">👥</span>
                            <span className="club-menu-item__label">Members</span>
                        </button>
                        <button className="club-menu-item" onClick={onCashier}>
                            <span className="club-menu-item__icon">💰</span>
                            <span className="club-menu-item__label">Cashier</span>
                        </button>
                        <button className="club-menu-item">
                            <span className="club-menu-item__icon">📊</span>
                            <span className="club-menu-item__label">Reports</span>
                        </button>
                        <button className="club-menu-item">
                            <span className="club-menu-item__icon">📩</span>
                            <span className="club-menu-item__label">Mail</span>
                        </button>
                    </div>
                </div>

                {/* Recent Activity */}
                <div className="club-home__activity">
                    <h3 className="club-home__section-title">Recent Activity</h3>
                    <div className="club-activity-list">
                        {activities.length > 0 ? (
                            activities.map((activity) => (
                                <div key={activity.id} className="club-activity-item">
                                    <div className={`club-activity-icon club-activity-icon--${activity.type}`}>
                                        {activity.type === 'game_start' && '🎮'}
                                        {activity.type === 'game_end' && '🏁'}
                                        {activity.type === 'member_join' && '👋'}
                                        {activity.type === 'jackpot_hit' && '💰'}
                                    </div>
                                    <div className="club-activity-text">
                                        <p className="club-activity-msg">{activity.message}</p>
                                        <span className="club-activity-time">{activity.time}</span>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="club-activity-empty">No recent activity</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ClubHome;
