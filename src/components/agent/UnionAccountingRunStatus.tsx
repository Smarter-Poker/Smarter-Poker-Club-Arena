import { useAuthUser } from '../../hooks/useAuthUser';
import { useAccountingRunObservation } from '../../hooks/useAccountingRunObservation';
import { accountingWeekEndingOn, accountingWeekEndDate, type AccountingObservationInput, type AccountingScopeKind } from '../../services/AccountingObservationService';

export function AccountingRunStatus({ scopeKind, scopeId, periodStart, periodEnd }: {
  scopeKind: AccountingScopeKind; scopeId: string; periodStart?: string; periodEnd: string;
}) {
  const { user } = useAuthUser();
  let input: AccountingObservationInput | null = null;
  try {
    const week = accountingWeekEndingOn(/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)
      ? periodEnd : accountingWeekEndDate({ periodStart: periodEnd, periodEnd }));
    if (user?.id) input = { actorId: user.id, scopeKind, scopeId,
      periodStart: periodStart ?? week.periodStart,
      periodEnd: /^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ? week.periodEnd : periodEnd };
  } catch { /* An invalid selected week is unavailable; never choose a different one. */ }
  const { observation, loading, refresh } = useAccountingRunObservation(input);
  const state = observation?.state;
  const message = loading ? 'Checking Automatic Weekly Accounting…'
    : state === 'posted' ? 'Automatic Weekly Accounting Posted'
    : state === 'incomplete' ? 'Automatic Weekly Accounting Incomplete'
    : state === 'running' ? 'Weekly Accounting Recorded As Running'
    : state === 'no_recorded_run' ? 'No Accounting Run Recorded For This Union Week'
    : 'Automatic Accounting Status Unavailable';
  return <section aria-label="Automatic Weekly Accounting" role={!loading && (!observation || state === 'incomplete' || state === 'unavailable') ? 'alert' : 'status'}
    style={{ margin: '12px 0', padding: 16, border: '1px solid #68748a', borderRadius: 8 }}>
    <strong>{message}</strong>
    {state === 'incomplete' && <p>Accounting review is required before this week can be treated as complete.</p>}
    {scopeKind === 'club' && observation?.record_found === false && <p>A standalone club run could not be established for this week. Check the club weekly statements below.</p>}
    <p>Accounting weeks end at midnight Pacific. The automatic run rule is Monday at 4:00 AM Chicago time.</p>
    {observation && <p>Rule time for this week: {new Date(observation.expected_run_at).toLocaleString(undefined, { timeZone: 'America/Chicago', timeZoneName: 'short' })}. Chicago time. This is a schedule rule, not confirmation that a job ran.</p>}
    {observation?.finished_at && <p>Recorded attempt finished: {new Date(observation.finished_at).toLocaleString()}</p>}
    {state === 'posted' && <p>The canonical weekly run is recorded as posted. Recipient device delivery is tracked separately.</p>}
    <button type="button" disabled={loading} onClick={refresh}>Refresh Status</button>
  </section>;
}

/** Date-only statement-board boundaries are interpreted in the accounting zone. */
export default function UnionAccountingRunStatus({ unionId, periodEnd }: { unionId: string; periodEnd: string }) {
  return <AccountingRunStatus scopeKind="union" scopeId={unionId} periodEnd={periodEnd} />;
}
