/**
 * 🎰 CLUB ENGINE — Club Detail Page
 * Individual club view with tables and members
 */

import { useParams } from 'react-router-dom';
import styles from './ClubDetailPage.module.css';

export default function ClubDetailPage() {
    const { clubId } = useParams();

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1>Club Details</h1>
                <p>Club ID: {clubId}</p>
            </header>
            <div className={styles.content}>
                <p>Club detail page coming soon...</p>
            </div>
        </div>
    );
}
