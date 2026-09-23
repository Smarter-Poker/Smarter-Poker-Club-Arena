import { useCallback, useEffect, useRef, useState } from 'react';
import type { WheelSegment } from '../../services/DiamondWheelService';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
import { triggerHaptic } from '../../services/HapticService';
import { WheelPrizeArt } from './WheelPrizeArt';
import styles from './WheelWinReveal.module.css';

/** What the one plate says, by what was won. A game is played when the player says so. */
export function revealButtonLabel(kind: WheelSegment['kind']): string {
  if (kind === 'bonus') return 'Play Game';
  if (kind === 'upgrade') return 'Open Upgrade Wheel';
  return 'Continue';
}

/**
 * Display only: the receipt already owns the award. Opening never books a bet.
 *
 * A WON GAME WAITS FOR PLAY GAME (owner ruling 2026-09-21, R1 and R9). This
 * reveal used to dismiss itself at the end of its pop-open animation whenever
 * the prize was a bonus game or an upgrade, and the page then navigated into
 * the game: play advanced with no tap. Now the only way off a bonus or upgrade
 * reveal is its plate; Escape and the backdrop do not open a game either. The
 * one timed continue left is the completion card a finished game shows on its
 * way back to the wheel (`autoContinue` with `autoContinueAfterMs`), which
 * starts nothing.
 */
export function WheelWinReveal({
  prize,
  title,
  detail,
  onOpen,
  autoContinue = false,
  autoContinueAfterMs = 0,
  eyebrow,
  silent = false,
  openLabel,
  holdOpen = false,
}: {
  prize: Pick<WheelSegment, 'kind' | 'game' | 'multiplier'>;
  title: string;
  detail: string;
  onOpen: () => void;
  /** A timed continue, honoured only with a positive `autoContinueAfterMs`. */
  autoContinue?: boolean;
  autoContinueAfterMs?: number;
  /**
   * What this receipt is, when it is not a win. The wheel's own prizes are
   * always won, so they keep the default; a bonus game's receipt can be a
   * guarantee paid after a hit or a crash, and "You Won" over that is a lie.
   */
  eyebrow?: string;
  /**
   * The round this receipt belongs to was not a win, or its own scene already
   * sang it. A major arpeggio and a success buzz over a hit or a crash teach
   * players that the sounds mean nothing.
   */
  silent?: boolean;
  /**
   * What the one plate says, when the prize's own kind does not say it. The
   * Diamonds card game is the case: its plate opens three sealed cards rather
   * than continuing, and `revealButtonLabel` cannot know that from the kind
   * alone, because the same kind PAID under contract 3.
   */
  openLabel?: string;
  /**
   * Money is still ahead of this reveal, so the plate is the only way off it.
   * Escape and the backdrop close nothing, exactly as they close nothing over
   * a bonus game or an upgrade.
   */
  holdOpen?: boolean;
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
    if (silent || !visible || sounded.current) return;
    sounded.current = true;
    if (prize.kind === 'upgrade' || prize.kind === 'bonus') soundService.playBigWin();
    else soundService.playWin();
    triggerHaptic('success');
  }, [prize.kind, visible, silent]);
  const continueButton = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const gameAhead = prize.kind === 'bonus' || prize.kind === 'upgrade' || holdOpen;
  const timedPrize = autoContinue && autoContinueAfterMs > 0 && !gameAhead;
  useEffect(() => {
    if (ready && !timedPrize) continueButton.current?.focus();
  }, [ready, timedPrize]);
  const finish = useCallback(() => {
    if (opened.current) return;
    opened.current = true;
    onOpenRef.current();
  }, []);
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
      onClose={() => !gameAhead && (ready || timedPrize) && finish()}
      closeOnOverlay={timedPrize}
      closeOnEscape={!gameAhead && (ready || timedPrize)}
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
            {openLabel ?? revealButtonLabel(prize.kind)}
          </button>
        </SpadeConsole>
      </div>
    </Modal>
  );
}
