/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⏱️ TIMER BAR — Action Clock Progress Bar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium action timer featuring:
 * - Smooth countdown animation
 * - Color gradient (green → yellow → red)
 * - Warning pulse effect
 * - Time bank integration
 */

import React, { useMemo } from 'react';
import './TimerBar.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TimerBarProps {
    /** Time remaining in seconds */
    timeRemaining: number;
    /** Total time allowed */
    maxTime: number;
    /** Time bank remaining (optional) */
    timeBank?: number;
    /** Whether using time bank */
    isUsingTimeBank?: boolean;
    /** Layout orientation */
    orientation?: 'horizontal' | 'circular';
    /** Size variant */
    size?: 'small' | 'medium' | 'large';
    /** Show numeric countdown */
    showCountdown?: boolean;
    /** Called when timer expires */
    onExpire?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const WARNING_THRESHOLD = 0.25; // Start warning at 25% remaining
const CRITICAL_THRESHOLD = 0.1; // Critical at 10% remaining

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TimerBar({
    timeRemaining,
    maxTime,
    timeBank = 0,
    isUsingTimeBank = false,
    orientation = 'horizontal',
    size = 'medium',
    showCountdown = true,
    onExpire,
}: TimerBarProps) {
    // Calculate progress (0-100)
    const progress = useMemo(() => {
        return Math.max(0, Math.min(100, (timeRemaining / maxTime) * 100));
    }, [timeRemaining, maxTime]);

    // Determine color state
    const colorState = useMemo(() => {
        const ratio = timeRemaining / maxTime;
        if (ratio <= CRITICAL_THRESHOLD) return 'critical';
        if (ratio <= WARNING_THRESHOLD) return 'warning';
        return 'normal';
    }, [timeRemaining, maxTime]);

    // Build class names
    const containerClasses = useMemo(() => {
        const classes = [
            'timer-bar',
            `timer-bar--${orientation}`,
            `timer-bar--${size}`,
            `timer-bar--${colorState}`,
        ];
        if (isUsingTimeBank) classes.push('timer-bar--time-bank');
        if (progress <= 10) classes.push('timer-bar--pulsing');
        return classes.join(' ');
    }, [orientation, size, colorState, isUsingTimeBank, progress]);

    // Format time display
    const formattedTime = useMemo(() => {
        const seconds = Math.ceil(timeRemaining);
        if (seconds >= 60) {
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        }
        return seconds.toString();
    }, [timeRemaining]);

    // Check for expiration
    React.useEffect(() => {
        if (timeRemaining <= 0 && onExpire) {
            onExpire();
        }
    }, [timeRemaining, onExpire]);

    // Circular timer (for seat component)
    if (orientation === 'circular') {
        const radius = size === 'small' ? 20 : size === 'large' ? 36 : 28;
        const circumference = 2 * Math.PI * radius;
        const strokeOffset = circumference - (progress / 100) * circumference;

        return (
            <div className={containerClasses}>
                <svg
                    className="timer-bar__circle"
                    viewBox={`0 0 ${(radius + 4) * 2} ${(radius + 4) * 2}`}
                >
                    {/* Background circle */}
                    <circle
                        className="timer-bar__circle-bg"
                        cx={radius + 4}
                        cy={radius + 4}
                        r={radius}
                    />
                    {/* Progress circle */}
                    <circle
                        className="timer-bar__circle-progress"
                        cx={radius + 4}
                        cy={radius + 4}
                        r={radius}
                        strokeDasharray={circumference}
                        strokeDashoffset={strokeOffset}
                        style={{
                            '--progress-color': colorState === 'critical' ? '#F85149' :
                                colorState === 'warning' ? '#FFB800' : '#3FB950',
                        } as React.CSSProperties}
                    />
                </svg>
                {showCountdown && (
                    <span className="timer-bar__countdown">{formattedTime}</span>
                )}
            </div>
        );
    }

    // Horizontal timer (default)
    return (
        <div className={containerClasses}>
            {/* Track */}
            <div className="timer-bar__track">
                {/* Progress fill */}
                <div
                    className="timer-bar__fill"
                    style={{
                        width: `${progress}%`,
                        '--progress-color': colorState === 'critical' ? '#F85149' :
                            colorState === 'warning' ? '#FFB800' : '#3FB950',
                    } as React.CSSProperties}
                />
            </div>

            {/* Countdown & Time Bank */}
            {showCountdown && (
                <div className="timer-bar__info">
                    <span className="timer-bar__time">{formattedTime}</span>
                    {timeBank > 0 && (
                        <span className={`timer-bar__time-bank ${isUsingTimeBank ? 'timer-bar__time-bank--active' : ''}`}>
                            +{timeBank}s
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

export default TimerBar;
