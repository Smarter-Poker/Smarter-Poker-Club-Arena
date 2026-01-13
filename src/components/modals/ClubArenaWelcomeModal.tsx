/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Club Arena Welcome Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * First-time entry acknowledgment popup for Club Arena
 * Users must accept before accessing club features
 */

import { useState, useEffect } from 'react';
import styles from './ClubArenaWelcomeModal.module.css';

interface ClubArenaWelcomeModalProps {
    isOpen: boolean;
    onAccept: () => void;
}

export default function ClubArenaWelcomeModal({ isOpen, onAccept }: ClubArenaWelcomeModalProps) {
    const [hasAgreed, setHasAgreed] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setHasAgreed(false);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <div className={styles.overlay}>
            <div className={styles.modal}>
                <header className={styles.header}>
                    <h2>Welcome to Club Arena</h2>
                </header>

                <div className={styles.content}>
                    <div className={styles.heroSection}>
                        <span className={styles.heroIcon}>🎰</span>
                        <h3>Important Notice</h3>
                    </div>

                    <div className={styles.disclaimer}>
                        <p>
                            <strong>Smarter.Poker is an online social gaming platform and does not
                                provide any real-money service.</strong>
                        </p>
                    </div>

                    <div className={styles.rules}>
                        <h4>By entering Club Arena, you acknowledge:</h4>
                        <ul>
                            <li>
                                <span className={styles.bullet}>✓</span>
                                This is a <strong>social gaming platform</strong> for entertainment purposes only
                            </li>
                            <li>
                                <span className={styles.bullet}>✓</span>
                                All chips and currencies are <strong>virtual</strong> with no real-world monetary value
                            </li>
                            <li>
                                <span className={styles.bullet}>✓</span>
                                You are <strong>18 years of age or older</strong> (or the legal age in your jurisdiction)
                            </li>
                            <li>
                                <span className={styles.bullet}>✓</span>
                                You will abide by all <strong>local, state, and national laws</strong>
                            </li>
                            <li>
                                <span className={styles.bullet}>✓</span>
                                Smarter.Poker is <strong>not responsible</strong> for any interactions or arrangements
                                between club members
                            </li>
                            <li>
                                <span className={styles.bullet}>✓</span>
                                Club owners and operators are <strong>independent</strong> and not affiliated with
                                or endorsed by Smarter.Poker
                            </li>
                        </ul>
                    </div>

                    <div className={styles.infoBox}>
                        <span className={styles.infoIcon}>ℹ️</span>
                        <p>
                            For questions or concerns, contact us at{' '}
                            <a href="mailto:support@smarter.poker">support@smarter.poker</a>
                        </p>
                    </div>
                </div>

                <footer className={styles.footer}>
                    <label className={styles.checkbox}>
                        <input
                            type="checkbox"
                            checked={hasAgreed}
                            onChange={(e) => setHasAgreed(e.target.checked)}
                        />
                        <span className={styles.checkmark} />
                        <span>I understand and agree to these terms</span>
                    </label>

                    <button
                        className={styles.enterButton}
                        onClick={onAccept}
                        disabled={!hasAgreed}
                    >
                        Enter Club Arena
                    </button>
                </footer>
            </div>
        </div>
    );
}

/**
 * Hook to manage first-time Club Arena entry
 */
export function useClubArenaWelcome() {
    const STORAGE_KEY = 'club_arena_welcome_accepted';
    const [showWelcome, setShowWelcome] = useState(false);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        // Check if user has already accepted
        const hasAccepted = localStorage.getItem(STORAGE_KEY) === 'true';
        if (!hasAccepted) {
            setShowWelcome(true);
        }
        setIsReady(true);
    }, []);

    const acceptWelcome = () => {
        localStorage.setItem(STORAGE_KEY, 'true');
        setShowWelcome(false);
    };

    const resetWelcome = () => {
        localStorage.removeItem(STORAGE_KEY);
        setShowWelcome(true);
    };

    return {
        showWelcome,
        isReady,
        acceptWelcome,
        resetWelcome,
    };
}
