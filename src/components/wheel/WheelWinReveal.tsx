import { useEffect, useRef, useState } from 'react';
import type { WheelSegment } from '../../services/DiamondWheelService';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
import { triggerHaptic } from '../../services/HapticService';
import { WheelPrizeArt } from './WheelPrizeArt';
import styles from './WheelWinReveal.module.css';

/** Display only: the receipt already owns the award. Opening never books a bet. */
export function WheelWinReveal({
  prize,
  title,
  detail,
  onOpen,
  autoContinue = false,
}: {
  prize: Pick<WheelSegment, 'kind' | 'game' | 'multiplier'>;
  title: string;
  detail: string;
  onOpen: () => void;
  autoContinue?: boolean;
}) {
  const opened = useRef(false);
  const sounded = useRef(false);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!visible || sounded.current) return;
    sounded.current = true;
    if (prize.kind === 'upgrade' || prize.kind === 'bonus') soundService.playBigWin();
    else soundService.playWin();
    triggerHaptic('success');
  }, [prize.kind, visible]);
  const continueButton = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const automatic = autoContinue || prize.kind === 'bonus' || prize.kind === 'upgrade';
  useEffect(() => {
    if (ready && !automatic) continueButton.current?.focus();
  }, [ready, automatic]);
  const finish = () => {
    if (opened.current) return;
    opened.current = true;
    onOpen();
  };
  return (
    <Modal
      isOpen
      ariaLabel={title}
      onClose={() => ready && finish()}
      closeOnOverlay={false}
      closeOnEscape={ready}
      showCloseButton={false}
      className={styles.dialog}
    >
      <div
        className={styles.opening}
        data-motion="keep"
        style={{
          animationDuration: `${1400 * getAnimationSpeed()}ms`,
          animationPlayState: visible ? 'running' : 'paused',
        }}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          setReady(true);
          if (automatic) finish();
        }}
      >
        <SpadeConsole
          eyebrow={prize.kind === 'upgrade' ? 'Wheel Upgrade' : 'You Won'}
          title={title}
          pill={
            prize.kind === 'bonus' ? 'Bonus Game' : prize.kind === 'upgrade' ? 'Super Spin' : 'Paid'
          }
          foot="foot"
        >
          <div className={styles.prize} aria-hidden="true">
            <div className={styles.rays} />
            <WheelPrizeArt segment={prize} className={styles.art} />
          </div>
          <p className="sc-copy sc-copy--center" role="status">
            {detail}
          </p>
          <button
            ref={continueButton}
            className={styles.continue}
            disabled={!ready}
            onClick={finish}
          >
            {prize.kind === 'bonus' || prize.kind === 'upgrade' ? 'Opening Your Bonus' : 'Continue'}
          </button>
        </SpadeConsole>
      </div>
    </Modal>
  );
}
