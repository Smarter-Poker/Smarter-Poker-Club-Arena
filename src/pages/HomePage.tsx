/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Home Page (Pixel-Perfect PokerBros Clone)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Matches the PokerBros reference template EXACTLY
 * - 3-card carousel layout
 * - Header with stats badges
 * - Bottom action bar with circular buttons
 * - NO external headers/footers
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useUserStore } from '../stores/useUserStore';
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

    // Real data states
    const [clubs, setClubs] = useState<Club[]>([]);
    const [isLoadingClubs, setIsLoadingClubs] = useState(true);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [userStats, setUserStats] = useState<UserStats>({ xp: 0, diamonds: 0, messages: 0 });

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

                if (!error && data && data.length > 0) {
                    setClubs(data);
                }
            } catch (err) {
                console.error('Error fetching clubs:', err);
            } finally {
                setIsLoadingClubs(false);
            }
        }
        fetchClubs();
    }, []);

    // Fetch user stats
    useEffect(() => {
        async function fetchUserStats() {
            try {
                const { data: { user: authUser } } = await supabase.auth.getUser();
                if (authUser) {
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('xp, diamonds')
                        .eq('id', authUser.id)
                        .single();

                    if (profile) {
                        setUserStats({
                            xp: profile.xp || 0,
                            diamonds: profile.diamonds || 0,
                            messages: 0,
                        });
                    }
                }
            } catch (err) {
                // Use defaults
            }
        }
        fetchUserStats();
    }, []);

    const nextClub = () => setCurrentIndex((prev) => (prev + 1) % Math.max(clubs.length, 1));
    const prevClub = () => setCurrentIndex((prev) => (prev - 1 + Math.max(clubs.length, 1)) % Math.max(clubs.length, 1));
    const enterClub = () => {
        if (clubs[currentIndex]) {
            navigate(`/clubs/${clubs[currentIndex].id}`);
        }
    };

    const currentClub = clubs[currentIndex] || { name: 'Featured Club', member_count: 68, online_count: 15, table_count: 4 };
    const prevClubData = clubs.length > 1 ? clubs[(currentIndex - 1 + clubs.length) % clubs.length] : null;
    const nextClubData = clubs.length > 1 ? clubs[(currentIndex + 1) % clubs.length] : null;

    return (
        <div className={styles.container}>
            {/* ═══════════════════════════════════════════════════════════════
                HEADER BAR (PokerBros Style)
            ═══════════════════════════════════════════════════════════════ */}
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <div className={styles.logo}>
                        <div className={styles.logoIcon}>
                            <img src="/poker-chip-logo.png" alt="" className={styles.logoImg} />
                        </div>
                        <span className={styles.logoText}>Club Arena</span>
                    </div>
                </div>

                <div className={styles.headerRight}>
                    {/* XP Badge - Yellow Diamond */}
                    <div className={styles.statBadge}>
                        <span className={styles.xpIcon}>💎</span>
                        <span className={styles.badgeValue}>{userStats.xp || 2350} XP</span>
                    </div>

                    {/* Hearts Badge - Purple */}
                    <div className={styles.statBadge}>
                        <span className={styles.heartIcon}>💜</span>
                        <span className={styles.badgeValue}>{userStats.diamonds || 126}</span>
                    </div>

                    {/* Profile Icon */}
                    <button className={styles.headerIcon} onClick={() => navigate('/profile')}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="8" r="4" />
                            <path d="M12 14c-6 0-8 3-8 5v1h16v-1c0-2-2-5-8-5z" />
                        </svg>
                    </button>

                    {/* Menu Icon */}
                    <button className={styles.headerIcon} onClick={() => navigate('/settings')}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
                        </svg>
                    </button>

                    {/* Messages Icon with Badge */}
                    <button className={styles.headerIcon}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                        </svg>
                        <span className={styles.notificationBadge}>3</span>
                    </button>
                </div>
            </header>

            {/* ═══════════════════════════════════════════════════════════════
                MAIN CONTENT - 3 Card Carousel
            ═══════════════════════════════════════════════════════════════ */}
            <main className={styles.main}>
                <h1 className={styles.title}>Club Arena</h1>

                {/* 3-Card Carousel */}
                <div className={styles.carouselSection}>
                    {/* Left Arrow */}
                    <button className={styles.carouselArrow} onClick={prevClub}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                        </svg>
                    </button>

                    {/* Cards Container */}
                    <div className={styles.cardsWrapper}>
                        {/* Left Preview Card */}
                        <div className={`${styles.previewCard} ${styles.leftCard}`}>
                            <div className={styles.previewCardInner}>
                                <span className={styles.previewName}>{prevClubData?.name || 'Elite Club'}</span>
                            </div>
                        </div>

                        {/* Main Featured Card with Poker Table Background */}
                        <div className={styles.mainCard}>
                            <div className={styles.cardBackground}>
                                <img src="/poker-table-bg.png" alt="" className={styles.tableBgImage} />
                                <div className={styles.cardOverlay}></div>
                            </div>
                            <div className={styles.cardContent}>
                                <h2 className={styles.clubName}>{currentClub.name}</h2>

                                <div className={styles.clubStats}>
                                    <div className={styles.stat}>
                                        <span className={styles.statIcon}>👥</span>
                                        <span>{currentClub.online_count} / {currentClub.member_count} Members Online</span>
                                    </div>
                                    <div className={styles.stat}>
                                        <span className={styles.statIcon}>🎴</span>
                                        <span>{currentClub.table_count} Live Tables</span>
                                    </div>
                                </div>

                                <button className={styles.enterButton} onClick={enterClub}>
                                    Enter
                                </button>
                            </div>
                        </div>

                        {/* Right Preview Card */}
                        <div className={`${styles.previewCard} ${styles.rightCard}`}>
                            <div className={styles.previewCardInner}>
                                <span className={styles.previewName}>{nextClubData?.name || 'Diamond'}</span>
                                <div className={styles.previewStats}>
                                    <div>206 / 999 M...</div>
                                    <div>🎴 13 Li...</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Arrow */}
                    <button className={styles.carouselArrow} onClick={nextClub}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z" />
                        </svg>
                    </button>
                </div>

                {/* Carousel Dots */}
                <div className={styles.carouselDots}>
                    {[0, 1, 2].map((i) => (
                        <button
                            key={i}
                            className={`${styles.dot} ${i === currentIndex % 3 ? styles.dotActive : ''}`}
                            onClick={() => setCurrentIndex(i)}
                        />
                    ))}
                </div>
            </main>

            {/* ═══════════════════════════════════════════════════════════════
                BOTTOM ACTION BAR - 5 Circular Buttons
            ═══════════════════════════════════════════════════════════════ */}
            <footer className={styles.actionBar}>
                {/* Join a Club */}
                <button className={styles.actionButton} onClick={() => navigate('/clubs')}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Join a Club</span>
                </button>

                {/* Create a Club */}
                <button className={styles.actionButton} onClick={() => navigate('/clubs/create')}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Create a Club</span>
                </button>

                {/* Invite Friends (was Terms of Service) */}
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

                {/* Hand Histories - Poker Chips Icon */}
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

                {/* Find Friends */}
                <button className={styles.actionButton} onClick={() => navigate('/friends')}>
                    <div className={styles.actionIconWrapper}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                        </svg>
                    </div>
                    <span className={styles.actionLabel}>Find Friends</span>
                </button>
            </footer>
        </div>
    );
}
