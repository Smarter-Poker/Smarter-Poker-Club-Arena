import { useCallback, useRef, useState } from 'react';
import type { WheelCardAward, WheelCardPick } from '../../services/DiamondWheelService';
import { Modal } from '../common/Modal';
import { SpadeConsole } from '../console/SpadeConsole';
import { WheelPrizeArt } from './WheelPrizeArt';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { soundService } from '../../services/SoundService';
import { triggerHaptic } from '../../services/HapticService';
import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import revealStyles from './WheelWinReveal.module.css';
import styles from './DiamondCardPick.module.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMONDS THREE-CARD GAME (owner ruling 2026-09-21, R15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "If 'Diamonds' is won it plays a game where 3 cards pop up:
 * one is 50% of diamonds risked, one is 2x, one is 3x. After the user selects
 * a card it awards that prize and reveals all 3 prizes behind the cards."
 *
 * So the spin pays nothing when it lands on Diamonds. It seals an award, and
 * the player turns one card over here. What is drawn and what is decided are
 * kept apart, exactly as they are on the wheel itself:
 *
 *   - the SERVER decides. The three values and their order are sealed at the
 *     spin and revealed by fn_wheel_diamond_cards_pick, which pays the card it
 *     names. This component never chooses a card, never computes a prize and
 *     never shows a value the reply did not carry.
 *   - the PLAYER acts. Nothing here runs on a clock: no card is picked for
 *     them, no reveal dismisses itself, and the Continue plate waits however
 *     long it waits (R1). The only timing is the flip's own animation, which
 *     always plays, at the player's Animation Speed (CLAUDE.md 10.6).
 *   - ONE pick. A double tap, a slow network and a second thumb all reach the
 *     same guard; the server is idempotent on the award behind it, so even a
 *     racing second call returns the first pick's answer and pays nothing
 *     twice. `picked` is therefore read from the reply, never assumed to be
 *     the card just tapped: an award already picked reveals ITS card.
 *   - a REFUSAL is the server's sentence, shown as it came, and the cards go
 *     back face down so the player can pick again.
 *
 * The chassis is the approved console; the cards are the one thing no master
 * paints, drawn in the Diamond Games' own tile language (MinesGrid) so the
 * hand reads as part of the same console the wheel sits in.
 */

/** The three positions, named for the accessible label a card carries. */
export const CARD_NAMES = ['Card One', 'Card Two', 'Card Three'] as const;

/**
 * What a revealed card is worth, by its rank among the three: the smallest is
 * the half, then the double, then the triple. Rank, not arithmetic against the
 * risk, because an odd risk halves to a floor or a ceiling by the spin's own
 * sealed rounding draw and 2x would be the only exact ratio left.
 */
export function cardMultiplierLabel(values: readonly number[], card: number): string {
  const value = values[card - 1];
  if (value === undefined) return '';
  const rank = [...values].sort((a, b) => a - b).indexOf(value);
  return ['Half', '2x', '3x'][rank] ?? '';
}

/** "You Won 300 Diamonds": the one line the player is here for. */
export function cardWinLine(paid: number): string {
  return `You Won ${compactChips(paid)} ${paid === 1 ? 'Diamond' : 'Diamonds'}`;
}

