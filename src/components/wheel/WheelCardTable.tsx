import { useEffect, useRef } from 'react';
import type { WheelCardAward, WheelCardPick } from '../../services/DiamondWheelService';
import type { WheelCardVerdict } from '../../utils/wheelFairness';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { WheelPrizeArt } from './WheelPrizeArt';
import revealStyles from './WheelWinReveal.module.css';
import styles from './WheelCardTable.module.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE THREE CARDS (owner ruling 2026-09-21, R15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Landing Diamonds pays nothing at the spin. The server seals three values
 * worth HALF, DOUBLE and TRIPLE the diamonds risked, shuffles them into one of
 * six orders behind cards one, two and three, and writes a pending award. This
 * surface is the only place that award is ever turned over: the player picks a
 * card, `fn_wheel_diamond_cards_pick` reveals all three and pays the one they
 * took, and the seed that ordered them is published so they can check it.
 *
 * NOTHING HERE DECIDES ANYTHING. The three faces are drawn from the award's
 * own risk before the pick (double and triple are exactly twice and three
 * times it) and from the server's revealed values after it. The half is the
 * server's own sealed rounding, so it is not named until the reveal.
 *
 * NOTHING HERE MOVES ON A CLOCK (R1). The cards wait for a press, the reveal
 * waits for Continue, and a pick already in flight shows that it is in flight
 * rather than quietly turning a second card over.
 *
 * The chassis, the plates and the diamond art are the wheel's own; the card
 * bodies are machined from the --realism-* tokens in club-engine.css, which
 * is the one palette a page may reach for.
 */

const CARD_NAMES = ['One', 'Two', 'Three'] as const;
const DIAMOND_PRIZE = { kind: 'diamonds' } as const;

/** Card one, two or three. The server accepts nothing else. */
export type WheelCardSlot = 1 | 2 | 3;

/** A figure a player reads: whole diamonds, grouped. */
const diamonds = (value: number) => value.toLocaleString();

/**
 * The one live line on this surface. It carries the stakes before the pick,
 * the send while it is out, and the outcome once, so a screen reader hears a
 * single announcement per state instead of three cards changing underneath it.
 */
export function cardStatusLine(
  award: WheelCardAward,
  pick: WheelCardPick | null,
  sending: WheelCardSlot | null,
  held: boolean
): string {
  if (pick)
    return `You Picked Card ${CARD_NAMES[pick.picked - 1]} And Won ${diamonds(pick.paid_diamonds)} Diamonds.`;
  if (held) return 'Your Card Is Saved For The Next Time The Wheel Opens.';
  if (sending) return `Turning Card ${CARD_NAMES[sending - 1]} Over.`;
  return `Three Cards, Face Down. One Pays Half, One Pays ${diamonds(2 * award.risk_diamonds)} And One Pays ${diamonds(3 * award.risk_diamonds)} Diamonds.`;
}

function faceValue(pick: WheelCardPick | null, slot: WheelCardSlot): number | null {
  const value = pick?.cards[slot - 1];
  return typeof value === 'number' ? value : null;
}

/** What a screen reader is handed for one card, before and after the reveal. */
export function cardControlName(
  pick: WheelCardPick | null,
  slot: WheelCardSlot,
  sending: WheelCardSlot | null
): string {
  const name = `Card ${CARD_NAMES[slot - 1]}`;
  const value = faceValue(pick, slot);
  if (value === null) return sending === slot ? `${name}, Turning Over` : `Pick ${name}`;
  return pick!.picked === slot
    ? `${name}, ${diamonds(value)} Diamonds, Your Card`
    : `${name}, ${diamonds(value)} Diamonds`;
}

/** The mismatch line, naming each half of the check rather than a bare failure. */
export function cardVerdictLine(verdict: WheelCardVerdict): string {
  if (verdict.fair) return 'Verified: The Three Values And Your Card Were Sealed Before You Chose';
  return `Mismatch: Seed ${verdict.hashMatches ? 'Ok' : 'Differs'}, Roll ${
    verdict.rollMatches ? 'Ok' : 'Differs'
  }, Order ${verdict.permutationMatches && verdict.cardsMatch ? 'Ok' : 'Differs'}, Prize ${
    verdict.paidMatches ? 'Ok' : 'Differs'
  }`;
}

