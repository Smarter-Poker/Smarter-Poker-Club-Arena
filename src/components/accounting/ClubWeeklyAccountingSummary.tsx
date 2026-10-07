import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useCashoutScope } from '../../hooks/useCashoutScope';
import {
  readClubWeeklyStatements,
  formatWeeklyChipsForDisplay,
  CLUB_WEEKLY_STATEMENT_LIMIT,
  type ClubWeeklyStatement,
} from '../../services/ClubWeeklyAccountingReader';
import { FinancialExportService } from '../../services/FinancialExportService';
import { reportError } from '../../utils/errorReporter';
import styles from './ClubWeeklyAccountingSummary.module.css';

interface Observation {
  scope: () => boolean;
  read: number;
  phase: 'loading' | 'ready' | 'unavailable';
  rows: ClubWeeklyStatement[];
}

function retire(counter: { current: number }) {
  counter.current += 1;
}

/** Every club surface reads the same issued weekly summaries. */
export function ClubWeeklyAccountingSummary({ clubId }: { clubId: string }) {
  const { user, isHydrating } = useAuthUser();
  const scope = useCashoutScope(user?.id, JSON.stringify(['weekly-statements', clubId]));
  const sequence = useRef(0);
  const exportSequence = useRef(0);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<{
    tone: 'ready' | 'unavailable';
    message: string;
  } | null>(null);
  const refresh = useCallback(async () => {
    const read = ++sequence.current;
    const current = () => scope() && sequence.current === read;
    if (!user?.id || isHydrating || !clubId || !current()) return;
    setExportNotice(null);
    setObservation({ scope, read, phase: 'loading', rows: [] });
    try {
      const result = await readClubWeeklyStatements({
        clubId,
        userId: user.id,
        limit: CLUB_WEEKLY_STATEMENT_LIMIT,
        isCurrent: current,
      });
      if (current()) setObservation({ scope, read, phase: 'ready', rows: result.rows });
    } catch (error) {
      if (current()) {
        reportError(error, 'ClubWeeklyAccountingSummary.read');
        setObservation({ scope, read, phase: 'unavailable', rows: [] });
      }
    }
  }, [clubId, user?.id, isHydrating, scope]);

  useEffect(() => {
    void refresh();
    return () => {
      retire(sequence);
      retire(exportSequence);
    };
  }, [refresh]);

  const exportSummaries = useCallback(async () => {
    const read = ++exportSequence.current;
    const current = () => scope() && exportSequence.current === read;
    if (!user?.id || isHydrating || !clubId || !current()) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const result = await FinancialExportService.exportCSV({
        type: 'settlement_club',
        clubId,
        userId: user.id,
        expectedActorId: user.id,
        limit: CLUB_WEEKLY_STATEMENT_LIMIT,
        isCurrent: current,
      });
      if (!current()) return;
      setExportNotice(
        result.success
          ? { tone: 'ready', message: 'Weekly Summary Export Prepared.' }
          : { tone: 'unavailable', message: 'Weekly Summary Export Is Unavailable.' }
      );
    } catch (error) {
      if (!current()) return;
      reportError(error, 'ClubWeeklyAccountingSummary.export');
      setExportNotice({
        tone: 'unavailable',
        message: 'Weekly Summary Export Is Unavailable.',
      });
    } finally {
      if (current()) setExporting(false);
    }
  }, [clubId, user?.id, isHydrating, scope]);

  const current =
    scope() && observation?.scope === scope && observation.read === sequence.current
      ? observation
      : null;
  const available = !!user?.id && !!clubId && !isHydrating && scope();
  const loading = available && (!current || current.phase === 'loading');
  const unavailable = !available || current?.phase === 'unavailable';
  return (
    /* Named for what it lists. Inside the Settlement Center it sits under the
       workspace's own "Club Weekly Accounting" heading, and a second heading
       with that exact name gave the page two of them (Post-Deploy E2E run
       37569802965, financial-admin-deep.spec.ts Settlement Center). */
    <section className={styles.summary} aria-label="Club Weekly Summaries" aria-busy={loading}>
      <div className={styles.header}>
        <h3 className={styles.title}>Club Weekly Summaries</h3>
        <p className={styles.copy}>
          Weekly Totals For Rake Received, Rakeback Paid And Rake Retained.
        </p>
        <p className={styles.meta}>
          Latest Up To {CLUB_WEEKLY_STATEMENT_LIMIT} Issued Weekly Summaries.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.word}
            disabled={!available || loading}
            onClick={() => void refresh()}
          >
            Refresh Weekly Summaries
          </button>
          <button
            type="button"
            className={styles.word}
            disabled={
              !available ||
              loading ||
              exporting ||
              current?.phase !== 'ready' ||
              current.rows.length === 0
            }
            onClick={() => void exportSummaries()}
          >
            {exporting ? 'Preparing Weekly Export...' : 'Export Weekly Summaries'}
          </button>
        </div>
      </div>
      {exportNotice && (
        <p
          className={`${styles.exportNotice} ${
            exportNotice.tone === 'unavailable' ? 'sc-ink--red' : 'sc-ink--blue'
          }`}
          role={exportNotice.tone === 'unavailable' ? 'alert' : 'status'}
        >
          {exportNotice.message}
        </p>
      )}
      {loading && (
        <p className={`${styles.state} sc-ink--muted`} role="status">
          Loading Weekly Summaries...
        </p>
      )}
      {unavailable && (
        <p className={`${styles.state} sc-ink--red`} role="alert">
          Weekly Summaries Are Unavailable. Refresh When This Account And Club Are Ready.
        </p>
      )}
      {!loading &&
        !unavailable &&
        current?.phase === 'ready' &&
        (current.rows.length === 0 ? (
          <p className={`${styles.state} sc-ink--muted`}>
            No Issued Weekly Summaries Were Found For This Club.
          </p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Week Starting</th>
                  <th>Rake Received</th>
                  <th>Rakeback Paid</th>
                  <th>Rake Retained</th>
                </tr>
              </thead>
              <tbody>
                {current.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {new Date(row.periodStart).toLocaleDateString(undefined, {
                        timeZone: 'America/Los_Angeles',
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </td>
                    <td>{formatWeeklyChipsForDisplay(row.rakeFunding)}</td>
                    <td>{formatWeeklyChipsForDisplay(row.paidByClub)}</td>
                    <td>{formatWeeklyChipsForDisplay(row.retainedByClub)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}

export default ClubWeeklyAccountingSummary;
