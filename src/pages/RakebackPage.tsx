/**
 * Player rakeback history and durable claim recovery.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useRakeback } from '../hooks/useRakeback';
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
const statusLabels = {
  open: 'Open Period',
  needs_review: 'Needs Review',
  pending: 'Unpaid Rakeback',
  fraction_pending: 'Fraction Carried Forward',
  settled_so_far: 'Paid So Far',
};
const chips = (value: number) =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export default function RakebackPage() {
  const { user } = useAuthUser();
  const {
    legacyPeriods,
    capturedPeriods,
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
    (sourceActive === null && capturedPeriods.length > 0);
  const periods = capturedMode ? capturedPeriods : legacyPeriods;
  const totalEarned = periods.reduce((sum, period) => sum + Number(period.rakeback_earned || 0), 0);
  const pendingAmount = capturedMode
    ? capturedPeriods.reduce((sum, period) => sum + period.pending_amount, 0)
    : sourceActive === false
      ? legacyPeriods
          .filter((period) => period.status === 'pending')
          .reduce((sum, period) => sum + Number(period.rakeback_earned || 0), 0)
      : 0;
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
            label: capturedMode ? 'Captured Earnings' : 'Recorded Earnings',
            value: chips(totalEarned),
            tone: 'live',
          },
          { label: 'Period Rate', value: rateLabel },
          {
            label: capturedMode ? 'Unpaid Rakeback' : 'Ready To Claim',
            value: chips(pendingAmount),
            tone: 'attention',
          },
        ]}
      />
      <div className="rakeback-summary">
        <div className="summary-card main">
          <div className="card-content">
            <span className="card-value">{chips(totalEarned)}</span>
            <span className="card-label">
              {capturedMode ? 'Captured Earnings' : 'Recorded Earnings'}
            </span>
          </div>
        </div>
        <div className="summary-row">
          <div className="summary-card">
            <span className="card-value">{rateLabel}</span>
            <span className="card-label">Period Rate</span>
          </div>
          <div className="summary-card pending">
            <span className="card-value">{chips(pendingAmount)}</span>
            <span className="card-label">
              {capturedMode ? 'Unpaid Rakeback' : 'Ready To Claim'}
            </span>
            {(pendingAmount > 0 || pendingRequest) && (
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

      {chartData.length > 0 && (
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
        <div className="rakeback-history">
          <h3>Captured Rakeback History</h3>
          <p>
            Each Row Represents One Club And Earning Period. Paid So Far Does Not Close An Earning
            Period.
          </p>
          {capturedPeriods.length === 0 && !loading ? (
            <p>No Captured Rakeback Yet.</p>
          ) : (
            <div className="periods-list">
              {capturedPeriods.map((period) => (
                <div key={period.club_id + ':' + period.period_start} className="period-row">
                  <div className="period-dates">
                    <span>
                      {formatDate(period.period_start)} - {formatDate(period.period_end)}
                    </span>
                  </div>
                  <div className="period-details">
                    <span className="rake-generated">Rake: {chips(period.rake_generated)}</span>
                    <span className="rakeback-rate">
                      {(period.rakeback_rate * 100).toFixed(1)}%
                    </span>
                    <span>Earned: {chips(period.rakeback_earned)}</span>
                    <span>Paid: {chips(period.paid_amount)}</span>
                    <span>Whole Cents: {chips(period.pending_amount)}</span>
                    <span>Unpaid Earnings: {String(period.unpaid_exact_entitlement)}</span>
                  </div>
                  <div className="period-earned">
                    <span className={`status ${period.status}`}>{statusLabels[period.status]}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
