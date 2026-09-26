import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { WheelPrizeArt } from '../wheel/WheelPrizeArt';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
import { triggerHaptic } from '../../services/HapticService';
import DiamondWheelService, { type WheelBonusAward } from '../../services/DiamondWheelService';
import { reportError } from '../../utils/errorReporter';
import styles from '../wheel/WheelWinReveal.module.css';
import { BonusReceiptArt, type BonusReceiptGame } from './BonusReceiptArt';

/** Where an accumulated award is played, by the game it names. */
export function bonusGameRoute(clubId: string, award: WheelBonusAward): string {
  return `/clubs/${clubId}/${award.game}?wheelAward=${encodeURIComponent(award.id)}`;
}

/**
 * A confirmed receipt is displayed here only after its game has finished
 * revealing, and it STAYS until the player taps (Dan 2026-09-21, R1: games can
 * never auto start; nothing ever auto-plays because the player is in the
 * lobby). The five-second return to the wheel that used to sit here armed the
 * wheel's own countdown, so a finished game rolled into a paid spin with no
 * tap at all. Now: Back To The Wheel, and when more won bonus games are
 * waiting, Play Next Bonus Game. Both are the player's own tap.
 */
export default function BonusCompletion({
  clubId,
  clubUuid = null,
  awardId,
  chips,
  detail,
  eyebrow,
  silent,
  proof,
  game,
  figure,
  cap,
}: {
  /** The route's club id, used for navigation. */
  clubId: string;
  /** The club's UUID, used to read the wheel's waiting awards. Absent: no read. */
  clubUuid?: string | null;
  /** The award this receipt settled, so it is never offered as the next game. */
  awardId?: string | null;
  chips: number;
  detail: string;
  /** What this receipt is, when the round was not won. */
  eyebrow?: string;
  /** The round was not a win, or its own scene already sang it. */
  silent?: boolean;
  /**
   * What this browser made of the sealed round, in the sentence the player is
   * already reading. Proving a round should not need a collapsed panel and a
   * press inside the five seconds this receipt lasts.
   */
  proof?: string;
  /**
   * The game that produced this receipt. With it, the picture is that game's
   * own (BonusReceiptArt) instead of the chip stack; without it, the chip
   * stack stays. Everything the receipt says and does is the same either way.
   */
  game?: BonusReceiptGame;
  /**
   * The one number the game is about, printed over its art: the booked (or
   * crashed) multiplier for Crash, the street reached for Donkey Cross, the
   * best bucket's multiplier for Plinko and the gems found for Mines.
   */
  figure?: number | null;
  /** Crash: the round's own cap as a multiplier, so the crown goes to a round booked at it. */
  cap?: number | null;
}) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [next, setNext] = useState<WheelBonusAward | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const sounded = useRef(false);
  const left = useRef(false);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  // A receipt sings only over a win the player has not already heard. A lost
  // round, or one whose own scene took the chord, stays quiet (PR #5100).
  useEffect(() => {
    if (!visible || silent || sounded.current) return;
    sounded.current = true;
    soundService.playWin();
    triggerHaptic('success');
  }, [visible, silent]);
  // One read of the wheel's waiting awards (C1 lists them as pending_awards).
  // A wheel state without the field, or a read that fails, simply offers no
  // next game: the wheel itself still shows every award when the player returns.
  useEffect(() => {
    if (!clubUuid) return;
    let cancelled = false;
    (async () => {
      try {
        const state = await DiamondWheelService.getStateV2(clubUuid);
        const waiting = (state.pending_awards ?? []).find((award) => award.id !== awardId);
        if (!cancelled && waiting) setNext(waiting);
      } catch (error) {
        reportError(error, 'BonusCompletion.pendingAwards');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubUuid, awardId]);
  const go = (to: string) => {
    if (left.current) return;
    left.current = true;
    navigate(to, { replace: true });
  };
  const back = {
    label: 'Back To The Wheel',
    disabled: !ready,
    onClick: () => go(`/clubs/${clubId}/wheel`),
  };
  const title = `${chips.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Chips`;
  return (
    <Modal
      isOpen
      ariaLabel={title}
      onClose={() => undefined}
      closeOnOverlay={false}
      closeOnEscape={false}
      showCloseButton={false}
      className={styles.dialog}
    >
      <div
        className={styles.opening}
        data-motion="keep"
        data-bonus-step="completed"
        style={{
          animationDuration: `${1400 * getAnimationSpeed()}ms`,
          animationPlayState: visible ? 'running' : 'paused',
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setReady(true);
        }}
      >
        <SpadeConsole
          eyebrow={eyebrow ?? 'You Won'}
          title={title}
          pill="Paid"
          plates={
            next
              ? {
                  secondary: back,
                  primary: {
                    label: 'Play Next Bonus Game',
                    disabled: !ready,
                    onClick: () => go(bonusGameRoute(clubId, next)),
                  },
                }
              : { primary: back }
          }
        >
          <div className={styles.prize} aria-hidden="true">
            <div className={styles.rays} />
            {game ? (
              // A receipt with an eyebrow is a round that was not won: the
              // same art, standing back.
              <BonusReceiptArt game={game} figure={figure} cap={cap} dim={eyebrow !== undefined} />
            ) : (
              <WheelPrizeArt segment={{ kind: 'chips' }} className={styles.art} />
            )}
          </div>
          <p className="sc-copy sc-copy--center" role="status">
            {`${chips > 0 ? 'Your Prize Is Booked.' : 'No Chips Won This Round.'} ${detail}`}
            {proof ? ` ${proof}` : ''}
            {next ? ' Another Bonus Game Is Waiting For You.' : ''}
          </p>
        </SpadeConsole>
      </div>
    </Modal>
  );
}
