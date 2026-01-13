/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💀 ELIMINATION OVERLAY — Tournament Knockout Animation
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useEffect, useState } from 'react';
import './EliminationOverlay.css';

export interface EliminatedPlayer {
    id: string;
    name: string;
    avatarUrl?: string;
    position: number;
    prize: number;
    bountyCollectedBy?: string;
    bountyAmount?: number;
}

export interface EliminationOverlayProps {
    elimination: EliminatedPlayer | null;
    tournamentName: string;
    totalPlayers: number;
    onComplete?: () => void;
}

export const EliminationOverlay: React.FC<EliminationOverlayProps> = ({
    elimination,
    tournamentName,
    totalPlayers,
    onComplete,
}) => {
    const [phase, setPhase] = useState<'entering' | 'showing' | 'exiting' | 'hidden'>('hidden');

    useEffect(() => {
        if (elimination) {
            setPhase('entering');

            const showTimer = setTimeout(() => setPhase('showing'), 100);
            const exitTimer = setTimeout(() => setPhase('exiting'), 3500);
            const hideTimer = setTimeout(() => {
                setPhase('hidden');
                onComplete?.();
            }, 4500);

            return () => {
                clearTimeout(showTimer);
                clearTimeout(exitTimer);
                clearTimeout(hideTimer);
            };
        }
    }, [elimination, onComplete]);

    if (phase === 'hidden' || !elimination) return null;

    const getPositionSuffix = (pos: number) => {
        if (pos === 1) return 'st';
        if (pos === 2) return 'nd';
        if (pos === 3) return 'rd';
        return 'th';
    };

    const isBubble = elimination.prize === 0 && elimination.position === Math.floor(totalPlayers * 0.2) + 1;
    const isMoneyFinish = elimination.prize > 0;

    return (
        <div className={`elimination-overlay elimination-overlay--${phase}`}>
            <div className="elimination-backdrop" />

            <div className="elimination-content">
                {/* Skull animation */}
                <div className="elimination-icon">
                    {isMoneyFinish ? '💰' : isBubble ? '🫧' : '💀'}
                </div>

                {/* Player info */}
                <div className="elimination-player">
                    {elimination.avatarUrl ? (
                        <img
                            src={elimination.avatarUrl}
                            alt={elimination.name}
                            className="elimination-avatar"
                        />
                    ) : (
                        <div className="elimination-avatar elimination-avatar--default">
                            {elimination.name.charAt(0).toUpperCase()}
                        </div>
                    )}
                    <h2 className="elimination-name">{elimination.name}</h2>
                </div>

                {/* Position & Prize */}
                <div className="elimination-result">
                    <div className="elimination-position">
                        <span className="elimination-position-number">
                            {elimination.position}
                            <sup>{getPositionSuffix(elimination.position)}</sup>
                        </span>
                        <span className="elimination-position-label">Place</span>
                    </div>

                    {elimination.prize > 0 && (
                        <div className="elimination-prize">
                            <span className="elimination-prize-amount">
                                {elimination.prize.toLocaleString()}
                            </span>
                            <span className="elimination-prize-label">Chips Won</span>
                        </div>
                    )}
                </div>

                {/* Bounty info (for bounty tournaments) */}
                {elimination.bountyCollectedBy && elimination.bountyAmount && (
                    <div className="elimination-bounty">
                        <span className="elimination-bounty-icon">🎯</span>
                        <span className="elimination-bounty-text">
                            Bounty collected by <strong>{elimination.bountyCollectedBy}</strong>
                        </span>
                        <span className="elimination-bounty-amount">
                            +{elimination.bountyAmount.toLocaleString()}
                        </span>
                    </div>
                )}

                {/* Bubble boy special */}
                {isBubble && (
                    <div className="elimination-bubble">
                        <span>🫧 BUBBLE BOY 🫧</span>
                    </div>
                )}

                {/* Tournament name */}
                <div className="elimination-tournament">
                    {tournamentName}
                </div>
            </div>
        </div>
    );
};

export default EliminationOverlay;
