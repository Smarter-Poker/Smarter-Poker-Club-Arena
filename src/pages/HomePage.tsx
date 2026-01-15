/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Home Page (Hub-Style Exact Match)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Exact match to World Hub design with:
 * - Top icon bar (diamonds, XP, notifications, profile, help)
 * - 5 specific cards matching Hub: Trivia, Social, Club Arena, Training, Diamond
 * - NO traditional header/footer - floating icons only
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useUserStore } from '../stores/useUserStore';
import styles from './HomePage.module.css';

export default function HomePage() {
    const navigate = useNavigate();
    const { user } = useUserStore();

    // Real data states
    const [diamonds, setDiamonds] = useState(0);
    const [xp, setXp] = useState(0);
    const [level, setLevel] = useState(1);
    const [currentIndex, setCurrentIndex] = useState(2); // Start on Club Arena (center)
    const [isLoading, setIsLoading] = useState(true);

    // Fetch user stats from Supabase
    useEffect(() => {
        async function fetchUserStats() {
            setIsLoading(true);
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    // Fetch diamonds from wallet/economy
                    const { data: walletData } = await supabase
                        .from('diamond_wallets')
                        .select('balance')
                        .eq('user_id', user.id)
                        .single();

                    if (walletData) {
                        setDiamonds(walletData.balance || 0);
                    }

                    // Fetch XP from profile
                    const { data: profileData } = await supabase
                        .from('profiles')
                        .select('xp, level')
                        .eq('id', user.id)
                        .single();

                    if (profileData) {
                        setXp(profileData.xp || 0);
                        setLevel(profileData.level || 1);
                    }
                }
            } catch (err) {
                console.error('Error fetching user stats:', err);
            } finally {
                setIsLoading(false);
            }
        }
        fetchUserStats();
    }, []);

    const nextCard = () => setCurrentIndex((prev) => (prev + 1) % 5);
    const prevCard = () => setCurrentIndex((prev) => (prev - 1 + 5) % 5);

    // The 5 Hub Cards - EXACT MATCH to World Hub
    const hubCards = [
        {
            id: 'trivia',
            title: 'TRIVIA',
            subtitle: 'POKER TRIVIA',
            description: 'COMPETITIVE GAMES AND MORE!',
            icon: '❓',
            color: '#ff6b6b',
            action: () => navigate('/trivia'),
        },
        {
            id: 'social',
            title: 'SOCIAL MEDIA',
            subtitle: 'CONNECT WITH FRIENDS',
            description: 'SHARE WHAT MATTERS\nSTAY CONNECTED TO THE POKER WORLD',
            icon: '👥',
            color: '#00d4ff',
            action: () => navigate('/social'),
        },
        {
            id: 'club-arena',
            title: 'CLUB ARENA',
            subtitle: 'HIGH-STAKES SHOWDOWN',
            description: 'PLAY AGAINST OTHER PLAYERS\nIN CLUBS AROUND THE WORLD',
            icon: '🦁',
            color: '#00d4ff',
            action: () => navigate('/clubs'),
        },
        {
            id: 'training',
            title: 'TRAINING GAMES',
            subtitle: 'SHARPEN YOUR SKILLS',
            description: 'MASTER THE GAME',
            icon: '🧠',
            color: '#00d4ff',
            action: () => navigate('/training'),
        },
        {
            id: 'diamond',
            title: 'DIAMOND ARENA',
            subtitle: 'PLAY LIVE POKER',
            description: 'WITH DIAMONDS',
            icon: '💎',
            color: '#00d4ff',
            action: () => window.location.href = 'https://diamond.smarter.poker',
        },
    ];

    // Get visible cards for carousel (3 at a time)
    const getVisibleCards = () => {
        const prev = (currentIndex - 1 + hubCards.length) % hubCards.length;
        const next = (currentIndex + 1) % hubCards.length;
        return [hubCards[prev], hubCards[currentIndex], hubCards[next]];
    };

    const visibleCards = getVisibleCards();

    return (
        <div className={styles.container}>
            {/* Background with circuit pattern */}
            <div className={styles.backgroundLayer}>
                <div className={styles.circuitPattern}></div>
                <div className={styles.glowOrb1}></div>
                <div className={styles.glowOrb2}></div>
                <div className={styles.glowOrb3}></div>
            </div>

            {/* TOP FLOATING ICON BAR */}
            <div className={styles.topBar}>
                {/* Left: Logo */}
                <div className={styles.logoSection}>
                    <span className={styles.logoIcon}>♠</span>
                    <span className={styles.logoText}>SMARTER POKER</span>
                </div>

                {/* Center: Stats */}
                <div className={styles.statsSection}>
                    <div className={styles.statBadge}>
                        <span className={styles.statIcon}>💎</span>
                        <span className={styles.statValue}>{diamonds}</span>
                        <button className={styles.addButton}>+</button>
                    </div>
                    <div className={styles.statBadge}>
                        <span className={styles.statLabel}>XP</span>
                        <span className={styles.statValue}>{xp}</span>
                        <span className={styles.levelBadge}>LV {level}</span>
                    </div>
                </div>

                {/* Right: Icons */}
                <div className={styles.iconsSection}>
                    <button className={styles.iconButton} onClick={() => navigate('/messages')}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" /></svg>
                    </button>
                    <button className={styles.iconButton} onClick={() => navigate('/notifications')}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" /></svg>
                    </button>
                    <button className={styles.profileButton} onClick={() => navigate('/profile')}>
                        {user?.avatar_url ? (
                            <img src={user.avatar_url} alt="Profile" className={styles.profileAvatar} />
                        ) : (
                            <span>👤</span>
                        )}
                    </button>
                    <button className={styles.iconButton} onClick={() => navigate('/search')}>
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" /></svg>
                    </button>
                    <button className={styles.helpButton} onClick={() => navigate('/help')}>
                        HELP
                    </button>
                </div>
            </div>

            {/* Welcome Message */}
            <div className={styles.welcomeMessage}>
                Welcome Back, {user?.username || 'Player'}
            </div>

            {/* Main 3D Carousel - 3 Floating Cards */}
            <div className={styles.carouselContainer}>
                {/* Left Arrow */}
                <button className={styles.navArrow} onClick={prevCard}>
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                    </svg>
                </button>

                {/* 3 Floating Cards */}
                <div className={styles.cardsRow}>
                    {visibleCards.map((card, index) => (
                        <div
                            key={card.id}
                            className={`${styles.floatingCard} ${index === 1 ? styles.centerCard : styles.sideCard
                                } ${index === 0 ? styles.leftCard : ''} ${index === 2 ? styles.rightCard : ''}`}
                            onClick={card.action}
                        >
                            {/* Neon border glow */}
                            <div className={styles.cardBorderGlow}></div>

                            {/* Card inner content */}
                            <div className={styles.cardInner}>
                                {/* Title area */}
                                <div className={styles.cardHeader}>
                                    <h2 className={styles.cardTitle}>{card.title}</h2>
                                    <span className={styles.cardSubtitle}>{card.subtitle}</span>
                                </div>

                                {/* Holographic icon area */}
                                <div className={styles.holoArea}>
                                    <div className={styles.holoCircle}>
                                        <span className={styles.holoIcon}>{card.icon}</span>
                                    </div>
                                    <div className={styles.techLines}></div>
                                </div>

                                {/* Footer description */}
                                <div className={styles.cardFooter}>
                                    <p className={styles.cardDescription}>
                                        {card.description.split('\n').map((line, i) => (
                                            <span key={i}>{line}<br /></span>
                                        ))}
                                    </p>
                                </div>
                            </div>

                            {/* Reflection */}
                            <div className={styles.cardReflection}></div>
                        </div>
                    ))}
                </div>

                {/* Right Arrow */}
                <button className={styles.navArrow} onClick={nextCard}>
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z" />
                    </svg>
                </button>
            </div>

            {/* Bottom Row - 5 Card Tiles (EXACT Hub Match) */}
            <div className={styles.bottomRow}>
                {hubCards.map((card, index) => (
                    <button
                        key={card.id}
                        className={`${styles.tileCard} ${index === currentIndex ? styles.tileActive : ''}`}
                        onClick={() => {
                            setCurrentIndex(index);
                        }}
                        onDoubleClick={card.action}
                    >
                        <div className={styles.tileBorder}></div>
                        <div className={styles.tileContent}>
                            <span className={styles.tileIcon}>{card.icon}</span>
                            <span className={styles.tileTitle}>{card.title}</span>
                            <span className={styles.tileSubtitle}>
                                {card.description.split('\n')[0]}
                            </span>
                        </div>
                    </button>
                ))}
            </div>

            {/* Loading indicator */}
            {isLoading && (
                <div className={styles.loadingOverlay}>
                    <div className={styles.spinner}></div>
                </div>
            )}
        </div>
    );
}
