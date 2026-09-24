import {
  plinkoAllocations,
  plinkoDrops,
  validBonusBudget,
  bonusWalletDebit,
  bonusTotal,
  gameChips,
  type BonusBudget,
} from '../../utils/bonusGameBudget';
import { diamondGameTitle, type DiamondBonusGame } from '../../utils/diamondGameTitles';
import type { BonusGuarantee } from '../../services/WheelBonusEntryService';
import { useState } from 'react';
import DoubleDownOffer from './DoubleDownOffer';
import styles from './BonusSetup.module.css';

/** The sentence a player reads before Start: what the game pays whatever happens. */
export function guaranteeCopy(
  game: DiamondBonusGame,
  guarantee: Pick<BonusGuarantee, 'guarantee' | 'minimumPayoutChips'>
): string | null {
  const chips = `${gameChips(guarantee.minimumPayoutChips)} Chips`;
  if (guarantee.guarantee === 'super') {
    const ending = {
      plinko: 'Even If Every Drop Lands Low',
      crash: 'Even If It Crashes Before You Cash Out',
      crossing: 'Even If You Do Not Make It Across',
      mines: 'Even If You Hit A Mine',
    }[game];
    return `${diamondGameTitle(game, 2)} Pays At Least ${chips}, ${ending}.`;
  }
  return guarantee.minimumPayoutChips > 0 ? `Pays At Least ${chips} On Any Loss.` : null;
}
/**
 * THE ENTRY FLOW OF A WON BONUS GAME (Dan 2026-09-21, R9). After Play Game on
 * the wheel: screen one is the Double Your Diamonds decision, screen two is
 * the game's setup (for Plinko, the drop selector), and only the player's own
 * tap on Start begins play. The step is derived from what is known, never from
 * a timer: an award whose offer has not been answered is on 'offer'; an
 * answered one is on 'setup'. A round already started is resumed by the page.
 */
export type BonusEntryStep = 'offer' | 'setup';
export function bonusEntryStep(budget: BonusBudget, offerAnswered: boolean): BonusEntryStep {
  return budget.award && !offerAnswered ? 'offer' : 'setup';
}

