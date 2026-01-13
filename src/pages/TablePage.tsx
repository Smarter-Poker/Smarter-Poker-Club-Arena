/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ARENA — Premium Poker Table Page
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style table interface with Facebook color scheme
 * Features:
 * - Oval table with premium rail
 * - 6-max or 9-max seating
 * - Real-time pot and community cards
 * - Action panel with raise slider
 * - Jackpot banner
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SeatSlot, PotDisplay, CommunityCards } from '../components/table';
import type { SeatPlayer, Card, LastAction, PositionBadge } from '../components/table/SeatSlot';
import type { SidePot } from '../components/table/PotDisplay';
import type { BoardStage } from '../components/table/CommunityCards';
import './TablePage.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableState {
    tableId: string;
    tableName: string;
    gameType: 'NLH' | 'PLO4' | 'PLO5' | 'PLO6';
    blinds: string;
    maxPlayers: 6 | 9;
    pot: number;
    sidePots: SidePot[];
    communityCards: Card[];
    boardStage: BoardStage;
    dealerSeat: number;
    currentPlayerSeat: number;
    heroSeat: number;
    players: SeatPlayer[];
    jackpotAmount: number;
    isHandInProgress: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_PLAYERS: SeatPlayer[] = [
    {
        id: 'u1',
        name: 'soul king',
        avatar: '',
        stack: 4642.84,
        status: 'active',
        isHero: false,
        showCards: false,
        holeCards: [
            { rank: 'K', suit: 's' },
            { rank: 'Q', suit: 'h' },
        ],
    },
    {
        id: 'u2',
        name: 'monkey88',
        avatar: '',
        stack: 1115,
        status: 'active',
        isHero: false,
        showCards: false,
    },
    {
        id: 'u3',
        name: 'cubby2426',
        avatar: '',
        stack: 2475,
        status: 'active',
        isHero: false,
        showCards: false,
    },
    {
        id: 'u4',
        name: 'Im gna CUM',
        avatar: '',
        stack: 2490,
        status: 'active',
        isHero: false,
        showCards: false,
    },
    {
        id: 'u5',
        name: 'Wizurd',
        avatar: '',
        stack: 5998.05,
        status: 'active',
        isHero: false,
        showCards: false,
    },
    {
        id: 'hero',
        name: '-KingFish-',
        avatar: '',
        stack: 2490,
        status: 'active',
        isHero: true,
        showCards: true,
        holeCards: [
            { rank: 'A', suit: 'h' },
            { rank: '4', suit: 'd' },
        ],
    },
];

const DEMO_POSITIONS: PositionBadge[] = ['D', null, 'SB', null, 'BB', null];
const DEMO_LAST_ACTIONS: LastAction[] = [null, 'bet', null, null, null, null];

