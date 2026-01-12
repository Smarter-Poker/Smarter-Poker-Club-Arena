/**
 * ♠ CLUB ARENA — Hand Replay Viewer
 * PokerBros-style hand history replay with timeline scrubbing
 */

import { useState, useEffect, useRef } from 'react';
import type { Card, CardSuit, CardRank } from '../../types/database.types';
import './HandReplay.css';

interface PlayerAction {
    player_id: string;
    action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in';
    amount?: number;
    timestamp: number;
}

interface HandPlayer {
    seat: number;
    user_id: string;
    username: string;
    avatar_url: string | null;
    position: 'UTG' | 'MP' | 'CO' | 'BTN' | 'SB' | 'BB';
    hole_cards: Card[];
    final_hand?: string; // "Two Pair", "One Pair", etc.
    result: number; // +/- chips
    is_winner: boolean;
}

interface HandData {
    id: string;
    serial_number: string;
    played_at: string;
    hand_number: number;
    total_hands: number;
    main_pot: number;
    community_cards: Card[];
    players: HandPlayer[];
    actions: PlayerAction[];
}

interface HandReplayProps {
    handId?: string;
    handData?: HandData;
    onClose?: () => void;
}

// Helper to convert suit name to symbol
function getSuitSymbol(suit: CardSuit): string {
    switch (suit) {
        case 'hearts': return '♥';
        case 'diamonds': return '♦';
        case 'clubs': return '♣';
        case 'spades': return '♠';
        default: return suit;
    }
}

// Color helper for suits
function getSuitColor(suit: CardSuit): 'red' | 'black' {
    return suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
}

// Position badge colors
function getPositionColor(position: string): string {
    switch (position) {
        case 'BTN': return '#10b981';
        case 'SB': return '#3b82f6';
        case 'BB': return '#f97316';
        case 'UTG': return '#ef4444';
        case 'MP': return '#8b5cf6';
        case 'CO': return '#22c55e';
        default: return '#6b7280';
    }
}

