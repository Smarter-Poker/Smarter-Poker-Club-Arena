import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { WheelPrizeArt } from '../wheel/WheelPrizeArt';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import type { BonusBudget } from '../../utils/bonusGameBudget';
import styles from '../wheel/WheelWinReveal.module.css';

/** Choosing an offer changes setup only. The existing game admission owns the debit.
 *
 * No game starts itself (owner ruling 2026-09-21, R1 and R9): the offer waits
 * for the player's own answer, so the eight-second window that answered it with
 * Keep My Bonus is gone. Only a press ever changes the bonus, either way. */
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
      ariaLabel="Double Down Your Bonus"
      onClose={() => ready && onChoose(false)}
      closeOnOverlay={false}
      closeOnEscape={ready}
      showCloseButton={false}
      className={`${styles.dialog} ${styles.offerDialog}`}
    >
      <div
        className={styles.opening}
        data-motion="keep"
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
          title="Double Down"
          pill="Optional"
          plates={{
            secondary: { label: 'Keep My Bonus', disabled: !ready, onClick: () => onChoose(false) },
            primary: {
              label: diamonds === null ? 'Checking Balance' : canAdd ? 'Add Diamonds' : 'Buy More',
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
            Extra Diamonds Are Used Only When You Start The Game. Keeping Your Bonus Costs Nothing
            Extra.
          </p>
          {diamonds !== null && !canAdd && (
            <p className="sc-copy sc-copy--center sc-ink--gold">
              You Need {(extra - diamonds).toLocaleString()} More Diamonds To Double Down.
            </p>
          )}
        </SpadeConsole>
      </div>
    </Modal>
  );
}
