/**
 * 🎰 CLUB ENGINE — Profile Page
 * User profile, stats, and settings
 */

import styles from './ProfilePage.module.css';

// Mock user data
const MOCK_USER = {
    username: 'Player123',
    avatar: '👤',
    vip_level: 'gold',
    total_hands: 15420,
    vpip: 24.5,
    pfr: 18.2,
    bb_per_100: 4.2,
    biggest_pot: 1250,
    total_profit: 8540,
};

export default function ProfilePage() {
    return (
        <div className={styles.page}>
            {/* Profile Header */}
            <section className={styles.profileHeader}>
                <div className={styles.avatar}>
                    {MOCK_USER.avatar}
                    <span className={styles.vipBadge}>{MOCK_USER.vip_level.toUpperCase()}</span>
                </div>
                <div className={styles.userInfo}>
                    <h1 className={styles.username}>{MOCK_USER.username}</h1>
                    <p className={styles.memberSince}>Member since Jan 2025</p>
                </div>
                <button className="btn btn-ghost">Edit Profile</button>
            </section>

            {/* Stats Grid */}
            <section className={styles.statsSection}>
                <h2 className={styles.sectionTitle}>Career Stats</h2>
                <div className={styles.statsGrid}>
                    <div className={styles.statCard}>
                        <span className={styles.statValue}>{MOCK_USER.total_hands.toLocaleString()}</span>
                        <span className={styles.statLabel}>Hands Played</span>
                    </div>
                    <div className={styles.statCard}>
                        <span className={styles.statValue}>{MOCK_USER.vpip}%</span>
                        <span className={styles.statLabel}>VPIP</span>
                    </div>
                    <div className={styles.statCard}>
                        <span className={styles.statValue}>{MOCK_USER.pfr}%</span>
                        <span className={styles.statLabel}>PFR</span>
                    </div>
                    <div className={styles.statCard}>
                        <span className={`${styles.statValue} ${MOCK_USER.bb_per_100 > 0 ? styles.positive : styles.negative}`}>
                            {MOCK_USER.bb_per_100 > 0 ? '+' : ''}{MOCK_USER.bb_per_100}
                        </span>
                        <span className={styles.statLabel}>BB/100</span>
                    </div>
                    <div className={styles.statCard}>
                        <span className={styles.statValue}>${MOCK_USER.biggest_pot}</span>
                        <span className={styles.statLabel}>Biggest Pot</span>
                    </div>
                    <div className={styles.statCard}>
                        <span className={`${styles.statValue} ${styles.positive}`}>
                            +${MOCK_USER.total_profit.toLocaleString()}
                        </span>
                        <span className={styles.statLabel}>Total Profit</span>
                    </div>
                </div>
            </section>

            {/* Recent Hands */}
            <section className={styles.historySection}>
                <h2 className={styles.sectionTitle}>Recent Hands</h2>
                <div className={styles.historyList}>
                    <div className={styles.emptyHistory}>
                        <span>🃏</span>
                        <p>No recent hands to display.</p>
                        <button className="btn btn-primary">Start Playing</button>
                    </div>
                </div>
            </section>
        </div>
    );
}
