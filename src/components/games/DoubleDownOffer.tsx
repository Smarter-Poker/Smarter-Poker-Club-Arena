import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { WheelPrizeArt } from '../wheel/WheelPrizeArt';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import type { BonusBudget } from '../../utils/bonusGameBudget';
import styles from '../wheel/WheelWinReveal.module.css';

/**
 * SCREEN ONE OF A WON BONUS GAME (Dan 2026-09-21, R9): "The NEXT screen is
 * where they decide whether to double their diamonds." Two explicit choices,
 * Add The Diamonds or Play Without, and nothing else closes it: no timer (the
 * eight-second window that used to answer it with Keep My Bonus is gone with
 * every other auto start, R1), no overlay tap, no Escape. Choosing changes the
 * setup only; the existing game admission owns the debit when the player
 * starts.
 */
export default function DoubleDownOffer({
  budget,
  diamonds,
  onChoose,
  onBuyMore,
}: {
  budget: BonusBudget;
  diamonds: number | null;
  onChoose: (doubled: boolean) => void;
  onBuyMore: () => void;
}) {
  const extra = budget.award?.entryDiamonds ?? budget.base;
  const canAdd = diamonds !== null && diamonds >= extra;
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  // The plates open when the reveal has played. If the browser never reports
  // the animation's end (reduced motion, a throttled tab), they open anyway a
  // moment after it would have, so the offer can never be a dead end.
  useEffect(() => {
    if (ready || !visible) return;
    const timer = setTimeout(() => setReady(true), 1400 * getAnimationSpeed() + 600);
    return () => clearTimeout(timer);
  }, [ready, visible]);
  return (
    <Modal
      isOpen
      ariaLabel="Double Your Diamonds"
      onClose={() => undefined}
      closeOnOverlay={false}
      closeOnEscape={false}
      showCloseButton={false}
      className={`${styles.dialog} ${styles.offerDialog}`}
    >
      <div
        className={styles.opening}
        data-motion="keep"
        data-bonus-step="offer"
        style={{
          animationDuration: `${1400 * getAnimationSpeed()}ms`,
          animationPlayState: visible ? 'running' : 'paused',
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setReady(true);
        }}
      >
        <SpadeConsole
          eyebrow="Your Bonus Game"
          title="Double Your Diamonds"
          pill="Your Choice"
          plates={{
            secondary: { label: 'Play Without', disabled: !ready, onClick: () => onChoose(false) },
            primary: {
              label:
                diamonds === null ? 'Checking Balance' : canAdd ? 'Add The Diamonds' : 'Buy More',
              disabled: !ready || diamonds === null,
              onClick: () => (canAdd ? onChoose(true) : onBuyMore()),
            },
          }}
        >
          <div className={`${styles.prize} ${styles.offerPrize}`} aria-hidden="true">
            <div className={styles.rays} />
            <WheelPrizeArt segment={{ kind: 'diamonds' }} className={styles.art} />
          </div>
          <p className="sc-copy sc-copy--center">
            Add {extra.toLocaleString()} Diamonds To Your {budget.base.toLocaleString()} Diamond
            Bonus. Play With {(budget.base + extra).toLocaleString()} Diamonds.
          </p>
          <p className="sc-copy sc-copy--center">
            Extra Diamonds Are Used Only When You Start The Game. Playing Without Costs Nothing
            Extra.
          </p>
          {diamonds !== null && !canAdd && (
            <p className="sc-copy sc-copy--center sc-ink--gold">
              You Need {(extra - diamonds).toLocaleString()} More Diamonds To Add Them.
            </p>
          )}
        </SpadeConsole>
      </div>
    </Modal>
  );
}
