import { useEffect, useRef, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import {
  loadDiamondStatements,
  type DiamondStatement,
} from '../../services/DiamondStatementService';
import { reportError } from '../../utils/errorReporter';
import { SpadeConsole } from '../console/SpadeConsole';
import styles from './DiamondSpinStatements.module.css';

const amount = (value: number) => value.toLocaleString();
const dateLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Chicago',
  });
const lines = [
  ['entry_diamonds', 'Paid Spins'],
  ['bonus_diamonds', 'Double Down'],
  ['mint_entry_diamonds', 'Daily Bonus Entries From The Mint'],
  ['diamond_prizes', 'Diamond Prizes'],
  ['throwables', 'Throwables'],
  ['time_banks', 'Time Banks'],
  ['rabbit_hunts', 'Rabbit Hunts'],
  ['other_expenses', 'Other Prizes'],
] as const;

export default function DiamondSpinStatements() {
  const { user } = useAuthUser();
  return user ? <Statements key={user.id} /> : null;
}
function Statements() {
  const [days, setDays] = useState<DiamondStatement[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  const failedCursor = useRef<string | null>(null);
  async function load(before: string | null = null) {
    if (pending.current) return;
    pending.current = true;
    failedCursor.current = before;
    setBusy(true);
    setError(null);
    try {
      const result = await loadDiamondStatements(before);
      if (!active.current) return;
      setDays((rows) => (before ? [...rows, ...result.days] : result.days));
      setNext(result.next_before_day);
    } catch (e) {
      reportError(e, 'DiamondSpinStatements');
      if (active.current)
        setError(e instanceof Error ? e.message : 'Statements Could Not Be Loaded');
    } finally {
      if (active.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <SpadeConsole eyebrow="Owner Wallet" title="Daily Diamond Statements" foot="foot">
      <p className="sc-copy">
        Spin Entries And Prize Costs Are Recorded Throughout The Day. Your Net Diamonds Settle To
        Your Wallet In One Transaction After Midnight, Chicago Time. Chip Prizes Still Use The Promo
        Wallet First, With The Main Bank Covering Any Shortfall.
      </p>
      <button className={styles.action} disabled={busy} type="button" onClick={() => void load()}>
        Refresh Statements
      </button>
      {busy && (
        <p className="sc-copy" role="status">
          Loading Statements
        </p>
      )}
      {error && (
        <div role="alert" className="sc-copy sc-ink--red">
          {error}
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => void load(failedCursor.current)}
          >
            Try Again
          </button>
        </div>
      )}
      {!busy && !error && days.length === 0 && (
        <p className="sc-copy">Your First Diamond Spins Statement Will Appear Here.</p>
      )}
      {days.map((row) => (
        <details className={styles.day} key={row.day}>
          <summary>
            <span>
              {dateLabel(row.day)}
              <small>{row.status === 'open' ? 'Awaiting Daily Settlement' : 'Settled'}</small>
            </span>
            <strong className={row.net_diamonds < 0 ? 'sc-ink--red' : 'sc-ink--blue'}>
              {amount(row.net_diamonds)} Diamonds
            </strong>
          </summary>
          <dl className={styles.totals}>
            {lines.map(([key, label], index) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  {index > 2 && row[key] > 0 ? '−' : ''}
                  {amount(row[key])}
                </dd>
              </div>
            ))}
            <div>
              <dt>Daily Net</dt>
              <dd>{amount(row.net_diamonds)}</dd>
            </div>
          </dl>
          {row.hosts.map((host) => (
            <div className={styles.host} key={`${host.host_kind}:${host.host_id}`}>
              <strong>{host.host_name ?? (host.host_kind === 'union' ? 'Union' : 'Club')}</strong>
              <span>
                {amount(host.entries)} In · {amount(host.expenses)} Prizes ·{' '}
                {amount(host.net_diamonds)} Net
              </span>
            </div>
          ))}
          {row.settled_at && (
            <p className={styles.note}>
              Settled {new Date(row.settled_at).toLocaleString()}.
              {row.wallet_transaction_id
                ? ' One Transfer Is Recorded In Your Diamond Wallet.'
                : ' No Wallet Transfer Was Needed For This Zero Net Day.'}
            </p>
          )}
        </details>
      ))}
      {next && (
        <button
          type="button"
          disabled={busy}
          className={styles.action}
          onClick={() => void load(next)}
        >
          Older Statements
        </button>
      )}
    </SpadeConsole>
  );
}
