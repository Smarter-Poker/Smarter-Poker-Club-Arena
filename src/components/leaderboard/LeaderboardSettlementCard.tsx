import type { LeaderboardSettlementStatus } from '../../services/LeaderboardService';
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
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

/* The word in the painted pill slot, in the master's own inks: a verified
   payout is green, a delayed one red, the live round lit blue, the rest muted. */
const STATE_INK: Record<LeaderboardSettlementStatus['state'], ConsoleInk> = {
  not_published: 'muted',
  disabled: 'muted',
  open: 'blue',
  pending: 'gold',
  failed: 'red',
  paid: 'green',
};

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
      <SpadeConsole
        as="section"
        className="lb-settlement-card is-loading"
        eyebrow="Settlement Desk"
        title="Reading The Settlement"
        pill="Reading"
        pillInk="muted"
        foot="foot"
        aria-label="Leaderboard Settlement"
      >
        <span className="lb-settlement-skeleton wide" />
        <span className="lb-settlement-skeleton" />
      </SpadeConsole>
    );
  }

  if (error && !status) {
    return (
      <SpadeConsole
        as="section"
        className="lb-settlement-card is-error"
        eyebrow="Settlement Desk"
        title="Could Not Verify"
        pill="Unverified"
        pillInk="red"
        foot="foot"
        aria-label="Leaderboard Settlement"
      >
        <p className="sc-copy lb-settlement-body">
          Settlement Status Could Not Be Verified. {error}
        </p>
        <div className="lb-settlement-actions">
          <button type="button" className="lb-settlement-word sc-ink--white" onClick={onRetry}>
            Retry Status
          </button>
        </div>
      </SpadeConsole>
    );
  }

  if (!status) return null;

  const copy = STATE_COPY[status.state];
  const ownReceipt = status.receipts.find((receipt) => receipt.user_id === currentUserId);
  const ownerMessage = status.can_manage ? status.failure?.owner_message : null;
  const showRefresh = !!error;
  const showReview = !!(status.can_manage && onReviewSetup && status.state !== 'paid');

  return (
    <SpadeConsole
      as="section"
      className={`lb-settlement-card state-${status.state}`}
      eyebrow="Settlement Desk"
      title={copy.title}
      pill={copy.label}
      pillInk={STATE_INK[status.state]}
      foot="foot"
      aria-label="Leaderboard Settlement"
      aria-live="polite"
    >
      <div className="lb-settlement-main">
        <p className="sc-copy lb-settlement-body">{ownerMessage || copy.body}</p>
        <span className="lb-settlement-window sc-ink--muted">
          {formatUtcDate(status.period_start)} To {formatUtcDate(status.period_end)} · UTC
        </span>
        {status.state === 'failed' && status.failure && (
          <span className="lb-settlement-retry sc-ink--red">
            Attempt {status.failure.attempt_count.toLocaleString('en-US')} Recorded · Automatic
            Retry Active
          </span>
        )}
      </div>

      <dl className="lb-settlement-ledger">
        <div className="lb-settlement-row">
          <dt className="lb-settlement-dt sc-ink--blue">
            {status.state === 'paid' ? 'Paid' : 'Prize Pool'}
          </dt>
          <dd className="lb-settlement-dd sc-ink--silver">
            {(status.batch?.total_paid ?? status.planned_total).toLocaleString('en-US')} Chips
          </dd>
        </div>
        <div className="lb-settlement-row">
          <dt className="lb-settlement-dt sc-ink--blue">
            {status.state === 'paid' ? 'Winners' : 'Program'}
          </dt>
          <dd className="lb-settlement-dd sc-ink--silver">
            {status.state === 'paid'
              ? (status.batch?.winner_count ?? 0).toLocaleString('en-US')
              : status.program
                ? `V${status.program.program_version}`
                : 'None'}
          </dd>
        </div>
        {status.batch && (
          <div className="lb-settlement-row">
            <dt className="lb-settlement-dt sc-ink--blue">Funding</dt>
            <dd className="lb-settlement-dd sc-ink--silver">Promo Only</dd>
          </div>
        )}
      </dl>

      {ownReceipt && (
        <div className="lb-settlement-receipt">
          <span className="lb-settlement-receipt-label sc-ink--blue">Your Verified Receipt</span>
          <strong className="lb-settlement-amount sc-ink--green">
            {ownReceipt.payout_amount.toLocaleString('en-US')} Chips
          </strong>
          <small className="lb-settlement-ref sc-ink--muted">
            Rank {ownReceipt.rank} · Receipt {ownReceipt.id.slice(0, 8).toUpperCase()}
          </small>
        </div>
      )}

      {(showRefresh || showReview) && (
        <div className="lb-settlement-actions">
          {showRefresh && (
            <button type="button" className="lb-settlement-word sc-ink--white" onClick={onRetry}>
              Refresh Status
            </button>
          )}
          {showReview && (
            <button
              type="button"
              className="lb-settlement-word sc-ink--white"
              onClick={onReviewSetup}
            >
              Review Prize Setup
            </button>
          )}
        </div>
      )}
    </SpadeConsole>
  );
}

export default LeaderboardSettlementCard;
