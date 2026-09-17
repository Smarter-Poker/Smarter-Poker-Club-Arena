import { SpadeConsole } from '../console/SpadeConsole';
import {
  plinkoAllocations,
  validSpinAmount,
  bonusTotal,
  type BonusBudget,
} from '../../utils/bonusGameBudget';
import { useNavigate } from 'react-router-dom';
import styles from '../../pages/diamondGames.module.css';

/** No debit occurs here. The entire chosen entry is accepted by one server request. */
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
  const valid = validSpinAmount(budget.base);
  const total = bonusTotal(budget);
  const choices = valid ? plinkoAllocations(total) : [];
  const change = (next: BonusBudget) => {
    if (validSpinAmount(next.base) && bonusTotal(next) % next.denomination !== 0)
      next.denomination = 1;
    onChange(next);
  };
  return (
    <SpadeConsole
      crest="diamond"
      title="Your Bonus"
      eyebrow="Before You Play"
      pill={budget.doubled ? 'Doubled' : 'Entry'}
      foot="foot"
    >
      <label className={styles.seedField}>
        Entry Diamonds
        <input
          className={styles.seedInput}
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
      <p className="sc-copy">
        Choose 25 To 2,500 Diamonds. You Can Double Your Entry Once Before The Game Starts.
      </p>
      <label className={styles.bonusToggle}>
        <input
          type="checkbox"
          checked={budget.doubled}
          disabled={disabled || !valid}
          onChange={(event) => change({ ...budget, doubled: event.target.checked })}
        />
        <span>Double Down{valid ? `: Add ${budget.base.toLocaleString()} Diamonds` : ''}</span>
      </label>
      {plinko && valid ? (
        <label className={styles.seedField}>
          Diamonds Per Drop
          <select
            className={styles.seedInput}
            value={budget.denomination}
            disabled={disabled}
            onChange={(event) => change({ ...budget, denomination: Number(event.target.value) })}
          >
            {choices.map((choice) => (
              <option key={choice.diamondsPerDrop} value={choice.diamondsPerDrop}>
                {choice.drops} {choice.drops === 1 ? 'Drop' : 'Drops'} At {choice.diamondsPerDrop}{' '}
                {choice.diamondsPerDrop === 1 ? 'Diamond' : 'Diamonds'} Each
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="sc-copy" aria-live="polite">
        {valid
          ? `${total.toLocaleString()} Diamonds In This Bonus.`
          : 'Enter A Whole Number From 25 To 2,500.'}
      </p>
      {diamonds !== null && valid && diamonds < total ? (
        <p className="sc-copy">
          You Need {(total - diamonds).toLocaleString()} More Diamonds To Start.
        </p>
      ) : null}
      <div className={styles.bonusLinks}>
        <button
          type="button"
          className={styles.back}
          disabled={disabled}
          onClick={() => navigate('/marketplace?tab=diamonds')}
        >
          Buy More
        </button>
        <button
          type="button"
          className={styles.back}
          disabled={disabled}
          onClick={() => navigate(`/clubs/${clubId}/earn-diamonds`)}
        >
          Earn Diamonds
        </button>
      </div>
    </SpadeConsole>
  );
}