export default function HandReplay({ handId: propHandId, handData: initialData, onClose }: HandReplayProps) {
    // Support both prop-based and route-based usage
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const pathParts = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
    const routeHandId = pathParts[pathParts.indexOf('replay') + 1];
    const handId = propHandId || routeHandId;

    const [handData, setHandData] = useState<HandData | null>(initialData || null);
    const [activeTab, setActiveTab] = useState<'summary' | 'detail'>('summary');
    const [isLoading, setIsLoading] = useState(!initialData);
    const [currentStep, setCurrentStep] = useState(1);
    const [totalSteps, setTotalSteps] = useState(1);
    const [isPlaying, setIsPlaying] = useState(false);

    const playbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        // Always load demo data for now (or fetch from API when handId is provided)
        loadHandData();
    }, [handId]);

    useEffect(() => {
        if (handData) {
            // Calculate total steps based on community cards stages
            // (preflop, flop, turn, river, showdown)
            const stages = 1 + // preflop
                (handData.community_cards.length >= 3 ? 1 : 0) + // flop
                (handData.community_cards.length >= 4 ? 1 : 0) + // turn
                (handData.community_cards.length >= 5 ? 1 : 0);  // river
            setTotalSteps(stages);
        }
    }, [handData]);

    const loadHandData = async () => {
        setIsLoading(true);
        try {
            // In production, fetch from API
            // const data = await handHistoryService.getHand(handId);
            // setHandData(data);

            // Demo data for now
            setHandData(getDemoHandData());
        } catch (error) {
            console.error('Failed to load hand:', error);
        }
        setIsLoading(false);
    };

    const handlePlay = () => {
        if (isPlaying) {
            if (playbackRef.current) clearInterval(playbackRef.current);
            setIsPlaying(false);
        } else {
            setIsPlaying(true);
            playbackRef.current = setInterval(() => {
                setCurrentStep((prev) => {
                    if (prev >= totalSteps) {
                        if (playbackRef.current) clearInterval(playbackRef.current);
                        setIsPlaying(false);
                        return prev;
                    }
                    return prev + 1;
                });
            }, 1500);
        }
    };

    const handleStepChange = (step: number) => {
        setCurrentStep(step);
        if (playbackRef.current) clearInterval(playbackRef.current);
        setIsPlaying(false);
    };

    const handlePrev = () => {
        if (currentStep > 1) setCurrentStep((prev) => prev - 1);
    };

    const handleNext = () => {
        if (currentStep < totalSteps) setCurrentStep((prev) => prev + 1);
    };

    const handleShare = async () => {
        const shareUrl = `https://smarter.poker/replay/${handData?.id}`;
        const shareText = `Check out this hand I played on Smarter.Poker! #PlayPoker`;

        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Smarter.Poker Hand Replay',
                    text: shareText,
                    url: shareUrl,
                });
            } catch {
                copyToClipboard(shareUrl);
            }
        } else {
            copyToClipboard(shareUrl);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        alert('Link copied to clipboard!');
    };

    const formatDate = (date: string) => {
        return new Date(date).toLocaleString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).replace(',', '');
    };

    // Get visible community cards based on current step
    const getVisibleCommunityCards = () => {
        if (!handData) return [];
        switch (currentStep) {
            case 1: return []; // preflop
            case 2: return handData.community_cards.slice(0, 3); // flop
            case 3: return handData.community_cards.slice(0, 4); // turn
            case 4: return handData.community_cards; // river
            default: return handData.community_cards;
        }
    };

    if (isLoading) {
        return (
            <div className="hand-replay loading">
                <div className="loader-spinner" />
                <p>Loading hand...</p>
            </div>
        );
    }

    if (!handData) {
        return (
            <div className="hand-replay error">
                <p>Hand not found</p>
                {onClose && <button onClick={onClose}>Close</button>}
            </div>
        );
    }

    return (
        <div className="hand-replay">
            {/* Header */}
            <header className="replay-header">
                <h1>HAND DETAIL</h1>
                <div className="header-actions">
                    <button className="action-btn star">☆</button>
                    <button className="action-btn play" onClick={handlePlay}>
                        {isPlaying ? '⏸' : '▶'}
                    </button>
                </div>
            </header>

            {/* Meta Info */}
            <div className="replay-meta">
                <span className="meta-date">{formatDate(handData.played_at)}</span>
                <span className="meta-hand">{handData.hand_number} / {handData.total_hands}</span>
                <span className="meta-sn">SN: {handData.serial_number}</span>
            </div>

            {/* Share Button */}
            <div className="share-row">
                <button className="share-btn" onClick={handleShare}>
                    Share 📤
                </button>
            </div>

            {/* Main Pot */}
            <div className="main-pot">
                <span>Main Pot : </span>
                <span className="pot-amount">{handData.main_pot.toLocaleString()}</span>
            </div>

            {/* Players Table */}
            <div className="players-table">
                {handData.players.map((player) => (
                    <div key={player.user_id} className={`player-row ${player.is_winner ? 'winner' : ''}`}>
                        {/* Name & Position */}
                        <div className="player-info">
                            <span className="player-name">{player.username}</span>
                            <span
                                className="player-position"
                                style={{ backgroundColor: getPositionColor(player.position) }}
                            >
                                {player.position}
                            </span>
                        </div>

                        {/* Hole Cards */}
                        <div className="player-hole-cards">
                            {player.hole_cards.length > 0 ? (
                                player.hole_cards.map((card, idx) => (
                                    <div key={idx} className={`card ${getSuitColor(card.suit)}`}>
                                        <span className="card-rank">{card.rank}</span>
                                        <span className="card-suit">{getSuitSymbol(card.suit)}</span>
                                    </div>
                                ))
                            ) : (
                                <>
                                    <div className="card back" />
                                    <div className="card back" />
                                </>
                            )}
                        </div>

                        {/* Hand Ranking (if shown) */}
                        {player.final_hand && (
                            <div className="player-hand-ranking">
                                {player.final_hand}
                            </div>
                        )}

                        {/* Community Cards (repeated per row for visual) */}
                        <div className="community-cards-row">
                            {getVisibleCommunityCards().map((card, idx) => (
                                <div key={idx} className={`card small ${getSuitColor(card.suit)}`}>
                                    <span className="card-rank">{card.rank}</span>
                                    <span className="card-suit">{getSuitSymbol(card.suit)}</span>
                                </div>
                            ))}
                        </div>

                        {/* Result */}
                        <div className={`player-result ${player.result >= 0 ? 'positive' : 'negative'}`}>
                            {player.result >= 0 ? '+' : ''}{player.result.toLocaleString()}
                            <br />
                            <span className="result-label">Main pot</span>
                        </div>
                    </div>
                ))}
            </div>

            {/* Playback Controls */}
            <div className="playback-controls">
                <span className="step-display">{currentStep}/{totalSteps}</span>
            </div>

            <div className="playback-slider-row">
                <button className="nav-arrow" onClick={handlePrev} disabled={currentStep <= 1}>◀</button>
                <input
                    type="range"
                    className="playback-slider"
                    min={1}
                    max={totalSteps}
                    value={currentStep}
                    onChange={(e) => handleStepChange(Number(e.target.value))}
                />
                <button className="nav-arrow" onClick={handleNext} disabled={currentStep >= totalSteps}>▶</button>
            </div>

            {/* Tab Switcher */}
            <div className="replay-tabs">
                <button
                    className={`replay-tab ${activeTab === 'summary' ? 'active' : ''}`}
                    onClick={() => setActiveTab('summary')}
                >
                    Hand Summary
                </button>
                <button
                    className={`replay-tab ${activeTab === 'detail' ? 'active' : ''}`}
                    onClick={() => setActiveTab('detail')}
                >
                    Hand Detail
                </button>
            </div>
        </div>
    );
}

