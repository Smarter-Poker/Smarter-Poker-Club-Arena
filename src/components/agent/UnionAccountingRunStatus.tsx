import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';

interface Run {
  status: 'running' | 'complete' | 'failed';
  attempts: number;
  finished_at: string | null;
  result: { error?: string; success?: boolean } | null;
}

/** Mount with a union/account/period key so another selection never inherits a result. */
export default function UnionAccountingRunStatus({
  unionId,
  periodEnd,
}: {
  unionId: string;
  periodEnd: string;
}) {
  const [state, setState] = useState<{ loading: boolean; unavailable: boolean; run: Run | null }>({
    loading: true,
    unavailable: false,
    run: null,
  });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, unavailable: false, run: null });
    void (async () => {
      try {
        // The statement board returns a date; the accounting run stores the
        // actual Pacific midnight (07:00/08:00 UTC). Select that date's run.
        const dayStart = new Date(`${periodEnd.slice(0, 10)}T00:00:00Z`);
        const dayEnd = new Date(dayStart.getTime() + 86_400_000);
        const { data, error } = await supabase
          .from('union_accounting_runs')
          .select('status, attempts, finished_at, result')
          .eq('union_id', unionId)
          .gte('period_end', dayStart.toISOString())
          .lt('period_end', dayEnd.toISOString())
          .maybeSingle();
        if (cancelled) return;
        if (error) throw error;
        if (
          data &&
          (!['running', 'complete', 'failed'].includes(data.status) ||
            (data.status === 'complete' && data.result?.success !== true))
        )
          throw new Error('Invalid accounting run result');
        setState({ loading: false, unavailable: false, run: data as Run | null });
      } catch (error) {
        if (cancelled) return;
        reportError(error, 'UnionAccountingRunStatus.load', { unionId, periodEnd });
        setState({ loading: false, unavailable: true, run: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unionId, periodEnd, refresh]);

  const failed = state.run?.status === 'failed';
  const message = state.loading
    ? 'Checking Automatic Weekly Close...'
    : state.unavailable
      ? 'Automatic Close Status Unavailable'
      : !state.run
        ? 'No Verified Automatic Close Recorded For This Period'
        : failed
          ? 'Automatic Weekly Close Incomplete'
          : state.run.status === 'running'
            ? 'Automatic Weekly Close In Progress'
            : 'Automatic Weekly Close Posted';
  const reason =
    state.run?.result?.error === 'union_rakeback_wrong_club'
      ? 'Player Rakeback Includes Records Assigned To The Wrong Club. Accounting Review Is Required.'
      : state.run?.result?.error === 'union_player_obligations_remaining'
        ? 'Player Rakeback Is Still Outstanding.'
        : 'Review The Accounting Failure Before Treating This Period As Complete.';
  return (
    <section
      aria-label="Automatic Weekly Accounting"
      role={failed || state.unavailable ? 'alert' : 'status'}
      style={{ margin: '12px 16px', padding: 16, border: '1px solid #68748a', borderRadius: 8 }}
    >
      <strong>{message}</strong>
      {failed && <p>{reason}</p>}
      <p>Scheduled Monday At 4:00 AM Chicago Time. Accounting Weeks Close At Midnight Pacific.</p>
      {state.run?.finished_at && (
        <p>Last Attempt: {new Date(state.run.finished_at).toLocaleString()}</p>
      )}
      <button
        type="button"
        disabled={state.loading}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh Status
      </button>
    </section>
  );
}
