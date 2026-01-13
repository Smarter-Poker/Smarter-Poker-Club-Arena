/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Profile Page
 * User profile with XP progression, DNA, and achievements
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import styles from './ProfilePage.module.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface UserProfile {
    id: string;
    username: string;
    displayName: string;
    playerNumber: number;
    avatarUrl: string;
    vipLevel: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
    memberSince: string;
}

interface XPStats {
    currentXP: number;
    levelXP: number;
    nextLevelXP: number;
    level: number;
    tier: 'Newcomer' | 'Regular' | 'Skilled' | 'Expert' | 'Master' | 'Legend';
    streakDays: number;
    streakMultiplier: number;
}

interface PokerStats {
    totalHands: number;
    vpip: number;
    pfr: number;
    threeBet: number;
    aggression: number;
    bbPer100: number;
    biggestPot: number;
    totalProfit: number;
    winRate: number;
    tournamentsPlayed: number;
    tournamentsWon: number;
    bountyKOs: number;
}

interface Achievement {
    id: string;
    name: string;
    description: string;
    icon: string;
    unlockedAt?: string;
    progress?: number;
    maxProgress?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK DATA
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_USER: UserProfile = {
    id: 'user-123',
    username: 'Player123',
    displayName: 'AceKingMaster',
    playerNumber: 42,
    avatarUrl: '',
    vipLevel: 'gold',
    memberSince: '2025-01-15',
};

const MOCK_XP: XPStats = {
    currentXP: 8750,
    levelXP: 8750,
    nextLevelXP: 10000,
    level: 8,
    tier: 'Skilled',
    streakDays: 7,
    streakMultiplier: 1.5,
};

const MOCK_STATS: PokerStats = {
    totalHands: 15420,
    vpip: 24.5,
    pfr: 18.2,
    threeBet: 7.8,
    aggression: 2.4,
    bbPer100: 4.2,
    biggestPot: 1250,
    totalProfit: 8540,
    winRate: 56.2,
    tournamentsPlayed: 45,
    tournamentsWon: 3,
    bountyKOs: 28,
};

const MOCK_ACHIEVEMENTS: Achievement[] = [
    { id: '1', name: 'First Win', description: 'Win your first hand', icon: '🏆', unlockedAt: '2025-01-15' },
    { id: '2', name: 'Shark', description: 'Play 1,000 hands', icon: '🦈', unlockedAt: '2025-01-28' },
    { id: '3', name: 'Tournament Victor', description: 'Win a tournament', icon: '👑', unlockedAt: '2025-02-05' },
    { id: '4', name: 'Bounty Hunter', description: 'Knock out 10 players', icon: '🎯', progress: 28, maxProgress: 10, unlockedAt: '2025-02-10' },
    { id: '5', name: 'High Roller', description: 'Win a pot over 1000 chips', icon: '💎', unlockedAt: '2025-02-12' },
    { id: '6', name: 'Streak Master', description: 'Maintain a 7-day streak', icon: '🔥', progress: 7, maxProgress: 7, unlockedAt: '2025-02-15' },
    { id: '7', name: 'Grinder', description: 'Play 10,000 hands', icon: '🎰', progress: 15420, maxProgress: 10000, unlockedAt: '2025-03-01' },
    { id: '8', name: 'Legend', description: 'Reach Level 50', icon: '⭐', progress: 8, maxProgress: 50 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const VIPBadge = ({ level }: { level: string }) => {
    const colors: Record<string, string> = {
        bronze: 'linear-gradient(135deg, #cd7f32 0%, #8b4513 100%)',
        silver: 'linear-gradient(135deg, #c0c0c0 0%, #808080 100%)',
        gold: 'linear-gradient(135deg, #ffd700 0%, #b8860b 100%)',
        platinum: 'linear-gradient(135deg, #e5e4e2 0%, #a0a0a0 100%)',
        diamond: 'linear-gradient(135deg, #b9f2ff 0%, #7df9ff 50%, #00bfff 100%)',
    };

    return (
        <span
            className={styles.vipBadge}
            style={{ background: colors[level] || colors.bronze }}
        >
            {level.toUpperCase()}
        </span>
    );
};

const XPProgressBar = ({ xp }: { xp: XPStats }) => {
    const progress = (xp.levelXP / xp.nextLevelXP) * 100;

    return (
        <div className={styles.xpContainer}>
            <div className={styles.xpHeader}>
                <span className={styles.xpLevel}>Level {xp.level}</span>
                <span className={styles.xpTier}>{xp.tier}</span>
                <span className={styles.xpCount}>
                    {xp.levelXP.toLocaleString()} / {xp.nextLevelXP.toLocaleString()} XP
                </span>
            </div>
            <div className={styles.xpBar}>
                <div
                    className={styles.xpFill}
                    style={{ width: `${progress}%` }}
                />
            </div>
            {xp.streakDays > 0 && (
                <div className={styles.streakInfo}>
                    <span className={styles.streakIcon}>🔥</span>
                    <span>{xp.streakDays} Day Streak</span>
                    <span className={styles.streakMultiplier}>×{xp.streakMultiplier} XP</span>
                </div>
            )}
        </div>
    );
};

const StatCard = ({
    value,
    label,
    positive
}: {
    value: string | number;
    label: string;
    positive?: boolean | null;
}) => (
    <div className={styles.statCard}>
        <span className={`${styles.statValue} ${positive === true ? styles.positive : positive === false ? styles.negative : ''}`}>
            {value}
        </span>
        <span className={styles.statLabel}>{label}</span>
    </div>
);

const AchievementCard = ({ achievement }: { achievement: Achievement }) => {
    const isUnlocked = !!achievement.unlockedAt;
    const isComplete = achievement.progress !== undefined &&
        achievement.maxProgress !== undefined &&
        achievement.progress >= achievement.maxProgress;

    return (
        <div className={`${styles.achievementCard} ${isUnlocked ? styles.unlocked : styles.locked}`}>
            <span className={styles.achievementIcon}>{achievement.icon}</span>
            <div className={styles.achievementInfo}>
                <h4>{achievement.name}</h4>
                <p>{achievement.description}</p>
                {achievement.progress !== undefined && achievement.maxProgress !== undefined && (
                    <div className={styles.achievementProgress}>
                        <div
                            className={styles.achievementProgressFill}
                            style={{ width: `${Math.min(100, (achievement.progress / achievement.maxProgress) * 100)}%` }}
                        />
                        <span>{Math.min(achievement.progress, achievement.maxProgress)} / {achievement.maxProgress}</span>
                    </div>
                )}
            </div>
            {isUnlocked && !isComplete && (
                <span className={styles.achievementDate}>
                    {new Date(achievement.unlockedAt!).toLocaleDateString()}
                </span>
            )}
            {isComplete && <span className={styles.achievementComplete}>✓</span>}
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function ProfilePage() {
    const [activeTab, setActiveTab] = useState<'stats' | 'achievements' | 'history'>('stats');
    const user = MOCK_USER;
    const xp = MOCK_XP;
    const stats = MOCK_STATS;
    const achievements = MOCK_ACHIEVEMENTS;

    return (
        <div className={styles.page}>
            {/* Profile Header */}
            <section className={styles.profileHeader}>
                <div className={styles.avatarContainer}>
                    {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt={user.displayName} className={styles.avatar} />
                    ) : (
                        <div className={styles.avatarDefault}>
                            {user.displayName.charAt(0).toUpperCase()}
                        </div>
                    )}
                    <VIPBadge level={user.vipLevel} />
                </div>

                <div className={styles.userInfo}>
                    <h1 className={styles.displayName}>{user.displayName}</h1>
                    <p className={styles.playerNumber}>Player #{user.playerNumber}</p>
                    <p className={styles.memberSince}>
                        Member since {new Date(user.memberSince).toLocaleDateString('en-US', {
                            month: 'long',
                            year: 'numeric'
                        })}
                    </p>
                </div>

                <div className={styles.headerActions}>
                    <button className={styles.editButton}>Edit Profile</button>
                </div>
            </section>

            {/* XP Progress */}
            <section className={styles.xpSection}>
                <XPProgressBar xp={xp} />
            </section>

            {/* Tab Navigation */}
            <nav className={styles.tabNav}>
                <button
                    className={`${styles.tab} ${activeTab === 'stats' ? styles.activeTab : ''}`}
                    onClick={() => setActiveTab('stats')}
                >
                    📊 Stats
                </button>
                <button
                    className={`${styles.tab} ${activeTab === 'achievements' ? styles.activeTab : ''}`}
                    onClick={() => setActiveTab('achievements')}
                >
                    🏆 Achievements
                </button>
                <button
                    className={`${styles.tab} ${activeTab === 'history' ? styles.activeTab : ''}`}
                    onClick={() => setActiveTab('history')}
                >
                    📜 History
                </button>
            </nav>

            {/* Tab Content */}
            <section className={styles.tabContent}>
                {activeTab === 'stats' && (
                    <div className={styles.statsContainer}>
                        {/* Core Stats */}
                        <div className={styles.statsGroup}>
                            <h3>Core Stats</h3>
                            <div className={styles.statsGrid}>
                                <StatCard value={stats.totalHands.toLocaleString()} label="Hands Played" />
                                <StatCard value={`${stats.vpip}%`} label="VPIP" />
                                <StatCard value={`${stats.pfr}%`} label="PFR" />
                                <StatCard value={`${stats.threeBet}%`} label="3-Bet" />
                                <StatCard value={stats.aggression.toFixed(1)} label="Aggression" />
                                <StatCard value={`${stats.winRate}%`} label="Win Rate" positive={stats.winRate > 50} />
                            </div>
                        </div>

                        {/* Financial */}
                        <div className={styles.statsGroup}>
                            <h3>Financial</h3>
                            <div className={styles.statsGrid}>
                                <StatCard
                                    value={`${stats.bbPer100 > 0 ? '+' : ''}${stats.bbPer100}`}
                                    label="BB/100"
                                    positive={stats.bbPer100 > 0 ? true : stats.bbPer100 < 0 ? false : null}
                                />
                                <StatCard value={`${stats.biggestPot.toLocaleString()}`} label="Biggest Pot" />
                                <StatCard
                                    value={`${stats.totalProfit > 0 ? '+' : ''}${stats.totalProfit.toLocaleString()}`}
                                    label="Total Profit"
                                    positive={stats.totalProfit > 0}
                                />
                            </div>
                        </div>

                        {/* Tournament */}
                        <div className={styles.statsGroup}>
                            <h3>Tournaments</h3>
                            <div className={styles.statsGrid}>
                                <StatCard value={stats.tournamentsPlayed} label="Played" />
                                <StatCard value={stats.tournamentsWon} label="Won" />
                                <StatCard value={stats.bountyKOs} label="Bounty KOs" />
                                <StatCard
                                    value={`${((stats.tournamentsWon / stats.tournamentsPlayed) * 100).toFixed(1)}%`}
                                    label="Win Rate"
                                />
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'achievements' && (
                    <div className={styles.achievementsContainer}>
                        <div className={styles.achievementsSummary}>
                            <span>{achievements.filter(a => a.unlockedAt).length}</span>
                            <span>/ {achievements.length} Unlocked</span>
                        </div>
                        <div className={styles.achievementsGrid}>
                            {achievements.map(achievement => (
                                <AchievementCard key={achievement.id} achievement={achievement} />
                            ))}
                        </div>
                    </div>
                )}

                {activeTab === 'history' && (
                    <div className={styles.historyContainer}>
                        <div className={styles.emptyHistory}>
                            <span className={styles.emptyIcon}>🃏</span>
                            <p>No recent hands to display.</p>
                            <button className={styles.playButton}>Start Playing</button>
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
}
