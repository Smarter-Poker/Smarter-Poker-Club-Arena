import {
  plinkoAllocations,
  validSpinAmount,
  bonusTotal,
  type BonusBudget,
} from '../../utils/bonusGameBudget';
import { useNavigate } from 'react-router-dom';
import styles from './BonusSetup.module.css';

/** These controls quote one atomic entry; changing a selection never debits a wallet. */
export default function BonusSetup({
  budget,
  onChange,
  diamonds,
  disabled,
  plinko = false,
  clubId,
}: {
  budget: BonusBudget;
  onChange: (value: BonusBudget) => void;
  diamonds: number | null;
  disabled: boolean;
  plinko?: boolean;
  clubId: string;
}) {
  const navigate = useNavigate();
  const valid = validSpinAmount(budget.base),
    total = bonusTotal(budget);
  const choices = valid ? plinkoAllocations(total) : [];
  const change = (next: BonusBudget) => {
    if (validSpinAmount(next.base) && bonusTotal(next) % next.denomination !== 0)
      next.denomination = 1;
    onChange(next);
  };
  return (
    <section className={styles.setup} aria-label="Your Bonus Setup">
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
      <label className={styles.double}>
        <input
          type="checkbox"
          checked={budget.doubled}
          disabled={disabled || !valid}
          onChange={(event) => change({ ...budget, doubled: event.target.checked })}
        />
        <span>Double Down{valid ? ` · +${budget.base.toLocaleString()} Diamonds` : ''}</span>
      </label>
      {plinko && valid && (
        <fieldset className={styles.drops} disabled={disabled}>
          <legend>Diamonds Per Drop</legend>
          <div className={styles.choices}>
            {choices.map((choice) => (
              <button
                type="button"
                key={choice.diamondsPerDrop}
                disabled={disabled}
                aria-pressed={budget.denomination === choice.diamondsPerDrop}
                onClick={() => change({ ...budget, denomination: choice.diamondsPerDrop })}
                aria-label={`${choice.diamondsPerDrop} ${choice.diamondsPerDrop === 1 ? 'Diamond' : 'Diamonds'} Per Drop, ${choice.drops} ${choice.drops === 1 ? 'Drop' : 'Drops'}`}
              >
                <strong>
                  {choice.diamondsPerDrop} <span>◆</span>
                </strong>
                <small>
                  {choice.drops} {choice.drops === 1 ? 'Drop' : 'Drops'}
                </small>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <p className={styles.total} aria-live="polite">
        {valid
          ? plinko
            ? `${total / budget.denomination} ${total / budget.denomination === 1 ? 'Drop' : 'Drops'} × ${budget.denomination} ${budget.denomination === 1 ? 'Diamond' : 'Diamonds'} = ${total.toLocaleString()} Diamonds`
            : `${total.toLocaleString()} Diamonds In This Round`
          : 'Enter 25–2,500 Whole Diamonds.'}
      </p>
      {diamonds !== null && valid && diamonds < total && (
        <p className={styles.short}>
          You Need {(total - diamonds).toLocaleString()} More Diamonds.
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
    </section>
  );
}
