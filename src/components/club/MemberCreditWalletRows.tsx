import { useEffect, useState } from 'react';
import { useMasterBusSubscriptions } from '../../hooks/useMasterBusSubscription';
import { reportError } from '../../utils/errorReporter';
import { supabase } from '../../lib/supabase';
import { runWithRequestDeadline } from '../../utils/requestDeadline';
import { formatWalletChips } from '../../utils/format';
import type { ClubRole } from '../../types/clubRoles';
import '../../pages/MemberManagementPage.css';

type Credit = { limit: number };

/** Read the agreement, never add borrowed capacity to a wallet balance. */
export default function MemberCreditWalletRows({
  clubId,
  userId,
  role,
  revision,
}: {
  clubId: string;
  userId: string;
  role: ClubRole;
  revision: string | number;
}) {
  const [result, setResult] = useState<{
    key: string;
    credit: Credit | null;
    failed: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useMasterBusSubscriptions(['AGENT_UPDATED'], (payload) => {
    const change = payload as { clubId?: string; agentId?: string } | null;
    if (change?.clubId && change.clubId !== clubId) return;
    if (change?.agentId && change.agentId !== userId) return;
    setAttempt((value) => value + 1);
  });
  const key = `${clubId}:${userId}:${role}:${revision}:${attempt}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const { data, error } = await runWithRequestDeadline(
          (signal) =>
            supabase
              .from('agents')
              .select('club_id,user_id,role,is_prepaid,credit_limit')
              .eq('club_id', clubId)
              .eq('user_id', userId)
              .eq('status', 'active')
              .abortSignal(signal)
              .maybeSingle(),
          { signal: controller.signal }
        );
        if (error) throw error;
        if (
          !data ||
          data.club_id !== clubId ||
          data.user_id !== userId ||
          data.role !== role ||
          typeof data.is_prepaid !== 'boolean' ||
          data.credit_limit == null ||
          !Number.isFinite(Number(data.credit_limit)) ||
          Number(data.credit_limit) < 0
        ) {
          throw new Error('Credit Terms Could Not Be Read');
        }
        if (!controller.signal.aborted)
          setResult({
            key,
            failed: false,
            credit: data.is_prepaid ? null : { limit: Number(data.credit_limit) },
          });
      } catch (error) {
        if (!controller.signal.aborted) {
          reportError(error, 'MemberCreditWalletRows.read');
          setResult({ key, credit: null, failed: true });
        }
      }
    })();
    return () => controller.abort();
  }, [key, clubId, userId, role]);
  if (result?.key !== key) return <p role="status">Loading Credit Line...</p>;
  if (result.failed)
    return (
      <p role="status">
        Credit Line Unavailable.{' '}
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry Credit Line
        </button>
      </p>
    );
  if (!result.credit) return null;
  return (
    <section className="mm-card mm-stats" aria-label="Credit Tracking">
      <h2 className="mm-card__title">Credit Tracking</h2>
      <p className="mm-range__caption">
        Tracking Only. Weekly Invoices Use The Agent Wallet Before Rakeback.
      </p>
      {([['Credit Line', result.credit.limit]] as const).map(([label, amount]) => (
        <div className="mm-stat" key={label}>
          <span className="mm-stat__label">{label}</span>
          <span className="mm-stat__value">{formatWalletChips(amount)}</span>
        </div>
      ))}
    </section>
  );
}
