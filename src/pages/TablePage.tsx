/**
 * ♠ CLUB ARENA — Multiplayer Table Page
 * Real poker table with WebSocket synchronization
 */

import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import { HandController, type HandEvent, type HandConfig, cardsToString } from '../engine';
import { BotLogic } from '../engine/BotLogic';
import { roomService, type RoomMessage, type PlayerPresence } from '../services/RoomService';
import { isDemoMode } from '../lib/supabase';
import { tableService } from '../services/TableService';
import { tournamentService } from '../services/TournamentService';
import type { Tournament, BlindLevel } from '../types/database.types';
import { RakeWaterfallEngine } from '../engines/financial/RakeWaterfallEngine';
import type { Card, SeatPlayer, ActionType, HandStage } from '../types/database.types';
import './TablePage.css';

import { useUserStore } from '../stores/useUserStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { soundService } from '../services/SoundService';

// Default fallback for unauthed
const GUEST_USER = {
    id: 'guest',
    username: 'Guest',
};

const HAND_CONFIG: HandConfig = {
    tableId: 'demo-table',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 10, cap: 15, noFlop: true },
};

// Bot players for demo
const BOT_PLAYERS: SeatPlayer[] = [
    { seat: 3, user_id: 'bot-1', username: 'Alice', stack: 1200, bet: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false },
    { seat: 5, user_id: 'bot-2', username: 'Bob', stack: 800, bet: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false },
    { seat: 7, user_id: 'bot-3', username: 'Charlie', stack: 1500, bet: 0, cards: [], is_folded: false, is_all_in: false, is_sitting_out: false },
];

interface TableState {
    handController: HandController | null;
    communityCards: Card[];
    pot: number;
    currentBet: number;
    myCards: Card[];
    mySeat: number;
    myStack: number;
    currentPlayerSeat: number;
    players: SeatPlayer[];
    stage: string;
    availableActions: ActionType[];
    winners: { userId: string; amount: number; hand?: string }[];
    handComplete: boolean;
    eventLog: string[];
    chatMessages: { sender: string; message: string; timestamp: number }[];
    isConnected: boolean;
    onlinePlayers: PlayerPresence[];
}

