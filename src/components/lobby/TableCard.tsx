/**
 * 🎰 CLUB ENGINE — Table Card Component
 * Displays a single table in the lobby grid
 */

import { useNavigate } from 'react-router-dom';
import styles from './TableCard.module.css';
import type { GameVariant } from '../../types/club.types';

interface TableCardProps {
    table: {
        id: string;
        name: string;
        game_variant: GameVariant;
        stakes: string;
        players: number;
        seats: number;
        waiting: number;
        avg_pot: number;
    };
}

const GAME_LABELS: Record<string, string> = {
    nlh: 'NL Hold\'em',
    flh: 'FL Hold\'em',
    short_deck: 'Short Deck',
    plo4: 'PLO4',
    plo5: 'PLO5',
    plo6: 'PLO6',
    plo_hilo: 'PLO Hi-Lo',
    ofc: 'OFC',
    ofc_pineapple: 'OFC Pineapple',
    double_board: 'Double Board',
    pineapple: 'Pineapple',
    crazy_pineapple: 'Crazy Pineapple',
    mixed: 'Mixed',
};

const GAME_ICONS: Record<string, string> = {
    nlh: '♠',
    flh: '♠',
    short_deck: '6️⃣',
    plo4: '🃏',
    plo5: '🃏',
    plo6: '🃏',
    plo_hilo: '↕️',
    ofc: '🀄',
    ofc_pineapple: '🍍',
    double_board: '🎴',
    pineapple: '🍍',
    crazy_pineapple: '🍍',
    mixed: '🎰',
};

export default function TableCard({ table }: TableCardProps) {
    const navigate = useNavigate();
    const seatsAvailable = table.seats - table.players;
    const isFull = seatsAvailable === 0;
    const hasWaitlist = table.waiting > 0;

    const handleJoin = () => {
        navigate(`/table/${table.id}`);
    };

    return (
        <div className={styles.card}>
            {/* Header with game type */}
            <div className={styles.header}>
                <div className={styles.gameType}>
                    <span className={styles.gameIcon}>{GAME_ICONS[table.game_variant] || '♠'}</span>
                    <span className={styles.gameLabel}>{GAME_LABELS[table.game_variant] || table.game_variant}</span>
                </div>
                <div className={styles.stakes}>{table.stakes}</div>
            </div>

            {/* Table Name */}
            <h3 className={styles.tableName}>{table.name}</h3>

            {/* Stats Row */}
            <div className={styles.stats}>
                <div className={styles.stat}>
                    <span className={styles.statLabel}>Players</span>
                    <span className={styles.statValue}>
                        {table.players}/{table.seats}
                    </span>
                </div>
                <div className={styles.stat}>
                    <span className={styles.statLabel}>Avg Pot</span>
                    <span className={styles.statValue}>${table.avg_pot}</span>
                </div>
                {hasWaitlist && (
                    <div className={`${styles.stat} ${styles.waitlist}`}>
                        <span className={styles.statLabel}>Waiting</span>
                        <span className={styles.statValue}>{table.waiting}</span>
                    </div>
                )}
            </div>

            {/* Seats Visualization */}
            <div className={styles.seatsBar}>
                <div
                    className={styles.seatsFilled}
                    style={{ width: `${(table.players / table.seats) * 100}%` }}
                />
            </div>

            {/* Action Button */}
            <button
                className={`${styles.joinButton} ${isFull ? styles.waitlistButton : ''}`}
                onClick={handleJoin}
            >
                {isFull ? (hasWaitlist ? 'Join Waitlist' : 'Table Full') : 'Join Table'}
            </button>
        </div>
    );
}