export function WheelCardTable({
  award,
  pick,
  sending,
  held,
  verdict,
  verifying,
  onPick,
  onVerify,
  onClose,
}: {
  award: WheelCardAward;
  /** The reveal, once the server has answered this award. */
  pick: WheelCardPick | null;
  /** The card whose pick is on the wire, saved and replayable. */
  sending: WheelCardSlot | null;
  /** The pick has been sent as far as this page will send it; it waits for the next visit. */
  held: boolean;
  verdict: WheelCardVerdict | null;
  verifying: boolean;
  onPick: (card: WheelCardSlot) => void;
  onVerify: () => void;
  onClose: () => void;
}) {
  const firstCard = useRef<HTMLButtonElement>(null);
  const continuePlate = useRef<HTMLButtonElement>(null);
  const revealed = pick !== null;
  const waiting = sending !== null && !revealed;
  /* A table with a plate in its foot: the reveal's Continue, or the Close a
     held pick leaves behind. Both are the same plate, so focus has one place
     to go and a phone is never left with Escape as its only way out. */
  const plated = revealed || held;
  /* Focus lands on the first card when the table opens and on that plate when
     one appears. Neither control leaves the document while it holds focus:
     the three cards stay mounted, disabled, under their values. */
  useEffect(() => {
    if (!plated) firstCard.current?.focus?.({ preventScroll: true });
  }, [plated]);
  useEffect(() => {
    if (plated) continuePlate.current?.focus?.({ preventScroll: true });
  }, [plated]);
  return (
    <Modal
      isOpen
      ariaLabel={revealed ? 'Your Diamond Card' : 'Pick A Card'}
      onClose={onClose}
      closeOnOverlay={false}
      closeOnEscape={plated}
      showCloseButton={false}
      className={revealStyles.dialog}
    >
      <SpadeConsole
        onClose={plated ? onClose : undefined}
        eyebrow="Diamond Cards"
        title={revealed ? 'Your Card' : 'Pick A Card'}
        crest="diamond"
        pill={revealed ? 'Paid' : 'Sealed'}
        pillInk={revealed ? 'green' : 'gold'}
        foot={plated ? 'plates' : 'foot'}
        plates={
          revealed
            ? {
                secondary: {
                  label: verifying ? 'Checking' : 'Check These Cards',
                  onClick: onVerify,
                  disabled: verifying,
                },
                primary: {
                  label: 'Continue',
                  ink: 'gold',
                  onClick: onClose,
                  buttonRef: continuePlate,
                },
              }
            : held
              ? {
                  primary: {
                    label: 'Close',
                    ink: 'white',
                    onClick: onClose,
                    buttonRef: continuePlate,
                  },
                }
              : undefined
        }
      >
        <p className={`sc-copy sc-copy--center ${styles.stakes}`}>
          {revealed
            ? `${diamonds(pick.paid_diamonds)} Diamonds Paid Into Your Account.`
            : `Your ${diamonds(award.risk_diamonds)} Diamond Entry Is On The Table. One Card Pays Half, One Pays Double, One Pays Triple.`}
        </p>
        <div className={styles.table}>
          {([1, 2, 3] as const).map((slot) => {
            const value = faceValue(pick, slot);
            const taken = revealed && pick.picked === slot;
            return (
              <button
                key={slot}
                ref={slot === 1 ? firstCard : undefined}
                type="button"
                className={styles.card}
                data-face={value === null ? 'down' : 'up'}
                data-taken={taken || undefined}
                data-turning={waiting && sending === slot ? '' : undefined}
                disabled={revealed || waiting || held}
                aria-label={cardControlName(pick, slot, sending)}
                onClick={() => onPick(slot)}
              >
                <span className={styles.rank}>{CARD_NAMES[slot - 1]}</span>
                <WheelPrizeArt segment={DIAMOND_PRIZE} className={styles.art} />
                <span className={styles.value}>
                  {value === null ? 'Sealed' : `${diamonds(value)} Diamonds`}
                </span>
              </button>
            );
          })}
        </div>
        <p className={`sc-copy sc-copy--center ${styles.status}`} role="status">
          {cardStatusLine(award, pick, sending, held)}
        </p>
        {revealed && verdict ? (
          <p
            className={`sc-copy sc-copy--center ${verdict.fair ? 'sc-ink--green' : 'sc-ink--red'}`}
          >
            {cardVerdictLine(verdict)}
          </p>
        ) : null}
        {revealed ? (
          <div className={styles.seal}>
            <span className="sc-label sc-ink--blue">Server Seed</span>
            <code className={styles.mono}>{pick.fairness.server_seed}</code>
            <span className="sc-label sc-ink--blue">Its Hash</span>
            <code className={styles.mono}>{pick.fairness.server_seed_hash}</code>
          </div>
        ) : null}
      </SpadeConsole>
    </Modal>
  );
}
