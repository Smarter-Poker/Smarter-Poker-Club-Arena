/**
 * 🎰 CLUB ENGINE — Lobby Page
 * Main game lobby with tables, game types, and quick actions
 */

import { useState } from 'react';
import styles from './LobbyPage.module.css';
import TableCard from '../components/lobby/TableCard';
import GameTypeTabs from '../components/lobby/GameTypeTabs';
import QuickActions from '../components/lobby/QuickActions';

// Mock data for demo
const MOCK_TABLES = [
    {
        id: '1',
        name: 'High Stakes NLH',
        game_variant: 'nlh' as const,
        stakes: '5/10',
        players: 6,
        seats: 9,
        waiting: 2,
        avg_pot: 450,
    },
    {
        id: '2',
        name: 'PLO Action',
        game_variant: 'plo4' as const,
        stakes: '2/5',
        players: 5,
        seats: 6,
        waiting: 0,
        avg_pot: 320,
    },
    {
        id: '3',
        name: 'Beginner NLH',
        game_variant: 'nlh' as const,
        stakes: '0.5/1',
        players: 4,
        seats: 9,
        waiting: 0,
        avg_pot: 25,
    },
    {
        id: '4',
        name: 'Short Deck',
        game_variant: 'short_deck' as const,
        stakes: '1/2',
        players: 6,
        seats: 6,
        waiting: 1,
        avg_pot: 180,
    },
];

type GameFilter = 'all' | 'nlh' | 'plo' | 'ofc' | 'tournaments';

export default function LobbyPage() {
    const [activeFilter, setActiveFilter] = useState<GameFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');

    const filteredTables = MOCK_TABLES.filter(table => {
        if (activeFilter !== 'all') {
            if (activeFilter === 'nlh' && !['nlh', 'short_deck'].includes(table.game_variant)) return false;
            if (activeFilter === 'plo' && !table.game_variant.startsWith('plo')) return false;
        }
        if (searchQuery && !table.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
    });

    return (
        <div className={styles.lobby}>
            {/* Hero Section */}
            <section className={styles.hero}>
                <div className={styles.heroContent}>
                    <h1 className={styles.heroTitle}>
                        <span className={styles.heroIcon}>♠</span>
                        Club Engine
                    </h1>
                    <p className={styles.heroSubtitle}>
                        Private poker clubs, better than ever.
                    </p>
                </div>
                <QuickActions />
            </section>

            {/* Game Type Tabs */}
            <section className={styles.filterSection}>
                <GameTypeTabs
                    activeFilter={activeFilter}
                    onFilterChange={setActiveFilter}
                />

                <div className={styles.searchBox}>
                    <span className={styles.searchIcon}>🔍</span>
                    <input
                        type="text"
                        placeholder="Search tables..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className={styles.searchInput}
                    />
                </div>
            </section>

            {/* Tables Grid */}
            <section className={styles.tablesSection}>
                <div className={styles.sectionHeader}>
                    <h2 className={styles.sectionTitle}>Active Tables</h2>
                    <span className={styles.tableCount}>{filteredTables.length} tables</span>
                </div>

                {filteredTables.length > 0 ? (
                    <div className={styles.tablesGrid}>
                        {filteredTables.map(table => (
                            <TableCard key={table.id} table={table} />
                        ))}
                    </div>
                ) : (
                    <div className={styles.emptyState}>
                        <span className={styles.emptyIcon}>🎰</span>
                        <h3>No tables found</h3>
                        <p>Try adjusting your filters or create a new table.</p>
                        <button className="btn btn-primary">Create Table</button>
                    </div>
                )}
            </section>

            {/* Recent Activity */}
            <section className={styles.activitySection}>
                <div className={styles.sectionHeader}>
                    <h2 className={styles.sectionTitle}>Recent Activity</h2>
                </div>
                <div className={styles.activityList}>
                    <div className={styles.activityItem}>
                        <span className={styles.activityIcon}>🏆</span>
                        <div className={styles.activityContent}>
                            <span className={styles.activityUser}>Player123</span> won a <span className={styles.activityHighlight}>$450</span> pot
                        </div>
                        <span className={styles.activityTime}>2m ago</span>
                    </div>
                    <div className={styles.activityItem}>
                        <span className={styles.activityIcon}>🎯</span>
                        <div className={styles.activityContent}>
                            <span className={styles.activityUser}>AceMaster</span> joined <span className={styles.activityHighlight}>High Stakes NLH</span>
                        </div>
                        <span className={styles.activityTime}>5m ago</span>
                    </div>
                    <div className={styles.activityItem}>
                        <span className={styles.activityIcon}>💎</span>
                        <div className={styles.activityContent}>
                            <span className={styles.activityUser}>ProGrinder</span> hit the <span className={styles.activityHighlight}>Bad Beat Jackpot!</span>
                        </div>
                        <span className={styles.activityTime}>12m ago</span>
                    </div>
                </div>
            </section>
        </div>
    );
}
