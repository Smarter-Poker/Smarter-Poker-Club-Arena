/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Profile Page
 * User profile with XP progression, DNA, and achievements
 * 
 * NO HARDCODED DATA - All data comes from Supabase
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useUserStore } from '../stores/useUserStore';
import { LoadingState } from '../components/common/EmptyState';
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
// DEFAULT VALUES (for new users with no data)
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_XP: XPStats = {
    currentXP: 0,
    levelXP: 0,
    nextLevelXP: 1000,
    level: 1,
    tier: 'Newcomer',
    streakDays: 0,
    streakMultiplier: 1,
};

const DEFAULT_STATS: PokerStats = {
    totalHands: 0,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    aggression: 0,
    bbPer100: 0,
    biggestPot: 0,
    totalProfit: 0,
    winRate: 0,
    tournamentsPlayed: 0,
    tournamentsWon: 0,
    bountyKOs: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function calculateLevel(xp: number): { level: number; tier: XPStats['tier'] } {
    const level = Math.floor(xp / 1000) + 1;
    let tier: XPStats['tier'] = 'Newcomer';
    if (level >= 50) tier = 'Legend';
    else if (level >= 30) tier = 'Master';
    else if (level >= 20) tier = 'Expert';
    else if (level >= 10) tier = 'Skilled';
    else if (level >= 5) tier = 'Regular';
    return { level, tier };
}

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
    const progress = xp.nextLevelXP > 0 ? (xp.levelXP / xp.nextLevelXP) * 100 : 0;

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
                <div className={styles.xpFill} style={{ width: `${progress}%` }} />
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

const StatCard = ({ value, label, positive }: { value: string | number; label: string; positive?: boolean | null }) => (
    <div className={styles.statCard}>
        <span className={`${styles.statValue} ${positive === true ? styles.positive : positive === false ? styles.negative : ''}`}>
            {value}
        </span>
        <span className={styles.statLabel}>{label}</span>
    </div>
);

const AchievementCard = ({ achievement }: { achievement: Achievement }) => {
    const isUnlocked = !!achievement.unlockedAt;
    const isComplete = achievement.progress !== undefined && achievement.maxProgress !== undefined && achievement.progress >= achievement.maxProgress;

    return (
        <div className={`${styles.achievementCard} ${isUnlocked ? styles.unlocked : styles.locked}`}>
            <span className={styles.achievementIcon}>{achievement.icon}</span>
            <div className={styles.achievementInfo}>
                <h4>{achievement.name}</h4>
                <p>{achievement.description}</p>
                {achievement.progress !== undefined && achievement.maxProgress !== undefined && (
                    <div className={styles.achievementProgress}>
                        <div className={styles.achievementProgressFill} style={{ width: `${Math.min(100, (achievement.progress / achievement.maxProgress) * 100)}%` }} />
                        <span>{Math.min(achievement.progress, achievement.maxProgress)} / {achievement.maxProgress}</span>
                    </div>
                )}
            </div>
            {isUnlocked && !isComplete && <span className={styles.achievementDate}>{new Date(achievement.unlockedAt!).toLocaleDateString()}</span>}
            {isComplete && <span className={styles.achievementComplete}>✓</span>}
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function ProfilePage() {
    const { user: storeUser } = useUserStore();
    const [activeTab, setActiveTab] = useState<'stats' | 'achievements' | 'history'>('stats');
    const [isLoading, setIsLoading] = useState(true);

    // Real data from database
    const [user, setUser] = useState<UserProfile | null>(null);
    const [xp, setXp] = useState<XPStats>(DEFAULT_XP);
    const [stats, setStats] = useState<PokerStats>(DEFAULT_STATS);
    const [achievements, setAchievements] = useState<Achievement[]>([]);

    // Load profile data from Supabase
    useEffect(() => {
        async function loadProfile() {
            setIsLoading(true);
            try {
                const { data: { user: authUser } } = await supabase.auth.getUser();
                if (!authUser) return;

                const { data: profile } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('id', authUser.id)
                    .single();

                if (profile) {
                    const { level, tier } = calculateLevel(profile.xp || 0);

                    setUser({
                        id: profile.id,
                        username: profile.username || 'Player',
                        displayName: profile.display_name || profile.username || 'Player',
                        playerNumber: profile.player_number || Math.floor(Math.random() * 9999) + 1,
                        avatarUrl: profile.avatar_url || '',
                        vipLevel: profile.vip_level || 'bronze',
                        memberSince: profile.created_at,
                    });

                    setXp({
                        currentXP: profile.xp || 0,
                        levelXP: (profile.xp || 0) % 1000,
                        nextLevelXP: 1000,
                        level,
                        tier,
                        streakDays: profile.streak_days || 0,
                        streakMultiplier: 1 + (profile.streak_days || 0) * 0.1,
                    });

                    if (profile.stats) {
                        setStats({
                            totalHands: profile.stats.total_hands || 0,
                            vpip: profile.stats.vpip || 0,
                            pfr: profile.stats.pfr || 0,
                            threeBet: profile.stats.three_bet || 0,
                            aggression: profile.stats.aggression_factor || 0,
                            bbPer100: profile.stats.bb_per_100 || 0,
                            biggestPot: profile.stats.biggest_pot || 0,
                            totalProfit: profile.stats.total_profit || 0,
                            winRate: profile.stats.win_rate || 0,
                            tournamentsPlayed: profile.stats.tournaments_played || 0,
                            tournamentsWon: profile.stats.tournaments_won || 0,
                            bountyKOs: profile.stats.bounty_kos || 0,
                        });
                    }
                }

                // Load achievements if table exists
                try {
                    const { data: userAchievements } = await supabase
                        .from('user_achievements')
                        .select('*, achievement:achievements(*)')
                        .eq('user_id', authUser.id);

                    if (userAchievements) {
                        setAchievements(userAchievements.map(ua => ({
                            id: ua.achievement?.id || ua.id,
                            name: ua.achievement?.name || 'Achievement',
                            description: ua.achievement?.description || '',
                            icon: ua.achievement?.icon || '🏆',
                            unlockedAt: ua.unlocked_at,
                            progress: ua.progress,
                            maxProgress: ua.achievement?.max_progress,
                        })));
                    }
                } catch {
                    // Achievements table may not exist yet
                    setAchievements([]);
                }
            } catch (err) {
                console.error('🔴 [PROFILE] Load failed:', err);
            } finally {
                setIsLoading(false);
            }
        }
        loadProfile();
    }, []);

    if (isLoading) {
        return <LoadingState message="Loading profile..." />;
    }

    if (!user) {
        return (
            <div className={styles.page}>
                <div className={styles.emptyProfile}>
                    <span style={{ fontSize: '3rem' }}>👤</span>
                    <p>Profile not found</p>
                </div>
            </div>
        );
    }

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
                        Member since {new Date(user.memberSince).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
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
                <button className={`${styles.tab} ${activeTab === 'stats' ? styles.activeTab : ''}`} onClick={() => setActiveTab('stats')}>
                    📊 Stats
                </button>
                <button className={`${styles.tab} ${activeTab === 'achievements' ? styles.activeTab : ''}`} onClick={() => setActiveTab('achievements')}>
                    🏆 Achievements
                </button>
                <button className={`${styles.tab} ${activeTab === 'history' ? styles.activeTab : ''}`} onClick={() => setActiveTab('history')}>
                    📜 History
                </button>
            </nav>

            {/* Tab Content */}
            <section className={styles.tabContent}>
                {activeTab === 'stats' && (
                    <div className={styles.statsContainer}>
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

                        <div className={styles.statsGroup}>
                            <h3>Financial</h3>
                            <div className={styles.statsGrid}>
                                <StatCard value={`${stats.bbPer100 > 0 ? '+' : ''}${stats.bbPer100}`} label="BB/100" positive={stats.bbPer100 > 0 ? true : stats.bbPer100 < 0 ? false : null} />
                                <StatCard value={stats.biggestPot.toLocaleString()} label="Biggest Pot" />
                                <StatCard value={`${stats.totalProfit > 0 ? '+' : ''}${stats.totalProfit.toLocaleString()}`} label="Total Profit" positive={stats.totalProfit > 0} />
                            </div>
                        </div>

                        <div className={styles.statsGroup}>
                            <h3>Tournaments</h3>
                            <div className={styles.statsGrid}>
                                <StatCard value={stats.tournamentsPlayed} label="Played" />
                                <StatCard value={stats.tournamentsWon} label="Won" />
                                <StatCard value={stats.bountyKOs} label="Bounty KOs" />
                                <StatCard value={stats.tournamentsPlayed > 0 ? `${((stats.tournamentsWon / stats.tournamentsPlayed) * 100).toFixed(1)}%` : '0%'} label="Win Rate" />
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'achievements' && (
                    <div className={styles.achievementsContainer}>
                        {achievements.length > 0 ? (
                            <>
                                <div className={styles.achievementsSummary}>
                                    <span>{achievements.filter(a => a.unlockedAt).length}</span>
                                    <span>/ {achievements.length} Unlocked</span>
                                </div>
                                <div className={styles.achievementsGrid}>
                                    {achievements.map(achievement => (
                                        <AchievementCard key={achievement.id} achievement={achievement} />
                                    ))}
                                </div>
                            </>
                        ) : (
                            <div className={styles.emptyAchievements}>
                                <span style={{ fontSize: '3rem' }}>🏆</span>
                                <p>No achievements yet. Start playing to unlock achievements!</p>
                            </div>
                        )}
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
