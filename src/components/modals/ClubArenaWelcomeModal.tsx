/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Club Arena Welcome Modal
 * ═══════════════════════════════════════════════════════════════════════════════
 * First-time entry acknowledgment popup for Club Arena
 * Users must accept before accessing club features
 *
 * ── ON THE SPADE CONSOLE (#ClubArenaConsole) ────────────────────────────────
 * This was a rounded Facebook-blue card: a gradient header bar, a bordered
 * "Important Notice" hero, a left-barred disclaimer block, a bulleted list
 * with drawn markers, a tinted info box, a hand-drawn checkmark square and a
 * blue gradient ENTER button. It is now Dan's approved spade master, cut into
 * head / rails / foot by SpadeConsole: WELCOME engraved in the header well,
 * IMPORTANT in the well's painted pill slot, every acknowledgment printed as
 * a row on the black glass with an engraved rule between, and the one action
 * as a lit word on that glass.
 *
 * ONE ACTION, SO NO PLATES. The foot paints BOTH plates, and this door has
 * only one way through it - a single plate would leave the other painted and
 * empty, which reads as broken rather than spare. So the foot is the flat
 * closing cap and ENTER POKER ARENA is a lit word, the same control Club Rules
 * uses for Copy and Retry.
 *
 * The agreement is a real checkbox to assistive technology (`role="checkbox"`
 * with `aria-checked`) and a lit word on the glass to everybody else: the
 * standard paints controls in the art, and the art paints no tick box.
 *
 * The copy is unchanged, and it is pinned: `tests/unit/nativeCompliance.test.ts`
 * requires "Club Play Credits" and Dan's 2026-09-07 sentence about chips
 * verbatim, on this file and two others.
 */

import { useState, useEffect } from 'react';
import { STORAGE_KEYS } from '../../lib/storage';
import { SpadeConsole } from '../console/SpadeConsole';
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="club-arena-welcome-title"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className={styles.scroller}>
          <SpadeConsole
            as="div"
            className={styles.console}
            eyebrow="Poker Arena"
            title="Welcome To Poker Arena"
            titleId="club-arena-welcome-title"
            pill="Important"
            pillInk="gold"
            foot="foot"
          >
            <p className={`sc-copy sc-copy--center ${styles.lead} sc-ink--silver`}>
              Club Arena Is An Online Social Gaming Platform And Does Not Provide Any Real-Money
              Service.
            </p>

            <span className={`sc-label sc-ink--blue ${styles.sectionLabel}`}>
              By Entering Club Arena, You Acknowledge
            </span>

            <ul className={styles.acknowledgements}>
              <li className={`sc-copy ${styles.acknowledgement}`}>
                This Is A <strong>Social Gaming Platform</strong> For Entertainment Purposes Only.
              </li>
              <li className={`sc-copy ${styles.acknowledgement}`}>
                Chips Are <strong>Club Play Credits</strong>. Smarter.Poker Does Not Sell, Redeem Or
                Pay Out Chips And Assigns Them No Monetary Value; Any Arrangement Between A Member
                And Their Club's Agent Is Private And Off-Platform.
              </li>
              <li className={`sc-copy ${styles.acknowledgement}`}>
                You Are <strong>18 Years Of Age Or Older</strong> (Or The Legal Age In Your
                Jurisdiction).
              </li>
              <li className={`sc-copy ${styles.acknowledgement}`}>
                You Will Abide By All <strong>Local, State, And National Laws</strong>.
              </li>
              <li className={`sc-copy ${styles.acknowledgement}`}>
                Club Arena Is <strong>Not Responsible</strong> For Any Interactions Or Arrangements
                Between Club Members.
              </li>
              <li className={`sc-copy ${styles.acknowledgement}`}>
                Club Owners And Operators Are <strong>Independent</strong> And Not Affiliated With
                Or Endorsed By Club Arena.
              </li>
            </ul>

            <p className={`sc-copy sc-copy--center ${styles.support}`}>
              For Questions Or Concerns, Contact Us At{' '}
              <a
                className={`${styles.supportLink} sc-ink--blue`}
                href="mailto:support@smarter.poker"
              >
                Support@Smarter.Poker
              </a>
            </p>

            {/* A checkbox to assistive technology, a lit word to everybody
                else: the art paints no tick box, so nothing here draws one. */}
            <button
              type="button"
              role="checkbox"
              aria-checked={hasAgreed}
              className={`${styles.agree} ${hasAgreed ? 'sc-ink--green' : 'sc-ink--muted'}`}
              onClick={() => setHasAgreed((agreed) => !agreed)}
            >
              I Understand And Agree To These Terms
            </button>

            <button
              type="button"
              className={`${styles.enter} ${hasAgreed ? 'sc-ink--white' : 'sc-ink--muted'}`}
              onClick={onAccept}
              disabled={!hasAgreed}
            >
              Enter Poker Arena
            </button>
          </SpadeConsole>
        </div>
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
