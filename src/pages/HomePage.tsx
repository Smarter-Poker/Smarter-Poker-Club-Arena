/**
 * ♠ CLUB ARENA — Pixel Perfect PokerBros Clone
 * Pure CSS/React implementation matching the design exactly
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import styles from './HomePage.module.css';

interface Club {
    id: string;
    name: string;
    member_count: number;
    online_count: number;
    table_count: number;
}

export default function HomePage() {
    const navigate = useNavigate();
    const [clubs, setClubs] = useState<Club[]>([
        { id: '1', name: 'Featured Club', member_count: 68, online_count: 15, table_count: 4 },
        { id: '2', name: 'Diamond Club', member_count: 999, online_count: 206, table_count: 13 },
        { id: '3', name: 'Elite Club', member_count: 245, online_count: 42, table_count: 6 },
    ]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [userStats] = useState({ xp: 2350, diamonds: 126, messages: 3 });

    // Fetch clubs from Supabase
    useEffect(() => {
        async function fetchClubs() {
            try {
                const { data, error } = await supabase
                    .from('clubs')
                    .select('id, name, member_count, online_count, table_count')
                    .order('member_count', { ascending: false })
                    .limit(10);

                if (!error && data && data.length > 0) {
                    setClubs(data.map(c => ({
                        ...c,
                        online_count: c.online_count || Math.floor(c.member_count * 0.22),
                        table_count: c.table_count || Math.floor(Math.random() * 10) + 1
                    })));
                }
            } catch (err) {
                console.error('Error fetching clubs:', err);
            }
        }
        fetchClubs();
    }, []);

    const nextClub = () => setCurrentIndex((prev) => (prev + 1) % clubs.length);
    const prevClub = () => setCurrentIndex((prev) => (prev - 1 + clubs.length) % clubs.length);
    const enterClub = () => navigate(`/clubs/${clubs[currentIndex]?.id || '1'}`);

    const currentClub = clubs[currentIndex];
    const prevClubData = clubs[(currentIndex - 1 + clubs.length) % clubs.length];
    const nextClubData = clubs[(currentIndex + 1) % clubs.length];

    return (
        <div className={styles.container}>
            {/* Header Bar */}
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <div className={styles.logo}>
                        <img src="/club-arena-logo.png" alt="" className={styles.logoImg} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                        <span className={styles.logoText}>Club Arena</span>
                    </div>
                </div>
                <div className={styles.headerRight}>
                    <div className={styles.statBadge}>
                        <span className={styles.xpIcon}>⭐</span>
                        <span>{userStats.xp.toLocaleString()} XP</span>
                    </div>
                    <div className={styles.statBadge}>
                        <span className={styles.diamondIcon}>💎</span>
                        <span>{userStats.diamonds}</span>
                    </div>
                    <button className={styles.iconBtn} onClick={() => navigate('/profile')}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4" /><path d="M12 14c-6 0-8 3-8 5v1h16v-1c0-2-2-5-8-5z" /></svg>
                    </button>
                    <button className={styles.iconBtn}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" /></svg>
                    </button>
                    <button className={styles.iconBtn}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" /></svg>
                        {userStats.messages > 0 && <span className={styles.badge}>{userStats.messages}</span>}
                    </button>
                </div>
            </header>

            {/* Title */}
            <h1 className={styles.title}>Club Arena</h1>

            {/* Carousel Section */}
            <div className={styles.carouselSection}>
                {/* Left Arrow */}
                <button className={styles.arrow} onClick={prevClub}>‹</button>

                {/* Cards Container */}
                <div className={styles.cardsContainer}>
                    {/* Left Side Card */}
                    <div className={styles.sideCard}>
                        <div className={styles.sideCardName}>{prevClubData?.name}</div>
                    </div>

                    {/* Main Featured Card */}
                    <div className={styles.mainCard}>
                        <div className={styles.cardBg}></div>
                        <div className={styles.cardContent}>
                            <h2 className={styles.clubName}>{currentClub?.name || 'Featured Club'}</h2>
                            <div className={styles.stats}>
                                <div className={styles.statRow}>
                                    <span>👥</span>
                                    <span>{currentClub?.online_count} / {currentClub?.member_count} Members Online</span>
                                </div>
                                <div className={styles.statRow}>
                                    <span>🃏</span>
                                    <span>{currentClub?.table_count} Live Tables</span>
                                </div>
                            </div>
                            <button className={styles.enterBtn} onClick={enterClub}>
                                Enter
                            </button>
                        </div>
                    </div>

                    {/* Right Side Card */}
                    <div className={styles.sideCard}>
                        <div className={styles.sideCardName}>{nextClubData?.name}</div>
                        <div className={styles.sideCardStats}>
                            <div>{nextClubData?.online_count} / {nextClubData?.member_count}</div>
                            <div>🃏 {nextClubData?.table_count} Li...</div>
                        </div>
                    </div>
                </div>

                {/* Right Arrow */}
                <button className={styles.arrow} onClick={nextClub}>›</button>
            </div>

            {/* Dots */}
            <div className={styles.dots}>
                {clubs.slice(0, 3).map((_, i) => (
                    <button
                        key={i}
                        className={`${styles.dot} ${i === currentIndex % 3 ? styles.dotActive : ''}`}
                        onClick={() => setCurrentIndex(i)}
                    />
                ))}
            </div>

            {/* Action Bar */}
            <div className={styles.actionBar}>
                <button className={styles.actionItem} onClick={() => navigate('/clubs')}>
                    <div className={styles.actionIcon}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z" /></svg>
                    </div>
                    <span className={styles.actionLabel}>Join a Club</span>
                </button>
                <button className={styles.actionItem} onClick={() => navigate('/clubs/create')}>
                    <div className={styles.actionIcon}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
                    </div>
                    <span className={styles.actionLabel}>Create a Club</span>
                </button>
                <button className={styles.actionItem} onClick={() => { navigator.clipboard.writeText('https://smarter.poker/hub/club-arena'); alert('Invite link copied!'); }}>
                    <div className={styles.actionIcon}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" /></svg>
                    </div>
                    <span className={styles.actionLabel}>Invite Friends</span>
                </button>
                <button className={styles.actionItem} onClick={() => navigate('/lobby')}>
                    <div className={styles.actionIcon}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" /></svg>
                    </div>
                    <span className={styles.actionLabel}>Hand Histories</span>
                </button>
                <button className={styles.actionItem} onClick={() => window.open('/terms', '_blank')}>
                    <div className={styles.actionIcon}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" /></svg>
                    </div>
                    <span className={styles.actionLabel}>Terms of Service</span>
                </button>
            </div>
        </div>
    );
}
