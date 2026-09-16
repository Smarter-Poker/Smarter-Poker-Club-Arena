/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Club Arena Welcome Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * First-time entry acknowledgment popup for Club Arena
 * Users must accept before accessing club features
 *
 * DESIGN: Facebook Blue color scheme (#1877F2)
 */

import { useState, useEffect } from 'react';
import { STORAGE_KEYS } from '../../lib/storage';
import styles from './ClubArenaWelcomeModal.module.css';

interface ClubArenaWelcomeModalProps {
  isOpen: boolean;
  onAccept: () => void;
}

export default function ClubArenaWelcomeModal({ isOpen, onAccept }: ClubArenaWelcomeModalProps) {
  const [hasAgreed, setHasAgreed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setHasAgreed(false);
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay}>
      <div
        className={styles.modal}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <header className={styles.header}>
          <h2>Welcome To Poker Arena</h2>
        </header>

        <div className={styles.content}>
          <div className={styles.heroSection}>
            <h3>Important Notice</h3>
          </div>

          <div className={styles.disclaimer}>
            <p>
              <strong>
                Club Arena Is An Online Social Gaming Platform And Does Not Provide Any Real-Money
                Service.
              </strong>
            </p>
          </div>

          <div className={styles.rules}>
            <h4>By Entering Club Arena, You Acknowledge:</h4>
            <ul>
              <li>
                This Is A <strong>Social Gaming Platform</strong> For Entertainment Purposes Only.
              </li>
              <li>
                Chips Are <strong>Club Play Credits</strong>. Smarter.Poker Does Not Sell, Redeem Or
                Pay Out Chips And Assigns Them No Monetary Value; Any Arrangement Between A Member
                And Their Club's Agent Is Private And Off-Platform.
              </li>
              <li>
                You Are <strong>18 Years Of Age Or Older</strong> (Or The Legal Age In Your
                Jurisdiction).
              </li>
              <li>
                You Will Abide By All <strong>Local, State, And National Laws</strong>.
              </li>
              <li>
                Club Arena Is <strong>Not Responsible</strong> For Any Interactions Or Arrangements
                Between Club Members.
              </li>
              <li>
                Club Owners And Operators Are <strong>Independent</strong> And Not Affiliated With
                Or Endorsed By Club Arena.
              </li>
            </ul>
          </div>

          <div className={styles.infoBox}>
            <p>
              For Questions Or Concerns, Contact Us At{' '}
              <a href="mailto:support@smarter.poker">Support@Smarter.Poker</a>
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
            <span>I Understand And Agree To These Terms</span>
          </label>

          <button className={styles.enterButton} onClick={onAccept} disabled={!hasAgreed}>
            Enter Poker Arena
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
  const [showWelcome, setShowWelcome] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Check if user has already accepted
    const hasAccepted = localStorage.getItem(STORAGE_KEYS.WELCOME_ACCEPTED) === 'true';
    if (!hasAccepted) {
      setShowWelcome(true);
    }
    setIsReady(true);
  }, []);

  const acceptWelcome = () => {
    localStorage.setItem(STORAGE_KEYS.WELCOME_ACCEPTED, 'true');
    setShowWelcome(false);
  };

  const resetWelcome = () => {
    localStorage.removeItem(STORAGE_KEYS.WELCOME_ACCEPTED);
    setShowWelcome(true);
  };

  return {
    showWelcome,
    isReady,
    acceptWelcome,
    resetWelcome,
  };
}
