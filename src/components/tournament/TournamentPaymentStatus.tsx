import { useEffect, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
import { moneyExact } from '../../utils/buyIn';
import {
  getMyTournamentPayments,
  type TournamentPayment,
  type TournamentPaymentCursor,
  type TournamentPaymentFilter,
} from '../../services/TournamentPaymentService';
import './TournamentPaymentStatus.css';

const KIND: Record<string, string> = {
  place: 'Placement Prize',
  bounty: 'Bounty',
  bounty_residual: 'Remaining Bounty',
  mystery_bounty: 'Mystery Bounty',
  refund: 'Refund',
  seat: 'Satellite Seat Value',
  satellite_remainder: 'Satellite Cash Award',
  bubble_protection: 'Bubble Protection',
  final_table_deal: 'Final Table Deal',
  late_reg_adjustment: 'Entry Adjustment',
};
const STATE = {
  paid: 'Paid',
  partially_paid: 'Partially Paid',
  owed: 'Owed',
  not_due: 'No Payment Due',
};

function PaymentRows({
  userId,
  tournamentId,
  clubId,
}: TournamentPaymentFilter & { userId: string }) {
  const [payments, setPayments] = useState<TournamentPayment[]>([]);
  const [next, setNext] = useState<TournamentPaymentCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const isMounted = useIsMounted();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getMyTournamentPayments(userId, { tournamentId, clubId })
      .then((page) => {
        if (!active) return;
        setPayments(page.payments);
        setNext(page.next);
      })
      .catch((failure) => {
        if (!active) return;
        reportError(failure, 'TournamentPaymentStatus.load');
        setError('Payment Status Could Not Be Loaded');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId, tournamentId, clubId, attempt]);

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getMyTournamentPayments(userId, { tournamentId, clubId }, next);
      if (!isMounted.current) return;
      setPayments((prior) => [...prior, ...page.payments]);
      setNext(page.next);
    } catch (failure) {
      if (!isMounted.current) return;
      reportError(failure, 'TournamentPaymentStatus.loadMore');
      setError('More Payment Records Could Not Be Loaded');
    } finally {
      if (isMounted.current) setLoadingMore(false);
    }
  };

  return (
    <section className="tournament-payments" aria-label="Your Tournament Payments">
      <header className="tournament-payments__header">
        <h3>Your Tournament Payments</h3>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          disabled={loading || loadingMore}
        >
          Refresh
        </button>
      </header>
      <p className="tournament-payments__note">
        A Completed Tournament May Still Have Amounts Owed. Only Paid Amounts Have Settled.
      </p>
      {loading ? (
        <p role="status">Loading Payment Status...</p>
      ) : (
        <>
          {error && <div role="alert">{error}</div>}
          {!error && payments.length === 0 && (
            <p>No Payment Records Available. Payment Status Is Unconfirmed.</p>
          )}
          <ul className="tournament-payments__list">
            {payments.map((payment) => (
              <li key={payment.id} className="tournament-payments__row">
                <div className="tournament-payments__identity">
                  <strong>{payment.tournamentName}</strong>
                  <span>{KIND[payment.kind] ?? 'Tournament Payment'}</span>
                </div>
                <strong className="tournament-payments__state" data-state={payment.state}>
                  {payment.kind === 'seat' && payment.state === 'paid'
                    ? 'Transferred'
                    : STATE[payment.state]}
                </strong>
                <div className="tournament-payments__amounts">
                  <span>
                    {payment.kind === 'seat' ? 'Transferred' : 'Paid'}:{' '}
                    {moneyExact(payment.amountPaid)}
                  </span>
                  <span>Owed: {moneyExact(payment.remaining)}</span>
                </div>
              </li>
            ))}
          </ul>
          {next && (
            <button type="button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load Earlier Payment Records'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export default function TournamentPaymentStatus(filter: TournamentPaymentFilter) {
  const { user } = useAuthUser();
  if (!user?.id) return null;
  // Remount when the account or financial scope changes, so another account's
  // or tournament's records cannot remain visible while a new read is pending.
  return (
    <PaymentRows
      key={[user.id, filter.tournamentId, filter.clubId].join(':')}
      userId={user.id}
      {...filter}
    />
  );
}
