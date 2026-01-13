/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🪙 CHIP STACK — Animated Betting Chips Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium chip stack visualization featuring:
 * - Multi-denomination stacking
 * - Bet animation (slide from player to pot)
 * - Win collection animation
 * - Realistic chip rendering
 */

import React, { useMemo } from 'react';
import './ChipStack.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChipStackProps {
    amount: number;
    variant?: 'bet' | 'pot' | 'stack';
    isAnimating?: boolean;
    animationType?: 'slide-to-pot' | 'slide-from-pot' | 'pile' | 'none';
    size?: 'small' | 'medium' | 'large';
    showLabel?: boolean;
    currency?: string;
}

interface ChipDenomination {
    value: number;
    color: string;
    accent: string;
    label: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// Standard poker chip denominations
const CHIP_DENOMINATIONS: ChipDenomination[] = [
    { value: 100000, color: '#8B4513', accent: '#CD853F', label: '100K' },
    { value: 25000, color: '#800080', accent: '#9932CC', label: '25K' },
    { value: 10000, color: '#FFD700', accent: '#FFA500', label: '10K' },
    { value: 5000, color: '#FF4500', accent: '#FF6347', label: '5K' },
    { value: 1000, color: '#1C1C1C', accent: '#4A4A4A', label: '1K' },
    { value: 500, color: '#4169E1', accent: '#6495ED', label: '500' },
    { value: 100, color: '#228B22', accent: '#32CD32', label: '100' },
    { value: 25, color: '#DC143C', accent: '#FF6B6B', label: '25' },
    { value: 5, color: '#4169E1', accent: '#6495ED', label: '5' },
    { value: 1, color: '#FFFFFF', accent: '#E0E0E0', label: '1' },
];

const MAX_CHIPS_VISIBLE = 12;
const MAX_STACK_HEIGHT = 5;

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function calculateChipBreakdown(amount: number): { denom: ChipDenomination; count: number }[] {
    const chips: { denom: ChipDenomination; count: number }[] = [];
    let remaining = Math.floor(amount);

    for (const denom of CHIP_DENOMINATIONS) {
        if (remaining >= denom.value) {
            const count = Math.floor(remaining / denom.value);
            chips.push({ denom, count: Math.min(count, MAX_STACK_HEIGHT) });
            remaining %= denom.value;
        }
        if (chips.length >= 4) break; // Max 4 different denominations
    }

    return chips;
}

function formatAmount(amount: number, currency: string = ''): string {
    if (amount >= 1000000) {
        return `${currency}${(amount / 1000000).toFixed(1)}M`;
    }
    if (amount >= 1000) {
        return `${currency}${(amount / 1000).toFixed(1)}K`;
    }
    return `${currency}${amount.toLocaleString()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface SingleChipProps {
    denom: ChipDenomination;
    stackIndex: number;
    delay: number;
    size: 'small' | 'medium' | 'large';
}

function SingleChip({ denom, stackIndex, delay, size }: SingleChipProps) {
    const sizeMultiplier = size === 'small' ? 0.7 : size === 'large' ? 1.3 : 1;
    const chipSize = 24 * sizeMultiplier;
    const offset = stackIndex * 3 * sizeMultiplier;

    return (
        <div
            className="chip-stack__chip"
            style={{
                width: chipSize,
                height: chipSize,
                background: `linear-gradient(145deg, ${denom.color} 0%, ${denom.accent} 100%)`,
                transform: `translateY(${-offset}px)`,
                zIndex: MAX_STACK_HEIGHT - stackIndex,
                animationDelay: `${delay}ms`,
            }}
        >
            {/* Chip edge pattern */}
            <div className="chip-stack__chip-edge" />

            {/* Center inlay */}
            <div
                className="chip-stack__chip-inlay"
                style={{ borderColor: denom.accent }}
            />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function ChipStack({
    amount,
    variant = 'bet',
    isAnimating = false,
    animationType = 'none',
    size = 'medium',
    showLabel = true,
    currency = '',
}: ChipStackProps) {
    // Calculate chip breakdown
    const chipBreakdown = useMemo(() => calculateChipBreakdown(amount), [amount]);

    // Build animation classes
    const containerClasses = useMemo(() => {
        const classes = ['chip-stack', `chip-stack--${variant}`, `chip-stack--${size}`];
        if (isAnimating) {
            classes.push('chip-stack--animating');
            if (animationType !== 'none') {
                classes.push(`chip-stack--${animationType}`);
            }
        }
        return classes.join(' ');
    }, [variant, size, isAnimating, animationType]);

    if (amount === 0) return null;

    return (
        <div className={containerClasses}>
            {/* Chip stacks */}
            <div className="chip-stack__stacks">
                {chipBreakdown.map(({ denom, count }, stackIdx) => (
                    <div key={denom.value} className="chip-stack__column">
                        {Array.from({ length: count }).map((_, chipIdx) => (
                            <SingleChip
                                key={chipIdx}
                                denom={denom}
                                stackIndex={chipIdx}
                                delay={stackIdx * 50 + chipIdx * 30}
                                size={size}
                            />
                        ))}
                    </div>
                ))}
            </div>

            {/* Amount label */}
            {showLabel && (
                <div className="chip-stack__label">
                    {formatAmount(amount, currency)}
                </div>
            )}
        </div>
    );
}

export default ChipStack;
