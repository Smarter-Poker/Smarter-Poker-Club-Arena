/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Home Page (Hub-Style Floating Cards)
 * ═══════════════════════════════════════════════════════════════════════════════
 * 3D Floating Cards with Neon-Cyan borders matching World Hub design
 * - NO header, NO footer
 * - Floating 3D cards in carousel
 * - Holographic cyberpunk aesthetic
 * - All-caps futuristic typography
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import styles from './HomePage.module.css';

interface Club {
    id: string;
    name: string;
    description?: string;
    member_count: number;
    online_count: number;
    table_count: number;
}

export default function HomePage() {
    const navigate = useNavigate();

    // Real data states
    const [clubs, setClubs] = useState<Club[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [currentIndex, setCurrentIndex] = useState(0);

    // Fetch clubs from Supabase
    useEffect(() => {
        async function fetchClubs() {
            setIsLoading(true);
            try {
                const { data, error } = await supabase
                    .from('clubs')
                    .select('id, name, description, member_count, online_count, table_count')
                    .order('member_count', { ascending: false })
                    .limit(10);

                if (!error && data) {
                    setClubs(data);
                }
            } catch (err) {
                console.error('Error fetching clubs:', err);
            } finally {
                setIsLoading(false);
            }
        }
        fetchClubs();
    }, []);

    const nextCard = () => setCurrentIndex((prev) => (prev + 1) % 5);
    const prevCard = () => setCurrentIndex((prev) => (prev - 1 + 5) % 5);

    // Action cards data - these navigate to real functional pages
    const actionCards = [
        {
            id: 'join',
            title: 'JOIN CLUB',
            subtitle: 'FIND YOUR TABLE',
            description: 'JOIN A CLUB AND PLAY WITH MEMBERS WORLDWIDE',
            icon: '👥',
            action: () => navigate('/clubs'),
        },
        {
            id: 'create',
            title: 'CREATE CLUB',
            subtitle: 'BUILD YOUR EMPIRE',
            description: 'START YOUR OWN CLUB AND INVITE PLAYERS',
            icon: '➕',
            action: () => navigate('/clubs/create'),
        },
        {
            id: 'lobby',
            title: 'GAME LOBBY',
            subtitle: 'LIVE TABLES',
            description: 'VIEW ALL ACTIVE TABLES AND JOIN A GAME',
            icon: '🎴',
            action: () => navigate('/lobby'),
        },
        {
            id: 'friends',
            title: 'FIND FRIENDS',
            subtitle: 'CONNECT & PLAY',
            description: 'INVITE FRIENDS AND PLAY TOGETHER',
            icon: '🔍',
            action: () => navigate('/friends'),
        },
        {
            id: 'profile',
            title: 'MY PROFILE',
            subtitle: 'STATS & HISTORY',
            description: 'VIEW YOUR STATS, ACHIEVEMENTS AND HAND HISTORY',
            icon: '👤',
            action: () => navigate('/profile'),
        },
    ];

    // Get visible cards for carousel (3 at a time)
    const getVisibleCards = () => {
        const prev = (currentIndex - 1 + actionCards.length) % actionCards.length;
        const next = (currentIndex + 1) % actionCards.length;
        return [actionCards[prev], actionCards[currentIndex], actionCards[next]];
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
                                    <p className={styles.cardDescription}>{card.description}</p>
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

            {/* Bottom Row - Smaller Card Tiles */}
            <div className={styles.bottomRow}>
                {actionCards.map((card, index) => (
                    <button
                        key={card.id}
                        className={`${styles.tileCard} ${index === currentIndex ? styles.tileActive : ''}`}
                        onClick={() => {
                            setCurrentIndex(index);
                            card.action();
                        }}
                    >
                        <div className={styles.tileBorder}></div>
                        <div className={styles.tileContent}>
                            <span className={styles.tileIcon}>{card.icon}</span>
                            <span className={styles.tileTitle}>{card.title}</span>
                            <span className={styles.tileSubtitle}>{card.subtitle}</span>
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
