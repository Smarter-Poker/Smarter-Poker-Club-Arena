import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useCashoutScope } from '../../hooks/useCashoutScope';
import { readClubWeeklyStatements, formatWeeklyChips, CLUB_WEEKLY_STATEMENT_LIMIT,
  type ClubWeeklyStatement } from '../../services/ClubWeeklyAccountingReader';

interface Observation {
  scope: () => boolean;
  read: number;
  phase: 'loading' | 'ready' | 'unavailable';
  rows: ClubWeeklyStatement[];
}

/** Every club surface reads the same issued weekly summaries. */
export function ClubWeeklyAccountingSummary({ clubId }: { clubId: string }) {
  const { user, isHydrating } = useAuthUser();
  const scope = useCashoutScope(user?.id, JSON.stringify(['weekly-statements', clubId]));
  const sequence = useRef(0);
  const [observation, setObservation] = useState<Observation | null>(null);
  const refresh = useCallback(async () => {
    const read = ++sequence.current;
    const current = () => scope() && sequence.current === read;
    if (!user?.id || isHydrating || !clubId || !current()) return;
    setObservation({ scope, read, phase: 'loading', rows: [] });
    try {
      const result = await readClubWeeklyStatements({ clubId, userId: user.id,
        limit: CLUB_WEEKLY_STATEMENT_LIMIT, isCurrent: current });
      if (current()) setObservation({ scope, read, phase: 'ready', rows: result.rows });
    } catch {
      if (current()) setObservation({ scope, read, phase: 'unavailable', rows: [] });
    }
  }, [clubId, user?.id, isHydrating, scope]);

  useEffect(() => {
    void refresh();
    return () => { ++sequence.current; };
  }, [refresh]);

  const current = scope() && observation?.scope === scope && observation.read === sequence.current
    ? observation : null;
  const available = !!user?.id && !!clubId && !isHydrating && scope();
  const loading = available && (!current || current.phase === 'loading');
  const unavailable = !available || current?.phase === 'unavailable';
  return (
    <section aria-label="Club Weekly Accounting" aria-busy={loading}>
      <div className="admin-card" style={{ marginBottom: 16 }}>
        <h3 className="admin-card-title">Club Weekly Accounting</h3>
        <p>Weekly Totals For Rake Received, Rakeback Paid And Rake Retained.</p>
        <p className="admin-text-secondary">Latest Up To {CLUB_WEEKLY_STATEMENT_LIMIT} Issued Weekly Summaries.</p>
        <button type="button" className="admin-btn admin-btn-primary"
          disabled={!available || loading} onClick={() => void refresh()}>
          Refresh Weekly Summaries
        </button>
      </div>
      {loading && <p role="status">Loading Weekly Summaries…</p>}
      {unavailable && <p role="alert">Weekly Summaries Are Unavailable. Refresh When This Account And Club Are Ready.</p>}
      {!loading && !unavailable && current?.phase === 'ready' && (
        current.rows.length === 0 ? <p>No Issued Weekly Summaries Were Found For This Club.</p> : (
          <div className="admin-table-scroll">
            <table className="admin-data-table">
              <thead><tr><th>Week Starting</th><th>Rake Received</th><th>Rakeback Paid</th><th>Rake Retained</th></tr></thead>
              <tbody>{current.rows.map(row => (
                <tr key={row.id}>
                  <td>{new Date(row.periodStart).toLocaleDateString(undefined,
                    { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td>{formatWeeklyChips(row.rakeFunding)} Chips</td>
                  <td>{formatWeeklyChips(row.paidByClub)} Chips</td>
                  <td>{formatWeeklyChips(row.retainedByClub)} Chips</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}

export default ClubWeeklyAccountingSummary;
