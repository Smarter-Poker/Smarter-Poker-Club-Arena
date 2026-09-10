/**
 * Player rakeback history and durable claim recovery.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useRakeback } from '../hooks/useRakeback';
import { capturedScopeKey, formatRakebackCash } from '../services/CapturedRakebackV2';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import PageSkeleton from '../components/common/PageSkeleton';
import { ErrorState } from '../components/common/EmptyState';
import RewardsSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import './RakebackPage.css';

const periodDate = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const formatDate = (value: string) =>
  periodDate.format(new Date(value.length === 10 ? value + 'T00:00:00Z' : value));
const formatPaymentDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));
const fundingContext = (unionId: string | null) =>
  unionId ? 'Original Union ' + unionId.slice(0, 8) : 'Club Funding';
const chips = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export default function RakebackPage() {
  const { user } = useAuthUser();
  const {
    legacyPeriods,
    captured,
    sourceActive,
    loading,
    loadError,
    historyError,
    pendingRequest,
    claimStatus,
    claimMessage,
    refresh,
    claim,
  } = useRakeback(user?.id ?? null);
  const refreshData = useCallback(() => {
    void refresh();
  }, [refresh]);
  useVisibilityRefresh(refreshData);
  useMasterBusChannel({
    channelName: user?.id ? `rakeback-updates-${user.id}` : null,
    table: 'rakeback_periods',
    filter: user?.id ? `user_id=eq.${user.id}` : null,
    event: '*',
    onPayload: refreshData,
    enabled: !!user?.id,
  });
  useEffect(() => {
    if (!user?.id) return;
    const unsubscribeBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', refreshData, 500);
    const unsubscribeSettlement = masterBus.subscribeDebounced(
      'SETTLEMENT_COMPLETED',
      refreshData,
      1000
    );
    return () => {
      unsubscribeBalance();
      unsubscribeSettlement();
    };
  }, [refreshData, user?.id]);

  const capturedMode =
    sourceActive === true ||
    !!pendingRequest ||
    (sourceActive === null && captured?.source_active === true);
  const periods = legacyPeriods;
  const totalEarned = periods.reduce((sum, period) => sum + Number(period.rakeback_earned || 0), 0);
  const legacyPending =
    sourceActive === false
      ? legacyPeriods
          .filter((period) => period.status === 'pending')
          .reduce((sum, period) => sum + Number(period.rakeback_earned || 0), 0)
      : 0;
  const pendingAmount = capturedMode
    ? (captured?.pending_amount ?? '0.00')
    : legacyPending.toFixed(2);
  const totalLabel = capturedMode ? 'Closed Earnings' : 'Recorded Earnings';
  const totalDisplay = capturedMode
    ? (captured?.closed_entitlement_exact ?? '0')
    : chips(totalEarned);
  const hasPending = pendingAmount !== '0.00';
  const rates = new Set(periods.map((period) => Number(period.rakeback_rate || 0)));
  const rateLabel =
    rates.size === 1
      ? `${((rates.values().next().value ?? 0) * 100).toFixed(1)}%`
      : rates.size > 1
        ? 'Varies By Period'
        : 'No Rate Yet';
  const chartData = useMemo(
    () =>
      [...periods]
        .reverse()
        .slice(-6)
        .map((period) => ({
          period: formatDate(period.period_start),
          earned: period.rakeback_earned,
        })),
    [periods]
  );

  return (
    <div className="rakeback-page">
      <RewardsSurfaceHeader
        eyebrow="Rewards Circuit / Rakeback"
        title="Rakeback Engine"
        description="Review Your Earning Periods, Paid Chips, And Unpaid Rakeback."
        art="diamonds"
        status={
          sourceActive === null ? 'RAKEBACK // CHECKING AVAILABILITY' : 'RAKEBACK // PERIOD HISTORY'
        }
        metrics={[
          {
            label: totalLabel,
            value: totalDisplay,
            tone: 'live',
          },
          {
            label: capturedMode ? 'Paid Chips' : 'Period Rate',
            value: capturedMode ? formatRakebackCash(captured?.paid_amount ?? '0.00') : rateLabel,
          },
          {
            label: capturedMode ? 'Unpaid Rakeback' : 'Ready To Claim',
            value: formatRakebackCash(pendingAmount),
            tone: 'attention',
          },
        ]}
      />
      <div className="rakeback-summary">
        <div className="summary-card main">
          <div className="card-content">
            <span className="card-value">{totalDisplay}</span>
            <span className="card-label">{totalLabel}</span>
          </div>
        </div>
        <div className="summary-row">
          <div className="summary-card">
            <span className="card-value">
              {capturedMode ? formatRakebackCash(captured?.paid_amount ?? '0.00') : rateLabel}
            </span>
            <span className="card-label">{capturedMode ? 'Paid Chips' : 'Period Rate'}</span>
          </div>
          <div className="summary-card pending">
            <span className="card-value">{formatRakebackCash(pendingAmount)}</span>
            <span className="card-label">
              {capturedMode ? 'Unpaid Rakeback' : 'Ready To Claim'}
            </span>
            {(hasPending || pendingRequest) && (
              <button
                className="claim-btn"
                onClick={() => void claim()}
                disabled={
                  claimStatus === 'claiming' ||
                  (!pendingRequest && (loading || !!loadError || sourceActive === null))
                }
                style={{
                  minHeight: '44px',
                  marginTop: '8px',
                  padding: '6px 16px',
                  background: 'var(--accent-success, #34c759)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 700,
                  cursor: claimStatus === 'claiming' ? 'wait' : 'pointer',
                  opacity: claimStatus === 'claiming' ? 0.6 : 1,
                }}
              >
                {claimStatus === 'claiming'
                  ? 'Checking Claim...'
                  : pendingRequest
                    ? 'Recover Claim'
                    : 'Claim Rakeback'}
              </button>
            )}
          </div>
        </div>
      </div>
      {pendingRequest && (
        <p role="status">
          A Previous Claim Is Awaiting Confirmation. Recover Claim Checks The Same Request, Even If
          Your Unpaid Balance Is Zero.
        </p>
      )}
      {claimMessage && (
        <p role="status" aria-live="polite">
          {claimMessage}
        </p>
      )}
      {loadError && <ErrorState message={loadError} onRetry={refreshData} />}
      {!user?.id && <p>Please Sign In To View Your Rakeback.</p>}

      {!capturedMode && chartData.length > 0 && (
        <div className="rakeback-chart">
          <h3>Earnings History</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis dataKey="period" stroke="var(--text-secondary)" fontSize={12} />
              <YAxis stroke="var(--text-secondary)" fontSize={12} />
              <Tooltip formatter={(value) => [chips(Number(value || 0)), 'Rakeback']} />
              <Bar dataKey="earned" fill="var(--accent-success)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="rakeback-info">
        <h3>How Rakeback Works</h3>
        <p>
          Your Rakeback Follows The Rate Assigned To Eligible Play. Rates Can Vary By Club And
          Earning Period.
        </p>
        {capturedMode && (
          <p>
            Claims Can Remain Unpaid Until Funding Is Available. Unpaid Fractions Remain Recorded
            Until A Whole Cent Can Be Paid. Open Periods And Amounts Under Review Are Not Final.
          </p>
        )}
      </div>
      {capturedMode && (
        <>
          <div className="rakeback-history">
            <h3>Rakeback Earning Agreements</h3>
            <p>
              Compatible Closed Weeks Carry Fractions Forward Together. Different Payers And Funding
              Agreements Stay Separate. Weekly Allocations Are Exact Earnings, Not Separate Cash
              Payments.
            </p>
            {!captured?.balances.length && !loading ? (
              <p>No Captured Rakeback Yet.</p>
            ) : (
              <div className="periods-list">
                {captured?.balances.map((balance) => (
                  <section
                    key={capturedScopeKey(balance.scope)}
                    className="rakeback-agreement"
                    aria-label={
                      'Earning Agreement ' +
                      balance.scope.club_id +
                      ' ' +
                      balance.scope.payer_user_id +
                      ' ' +
                      fundingContext(balance.scope.funding_union_id)
                    }
                  >
                    <h4>
                      Club {balance.scope.club_id.slice(0, 8)} / Payer{' '}
                      {balance.scope.payer_user_id.slice(0, 8)}
                    </h4>
                    <p>{fundingContext(balance.scope.funding_union_id)}</p>
                    <p>
                      Unpaid Rakeback: {formatRakebackCash(balance.pending_amount)} / Paid Chips:{' '}
                      {formatRakebackCash(balance.paid_amount)}
                    </p>
                    <p>Unpaid Earnings: {balance.unpaid_exact}</p>
                    {balance.pool_id === null && <p>Funding Not Yet Recorded.</p>}
                    {balance.unpaid_exact !== '0' && balance.pending_amount === '0.00' && (
                      <p>Fraction Carried Forward</p>
                    )}
                    {balance.earning_weeks.map((earning) => (
                      <div key={earning.week_start} className="period-row">
                        <div className="period-dates">
                          <span>
                            {formatDate(earning.week_start)} - {formatDate(earning.week_end)}
                          </span>
                          <span>
                            {earning.closed ? 'Closed Earning Period' : 'Open Earning Period'}
                          </span>
                        </div>
                        <div className="period-details">
                          <span>Earned: {earning.entitlement_exact}</span>
                          <span>Allocated To Payments: {earning.consumed_exact}</span>
                          <span>Remaining Earnings: {earning.remaining_exact}</span>
                        </div>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </div>
          <div className="rakeback-history">
            <h3>Cash Payment History</h3>
            <p>
              These Are Actual Whole-Cent Payments. Their Payment Dates Are Separate From Earning
              Weeks.
            </p>
            {!captured?.cash_payments.length ? (
              <p>No Captured Cash Payments Yet.</p>
            ) : (
              captured.cash_payments.map((payment) => (
                <details key={payment.payment_id} className="period-row rakeback-payment">
                  <summary>
                    Paid {formatRakebackCash(payment.amount)} Chips /{' '}
                    <time dateTime={payment.paid_at}>{formatPaymentDate(payment.paid_at)} UTC</time>
                  </summary>
                  <p>Receipt {payment.payment_id}</p>
                  <p>
                    Club {payment.scope.club_id.slice(0, 8)} / Payer{' '}
                    {payment.scope.payer_user_id.slice(0, 8)}
                  </p>
                  <p>{fundingContext(payment.scope.funding_union_id)}</p>
                  {payment.earning_slices.map((slice) => (
                    <p key={slice.hand_id + ':' + slice.contributor_id}>
                      Earning Week {formatDate(slice.week_start)}: {slice.amount_exact}
                    </p>
                  ))}
                </details>
              ))
            )}
          </div>
          {!!captured?.unresolved_earnings.length && (
            <div className="rakeback-history">
              <h3>Earnings Under Review</h3>
              <p>These Earning Records Need Review Before An Amount Can Be Confirmed.</p>
              {captured.unresolved_earnings.map((earning) => (
                <div key={earning.club_id + ':' + earning.week_start} className="period-row">
                  <span>
                    Club {earning.club_id.slice(0, 8)} / {formatDate(earning.week_start)} -{' '}
                    {formatDate(earning.week_end)}
                  </span>
                  <span>{earning.source_count} Earning Records Need Review</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="rakeback-history">
        <h3>{capturedMode ? 'Previous Rakeback History' : 'History'}</h3>
        {capturedMode && (
          <p>
            Previous Records Are Shown Separately And Are Not Added To Captured Earnings Or Unpaid
            Amounts.
          </p>
        )}
        {loading && legacyPeriods.length === 0 ? (
          <PageSkeleton variant="financial" />
        ) : historyError ? (
          <ErrorState message={historyError} onRetry={refreshData} />
        ) : legacyPeriods.length === 0 ? (
          <p>No Previous Rakeback History.</p>
        ) : (
          <div className="periods-list">
            {legacyPeriods.map((period) => (
              <div key={period.id} className="period-row">
                <div className="period-dates">
                  <span>
                    {formatDate(period.period_start)} - {formatDate(period.period_end)}
                  </span>
                </div>
                <div className="period-details">
                  <span className="rake-generated">
                    Rake: {chips(Number(period.rake_generated || 0))}
                  </span>
                  <span className="rakeback-rate">
                    {(Number(period.rakeback_rate || 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="period-earned">
                  <span className={`amount ${period.status}`}>
                    {chips(Number(period.rakeback_earned || 0))}
                  </span>
                  <span className={`status ${period.status}`}>
                    {period.status === 'paid'
                      ? 'Paid'
                      : capturedMode
                        ? 'Previously Pending'
                        : 'Pending'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
