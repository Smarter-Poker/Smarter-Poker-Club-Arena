import { useCallback, useEffect, useRef, useState } from 'react';
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
  autoContinueAfterMs = 0,
  eyebrow,
}: {
  prize: Pick<WheelSegment, 'kind' | 'game' | 'multiplier'>;
  title: string;
  detail: string;
  onOpen: () => void;
  autoContinue?: boolean;
  autoContinueAfterMs?: number;
  /**
   * What this receipt is, when it is not a win. The wheel's own prizes are
   * always won, so they keep the default; a bonus game's receipt can be a
   * guarantee paid after a hit or a crash, and "You Won" over that is a lie.
   */
  eyebrow?: string;
}) {
  const opened = useRef(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const remaining = useRef(autoContinueAfterMs);
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
  const finish = useCallback(() => {
    if (opened.current) return;
    opened.current = true;
    onOpenRef.current();
  }, []);
  const timedPrize = automatic && autoContinueAfterMs > 0;
  useEffect(() => {
    if (!timedPrize || !visible || opened.current) return;
    const started = Date.now();
    const timer = window.setTimeout(finish, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [timedPrize, visible, finish]);
  return (
    <Modal
      isOpen
      ariaLabel={title}
      onClose={() => (ready || timedPrize) && finish()}
      closeOnOverlay={timedPrize}
      closeOnEscape={ready || timedPrize}
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
          if (automatic && !timedPrize) finish();
        }}
      >
        <SpadeConsole
          eyebrow={eyebrow ?? (prize.kind === 'upgrade' ? 'Wheel Upgrade' : 'You Won')}
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
            disabled={!ready && !timedPrize}
            onClick={finish}
          >
            {prize.kind === 'bonus' || prize.kind === 'upgrade' ? 'Opening Your Bonus' : 'Continue'}
          </button>
        </SpadeConsole>
      </div>
    </Modal>
  );
}
