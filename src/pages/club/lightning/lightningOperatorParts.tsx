/**
 * The pieces the Lightning operator views share: the mode inks, the figure
 * and latency grids, and the calm states every door answers with
 * (restricted, not available yet, refused, failed). Printed on the console
 * glass; nothing here draws a frame.
 */
import { type ConsoleInk } from '../../../components/console/SpadeConsole';
import { compactChips } from '../../../utils/format';
import {
  LATENCY_LEGS,
  LATENCY_LEG_LABELS,
  enumLabel,
  type LatencyLegs,
  type LightningModeTone,
  type OperatorAnswer,
} from '../../../lightning/lightningOperatorApi';
import styles from '../ClubLightningOperationsPage.module.css';

export const MODE_INK: Record<LightningModeTone, ConsoleInk> = {
  must_move: 'silver',
  lightning: 'blue',
  pending: 'gold',
  frozen: 'red',
  other: 'muted',
};

/** A count the door did not give is unknown, and prints as a dash, never 0. */
export function count(n: number | null): string {
  return n === null ? '-' : compactChips(n);
}

export function onOff(flag: boolean | null): string {
  if (flag === null) return 'Unknown';
  return flag ? 'On' : 'Off';
}

/** A latency in whole milliseconds; the unit is printed once, in the head. */
export function ms(n: number | null): string {
  return n === null ? '-' : Math.round(n).toLocaleString('en-US');
}

export function Figure({
  label,
  value,
  ink = 'silver',
}: {
  label: string;
  value: string;
  ink?: ConsoleInk;
}) {
  return (
    <div className={styles.figure}>
      <dt className={`${styles.figureLabel} sc-ink--blue`}>{label}</dt>
      <dd className={`${styles.figureValue} sc-ink--${ink}`}>{value}</dd>
    </div>
  );
}

export function LatencyGrid({ legs }: { legs: LatencyLegs }) {
  const present = LATENCY_LEGS.filter((leg) => legs[leg]);
  if (present.length === 0) return null;
  return (
    <ul className={styles.grid} aria-label="Action Latency In Milliseconds">
      <li className={styles.gridRow}>
        <span className={`${styles.gridHead} sc-ink--muted`}>Milliseconds</span>
        <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>P50</span>
        <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>P95</span>
        <span className={`${styles.gridHead} ${styles.gridCell} sc-ink--muted`}>P99</span>
      </li>
      {present.map((leg) => {
        const r = legs[leg]!;
        return (
          <li className={styles.gridRow} key={leg}>
            <span className={`${styles.gridName} sc-ink--blue`}>{LATENCY_LEG_LABELS[leg]}</span>
            <span className={`${styles.gridCell} sc-ink--silver`}>{ms(r.p50)}</span>
            <span className={`${styles.gridCell} sc-ink--silver`}>{ms(r.p95)}</span>
            <span className={`${styles.gridCell} sc-ink--silver`}>{ms(r.p99)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The calm states every door shares: restricted, not yet, refused, failed. */
export function AnswerState({
  answer,
  onRetry,
}: {
  answer: OperatorAnswer<unknown> | null;
  onRetry: () => void;
}) {
  if (!answer) {
    return (
      <p className={`sc-copy sc-copy--center ${styles.state}`} aria-busy="true">
        Reading Lightning...
      </p>
    );
  }
  if (answer.status === 'denied') {
    return (
      <p className={`sc-copy sc-copy--center ${styles.state}`}>
        Lightning Operations Is Available To Club Owners And Administrators.
      </p>
    );
  }
  if (answer.status === 'unavailable') {
    return (
      <p className={`sc-copy sc-copy--center ${styles.state}`} role="status">
        Not Available Yet. Lightning Operator Readings Arrive With The Next Database Release.
      </p>
    );
  }
  if (answer.status === 'refused') {
    return (
      <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`} role="status">
        Lightning Refused This Read: {enumLabel(answer.code)}
      </p>
    );
  }
  if (answer.status === 'error') {
    return (
      <div className={styles.words} role="alert">
        <p className={`sc-copy sc-copy--center ${styles.state} sc-ink--red`}>{answer.message}</p>
        <button type="button" className={`${styles.word} sc-ink--white`} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}
