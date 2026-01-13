/**
 * 🎰 CLUB ENGINE — Quick Actions
 * Hero section quick action buttons
 */

import { useNavigate } from 'react-router-dom';
import styles from './QuickActions.module.css';

export default function QuickActions() {
    const navigate = useNavigate();

    return (
        <div className={styles.actions}>
            <button className={styles.actionButton} onClick={() => navigate('/clubs')}>
                <span className={styles.actionIcon}>🏛️</span>
                <span className={styles.actionLabel}>My Clubs</span>
            </button>
            <button className={styles.actionButton} onClick={() => { }}>
                <span className={styles.actionIcon}>➕</span>
                <span className={styles.actionLabel}>Create Table</span>
            </button>
            <button className={`${styles.actionButton} ${styles.primary}`} onClick={() => { }}>
                <span className={styles.actionIcon}>⚡</span>
                <span className={styles.actionLabel}>Quick Seat</span>
            </button>
        </div>
    );
}
