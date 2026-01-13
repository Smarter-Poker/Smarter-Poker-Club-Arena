/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📝 REPLAY ACTIONS — Hand History Action Log Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium action log for hand replay showing:
 * - All player actions by street
 * - Pot totals at each stage
 * - Winning hand reveal
 * - Timeline integration
 */

import React, { useMemo } from 'react';
import './ReplayActions.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ActionType = 'POST_SB' | 'POST_BB' | 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN' | 'SHOW' | 'MUCK' | 'WIN';
export type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN';

export interface PlayerAction {
    playerId: string;
    playerName: string;
    action: ActionType;
    amount?: number;
    potAfter?: number;
    cards?: string; // For SHOW action
    timestamp: number;
}

export interface StreetActions {
    street: Street;
    actions: PlayerAction[];
    board?: string[]; // Cards dealt on this street
    potTotal: number;
}

export interface ReplayActionsProps {
    streets: StreetActions[];
    currentStreet?: Street;
    currentActionIndex?: number;
    onActionClick?: (street: Street, actionIndex: number) => void;
    currency?: string;
    isPlaying?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const ACTION_CONFIG: Record<ActionType, { label: string; color: string; icon: string }> = {
    POST_SB: { label: 'SB', color: '#6E7681', icon: '🪙' },
    POST_BB: { label: 'BB', color: '#6E7681', icon: '🪙' },
    FOLD: { label: 'Fold', color: '#F85149', icon: '❌' },
    CHECK: { label: 'Check', color: '#8B949E', icon: '✓' },
    CALL: { label: 'Call', color: '#3FB950', icon: '📞' },
    BET: { label: 'Bet', color: '#FFB800', icon: '💰' },
    RAISE: { label: 'Raise', color: '#FF6B35', icon: '⬆️' },
    ALL_IN: { label: 'All-In', color: '#A855F7', icon: '🔥' },
    SHOW: { label: 'Show', color: '#1877F2', icon: '🃏' },
    MUCK: { label: 'Muck', color: '#6E7681', icon: '🙈' },
    WIN: { label: 'Win', color: '#3FB950', icon: '🏆' },
};

const STREET_LABELS: Record<Street, string> = {
    PREFLOP: 'Pre-Flop',
    FLOP: 'Flop',
    TURN: 'Turn',
    RIVER: 'River',
    SHOWDOWN: 'Showdown',
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatAmount(amount: number, currency: string = ''): string {
    return `${currency}${amount.toLocaleString()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface ActionRowProps {
    action: PlayerAction;
    index: number;
    isActive: boolean;
    onClick?: () => void;
    currency: string;
}

function ActionRow({ action, index, isActive, onClick, currency }: ActionRowProps) {
    const config = ACTION_CONFIG[action.action];

    return (
        <div
            className={`replay-action ${isActive ? 'replay-action--active' : ''}`}
            onClick={onClick}
            style={{ '--action-color': config.color } as React.CSSProperties}
        >
            <span className="replay-action__index">{index + 1}</span>
            <span className="replay-action__player">{action.playerName}</span>
            <span className="replay-action__type">
                <span className="replay-action__icon">{config.icon}</span>
                {config.label}
                {action.amount !== undefined && action.amount > 0 && (
                    <span className="replay-action__amount">{formatAmount(action.amount, currency)}</span>
                )}
            </span>
            {action.cards && (
                <span className="replay-action__cards">{action.cards}</span>
            )}
            {action.potAfter !== undefined && (
                <span className="replay-action__pot">Pot: {formatAmount(action.potAfter, currency)}</span>
            )}
        </div>
    );
}

interface StreetSectionProps {
    street: StreetActions;
    isCurrentStreet: boolean;
    currentActionIndex?: number;
    onActionClick?: (actionIndex: number) => void;
    currency: string;
}

function StreetSection({
    street,
    isCurrentStreet,
    currentActionIndex,
    onActionClick,
    currency,
}: StreetSectionProps) {
    return (
        <div className={`replay-street ${isCurrentStreet ? 'replay-street--current' : ''}`}>
            {/* Street Header */}
            <div className="replay-street__header">
                <span className="replay-street__label">{STREET_LABELS[street.street]}</span>
                {street.board && street.board.length > 0 && (
                    <span className="replay-street__board">{street.board.join(' ')}</span>
                )}
                <span className="replay-street__pot">Pot: {formatAmount(street.potTotal, currency)}</span>
            </div>

            {/* Actions */}
            <div className="replay-street__actions">
                {street.actions.map((action, idx) => (
                    <ActionRow
                        key={`${action.playerId}-${idx}`}
                        action={action}
                        index={idx}
                        isActive={isCurrentStreet && currentActionIndex === idx}
                        onClick={() => onActionClick?.(idx)}
                        currency={currency}
                    />
                ))}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ReplayActions({
    streets,
    currentStreet,
    currentActionIndex,
    onActionClick,
    currency = '',
    isPlaying = false,
}: ReplayActionsProps) {
    // Calculate total actions
    const totalActions = useMemo(() => {
        return streets.reduce((sum, s) => sum + s.actions.length, 0);
    }, [streets]);

    // Get current action number (1-indexed)
    const currentActionNumber = useMemo(() => {
        if (!currentStreet) return 0;
        let count = 0;
        for (const street of streets) {
            if (street.street === currentStreet) {
                return count + (currentActionIndex ?? 0) + 1;
            }
            count += street.actions.length;
        }
        return count;
    }, [streets, currentStreet, currentActionIndex]);

    if (streets.length === 0) {
        return (
            <div className="replay-actions replay-actions--empty">
                <span className="replay-actions__empty-text">No actions to display</span>
            </div>
        );
    }

    return (
        <div className={`replay-actions ${isPlaying ? 'replay-actions--playing' : ''}`}>
            {/* Header */}
            <div className="replay-actions__header">
                <span className="replay-actions__title">Hand Actions</span>
                <span className="replay-actions__counter">
                    {currentActionNumber}/{totalActions}
                </span>
            </div>

            {/* Streets */}
            <div className="replay-actions__body">
                {streets.map((street) => (
                    <StreetSection
                        key={street.street}
                        street={street}
                        isCurrentStreet={currentStreet === street.street}
                        currentActionIndex={currentStreet === street.street ? currentActionIndex : undefined}
                        onActionClick={(idx) => onActionClick?.(street.street, idx)}
                        currency={currency}
                    />
                ))}
            </div>

            {/* Legend */}
            <div className="replay-actions__legend">
                <span className="replay-actions__legend-item">
                    <span style={{ color: '#3FB950' }}>●</span> Call/Win
                </span>
                <span className="replay-actions__legend-item">
                    <span style={{ color: '#FFB800' }}>●</span> Bet
                </span>
                <span className="replay-actions__legend-item">
                    <span style={{ color: '#FF6B35' }}>●</span> Raise
                </span>
                <span className="replay-actions__legend-item">
                    <span style={{ color: '#F85149' }}>●</span> Fold
                </span>
            </div>
        </div>
    );
}

export default ReplayActions;