// Demo data generator
function getDemoHandData(): HandData {
    return {
        id: '2049883074',
        serial_number: '2049883074',
        played_at: '2026-01-12T14:51:23',
        hand_number: 5,
        total_hands: 10,
        main_pot: 2265,
        community_cards: [
            { rank: 'A', suit: 'spades' },
            { rank: '5', suit: 'diamonds' },
            { rank: '9', suit: 'hearts' },
            { rank: '5', suit: 'spades' },
            { rank: '2', suit: 'hearts' },
        ],
        players: [
            {
                seat: 1,
                user_id: 'p1',
                username: '-KingFish-',
                avatar_url: null,
                position: 'UTG',
                hole_cards: [
                    { rank: 'T', suit: 'clubs' },
                    { rank: '4', suit: 'spades' },
                ],
                result: -10,
                is_winner: false,
            },
            {
                seat: 2,
                user_id: 'p2',
                username: 'soul king',
                avatar_url: null,
                position: 'BTN',
                hole_cards: [],
                result: 0,
                is_winner: false,
            },
            {
                seat: 3,
                user_id: 'p3',
                username: 'cubby2426',
                avatar_url: null,
                position: 'SB',
                hole_cards: [],
                result: -5,
                is_winner: false,
            },
            {
                seat: 4,
                user_id: 'p4',
                username: 'Im gna CUM',
                avatar_url: null,
                position: 'BB',
                hole_cards: [
                    { rank: 'K', suit: 'spades' },
                    { rank: 'K', suit: 'hearts' },
                ],
                final_hand: 'One Pair',
                result: -1125,
                is_winner: false,
            },
            {
                seat: 5,
                user_id: 'p5',
                username: 'Wizurd',
                avatar_url: null,
                position: 'MP',
                hole_cards: [],
                result: 0,
                is_winner: false,
            },
            {
                seat: 6,
                user_id: 'p6',
                username: 'monkey88',
                avatar_url: null,
                position: 'CO',
                hole_cards: [
                    { rank: 'T', suit: 'diamonds' },
                    { rank: 'T', suit: 'hearts' },
                ],
                final_hand: 'Two Pair',
                result: 1137.73,
                is_winner: true,
            },
        ],
        actions: [],
    };
}

export { HandReplay };
