/**
 * The header every Diamond Game page shares: back, eyebrow, title, and the two
 * balances a player watches while they play, in the lobby's bay plaques.
 */

import { useNavigate } from 'react-router-dom';
import { CasinoBay, CasinoBays, CasinoFrame, CasinoNote } from './CasinoChassis';
import styles from './DiamondGamesHeader.module.css';

export function chipsText(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function dollarsText(chipsValue: number): string {
  return `$${chipsText(chipsValue)}`;
}

export default function DiamondGamesHeader({
  eyebrow,
  title,
  diamonds,
  spendable,
  memberChips,
  purchasedOnly,
  backTo,
  note,
}: {
  eyebrow: string;
  title: string;
  diamonds: number;
  spendable: number;
  memberChips: number | null;
  purchasedOnly: boolean;
  backTo?: string;
  note?: string;
}) {
  const navigate = useNavigate();
  return (
    <div className={styles.header}>
      <button
        type="button"
        className={styles.back}
        onClick={() => (backTo ? navigate(backTo) : navigate(-1))}
        aria-label="Back"
      >
        <span aria-hidden="true">‹</span>
        <span className={styles.backText}>Back</span>
      </button>
      <CasinoFrame eyebrow={eyebrow} title={title} tight>
        <CasinoBays columns={2}>
          <CasinoBay
            label="Diamonds"
            value={diamonds.toLocaleString()}
            sub={purchasedOnly ? `${spendable.toLocaleString()} Purchased` : 'Ready To Play'}
            tone="cyan"
          />
          <CasinoBay
            label="Club Chips"
            value={chipsText(memberChips ?? 0)}
            sub={dollarsText(memberChips ?? 0)}
            tone="gold"
          />
        </CasinoBays>
        {note ? <CasinoNote>{note}</CasinoNote> : null}
      </CasinoFrame>
    </div>
  );
}
