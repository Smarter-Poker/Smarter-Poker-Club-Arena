/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Home Page
 * ═══════════════════════════════════════════════════════════════════════════════
 * Main landing page with club carousel and navigation
 * 
 * NO HARDCODED DATA - All data comes from Supabase
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useUserStore } from '../stores/useUserStore';
import { NoClubsEmpty, LoadingState } from '../components/common/EmptyState';
import styles from './HomePage.module.css';

interface Club {
    id: string;
    name: string;
    member_count: number;
    online_count: number;
    table_count: number;
    image_url?: string;
}

interface UserStats {
    xp: number;
    diamonds: number;
    messages: number;
}

export default function HomePage() {
    const navigate = useNavigate();
    const { user } = useUserStore();

    // Real data states - NO DEFAULTS
    const [clubs, setClubs] = useState<Club[]>([]);
    const [isLoadingClubs, setIsLoadingClubs] = useState(true);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [userStats, setUserStats] = useState<UserStats>({ xp: 0, diamonds: 0, messages: 0 });
    const [isLoadingStats, setIsLoadingStats] = useState(true);

    // Fetch clubs from Supabase
    useEffect(() => {
        async function fetchClubs() {
            setIsLoadingClubs(true);
            try {
                const { data, error } = await supabase
                    .from('clubs')
                    .select('id, name, member_count, online_count, table_count, image_url')
                    .order('member_count', { ascending: false })
                    .limit(10);

                if (error) {
                    console.error('🔴 [HOME] Failed to fetch clubs:', error);
                    setClubs([]);
                } else {
                    setClubs(data || []);
                }
            } catch (err) {
                console.error('🔴 [HOME] Error fetching clubs:', err);
                setClubs([]);
            } finally {
                setIsLoadingClubs(false);
            }
        }
        fetchClubs();
    }, []);

    // Fetch user stats from profile
    useEffect(() => {
        async function fetchUserStats() {
            setIsLoadingStats(true);
            try {
                const { data: { user: authUser } } = await supabase.auth.getUser();
                if (authUser) {
                    const { data: profile, error } = await supabase
                        .from('profiles')
                        .select('xp, diamonds')
                        .eq('id', authUser.id)
                        .single();

                    if (!error && profile) {
                        setUserStats({
                            xp: profile.xp || 0,
                            diamonds: profile.diamonds || 0,
                            messages: 0, // TODO: Wire to unread messages count
                        });
                    }
                }
            } catch (err) {
                console.error('🔴 [HOME] Error fetching user stats:', err);
            } finally {
                setIsLoadingStats(false);
            }
        }
        fetchUserStats();
    }, []);

    const nextClub = () => setCurrentIndex((prev) => (prev + 1) % clubs.length);
    const prevClub = () => setCurrentIndex((prev) => (prev - 1 + clubs.length) % clubs.length);
    const enterClub = () => {
        if (clubs[currentIndex]) {
            navigate(`/clubs/${clubs[currentIndex].id}`);
        }
    };

    const currentClub = clubs[currentIndex];
    const prevClubData = clubs.length > 1 ? clubs[(currentIndex - 1 + clubs.length) % clubs.length] : null;
    const nextClubData = clubs.length > 1 ? clubs[(currentIndex + 1) % clubs.length] : null;

    return (
        <div className={styles.container}>
            {/* ═══════════════════════════════════════════════════════════════
                HEADER BAR
            ═══════════════════════════════════════════════════════════════ */}
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <div className={styles.logo}>
                        <div className={styles.logoIcon}>♠</div>
                        <span className={styles.logoText}>Club Arena</span>
                    </div>
                </div>

                <div className={styles.headerRight}>
                    {/* XP Badge */}
                    <div className={styles.statBadge}>
                        <span className={styles.badgeIcon}>💎</span>
                        <span className={styles.badgeValue}>
                            {isLoadingStats ? '...' : `${userStats.xp.toLocaleString()} XP`}
                        </span>
                    </div>

                    {/* Diamond Badge */}
                    <div className={styles.statBadge}>
                        <span className={styles.badgeIcon}>💜</span>
                        <span className={styles.badgeValue}>
                            {isLoadingStats ? '...' : userStats.diamonds}
                        </span>
                    </div>

                    {/* Profile */}
                    <button className={styles.headerIcon} onClick={() => navigate('/profile')}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="8" r="4" />
                            <path d="M12 14c-6 0-8 3-8 5v1h16v-1c0-2-2-5-8-5z" />
                        </svg>
                    </button>

                    {/* Menu */}
                    <button className={styles.headerIcon} onClick={() => navigate('/settings')}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
                        </svg>
                    </button>

                    {/* Messages */}
                    <button className={styles.headerIcon}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                        </svg>
                        {userStats.messages > 0 && (
                            <span className={styles.notificationBadge}>{userStats.messages}</span>
                        )}
                    </button>
                </div>
            </header>

            {/* ═══════════════════════════════════════════════════════════════
                MAIN CONTENT
            ═══════════════════════════════════════════════════════════════ */}
            <main className={styles.main}>
                {/* Title */}
                <h1 className={styles.title}>Club Arena</h1>

                {/* Loading State */}
                {isLoadingClubs && <LoadingState message="Loading clubs..." />}

                {/* Empty State - No Clubs */}
                {!isLoadingClubs && clubs.length === 0 && (
                    <NoClubsEmpty onCreate={() => navigate('/clubs/create')} />
                )}

                {/* Carousel Section - Only show if clubs exist */}
                {!isLoadingClubs && clubs.length > 0 && (
                    <>
                        <div className={styles.carouselSection}>
                            {/* Left Arrow */}
                            {clubs.length > 1 && (
                                <button className={styles.carouselArrow} onClick={prevClub}>
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                                    </svg>
                                </button>
                            )}

                            {/* Cards Container */}
                            <div className={styles.cardsWrapper}>
                                {/* Left Preview Card */}
                                {prevClubData && (
                                    <div className={styles.previewCard + ' ' + styles.leftCard}>
                                        <div className={styles.previewCardInner}>
                                            <span className={styles.previewName}>{prevClubData.name}</span>
                                        </div>
                                    </div>
                                )}

                                {/* Main Featured Card */}
                                <div className={styles.mainCard}>
                                    <div className={styles.cardBackground}>
                                        <div className={styles.pokerTableBg}></div>
                                    </div>
                                    <div className={styles.cardContent}>
                                        <h2 className={styles.clubName}>{currentClub?.name}</h2>

                                        <div className={styles.clubStats}>
                                            <div className={styles.stat}>
                                                <span className={styles.statIcon}>👥</span>
                                                <span>
                                                    {currentClub?.online_count || 0} / {currentClub?.member_count || 0} Members Online
                                                </span>
                                            </div>
                                            <div className={styles.stat}>
                                                <span className={styles.statIcon}>🎴</span>
                                                <span>{currentClub?.table_count || 0} Live Tables</span>
                                            </div>
                                        </div>

                                        <button className={styles.enterButton} onClick={enterClub}>
                                            Enter
                                        </button>
                                    </div>
                                </div>

                                {/* Right Preview Card */}
                                {nextClubData && (
                                    <div className={styles.previewCard + ' ' + styles.rightCard}>
                                        <div className={styles.previewCardInner}>
                                            <span className={styles.previewName}>{nextClubData.name}</span>
                                            <div className={styles.previewStats}>
                                                <div>{nextClubData.online_count} / {nextClubData.member_count} M...</div>
                                                <div>🎴 {nextClubData.table_count} Li...</div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Right Arrow */}
                            {clubs.length > 1 && (
                                <button className={styles.carouselArrow} onClick={nextClub}>
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z" />
                                    </svg>
                                </button>
                            )}
                        </div>

                        {/* Carousel Dots */}
                        {clubs.length > 1 && (
                            <div className={styles.carouselDots}>
                                {clubs.slice(0, Math.min(clubs.length, 5)).map((_, i) => (
                                    <button
                                        key={i}
                                        className={`${styles.dot} ${i === currentIndex % clubs.length ? styles.dotActive : ''}`}
                                        onClick={() => setCurrentIndex(i)}
                                        aria-label={`Go to club ${i + 1}`}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                )}
            </main>

            {/* ═══════════════════════════════════════════════════════════════
                BOTTOM ACTION BAR
            ═══════════════════════════════════════════════════════════════ */}
            <footer className={styles.actionBar}>
                <button className={styles.actionButton} onClick={() => navigate('/clubs')}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Join a Club</span>
                </button>

                <button className={styles.actionButton} onClick={() => navigate('/clubs/create')}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Create a Club</span>
                </button>

                <button className={styles.actionButton} onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/clubs`);
                    alert('Invite link copied!');
                }}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Invite Friends</span>
                </button>

                <button className={styles.actionButton} onClick={() => navigate('/lobby')}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <ellipse cx="12" cy="6" rx="8" ry="3" />
                            <path d="M4 6v4c0 1.66 3.58 3 8 3s8-1.34 8-3V6c0 1.66-3.58 3-8 3S4 7.66 4 6z" />
                            <path d="M4 10v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4c0 1.66-3.58 3-8 3s-8-1.34-8-3z" />
                            <path d="M4 14v4c0 1.66 3.58 3 8 3s8-1.34 8-3v-4c0 1.66-3.58 3-8 3s-8-1.34-8-3z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Hand Histories</span>
                </button>

                <button className={styles.actionButton} onClick={() => window.open('/terms', '_blank')}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Terms of Service</span>
                </button>
            </footer>
        </div>
    );
}