export function DiamondCardPick({
  award,
  onPick,
  onClose,
}: {
  award: WheelCardAward;
  /** The RPC, passed in so the page owns the service and this owns the table. */
  onPick: (awardId: string, card: number) => Promise<WheelCardPick>;
  onClose: () => void;
}) {
  const isMountedRef = useIsMounted();
  const picking = useRef(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WheelCardPick | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const speed = getAnimationSpeed();

  const pick = useCallback(
    async (card: number) => {
      if (picking.current || result) return;
      picking.current = true;
      setChosen(card);
      setBusy(true);
      setRefusal(null);
      triggerHaptic('medium');
      /** The cards go back face down and the guard reopens: pick again. */
      const refuse = (why: string) => {
        setRefusal(why);
        setChosen(null);
        setBusy(false);
        picking.current = false;
      };
      try {
        const answer = await onPick(award.id, card);
        if (!isMountedRef.current) return;
        if (!answer.ok) {
          refuse(answer.error || 'The Card Pick Was Refused');
          return;
        }
        setResult(answer);
        setBusy(false);
        soundService.playWin();
        triggerHaptic('success');
      } catch (err) {
        reportError(err, 'DiamondCardPick.pick');
        if (isMountedRef.current) refuse('The Card Pick Could Not Be Confirmed. Try Again.');
      }
    },
    [award.id, onPick, result, isMountedRef]
  );

  const values = result?.cards ?? [];
  const risk = compactChips(award.risk_diamonds);
  return (
    <Modal
      isOpen
      ariaLabel="Diamond Card Pick"
      onClose={onClose}
      closeOnOverlay={false}
      closeOnEscape
      showCloseButton={false}
      className={revealStyles.dialog}
    >
      <SpadeConsole
        eyebrow="Diamond Cards"
        title={result ? 'Your Card' : 'Pick A Card'}
        titleId="diamond-card-pick-title"
        pill={result ? 'Paid' : 'Sealed'}
        pillInk={result ? 'green' : 'blue'}
        foot="foot"
      >
        <p className="sc-copy sc-copy--center">
          {result
            ? `Every Card Is Turned Over. ${risk} Diamonds Were Risked.`
            : `Your Spin Risked ${risk} Diamonds. One Card Pays Half, One Pays 2x, One Pays 3x.`}
        </p>
        <div className={styles.hand} role="group" aria-label="Three Diamond Cards">
          {[1, 2, 3].map((card) => {
            const value = values[card - 1];
            const revealed = value !== undefined;
            const mine = result ? result.picked === card : chosen === card;
            const multiplier = revealed ? cardMultiplierLabel(values, card) : '';
            return (
              <button
                key={card}
                type="button"
                className={styles.card}
                data-card={card}
                data-revealed={revealed || undefined}
                data-picked={mine || undefined}
                data-motion="keep"
                style={
                  revealed
                    ? {
                        animationDelay: `${(mine ? 0 : card * 220 + 320) * speed}ms`,
                        animationDuration: `${520 * speed}ms`,
                      }
                    : undefined
                }
                disabled={busy || Boolean(result)}
                aria-label={
                  revealed
                    ? `${CARD_NAMES[card - 1]}, ${multiplier}, ${compactChips(value)} Diamonds${
                        mine ? ', Your Pick' : ''
                      }`
                    : CARD_NAMES[card - 1]
                }
                onClick={() => void pick(card)}
              >
                <span className={styles.cardFace} aria-hidden="true">
                  {revealed ? (
                    <>
                      <span className={styles.cardMultiplier}>{multiplier}</span>
                      <WheelPrizeArt segment={{ kind: 'diamonds' }} className={styles.cardArt} />
                      <span className={styles.cardValue}>{compactChips(value)}</span>
                    </>
                  ) : (
                    <>
                      <WheelPrizeArt segment={{ kind: 'diamonds' }} className={styles.cardArt} />
                      <span className={styles.cardIndex}>{card}</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {refusal && (
          <p className="sc-copy sc-copy--center sc-ink--red" role="alert">
            {refusal}
          </p>
        )}
        {result ? (
          <>
            <p
              className={`${styles.win} sc-ink--gold`}
              style={{ animationDelay: `${1100 * speed}ms` }}
              data-motion="keep"
              role="status"
            >
              {cardWinLine(result.paid_diamonds)}
            </p>
            <button type="button" className={revealStyles.continue} onClick={onClose}>
              Continue
            </button>
          </>
        ) : (
          <p className="sc-copy sc-copy--center sc-ink--muted">
            {busy ? 'Turning Your Card Over' : 'Tap A Card. Nothing Is Picked For You.'}
          </p>
        )}
      </SpadeConsole>
    </Modal>
  );
}

export default DiamondCardPick;
