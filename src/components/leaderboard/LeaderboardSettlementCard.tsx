import { useEffect, useState } from 'react';
import type { LeaderboardSettlementStatus } from '../../services/LeaderboardService';
import { compactChips } from '../../utils/format';
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
    body: 'No Published Prize Program Covered This Period When It Started.',
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

/* The live round's close, from the server's own exclusive period end (00:00
   UTC on period_end), so the countdown and the settlement run agree on the
   instant. Minute resolution: a round lasts days, and a seconds tick would
   re-render the board every second for nothing. */
const COUNTDOWN_TICK_MS = 30_000;

function useCountdownNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function formatRoundCloses(remainingMs: number): string {
  if (remainingMs <= 0) return 'Round Closing';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Closes In ${days}D ${hours}H`;
  if (hours > 0) return `Closes In ${hours}H ${minutes}M`;
  return `Closes In ${minutes}M`;
}

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
  // Hooks run before any early return: the countdown is live only while the
  // round is open.
  const closesAt =
    status?.state === 'open' ? Date.parse(`${status.period_end}T00:00:00Z`) : Number.NaN;
  const now = useCountdownNow(Number.isFinite(closesAt));

  if (loading && !status) {
    return (
      <section className="lb-settlement-card is-loading" aria-label="Leaderboard Settlement">
        <p role="status">Verifying Settlement Status...</p>
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
        {Number.isFinite(closesAt) && (
          <span className="lb-settlement-countdown" role="timer">
            {formatRoundCloses(closesAt - now)}
          </span>
        )}
        {status.state === 'failed' && status.failure && (
          <span className="lb-settlement-retry">
            Attempt {status.failure.attempt_count.toLocaleString('en-US')} Recorded · Automatic
            Retry Active
          </span>
        )}
        {status.state !== 'open' && status.program && status.program.rewards_enabled && (
          /* The tie rule is the same in every settled state, so a player
             reading a pending, delayed or paid round sees the policy their
             rank was resolved under, not only the live round's copy. */
          <span className="lb-settlement-rule">Tied Places Share Their Occupied Prizes.</span>
        )}
      </div>

      <dl className="lb-settlement-ledger">
        <div>
          <dt>{status.state === 'paid' ? 'Paid' : 'Prize Pool'}</dt>
          <dd>{compactChips(status.batch?.total_paid ?? status.planned_total)} Chips</dd>
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
            {/* The batch row records which pools paid. A standalone club's
                one-time opening leaderboard seed is drawn down before its Promo
                Wallet; a union batch never has a seed. The sources are named,
                not re-priced: flooring each part separately (house compact
                format) would print parts that do not add up to the total above,
                and a half-chip seed would read "Seed 0". */}
            <dd>{status.batch.seed_funded > 0 ? 'Seed And Promo Wallet' : 'Promo Wallet'}</dd>
          </div>
        )}
      </dl>

      {ownReceipt && (
        <div className="lb-settlement-receipt">
          <span>Your Verified Receipt</span>
          <strong>{compactChips(ownReceipt.payout_amount)} Chips</strong>
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
