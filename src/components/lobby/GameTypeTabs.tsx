/**
 * 🎰 CLUB ENGINE — Game Type Tabs
 * Filter tabs for different poker variants
 */

import styles from './GameTypeTabs.module.css';

type GameFilter = 'all' | 'nlh' | 'plo' | 'ofc' | 'tournaments';

interface GameTypeTabsProps {
    activeFilter: GameFilter;
    onFilterChange: (filter: GameFilter) => void;
}

const TABS: { id: GameFilter; label: string; icon: string }[] = [
    { id: 'all', label: 'All Games', icon: '🎰' },
    { id: 'nlh', label: "Hold'em", icon: '♠' },
    { id: 'plo', label: 'Omaha', icon: '🃏' },
    { id: 'ofc', label: 'OFC', icon: '🀄' },
    { id: 'tournaments', label: 'Tournaments', icon: '🏆' },
];

export default function GameTypeTabs({ activeFilter, onFilterChange }: GameTypeTabsProps) {
    return (
        <div className={styles.tabs}>
            {TABS.map(tab => (
                <button
                    key={tab.id}
                    className={`${styles.tab} ${activeFilter === tab.id ? styles.active : ''}`}
                    onClick={() => onFilterChange(tab.id)}
                >
                    <span className={styles.tabIcon}>{tab.icon}</span>
                    <span className={styles.tabLabel}>{tab.label}</span>
                </button>
            ))}
        </div>
    );
}