const DEMO_COMMUNITY: Card[] = [
    { rank: 'A', suit: 's' },
    { rank: '5', suit: 'c' },
    { rank: '9', suit: 'd' },
    { rank: '5', suit: 'h' },
    { rank: '2', suit: 'c' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

const SEAT_POSITIONS_6MAX = [
    { x: 50, y: 88 },  // Seat 1 (Hero - bottom center)
    { x: 12, y: 65 },  // Seat 2 (left bottom)
    { x: 12, y: 35 },  // Seat 3 (left top)
    { x: 50, y: 8 },   // Seat 4 (top center)
    { x: 88, y: 35 },  // Seat 5 (right top)
    { x: 88, y: 65 },  // Seat 6 (right bottom)
];

const SEAT_POSITIONS_9MAX = [
    { x: 50, y: 90 },  // Seat 1 (Hero)
    { x: 20, y: 82 },  // Seat 2
    { x: 5, y: 60 },   // Seat 3
    { x: 5, y: 38 },   // Seat 4
    { x: 25, y: 10 },  // Seat 5
    { x: 50, y: 5 },   // Seat 6
    { x: 75, y: 10 },  // Seat 7
    { x: 95, y: 38 },  // Seat 8
    { x: 95, y: 60 },  // Seat 9
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function TablePage() {
    const { tableId } = useParams<{ tableId: string }>();
    const navigate = useNavigate();

    // State
    const [tableState, setTableState] = useState<TableState>({
        tableId: tableId || 'demo-table',
        tableName: '12-Jan 5🐘20🐘 6MAX RIT (Paradise)',
        gameType: 'NLH',
        blinds: '5/10',
        maxPlayers: 6,
        pot: 35,
        sidePots: [],
        communityCards: DEMO_COMMUNITY.slice(0, 3), // Just flop
        boardStage: 'flop',
        dealerSeat: 1,
        currentPlayerSeat: 6,
        heroSeat: 6,
        players: DEMO_PLAYERS,
        jackpotAmount: 139381,
        isHandInProgress: true,
    });

    const [raiseAmount, setRaiseAmount] = useState(20);
    const [showRaiseSlider, setShowRaiseSlider] = useState(false);
    const [actionTimeRemaining, setActionTimeRemaining] = useState(15);
    const [isSideMenuOpen, setIsSideMenuOpen] = useState(false);

    // Get seat positions based on table size
    const seatPositions = tableState.maxPlayers === 9 ? SEAT_POSITIONS_9MAX : SEAT_POSITIONS_6MAX;

    // Find player at specific seat (1-indexed)
    const getPlayerAtSeat = useCallback((seatNumber: number): SeatPlayer | undefined => {
        // Map players to seats (for demo, use index)
        return tableState.players[seatNumber - 1];
    }, [tableState.players]);

    // Handle seat click (sit down at empty seat)
    const handleSeatClick = (seatNumber: number) => {
        console.log('Seat clicked:', seatNumber);
        // Would open buy-in modal
    };

    // Action handlers
    const handleFold = () => {
        console.log('Fold clicked');
    };

    const handleCheck = () => {
        console.log('Check clicked');
    };

    const handleCall = () => {
        console.log('Call clicked');
    };

    const handleBet = () => {
        setShowRaiseSlider(true);
    };

    const handleRaise = () => {
        setShowRaiseSlider(true);
    };

    const handleConfirmRaise = () => {
        console.log('Raise confirmed:', raiseAmount);
        setShowRaiseSlider(false);
    };

    const handleAllIn = () => {
        console.log('All-in clicked');
    };

    // Side menu toggle
    const toggleSideMenu = () => {
        setIsSideMenuOpen(!isSideMenuOpen);
    };

    // Timer countdown (demo)
    useEffect(() => {
        if (tableState.currentPlayerSeat === tableState.heroSeat && actionTimeRemaining > 0) {
            const timer = setInterval(() => {
                setActionTimeRemaining(prev => Math.max(0, prev - 1));
            }, 1000);
            return () => clearInterval(timer);
        }
    }, [tableState.currentPlayerSeat, tableState.heroSeat, actionTimeRemaining]);

    return (
        <div className="table-page">
            {/* ═══════════════════════════════════════════════════════════════════════
          HEADER BAR
          ═══════════════════════════════════════════════════════════════════════ */}
            <header className="table-header">
                <button className="header-btn menu-btn" onClick={toggleSideMenu}>
                    <span className="menu-icon">≡</span>
                </button>

                <div className="jackpot-banner">
                    <span className="jackpot-label">JACKPOT</span>
                    <span className="jackpot-amount">{tableState.jackpotAmount.toLocaleString()}</span>
                    <span className="jackpot-diamond">💎</span>
                </div>

                <div className="header-actions">
                    <button className="header-btn" title="Help">?</button>
                    <button className="header-btn" title="Info">📋</button>
                    <button className="header-btn table-id" title="Table ID">
                        {tableState.tableId.slice(0, 8)}
                    </button>
                </div>
            </header>

            {/* ═══════════════════════════════════════════════════════════════════════
          ADD CHIPS BUTTON (Left side)
          ═══════════════════════════════════════════════════════════════════════ */}
            <button className="add-chips-btn" title="Add Chips">
                <span>+</span>
            </button>

            {/* ═══════════════════════════════════════════════════════════════════════
          TABLE AREA
          ═══════════════════════════════════════════════════════════════════════ */}
            <div className="table-container">
                {/* Table Felt */}
                <div className="table-felt">
                    <div className="table-rail">
                        <div className="table-surface">

                            {/* Pot Display */}
                            <div className="pot-area">
                                <PotDisplay
                                    mainPot={tableState.pot}
                                    sidePots={tableState.sidePots}
                                />
                            </div>

                            {/* Community Cards */}
                            <div className="community-area">
                                <CommunityCards
                                    cards={tableState.communityCards}
                                    stage={tableState.boardStage}
                                    highlightedIndices={[]}
                                />
                            </div>

                            {/* Game Info */}
                            <div className="game-info">
                                <span className="game-type">{tableState.gameType}</span>
                                <span className="game-variant">CLASSIC HOLD'EM 🏆 (4)</span>
                                <span className="game-blinds">Blinds: {tableState.blinds}</span>
                            </div>

                        </div>
                    </div>
                </div>

                {/* Player Seats */}
                {seatPositions.map((pos, idx) => {
                    const seatNumber = idx + 1;
                    const player = getPlayerAtSeat(seatNumber);

                    return (
                        <div
                            key={seatNumber}
                            className="seat-wrapper"
                            style={{
                                left: `${pos.x}%`,
                                top: `${pos.y}%`,
                            }}
                        >
                            <SeatSlot
                                seatNumber={seatNumber}
                                player={player || null}
                                position={DEMO_POSITIONS[idx] || null}
                                isActive={seatNumber === tableState.currentPlayerSeat}
                                lastAction={DEMO_LAST_ACTIONS[idx] || null}
                                timerProgress={seatNumber === tableState.currentPlayerSeat ? (actionTimeRemaining / 15) * 100 : undefined}
                                onSit={() => handleSeatClick(seatNumber)}
                            />
                        </div>
                    );
                })}
            </div>

            {/* ═══════════════════════════════════════════════════════════════════════
          ACTION PANEL
          ═══════════════════════════════════════════════════════════════════════ */}
            <div className="action-panel">
                {showRaiseSlider ? (
                    /* Raise Slider Mode */
                    <div className="raise-slider-panel">
                        <div className="raise-display">
                            <span className="raise-amount">{raiseAmount}</span>
                        </div>
                        <div className="raise-controls">
                            <button
                                className="raise-adjust-btn"
                                onClick={() => setRaiseAmount(prev => Math.max(10, prev - 10))}
                            >
                                −
                            </button>
                            <input
                                type="range"
                                className="raise-slider"
                                min={tableState.pot}
                                max={getPlayerAtSeat(tableState.heroSeat)?.stack || 1000}
                                value={raiseAmount}
                                onChange={(e) => setRaiseAmount(Number(e.target.value))}
                            />
                            <button
                                className="raise-adjust-btn"
                                onClick={() => setRaiseAmount(prev => prev + 10)}
                            >
                                +
                            </button>
                        </div>
                        <div className="raise-presets">
                            <button className="preset-btn" onClick={() => setRaiseAmount(tableState.pot * 2)}>2X</button>
                            <button className="preset-btn" onClick={() => setRaiseAmount(tableState.pot * 3)}>3X</button>
                            <button className="preset-btn" onClick={() => setRaiseAmount(tableState.pot * 4)}>4X</button>
                            <button className="confirm-btn" onClick={handleConfirmRaise}>Confirm</button>
                        </div>
                    </div>
                ) : (
                    /* Normal Action Buttons */
                    <div className="action-buttons">
                        <div className="timer-display">
                            <span className="timer-icon">⏱</span>
                            <span className="timer-value">{actionTimeRemaining}</span>
                            <span className="time-bank">20s</span>
                        </div>
                        <button className="action-btn fold-btn" onClick={handleFold}>
                            Fold
                        </button>
                        <button className="action-btn check-btn" onClick={handleCheck}>
                            Check
                        </button>
                        <button className="action-btn raise-btn" onClick={handleRaise}>
                            Raise
                        </button>
                    </div>
                )}
            </div>

            {/* ═══════════════════════════════════════════════════════════════════════
          SIDE MENU (Slide-in)
          ═══════════════════════════════════════════════════════════════════════ */}
            {isSideMenuOpen && (
                <>
                    <div className="menu-overlay" onClick={toggleSideMenu} />
                    <nav className="side-menu">
                        <button className="menu-item" onClick={() => navigate('/cashier')}>
                            <span className="menu-item-icon">💳</span>
                            <span className="menu-item-label">Cashier</span>
                            <span className="menu-item-arrow">›</span>
                        </button>
                        <button className="menu-item">
                            <span className="menu-item-icon">💎</span>
                            <span className="menu-item-label">Top Up</span>
                            <span className="menu-item-arrow">›</span>
                        </button>
                        <button className="menu-item">
                            <span className="menu-item-icon">⚙️</span>
                            <span className="menu-item-label">Table Settings</span>
                            <span className="menu-item-arrow">›</span>
                        </button>
                        <button className="menu-item">
                            <span className="menu-item-icon">🔊</span>
                            <span className="menu-item-label">Sounds</span>
                            <span className="menu-item-arrow">›</span>
                        </button>
                        <button className="menu-item">
                            <span className="menu-item-icon">📳</span>
                            <span className="menu-item-label">Vibrations</span>
                            <span className="menu-item-toggle on">ON</span>
                        </button>
                        <button className="menu-item">
                            <span className="menu-item-icon">📤</span>
                            <span className="menu-item-label">Share</span>
                            <span className="menu-item-arrow">›</span>
                        </button>
                        <button className="menu-item">
                            <span className="menu-item-icon">👑</span>
                            <span className="menu-item-label">VIP</span>
                            <span className="menu-item-arrow">›</span>
                        </button>
                        <button className="menu-item exit" onClick={() => navigate('/')}>
                            <span className="menu-item-icon">🚪</span>
                            <span className="menu-item-label">Exit</span>
                            <span className="menu-item-arrow">›</span>
                        </button>
                        <div className="menu-footer">
                            Version: 1.0.0 (Club Arena)
                        </div>
                    </nav>
                </>
            )}

            {/* Observing Mode Indicator (when not seated) */}
            {!tableState.players.some(p => p?.isHero) && (
                <div className="observing-indicator">
                    <span className="eye-icon">👁</span>
                    <span>Observing</span>
                </div>
            )}
        </div>
    );
}
