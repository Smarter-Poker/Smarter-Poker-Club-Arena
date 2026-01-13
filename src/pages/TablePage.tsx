/**
 * 🎰 CLUB ENGINE — Table Page
 * Poker table gameplay interface
 */

import { useParams } from 'react-router-dom';
import styles from './TablePage.module.css';

export default function TablePage() {
    const { tableId } = useParams();

    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1>🃏 Poker Table</h1>
                <p>Table ID: {tableId}</p>
            </header>
            <div className={styles.tableArea}>
                {/* Poker table will be rendered here */}
                <div className={styles.tableFelt}>
                    <div className={styles.tableCenter}>
                        <span className={styles.potLabel}>POT</span>
                        <span className={styles.potAmount}>$0</span>
                    </div>
                </div>
            </div>
            <div className={styles.actions}>
                <button className="btn btn-danger">Fold</button>
                <button className="btn btn-ghost">Check</button>
                <button className="btn btn-primary">Bet</button>
            </div>
        </div>
    );
}
