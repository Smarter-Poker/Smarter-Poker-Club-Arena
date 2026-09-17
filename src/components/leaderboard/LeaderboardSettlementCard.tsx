import type { LeaderboardSettlementStatus } from '../../services/LeaderboardService';
import './LeaderboardSettlementCard.css';

interface LeaderboardSettlementCardProps {
  status: LeaderboardSettlementStatus | null;
  currentUserId?: string;
  loading?: boolean;
  error?: string | null;
  onRetry: () => void;
  onReviewSetup?: () => void;
}

const STATE_COPY = {
  not_published: {
    label: 'No Program',
    title: 'No Prize Program Applies To This Round',
    body: 'This Period Started Before A Published Prize Program Took Effect.',
  },
  disabled: {
    label: 'Disabled',
    title: 'Prizes Were Disabled For This Round',
    body: 'The Immutable Program For This Period Does Not Award Prizes.',
  },
  open: {
    label: 'In Progress',
    title: 'Prize Round In Progress',
    body: 'Rankings Remain Live Until The UTC Period Closes. Tied Places Share Their Occupied Prizes.',
  },
  pending: {
    label: 'Pending',
    title: 'Settlement Pending',
    body: 'The Round Is Closed And Waiting For The Service-Only Settlement Run.',
  },
  failed: {
    label: 'Delayed',
    title: 'Settlement Delayed',
    body: 'No Partial Payout Was Issued. Automatic Retry Remains Active.',
  },
  paid: {
    label: 'Verified',
    title: 'Payouts Verified',
    body: 'The Promo Wallet Debit, Winner Credits, And Immutable Receipts Committed Together.',
  },
} as const;

function formatUtcDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

export function LeaderboardSettlementCard({
  status,
  currentUserId,
  loading = false,
  error,
  onRetry,
  onReviewSetup,
}: LeaderboardSettlementCardProps) {
  if (loading && !status) {
    return (
      <section className="lb-settlement-card is-loading" aria-label="Leaderboard Settlement">
        <span className="lb-settlement-skeleton wide" />
        <span className="lb-settlement-skeleton" />
      </section>
    );
  }

  if (error && !status) {
    return (
      <section className="lb-settlement-card is-error" aria-label="Leaderboard Settlement">
        <div>
          <span className="lb-settlement-kicker">Settlement Desk</span>
          <h2>Settlement Status Could Not Be Verified</h2>
          <p>{error}</p>
        </div>
        <button type="button" onClick={onRetry}>
          Retry Status
        </button>
      </section>
    );
  }

  if (!status) return null;

  const copy = STATE_COPY[status.state];
  const ownReceipt = status.receipts.find((receipt) => receipt.user_id === currentUserId);
  const ownerMessage = status.can_manage ? status.failure?.owner_message : null;

  return (
    <section
      className={`lb-settlement-card state-${status.state}`}
      aria-label="Leaderboard Settlement"
      aria-live="polite"
    >
      <div className="lb-settlement-main">
        <div className="lb-settlement-heading">
          <div>
            <span className="lb-settlement-kicker">Settlement Desk</span>
            <h2>{copy.title}</h2>
          </div>
          <span className="lb-settlement-state">{copy.label}</span>
        </div>
        <p>{ownerMessage || copy.body}</p>
        <span className="lb-settlement-window">
          {formatUtcDate(status.period_start)} To {formatUtcDate(status.period_end)} · UTC
        </span>
        {status.state === 'failed' && status.failure && (
          <span className="lb-settlement-retry">
            Attempt {status.failure.attempt_count.toLocaleString('en-US')} Recorded · Automatic
            Retry Active
          </span>
        )}
      </div>

      <dl className="lb-settlement-ledger">
        <div>
          <dt>{status.state === 'paid' ? 'Paid' : 'Prize Pool'}</dt>
          <dd>
            {(status.batch?.total_paid ?? status.planned_total).toLocaleString('en-US')} Chips
          </dd>
        </div>
        <div>
          <dt>{status.state === 'paid' ? 'Winners' : 'Program'}</dt>
          <dd>
            {status.state === 'paid'
              ? (status.batch?.winner_count ?? 0).toLocaleString('en-US')
              : status.program
                ? `V${status.program.program_version}`
                : 'None'}
          </dd>
        </div>
        {status.batch && (
          <div>
            <dt>Funding</dt>
            <dd>Promo Only</dd>
          </div>
        )}
      </dl>

      {ownReceipt && (
        <div className="lb-settlement-receipt">
          <span>Your Verified Receipt</span>
          <strong>{ownReceipt.payout_amount.toLocaleString('en-US')} Chips</strong>
          <small>
            Rank {ownReceipt.rank} · Receipt {ownReceipt.id.slice(0, 8).toUpperCase()}
          </small>
        </div>
      )}

      <div className="lb-settlement-actions">
        {error && (
          <button type="button" onClick={onRetry}>
            Refresh Status
          </button>
        )}
        {status.can_manage && onReviewSetup && status.state !== 'paid' && (
          <button type="button" onClick={onReviewSetup}>
            Review Prize Setup
          </button>
        )}
      </div>
    </section>
  );
}

export default LeaderboardSettlementCard;