export default function TablePage() {
    const { clubId, tableId } = useParams();
    const roomTableId = tableId || 'demo-table';
    const { user, initDemoUser } = useUserStore();
    const navigate = useNavigate();
    const currentUser = user || GUEST_USER;

    // Auto-login demo user
    useEffect(() => {
        if (!user && isDemoMode) {
            initDemoUser();
        }
    }, [user]);

    const [state, setState] = useState<TableState>({
        handController: null,
        communityCards: [],
        pot: 0,
        currentBet: 0,
        myCards: [],
        mySeat: 1,
        myStack: 1000,
        currentPlayerSeat: -1,
        players: [],
        stage: 'waiting',
        availableActions: [],
        winners: [],
        handComplete: false,
        eventLog: [],
        chatMessages: [],
        isConnected: false,
        onlinePlayers: [],
    });

    const [betAmount, setBetAmount] = useState(20);
    const [chatInput, setChatInput] = useState('');
    const [showCards, setShowCards] = useState<Record<number, boolean>>({});

    // Tournament State
    const [tournament, setTournament] = useState<Tournament | null>(null);
    const [blindLevel, setBlindLevel] = useState<BlindLevel | null>(null);
    const [timeRemaining, setTimeRemaining] = useState<number>(0);
    const [isTournamentMode, setIsTournamentMode] = useState(false);

    // Global Settings
    const { soundEnabled, fourColorDeck, toggleSound } = useSettingsStore();

    // Sync sound service
    useEffect(() => {
        soundService.setEnabled(soundEnabled);
    }, [soundEnabled]);

    const handControllerRef = useRef<HandController | null>(null);

    // ─────────────────────────────────────────────────────────────────────────────
    // Room Connection
    // ─────────────────────────────────────────────────────────────────────────────

    useEffect(() => {
        // Join room on mount
        const joinRoom = async () => {
            await roomService.joinRoom(
                roomTableId,
                currentUser.id,
                currentUser.username,
                state.mySeat,
                state.myStack
            );
            setState(prev => ({ ...prev, isConnected: true }));
        };

        joinRoom();

        // Subscribe to room messages
        const unsubscribe = roomService.onMessage(roomTableId, handleRoomMessage);

        // Cleanup on unmount
        return () => {
            unsubscribe();
            roomService.leaveRoom(roomTableId);
        };
    }, [roomTableId]);

    // Tournament Logic
    useEffect(() => {
        if (!roomTableId) return;

        const loadTournamentContext = async () => {
            const table = await tableService.getTable(roomTableId);
            if (table?.tournament_id) {
                setIsTournamentMode(true);
                const tourn = await tournamentService.getTournament(table.tournament_id);
                setTournament(tourn);
            }
        };
        loadTournamentContext();
    }, [roomTableId]);

    // Tournament Timer
    useEffect(() => {
        if (!tournament || tournament.status !== 'running') return;

        const timer = setInterval(() => {
            const state = tournamentService.getCurrentLevelState(tournament);
            setBlindLevel(state.currentLevel);
            setTimeRemaining(state.timeRemainingSeconds);

            // Sync Engine Blinds
            if (handControllerRef.current) {
                const engine = handControllerRef.current as any;
                // Assuming 'config' is the property name in HandController
                if (engine.config) {
                    if (engine.config.smallBlind !== state.currentLevel.smallBlind) {
                        engine.config.smallBlind = state.currentLevel.smallBlind;
                        engine.config.bigBlind = state.currentLevel.bigBlind;
                    }
                }
            }
        }, 1000);

        return () => clearInterval(timer);
    }, [tournament]);

    // Tournament Elimination Check
    useEffect(() => {
        if (!tournament || !state.handComplete) return;

        const checkEliminations = async () => {
            // Check myself
            if (state.myStack === 0) {
                await tournamentService.eliminatePlayerAuto(tournament.id, currentUser.id);
                alert('You have been eliminated!');
                navigate(`/clubs/${clubId}`);
            }

            // Check Bots (Simple Host Logic: Everyone tries to clean up bots)
            state.players.forEach(async p => {
                if (p.stack === 0 && p.user_id.startsWith('bot-')) {
                    await tournamentService.eliminatePlayerAuto(tournament.id, p.user_id);
                }
            });
        };
        checkEliminations();
    }, [state.handComplete, tournament, state.players, state.myStack]);

    // ─────────────────────────────────────────────────────────────────────────────
    // Room Message Handler
    // ─────────────────────────────────────────────────────────────────────────────

    const handleRoomMessage = useCallback((message: RoomMessage) => {
        setState(prev => {
            const newLog = [...prev.eventLog];

            switch (message.type) {
                case 'PLAYER_JOINED':
                    const joinPayload = message.payload as { userId: string; presences: PlayerPresence[] };
                    newLog.push(`👤 ${joinPayload.presences[0]?.username || 'Player'} joined`);
                    return { ...prev, eventLog: newLog };

                case 'PLAYER_LEFT':
                    const leftPayload = message.payload as { userId: string };
                    newLog.push(`👋 Player left`);
                    return { ...prev, eventLog: newLog };

                case 'PLAYER_ACTION':
                    // Remote player action - apply to our hand controller
                    const actionPayload = message.payload as { seat: number; action: ActionType; amount: number };
                    if (handControllerRef.current && message.sender !== currentUser.id) {
                        handControllerRef.current.performAction(
                            actionPayload.seat,
                            actionPayload.action,
                            actionPayload.amount
                        );
                    }
                    return prev;

                case 'PRESENCE_SYNC':
                    const presences = message.payload as PlayerPresence[];
                    return { ...prev, onlinePlayers: presences };

                case 'CHAT':
                    const chatPayload = message.payload as { message: string };
                    const senderName = prev.players.find(p => p.user_id === message.sender)?.username || 'Unknown';
                    return {
                        ...prev,
                        chatMessages: [
                            ...prev.chatMessages,
                            { sender: senderName, message: chatPayload.message, timestamp: message.timestamp }
                        ]
                    };

                default:
                    return prev;
            }
        });
    }, []);

    // ─────────────────────────────────────────────────────────────────────────────
    // Initialize Hand
    // ─────────────────────────────────────────────────────────────────────────────

    const startNewHand = useCallback(() => {
        // Create player list with user and bots
        const myPlayer: SeatPlayer = {
            seat: state.mySeat,
            user_id: currentUser.id,
            username: currentUser.username,
            stack: state.myStack || 1000,
            bet: 0,
            cards: [],
            is_folded: false,
            is_all_in: false,
            is_sitting_out: false,
        };

        const players = [myPlayer, ...BOT_PLAYERS].map(p => ({
            ...p,
            cards: [],
            bet: 0,
            is_folded: false,
            is_all_in: false,
        }));

        const handNumber = 1; // Simplified - each hand starts fresh

        const handController = new HandController(
            { ...HAND_CONFIG, tableId: roomTableId, handNumber },
            players,
            1 // Dealer at seat 1
        );

        handControllerRef.current = handController;

        // Subscribe to engine events
        handController.onEvent((event: HandEvent) => {
            handleGameEvent(event);
        });

        setState(prev => ({
            ...prev,
            handController,
            players,
            communityCards: [],
            pot: 0,
            currentBet: 0,
            myCards: [],
            winners: [],
            handComplete: false,
            stage: 'preflop',
            eventLog: [],
            // Don't clear chat
        }));

        // Start the hand
        handController.start();

        // Broadcast hand start to room
        roomService.broadcastHandStart(
            roomTableId,
            handNumber,
            1,
            players
        );
    }, [roomTableId, state.mySeat, state.myStack]);

    // ─────────────────────────────────────────────────────────────────────────────
    // Game Event Handler
    // ─────────────────────────────────────────────────────────────────────────────

    const handleGameEvent = useCallback((event: HandEvent) => {
        setState(prev => {
            const newLog = [...prev.eventLog];

            switch (event.type) {
                case 'HAND_START':
                    newLog.push(`🎰 Hand #${event.handNumber} started`);
                    return {
                        ...prev,
                        eventLog: newLog,
                        players: event.players,
                    };

                case 'CARDS_DEALT':
                    if (event.seat === prev.mySeat) {
                        newLog.push(`🃏 You received: ${cardsToString(event.cards)}`);
                        return {
                            ...prev,
                            myCards: event.cards,
                            eventLog: newLog,
                        };
                    }
                    return prev;

                case 'COMMUNITY_CARDS':
                    newLog.push(`📋 ${event.stage.toUpperCase()}: ${cardsToString(event.cards)}`);
                    return {
                        ...prev,
                        communityCards: [...prev.communityCards, ...event.cards],
                        stage: event.stage,
                        eventLog: newLog,
                    };

                case 'PLAYER_ACTION':
                    // Sound effects
                    if (soundEnabled) {
                        switch (event.action) {
                            case 'check': soundService.playCheck(); break;
                            case 'fold': soundService.playFold(); break;
                            case 'call':
                            case 'bet':
                            case 'raise':
                            case 'all_in': soundService.playChips(); break;
                        }
                    }

                    const player = prev.players.find(p => p.seat === event.seat);
                    const playerName = player?.username || `Seat ${event.seat}`;
                    newLog.push(`▶️ ${playerName}: ${event.action}${event.amount ? ` $${event.amount}` : ''}`);
                    return {
                        ...prev,
                        lastAction: `${playerName} ${event.action}`,
                        eventLog: newLog,
                    };

                case 'POT_UPDATE':
                    return { ...prev, pot: event.pot };

                case 'TURN_CHANGE':
                    if (event.seat === prev.mySeat && soundEnabled) {
                        soundService.playTurnAlert();
                    }
                    return {
                        ...prev,
                        currentPlayerSeat: event.seat,
                        availableActions: event.availableActions,
                    };

                case 'SHOWDOWN':
                    for (const result of event.results) {
                        const name = prev.players.find(p => p.seat === result.seat)?.username || `Seat ${result.seat}`;
                        newLog.push(`🎴 ${name}: ${cardsToString(result.cards)} (${result.hand.name})`);
                    }
                    const showAll: Record<number, boolean> = {};
                    event.results.forEach(r => showAll[r.seat] = true);
                    setShowCards(showAll);
                    return { ...prev, eventLog: newLog };

                case 'WINNERS':
                    if (soundEnabled && event.winners.some(w => w.userId === currentUser.id)) {
                        soundService.playWin();
                    } else if (soundEnabled && event.winners.length > 0) {
                        // Winner sound (chips)
                        soundService.playChips();
                    }

                    for (const winner of event.winners) {
                        const name = prev.players.find(p => p.user_id === winner.userId)?.username || winner.userId;
                        newLog.push(`🏆 ${name} wins $${winner.amount}${winner.hand ? ` with ${winner.hand.name}` : ''}`);
                    }
                    return {
                        ...prev,
                        winners: event.winners.map(w => ({
                            userId: w.userId,
                            amount: w.amount,
                            hand: w.hand?.name,
                        })),
                        eventLog: newLog,
                    };

                case 'HAND_COMPLETE':
                    newLog.push(`✅ Hand complete, rake: $${event.rake}`);
                    return {
                        ...prev,
                        handComplete: true,
                        eventLog: newLog,
                    };

                default:
                    return prev;
            }
        });


        // 💰 RAKE WATERFALL INTEGRATION 💰
        if (event.type === 'HAND_COMPLETE' && clubId && handControllerRef.current) {
            const gameState = handControllerRef.current.getState();

            // Only if we are the "host" or it's a demo. 
            // In a real app, this logic runs on the server.
            // For now, we simulate it here.

            const context = {
                tableId: roomTableId,
                handId: crypto.randomUUID(), // New Hand ID
                clubId: clubId,
                totalPot: gameState.pot,
                players: gameState.players.map(p => ({
                    userId: p.user_id,
                    hasCards: !p.is_sitting_out, // Simple approximation
                    isSittingOut: p.is_sitting_out
                }))
            };

            console.log('🌊 Triggering Rake Waterfall...', context);
            RakeWaterfallEngine.processHand(context).then(res => {
                console.log('✅ Waterfall Complete:', res);
            }).catch(err => {
                console.error('❌ Waterfall Failed:', err);
            });
        }

    }, [clubId, roomTableId]);

    // ─────────────────────────────────────────────────────────────────────────────
    // Perform Action
    // ─────────────────────────────────────────────────────────────────────────────

    const performAction = useCallback((action: ActionType, amount?: number) => {
        if (!handControllerRef.current) return;

        const success = handControllerRef.current.performAction(state.mySeat, action, amount);
        if (!success) {
            console.error('Action failed');
            return;
        }

        // Broadcast action to room
        roomService.broadcastAction(
            roomTableId,
            state.mySeat,
            action,
            amount || 0,
            currentUser.id
        );

        // Update state from controller
        const gameState = handControllerRef.current.getState();
        setState(prev => ({
            ...prev,
            players: gameState.players,
            currentBet: gameState.currentBet,
            pot: gameState.pot,
            myStack: gameState.players.find(p => p.seat === prev.mySeat)?.stack || prev.myStack,
        }));

        // Trigger bot actions
        simulateBotActions();
    }, [state.mySeat, roomTableId]);

    // ─────────────────────────────────────────────────────────────────────────────
    // Bot Simulation
    // ─────────────────────────────────────────────────────────────────────────────

    const simulateBotActions = useCallback(() => {
        // Random thinking time: 1s - 2.5s
        const delay = 1000 + Math.random() * 1500;

        setTimeout(() => {
            if (!handControllerRef.current) return;

            const gameState = handControllerRef.current.getState();
            const currentSeat = gameState.currentPlayerSeat;
            const player = gameState.players.find(p => p.seat === currentSeat);

            if (!player || player.user_id === currentUser.id) return;
            if (gameState.stage === 'showdown') return;

            // Use Smart Bot Logic
            const decision = BotLogic.decide(player, {
                players: gameState.players,
                communityCards: gameState.communityCards,
                pot: gameState.pot,
                currentBet: gameState.currentBet,
                stage: gameState.stage as HandStage,
                gameVariant: (HAND_CONFIG.gameVariant || 'nlh') as 'nlh' | 'plo4' | 'plo5' | 'plo6',
                bigBlind: (handControllerRef.current as any).handConfig?.bigBlind || 10,
            });

            // Execute Decision
            handControllerRef.current.performAction(currentSeat, decision.action, decision.amount);

            // Update state
            const newGameState = handControllerRef.current.getState();
            setState(prev => ({
                ...prev,
                players: newGameState.players,
                currentBet: newGameState.currentBet,
                pot: newGameState.pot,
            }));

            // Continue chain if needed
            if (newGameState.currentPlayerSeat !== state.mySeat && newGameState.stage !== 'showdown') {
                simulateBotActions();
            }
        }, delay);
    }, [state.mySeat]);

    // Start first hand on mount
    useEffect(() => {
        const timer = setTimeout(() => {
            startNewHand();
        }, 500);
        return () => clearTimeout(timer);
    }, []);

    const isMyTurn = state.currentPlayerSeat === state.mySeat && !state.handComplete;
    const myPlayer = state.players.find(p => p.seat === state.mySeat);
    const toCall = state.currentBet - (myPlayer?.bet || 0);

    return (
        <div className="table-page">
            {/* Back Link */}
            <Link to={clubId ? `/clubs/${clubId}` : '/clubs'} className="back-link">
                ← Back to Club
            </Link>

            {/* Tournament HUD */}
            {isTournamentMode && blindLevel && (
                <div className="tournament-hud" style={{
                    position: 'absolute',
                    top: '20px',
                    right: '20px',
                    background: 'rgba(0,0,0,0.85)',
                    padding: '12px 16px',
                    borderRadius: '8px',
                    border: '1px solid #444',
                    zIndex: 200,
                    color: '#fff',
                    textAlign: 'right',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                    backdropFilter: 'blur(4px)'
                }}>
                    <div style={{ fontSize: '1.1em', fontWeight: 'bold', marginBottom: '4px', color: '#ffd700' }}>
                        Level {blindLevel.level}
                    </div>
                    <div style={{ color: '#ddd', fontSize: '0.9em', marginBottom: '4px' }}>
                        Blinds: {blindLevel.smallBlind}/{blindLevel.bigBlind}
                    </div>
                    <div style={{
                        color: timeRemaining < 30 ? '#ff4d4d' : '#4dff4d',
                        fontWeight: 'bold',
                        fontSize: '1.2em',
                        fontFamily: 'monospace'
                    }}>
                        {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')}
                    </div>
                </div>
            )}

            {/* Connection Status & Settings */}
            <div className="table-header-controls">
                <div className="connection-status">
                    <span className={`status-dot ${state.isConnected ? 'connected' : ''}`} />
                    {state.isConnected ? `Online (${state.onlinePlayers.length})` : 'Connecting...'}
                </div>
                <button
                    className="btn-icon"
                    onClick={toggleSound}
                    title={soundEnabled ? "Mute Sound" : "Enable Sound"}
                >
                    {soundEnabled ? '🔊' : '🔇'}
                </button>
            </div>

            {/* Table Container */}
            <div className={`table-container ${fourColorDeck ? 'four-color-deck' : ''}`}>
                <div className="poker-table">
                    <div className="table-felt">
                        {/* Community Cards */}
                        <div className="community-cards">
                            {state.communityCards.map((card, i) => (
                                <div key={i} className={`card ${card.suit}`}>
                                    {card.rank}{getSuitSymbol(card.suit)}
                                </div>
                            ))}
                            {Array(5 - state.communityCards.length).fill(null).map((_, i) => (
                                <div key={`empty-${i}`} className="card placeholder" />
                            ))}
                        </div>

                        {/* Pot */}
                        <div className="pot-display">
                            <span className="pot-label">POT</span>
                            <span className="pot-amount">${state.pot}</span>
                        </div>
                    </div>

                    {/* Player Seats */}
                    {state.players.map(player => (
                        <div
                            key={player.seat}
                            className={`seat seat-${player.seat} ${player.is_folded ? 'folded' : ''} ${state.currentPlayerSeat === player.seat ? 'active' : ''}`}
                        >
                            <div className="seat-avatar">
                                {player.user_id === currentUser.id ? '🧑' : '🤖'}
                            </div>
                            <div className="seat-info">
                                <span className="seat-name">{player.username}</span>
                                <span className="seat-stack">${player.stack}</span>
                            </div>
                            {player.bet > 0 && (
                                <div className="seat-bet">${player.bet}</div>
                            )}
                            {/* Cards */}
                            {player.seat === state.mySeat && state.myCards.length > 0 && (
                                <div className="hole-cards">
                                    {state.myCards.map((card, i) => (
                                        <div key={i} className={`card hole-card ${card.suit}`}>
                                            {card.rank}{getSuitSymbol(card.suit)}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {showCards[player.seat] && player.seat !== state.mySeat && (
                                <div className="hole-cards">
                                    {player.cards.map((card, i) => (
                                        <div key={i} className={`card hole-card ${card.suit}`}>
                                            {card.rank}{getSuitSymbol(card.suit)}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {state.winners.some(w => w.userId === player.user_id) && (
                                <div className="winner-badge">🏆</div>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* Action Bar */}
            <div className="action-bar">
                {state.handComplete ? (
                    <div className="hand-result">
                        <div className="winner-announcement">
                            {state.winners.map((w, i) => {
                                const winner = state.players.find(p => p.user_id === w.userId);
                                return (
                                    <span key={i}>
                                        🏆 {winner?.username} wins ${w.amount} {w.hand && `(${w.hand})`}
                                    </span>
                                );
                            })}
                        </div>
                        <button className="btn btn-primary btn-lg" onClick={startNewHand}>
                            Deal Next Hand
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="action-info">
                            <span className="stage-badge">{state.stage.toUpperCase()}</span>
                            {isMyTurn ? (
                                <span className="your-turn">Your Turn</span>
                            ) : (
                                <span className="waiting">Waiting...</span>
                            )}
                        </div>

                        <div className="action-buttons">
                            <button
                                className="btn btn-danger"
                                onClick={() => performAction('fold')}
                                disabled={!isMyTurn}
                            >
                                Fold
                            </button>

                            {toCall === 0 ? (
                                <button
                                    className="btn btn-ghost"
                                    onClick={() => performAction('check')}
                                    disabled={!isMyTurn}
                                >
                                    Check
                                </button>
                            ) : (
                                <button
                                    className="btn btn-ghost"
                                    onClick={() => performAction('call')}
                                    disabled={!isMyTurn}
                                >
                                    Call ${toCall}
                                </button>
                            )}

                            <button
                                className="btn btn-primary"
                                onClick={() => performAction(toCall === 0 ? 'bet' : 'raise', betAmount)}
                                disabled={!isMyTurn || betAmount > (myPlayer?.stack || 0)}
                            >
                                {toCall === 0 ? 'Bet' : 'Raise'} ${betAmount}
                            </button>
                        </div>

                        <div className="bet-slider">
                            <input
                                type="range"
                                min={state.currentBet + 10}
                                max={myPlayer?.stack || 100}
                                value={betAmount}
                                onChange={(e) => setBetAmount(Number(e.target.value))}
                            />
                            <span className="bet-amount">${betAmount}</span>
                            <button
                                className="btn btn-sm btn-ghost"
                                onClick={() => performAction('all_in')}
                                disabled={!isMyTurn}
                            >
                                All-In
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* Footer: Log & Chat */}
            <div className="table-footer">
                {/* Event Log */}
                <div className="event-log">
                    <h4>Hand Log</h4>
                    <div className="log-entries">
                        {state.eventLog.map((entry, i) => (
                            <div key={i} className="log-entry">{entry}</div>
                        ))}
                    </div>
                </div>

                {/* Chat */}
                <div className="chat-box">
                    <h4>Chat</h4>
                    <div className="chat-messages">
                        {state.chatMessages?.map((msg, i) => (
                            <div key={i} className="chat-message">
                                <span className="chat-sender">{msg.sender}:</span>
                                <span className="chat-text">{msg.message}</span>
                            </div>
                        ))}
                    </div>
                    <form
                        className="chat-input-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!chatInput.trim()) return;
                            roomService.sendChat(roomTableId, currentUser.id, chatInput);
                            setChatInput('');
                        }}
                    >
                        <input
                            type="text"
                            placeholder="Type a message..."
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                        />
                        <button type="submit" className="btn btn-sm btn-ghost">Send</button>
                    </form>
                </div>
            </div>
        </div>
    );
}

function getSuitSymbol(suit: Card['suit']): string {
    const symbols: Record<Card['suit'], string> = {
        hearts: '♥',
        diamonds: '♦',
        clubs: '♣',
        spades: '♠',
    };
    return symbols[suit];
}
