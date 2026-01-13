/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🏆 POT DISPLAY — Main Pot & Side Pots Visualization
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Displays the current pot amount(s) at the center of the poker table with:
 * - Animated main pot with chip visuals
 * - Side pot breakdown for all-in scenarios
 * - Chip stack animations on pot updates
 */

import React, { useMemo, useEffect, useState } from 'react';
import './PotDisplay.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SidePot {
    id: string;
    amount: number;
    eligiblePlayers: string[];
}

export interface PotDisplayProps {
    mainPot: number;
    sidePots?: SidePot[];
    previousPot?: number;
    showChipAnimation?: boolean;
    currency?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatAmount(amount: number, currency: string = ''): string {
    if (amount >= 1000000) {
        return `${currency}${(amount / 1000000).toFixed(2)}M`;
    }
    if (amount >= 1000) {
        return `${currency}${(amount / 1000).toFixed(1)}K`;
    }
    return `${currency}${amount.toLocaleString()}`;
}

// Chip denomination colors
const CHIP_COLORS = [
    { threshold: 10000, color: '#8B4513', label: '10K' },    // Brown
    { threshold: 5000, color: '#1E90FF', label: '5K' },     // Blue
    { threshold: 1000, color: '#1C1C1C', label: '1K' },     // Black
    { threshold: 500, color: '#800080', label: '500' },     // Purple
    { threshold: 100, color: '#228B22', label: '100' },     // Green
    { threshold: 25, color: '#DC143C', label: '25' },       // Red
    { threshold: 5, color: '#4169E1', label: '5' },         // Blue
    { threshold: 1, color: '#F5F5F5', label: '1' },         // White
];

function getChipBreakdown(amount: number): { color: string; count: number; label: string }[] {
    const chips: { color: string; count: number; label: string }[] = [];
    let remaining = amount;

    for (const chip of CHIP_COLORS) {
        if (remaining >= chip.threshold) {
            const count = Math.min(Math.floor(remaining / chip.threshold), 8); // Max 8 chips per denom
            chips.push({ color: chip.color, count, label: chip.label });
            remaining -= count * chip.threshold;
        }
    }

    return chips.slice(0, 4); // Max 4 denomination stacks visible
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface ChipStackProps {
    color: string;
    count: number;
    offsetX: number;
}

function ChipStack({ color, count, offsetX }: ChipStackProps) {
    return (
        <div
            className="pot-display__chip-stack"
            style={{ transform: `translateX(${offsetX}px)` }}
        >
            {Array.from({ length: Math.min(count, 8) }).map((_, i) => (
                <div
                    key={i}
                    className="pot-display__chip"
                    style={{
                        backgroundColor: color,
                        transform: `translateY(${-i * 3}px)`,
                        zIndex: count - i,
                        animationDelay: `${i * 50}ms`,
                    }}
                >
                    <div className="pot-display__chip-inner" />
                </div>
            ))}
        </div>
    );
}

interface SidePotBadgeProps {
    pot: SidePot;
    index: number;
}

function SidePotBadge({ pot, index }: SidePotBadgeProps) {
    return (
        <div
            className="pot-display__side-pot"
            style={{ animationDelay: `${index * 100}ms` }}
        >
            <span className="pot-display__side-pot-label">Side Pot {index + 1}</span>
            <span className="pot-display__side-pot-amount">
                {formatAmount(pot.amount)}
            </span>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function PotDisplay({
    mainPot,
    sidePots = [],
    previousPot = 0,
    showChipAnimation = true,
    currency = '',
}: PotDisplayProps) {
    const [displayPot, setDisplayPot] = useState(mainPot);
    const [isAnimating, setIsAnimating] = useState(false);

    // Animate pot changes
    useEffect(() => {
        if (mainPot !== displayPot) {
            setIsAnimating(true);

            // Animate number counting up
            const diff = mainPot - displayPot;
            const steps = 20;
            const increment = diff / steps;
            let current = displayPot;
            let step = 0;

            const timer = setInterval(() => {
                step++;
                current += increment;

                if (step >= steps) {
                    setDisplayPot(mainPot);
                    setIsAnimating(false);
                    clearInterval(timer);
                } else {
                    setDisplayPot(Math.round(current));
                }
            }, 25);

            return () => clearInterval(timer);
        }
    }, [mainPot, displayPot]);

    // Calculate chip visualization
    const chipBreakdown = useMemo(() => getChipBreakdown(mainPot), [mainPot]);

    // Total pot calculation
    const totalPot = useMemo(() => {
        return mainPot + sidePots.reduce((sum, p) => sum + p.amount, 0);
    }, [mainPot, sidePots]);

    if (mainPot === 0 && sidePots.length === 0) {
        return null;
    }

    return (
        <div className="pot-display">
            {/* Chip Stacks Visualization */}
            {showChipAnimation && mainPot > 0 && (
                <div className="pot-display__chips">
                    {chipBreakdown.map((chip, i) => (
                        <ChipStack
                            key={i}
                            color={chip.color}
                            count={chip.count}
                            offsetX={i * 22 - (chipBreakdown.length * 11)}
                        />
                    ))}
                </div>
            )}

            {/* Main Pot Amount */}
            <div className={`pot-display__main ${isAnimating ? 'pot-display__main--animating' : ''}`}>
                <span className="pot-display__label">POT</span>
                <span className="pot-display__amount">
                    {formatAmount(displayPot, currency)}
                </span>
            </div>

            {/* Side Pots */}
            {sidePots.length > 0 && (
                <div className="pot-display__side-pots">
                    {sidePots.map((pot, i) => (
                        <SidePotBadge key={pot.id} pot={pot} index={i} />
                    ))}
                </div>
            )}

            {/* Total (if side pots exist) */}
            {sidePots.length > 0 && (
                <div className="pot-display__total">
                    <span className="pot-display__total-label">TOTAL</span>
                    <span className="pot-display__total-amount">
                        {formatAmount(totalPot, currency)}
                    </span>
                </div>
            )}

            {/* Pot Increase Indicator */}
            {isAnimating && mainPot > previousPot && (
                <div className="pot-display__increase">
                    +{formatAmount(mainPot - previousPot, currency)}
                </div>
            )}
        </div>
    );
}

export default PotDisplay;
