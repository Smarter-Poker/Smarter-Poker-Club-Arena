import {
  PLINKO_DROPS,
  validBonusBudget,
  bonusWalletDebit,
  bonusTotal,
  gameChips,
  type BonusBudget,
} from '../../utils/bonusGameBudget';
import { diamondGameTitle, type DiamondBonusGame } from '../../utils/diamondGameTitles';
import type { BonusGuarantee } from '../../services/WheelBonusEntryService';
import { useNavigate } from 'react-router-dom';
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
  onRefresh,
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
  onRefresh?: () => void;
}) {
  const navigate = useNavigate();
  const [answeredAward, setAnsweredAward] = useState<string | null>(null);
  const valid = validBonusBudget(budget),
    total = bonusTotal(budget);
  const plinko = game === 'plinko';
  const change = (next: BonusBudget) => onChange(next);
  const debit = bonusWalletDebit(budget);
  const promise = guarantee ? guaranteeCopy(game, guarantee) : null;
  if (!entryReady)
    return (
      <section className={styles.setup} aria-label="Your Bonus Setup">
        <p className={styles.total} role={awardError ? 'alert' : 'status'}>
          {awardError ??
            (awardLoading
              ? 'Checking Your Wheel Award'
              : 'Win This Game On Diamond Spins To Play.')}
        </p>
        <div className={styles.links}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => navigate(`/clubs/${clubId}/wheel`)}
          >
            Spin The Wheel
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => navigate('/marketplace?tab=diamonds')}
          >
            Buy More
          </button>
          {awardError && onRefresh && (
            <button type="button" disabled={disabled} onClick={onRefresh}>
              Refresh
            </button>
          )}
        </div>
      </section>
    );
  return (
    <section className={styles.setup} aria-label="Your Bonus Setup">
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
          disabled={disabled || !valid}
          onClick={() => setAnsweredAward(null)}
        >
          {budget.doubled ? 'Double Down Selected' : 'Double Down Your Bonus'}
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
      <p className={styles.total} aria-live="polite">
        {valid
          ? plinko
            ? `${PLINKO_DROPS} Drops × ${budget.denomination.toLocaleString()} ${budget.denomination === 1 ? 'Diamond' : 'Diamonds'} = ${total.toLocaleString()} Diamonds`
            : `${total.toLocaleString()} Diamonds In This Round`
          : 'Enter 25-2,500 Whole Diamonds.'}
      </p>
      {diamonds !== null && valid && diamonds < debit && (
        <p className={styles.short}>
          You Need {(debit - diamonds).toLocaleString()} More Diamonds.
        </p>
      )}
      <div className={styles.links}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => navigate('/marketplace?tab=diamonds')}
        >
          Buy More
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => navigate(`/clubs/${clubId}/earn-diamonds`)}
        >
          Earn Diamonds
        </button>
      </div>
      {budget.award && valid && !disabled && answeredAward !== budget.award.id && (
        <DoubleDownOffer
          key={budget.award.id}
          budget={budget}
          diamonds={diamonds}
          onChoose={(doubled) => {
            setAnsweredAward(budget.award!.id);
            change({ ...budget, doubled });
          }}
          onBuyMore={() => navigate('/marketplace?tab=diamonds')}
        />
      )}
    </section>
  );
}
