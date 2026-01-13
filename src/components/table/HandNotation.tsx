/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📝 HAND NOTATION — Hand History Text Export
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Text-based hand history display and export:
 * - PokerStars-style notation
 * - Copy to clipboard
 * - Download as text file
 */

import React, { useMemo, useCallback, useState } from 'react';
import './HandNotation.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface NotationPlayer {
    seat: number;
    name: string;
    stack: number;
    isButton?: boolean;
    isSmallBlind?: boolean;
    isBigBlind?: boolean;
}

export interface NotationAction {
    player: string;
    action: string;
    amount?: number;
}

export interface NotationHand {
    handId: string;
    tableName: string;
    gameType: string; // 'Hold\'em No Limit' etc
    stakes: string; // '$1/$2'
    timestamp: Date;
    players: NotationPlayer[];
    heroSeat?: number;
    heroCards?: string[];
    buttonSeat: number;
    smallBlind: number;
    bigBlind: number;
    ante?: number;
    preflop: NotationAction[];
    flop?: { cards: string[]; actions: NotationAction[] };
    turn?: { card: string; actions: NotationAction[] };
    river?: { card: string; actions: NotationAction[] };
    showdown?: { player: string; cards: string[]; hand: string }[];
    winners: { player: string; amount: number; hand?: string }[];
    potTotal: number;
}

export interface HandNotationProps {
    hand: NotationHand;
    onClose?: () => void;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatDate(date: Date): string {
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function formatAction(action: NotationAction, currency: string): string {
    if (action.amount !== undefined && action.amount > 0) {
        return `${action.player}: ${action.action} ${currency}${action.amount.toLocaleString()}`;
    }
    return `${action.player}: ${action.action}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE NOTATION
// ═══════════════════════════════════════════════════════════════════════════════

function generateNotation(hand: NotationHand, currency: string): string {
    const lines: string[] = [];

    // Header
    lines.push(`PokerStars Hand #${hand.handId}: ${hand.gameType} (${hand.stakes}) - ${formatDate(hand.timestamp)}`);
    lines.push(`Table '${hand.tableName}' ${hand.players.length}-max Seat #${hand.buttonSeat} is the button`);
    lines.push('');

    // Seats
    for (const player of hand.players) {
        lines.push(`Seat ${player.seat}: ${player.name} (${currency}${player.stack.toLocaleString()} in chips)`);
    }
    lines.push('');

    // Blinds
    const sb = hand.players.find((p) => p.isSmallBlind);
    const bb = hand.players.find((p) => p.isBigBlind);
    if (sb) lines.push(`${sb.name}: posts small blind ${currency}${hand.smallBlind}`);
    if (bb) lines.push(`${bb.name}: posts big blind ${currency}${hand.bigBlind}`);
    if (hand.ante) {
        for (const player of hand.players) {
            lines.push(`${player.name}: posts ante ${currency}${hand.ante}`);
        }
    }
    lines.push('');

    // Hole cards
    if (hand.heroCards && hand.heroSeat !== undefined) {
        const hero = hand.players.find((p) => p.seat === hand.heroSeat);
        lines.push(`*** HOLE CARDS ***`);
        if (hero) lines.push(`Dealt to ${hero.name} [${hand.heroCards.join(' ')}]`);
    }

    // Preflop
    for (const action of hand.preflop) {
        lines.push(formatAction(action, currency));
    }
    lines.push('');

    // Flop
    if (hand.flop) {
        lines.push(`*** FLOP *** [${hand.flop.cards.join(' ')}]`);
        for (const action of hand.flop.actions) {
            lines.push(formatAction(action, currency));
        }
        lines.push('');
    }

    // Turn
    if (hand.turn) {
        lines.push(`*** TURN *** [${hand.flop?.cards.join(' ')}] [${hand.turn.card}]`);
        for (const action of hand.turn.actions) {
            lines.push(formatAction(action, currency));
        }
        lines.push('');
    }

    // River
    if (hand.river) {
        const turnCard = hand.turn?.card || '';
        lines.push(`*** RIVER *** [${hand.flop?.cards.join(' ')} ${turnCard}] [${hand.river.card}]`);
        for (const action of hand.river.actions) {
            lines.push(formatAction(action, currency));
        }
        lines.push('');
    }

    // Showdown
    if (hand.showdown && hand.showdown.length > 0) {
        lines.push('*** SHOW DOWN ***');
        for (const show of hand.showdown) {
            lines.push(`${show.player}: shows [${show.cards.join(' ')}] (${show.hand})`);
        }
        lines.push('');
    }

    // Summary
    lines.push('*** SUMMARY ***');
    lines.push(`Total pot ${currency}${hand.potTotal.toLocaleString()}`);

    const board = [
        ...(hand.flop?.cards || []),
        hand.turn?.card,
        hand.river?.card,
    ].filter(Boolean);
    if (board.length > 0) {
        lines.push(`Board [${board.join(' ')}]`);
    }

    for (const winner of hand.winners) {
        const handStr = winner.hand ? ` with ${winner.hand}` : '';
        lines.push(`${winner.player} collected ${currency}${winner.amount.toLocaleString()}${handStr}`);
    }

    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function HandNotation({
    hand,
    onClose,
    currency = '$',
}: HandNotationProps) {
    const [copied, setCopied] = useState(false);

    // Generate notation text
    const notation = useMemo(() => generateNotation(hand, currency), [hand, currency]);

    // Copy to clipboard
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(notation);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            console.error('Copy failed:', error);
        }
    }, [notation]);

    // Download as text file
    const handleDownload = useCallback(() => {
        const blob = new Blob([notation], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `hand_${hand.handId}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, [notation, hand.handId]);

    return (
        <div className="hand-notation">
            {/* Header */}
            <div className="hand-notation__header">
                <h3 className="hand-notation__title">Hand History</h3>
                <div className="hand-notation__actions">
                    <button
                        className={`hand-notation__btn ${copied ? 'hand-notation__btn--success' : ''}`}
                        onClick={handleCopy}
                    >
                        {copied ? '✓ Copied' : '📋 Copy'}
                    </button>
                    <button className="hand-notation__btn" onClick={handleDownload}>
                        📥 Download
                    </button>
                    {onClose && (
                        <button className="hand-notation__close" onClick={onClose}>
                            ×
                        </button>
                    )}
                </div>
            </div>

            {/* Text Content */}
            <pre className="hand-notation__content">{notation}</pre>
        </div>
    );
}

export default HandNotation;
