/**
 * 🎰 CHIP STACK COMPONENT
 * Premium visual chip stacks with denomination colors and animations
 */

import './ChipStack.css';

// Chip denomination colors (inspired by real casino chips)
const CHIP_COLORS: Record<number, { bg: string; border: string; text: string }> = {
    1: { bg: '#ffffff', border: '#888888', text: '#333333' },      // White - $1
    5: { bg: '#e74c3c', border: '#c0392b', text: '#ffffff' },      // Red - $5
    25: { bg: '#27ae60', border: '#1e8449', text: '#ffffff' },     // Green - $25
    100: { bg: '#1a1a2e', border: '#333355', text: '#ffffff' },    // Black - $100
    500: { bg: '#8e44ad', border: '#6c3483', text: '#ffffff' },    // Purple - $500
    1000: { bg: '#f1c40f', border: '#d4ac0d', text: '#1a1a2e' },   // Gold - $1000
    5000: { bg: '#e67e22', border: '#d35400', text: '#ffffff' },   // Orange - $5000
};

export interface ChipStackProps {
    amount: number;
    size?: 'sm' | 'md' | 'lg';
    showLabel?: boolean;
    animated?: boolean;
    className?: string;
}

// Calculate optimal chip breakdown
function calculateChips(amount: number): { value: number; count: number }[] {
    const denominations = [5000, 1000, 500, 100, 25, 5, 1];
    const chips: { value: number; count: number }[] = [];
    let remaining = amount;

    for (const denom of denominations) {
        if (remaining >= denom) {
            const count = Math.floor(remaining / denom);
            chips.push({ value: denom, count: Math.min(count, 10) }); // Cap at 10 per denomination
            remaining -= count * denom;
        }
    }

    return chips.slice(0, 5); // Max 5 stacks for visual clarity
}

// Get chip color based on closest denomination
function getChipColor(value: number) {
    const denoms = Object.keys(CHIP_COLORS).map(Number).sort((a, b) => b - a);
    for (const denom of denoms) {
        if (value >= denom) {
            return CHIP_COLORS[denom];
        }
    }
    return CHIP_COLORS[1];
}

// Chip sizes
const SIZES = {
    sm: { chipSize: 20, spacing: 3 },
    md: { chipSize: 28, spacing: 4 },
    lg: { chipSize: 36, spacing: 5 },
};

export default function ChipStack({
    amount,
    size = 'md',
    showLabel = true,
    animated = true,
    className = '',
}: ChipStackProps) {
    if (amount <= 0) return null;

    const chips = calculateChips(amount);
    const { chipSize, spacing } = SIZES[size];

    return (
        <div className={`chip-stack-container ${className}`}>
            {/* Chip Stacks */}
            <div className="chip-stacks">
                {chips.map((stack, stackIndex) => {
                    const color = getChipColor(stack.value);
                    const stackHeight = Math.min(stack.count, 5);

                    return (
                        <div
                            key={stack.value}
                            className={`chip-stack ${animated ? 'animated' : ''}`}
                            style={{
                                animationDelay: `${stackIndex * 50}ms`,
                            }}
                        >
                            {Array.from({ length: stackHeight }).map((_, chipIndex) => (
                                <div
                                    key={chipIndex}
                                    className="chip"
                                    style={{
                                        width: chipSize,
                                        height: chipSize * 0.2,
                                        background: `linear-gradient(135deg, ${color.bg} 0%, ${color.border} 100%)`,
                                        borderColor: color.border,
                                        bottom: chipIndex * spacing,
                                        zIndex: stackHeight - chipIndex,
                                    }}
                                >
                                    {chipIndex === stackHeight - 1 && (
                                        <span
                                            className="chip-value"
                                            style={{ color: color.text, fontSize: chipSize * 0.35 }}
                                        >
                                            {stack.value >= 1000 ? `${stack.value / 1000}K` : stack.value}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>

            {/* Amount Label */}
            {showLabel && (
                <div className="chip-amount">
                    {amount.toLocaleString()}
                </div>
            )}
        </div>
    );
}

// Pot display with chip pile visualization
export function PotDisplay({
    amount,
    size = 'md',
}: {
    amount: number;
    size?: 'sm' | 'md' | 'lg';
}) {
    if (amount <= 0) return null;

    return (
        <div className="pot-display-premium">
            <div className="pot-chips">
                <ChipStack amount={amount} size={size} showLabel={false} />
            </div>
            <div className="pot-info">
                <span className="pot-label">POT</span>
                <span className="pot-value">{amount.toLocaleString()}</span>
            </div>
        </div>
    );
}

export { ChipStack };