/** These controls quote one atomic entry; changing a selection never debits a wallet. */
export default function BonusSetup({
  budget,
  onChange,
  diamonds,
  disabled,
  game,
  guarantee = null,
  clubId,
  entryReady = true,
  awardLoading = false,
  awardError,
  leave,
  offerAnswered = true,
  onOfferAnswered,
}: {
  budget: BonusBudget;
  onChange: (value: BonusBudget) => void;
  diamonds: number | null;
  disabled: boolean;
  game: DiamondBonusGame;
  /** The server's own quote for a pending award, shown before Start. */
  guarantee?: BonusGuarantee | null;
  clubId: string;
  entryReady?: boolean;
  awardLoading?: boolean;
  awardError?: string | null;
  /** How the page lets the player leave for another page: it lets go of its
   * bonus hold, then navigates. The hold keeps a won game on screen until the
   * player plays it, and a plain navigate from here ran straight into it, so
   * Buy More, Earn Diamonds and Spin The Wheel went nowhere (review
   * 2026-09-22). Called only while the setup is enabled: every page disables it
   * while money is in flight and takes it off screen while a round is open. */
  leave: (to: string) => void;
  /** Whether the Double Your Diamonds offer for `budget.award` has been answered. */
  offerAnswered?: boolean;
  /** Records the answer for `budget.award`, so a refresh does not ask again. */
  onOfferAnswered?: (awardId: string) => void;
}) {
  const [revisiting, setRevisiting] = useState<string | null>(null);
  const valid = validBonusBudget(budget),
    total = bonusTotal(budget);
  const plinko = game === 'plinko';
  const change = (next: BonusBudget) => onChange(next);
  const exit = (to: string) => {
    if (!disabled) leave(to);
  };
  const debit = bonusWalletDebit(budget);
  const promise = guarantee ? guaranteeCopy(game, guarantee) : null;
  const step = bonusEntryStep(budget, offerAnswered);
  const offerOpen =
    Boolean(budget.award) &&
    valid &&
    !disabled &&
    (step === 'offer' || revisiting === budget.award?.id);
  const choices = plinko && valid ? plinkoAllocations(total) : [];
  const drops = plinko ? plinkoDrops(budget) : null;
  if (!entryReady)
    return (
      <section className={styles.setup} aria-label="Your Bonus Setup">
        {/* A failed award read retries itself (useEarnedBonus), so there is
            nothing here for the player to press. */}
        <p className={styles.total} role="status">
          {awardError ??
            (awardLoading
              ? 'Checking Your Wheel Award'
              : 'Win This Game On Diamond Spins To Play.')}
        </p>
        <div className={styles.links}>
          <button type="button" disabled={disabled} onClick={() => exit(`/clubs/${clubId}/wheel`)}>
            Spin The Wheel
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => exit('/marketplace?tab=diamonds')}
          >
            Buy More
          </button>
        </div>
      </section>
    );
  return (
    <section className={styles.setup} aria-label="Your Bonus Setup" data-bonus-step={step}>
      {budget.award ? (
        <div className={styles.entry} data-guarantee={guarantee?.guarantee}>
          <span>{diamondGameTitle(game, budget.award.boostMultiplier)} Award</span>
          <strong>{budget.base.toLocaleString()} Diamonds Funded</strong>
          <small>Your Original Spin: {budget.award.entryDiamonds.toLocaleString()} Diamonds</small>
          {promise && (
            <small className={styles.promise} role="status">
              {promise}
            </small>
          )}
        </div>
      ) : (
        <label className={styles.entry}>
          Entry Diamonds
          <input
            type="number"
            inputMode="numeric"
            min={25}
            max={2500}
            step={1}
            value={Number.isNaN(budget.base) ? '' : budget.base}
            disabled={disabled}
            onChange={(event) => change({ ...budget, base: event.target.valueAsNumber })}
          />
        </label>
      )}
      {budget.award ? (
        <button
          type="button"
          className={styles.offer}
          disabled={disabled || !valid || step === 'offer'}
          onClick={() => setRevisiting(budget.award?.id ?? null)}
        >
          {step === 'offer'
            ? 'Choose Whether To Double Your Diamonds'
            : budget.doubled
              ? 'Diamonds Added: Change'
              : 'Playing Without Extra Diamonds: Change'}
        </button>
      ) : (
        <label className={styles.double}>
          <input
            type="checkbox"
            checked={budget.doubled}
            disabled={disabled || !valid}
            onChange={(event) => change({ ...budget, doubled: event.target.checked })}
          />
          <span>
            Double Down
            {valid ? ` · +${budget.base.toLocaleString()} Diamonds` : ''}
          </span>
        </label>
      )}
      {plinko && valid && step === 'setup' && (
        <fieldset className={styles.drops} disabled={disabled} data-plinko-selector>
          <legend>Diamonds Per Drop</legend>
          <div className={styles.choices}>
            {choices.map((choice) => (
              <button
                type="button"
                key={choice.diamondsPerDrop}
                disabled={disabled}
                aria-pressed={budget.denomination === choice.diamondsPerDrop}
                onClick={() => change({ ...budget, denomination: choice.diamondsPerDrop })}
                aria-label={`${choice.diamondsPerDrop.toLocaleString()} ${choice.diamondsPerDrop === 1 ? 'Diamond' : 'Diamonds'} Per Drop, ${choice.drops.toLocaleString()} ${choice.drops === 1 ? 'Drop' : 'Drops'}`}
              >
                <strong>{choice.diamondsPerDrop.toLocaleString()}</strong>
                <small>
                  {choice.drops.toLocaleString()} {choice.drops === 1 ? 'Drop' : 'Drops'}
                </small>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <p className={styles.total} aria-live="polite">
        {valid
          ? plinko
            ? drops !== null && budget.denomination !== null
              ? `${drops.toLocaleString()} ${drops === 1 ? 'Drop' : 'Drops'} × ${budget.denomination.toLocaleString()} ${budget.denomination === 1 ? 'Diamond' : 'Diamonds'} = ${total.toLocaleString()} Diamonds`
              : step === 'offer'
                ? `${total.toLocaleString()} Diamonds To Drop. Answer The Offer First.`
                : `Choose Your Diamonds Per Drop To Play ${total.toLocaleString()} Diamonds.`
            : `${total.toLocaleString()} Diamonds In This Round`
          : 'Enter 25-2,500 Whole Diamonds.'}
      </p>
      {diamonds !== null && valid && diamonds < debit && (
        <p className={styles.short}>
          You Need {(debit - diamonds).toLocaleString()} More Diamonds.
        </p>
      )}
      <div className={styles.links}>
        <button type="button" disabled={disabled} onClick={() => exit('/marketplace?tab=diamonds')}>
          Buy More
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => exit(`/clubs/${clubId}/earn-diamonds`)}
        >
          Earn Diamonds
        </button>
      </div>
      {offerOpen && budget.award && (
        <DoubleDownOffer
          key={budget.award.id}
          budget={budget}
          diamonds={diamonds}
          onChoose={(doubled) => {
            const awardId = budget.award!.id;
            setRevisiting(null);
            onOfferAnswered?.(awardId);
            change({ ...budget, doubled });
          }}
          onBuyMore={() => exit('/marketplace?tab=diamonds')}
        />
      )}
    </section>
  );
}
