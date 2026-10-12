import { useEffect, useRef, useState } from 'react';
import { SpadeConsole } from '../console/SpadeConsole';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useCashoutScope, useCashoutScopeKey } from '../../hooks/useCashoutScope';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import {
  getMyTournamentPayments,
  type TournamentPayment,
  type TournamentPaymentCursor,
  type TournamentPaymentFilter,
  type TournamentPaymentPage,
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
} as const;

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function timestampValue(value: unknown, label: string): string {
  const timestamp = textValue(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid`);
  return timestamp;
}

function timestampMicros(timestamp: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    timestamp
  );
  if (!match) throw new Error('Tournament payment timestamp is invalid');
  const atSecond = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(atSecond)) throw new Error('Tournament payment timestamp is invalid');
  return BigInt(atSecond) * 1_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function amountValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) {
    throw new Error(`${label} is not an exact chip-cent amount`);
  }
  return cents / 100;
}

function paymentComesAfterCursor(
  payment: TournamentPayment,
  cursor: TournamentPaymentCursor
): boolean {
  const paymentAt = timestampMicros(payment.createdAt);
  const cursorAt = timestampMicros(cursor.createdAt);
  if (paymentAt !== cursorAt) return paymentAt < cursorAt;
  return payment.id < cursor.id;
}

function paymentsAreOrdered(previous: TournamentPayment, current: TournamentPayment): boolean {
  const previousAt = timestampMicros(previous.createdAt);
  const currentAt = timestampMicros(current.createdAt);
  if (previousAt !== currentAt) return previousAt > currentAt;
  return previous.id > current.id;
}

interface PaymentPageExpectation {
  filter: TournamentPaymentFilter;
  requestedCursor: TournamentPaymentCursor | null;
  seenIds?: ReadonlySet<string>;
}

/** The service validates the RPC envelope. This component validates its own
 * boundary too, so a malformed success can never become an empty or paid card
 * when the service is replaced, mocked or refactored. */
function parsePaymentPage(raw: unknown, expected: PaymentPageExpectation): TournamentPaymentPage {
  const page = objectValue(raw, 'Tournament payment page');
  if (!Array.isArray(page.payments)) throw new Error('Tournament payment rows are invalid');
  const seen = new Set(expected.seenIds ?? []);
  const payments = page.payments.map((rawPayment) => {
    const payment = objectValue(rawPayment, 'Tournament payment');
    const state = payment.state;
    if (state !== 'paid' && state !== 'partially_paid' && state !== 'owed' && state !== 'not_due') {
      throw new Error('Tournament payment state is invalid');
    }
    const clubId =
      payment.clubId === null ? null : textValue(payment.clubId, 'Tournament payment club');
    const parsed: TournamentPayment = {
      id: textValue(payment.id, 'Tournament payment identity'),
      tournamentId: textValue(payment.tournamentId, 'Tournament identity'),
      tournamentName: textValue(payment.tournamentName, 'Tournament name'),
      clubId,
      kind: textValue(payment.kind, 'Tournament payment kind'),
      amountOwed: amountValue(payment.amountOwed, 'Tournament amount owed'),
      amountPaid: amountValue(payment.amountPaid, 'Tournament amount paid'),
      remaining: amountValue(payment.remaining, 'Tournament amount remaining'),
      state,
      createdAt: timestampValue(payment.createdAt, 'Tournament payment creation time'),
      updatedAt: timestampValue(payment.updatedAt, 'Tournament payment update time'),
    };
    if (
      (expected.filter.tournamentId && parsed.tournamentId !== expected.filter.tournamentId) ||
      (expected.filter.clubId && parsed.clubId !== expected.filter.clubId)
    ) {
      throw new Error('Tournament payment does not match this view');
    }
    const expectedRemaining = Math.round((parsed.amountOwed - parsed.amountPaid) * 100) / 100;
    const expectedState =
      expectedRemaining === 0
        ? parsed.amountOwed === 0
          ? 'not_due'
          : 'paid'
        : parsed.amountPaid === 0
          ? 'owed'
          : 'partially_paid';
    if (
      parsed.amountPaid > parsed.amountOwed ||
      parsed.remaining !== expectedRemaining ||
      parsed.state !== expectedState
    ) {
      throw new Error('Tournament payment arithmetic is inconsistent');
    }
    if (seen.has(parsed.id)) throw new Error('Tournament payment is duplicated');
    seen.add(parsed.id);
    if (expected.requestedCursor && !paymentComesAfterCursor(parsed, expected.requestedCursor)) {
      throw new Error('Tournament payment page does not continue from its requested cursor');
    }
    return parsed;
  });
  for (let index = 1; index < payments.length; index += 1) {
    if (!paymentsAreOrdered(payments[index - 1], payments[index])) {
      throw new Error('Tournament payment rows are out of order');
    }
  }

  let next: TournamentPaymentCursor | null = null;
  if (page.next !== null) {
    const cursor = objectValue(page.next, 'Tournament payment cursor');
    next = {
      id: textValue(cursor.id, 'Tournament payment cursor identity'),
      createdAt: timestampValue(cursor.createdAt, 'Tournament payment cursor time'),
    };
    const last = payments[payments.length - 1];
    if (!last || next.id !== last.id || next.createdAt !== last.createdAt) {
      throw new Error('Tournament payment cursor does not match the last row');
    }
  }
  return { payments, next };
}

function paymentChips(value: number): string {
  if (value !== 0 && value < 1) return 'Under 1 Chip';
  return compactChips(value);
}

function PaymentRows({
  userId,
  tournamentId,
  clubId,
  viewKey,
}: TournamentPaymentFilter & { userId: string; viewKey: string }) {
  const [payments, setPayments] = useState<TournamentPayment[]>([]);
  const [next, setNext] = useState<TournamentPaymentCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestSequence = useRef(0);
  const loadingMoreRef = useRef(false);
  const isScopeCurrent = useCashoutScope(userId, viewKey);

  useEffect(() => {
    const sequence = requestSequence;
    const request = ++requestSequence.current;
    const current = () => requestSequence.current === request && isScopeCurrent();
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    setPayments([]);
    setNext(null);
    if (!isScopeCurrent()) {
      setError('Payment Account Could Not Be Verified');
      setLoading(false);
      return () => {
        ++sequence.current;
      };
    }
    void getMyTournamentPayments(userId, { tournamentId, clubId })
      .then((page) =>
        parsePaymentPage(page, {
          filter: { tournamentId, clubId },
          requestedCursor: null,
        })
      )
      .then((page) => {
        if (!current()) return;
        setPayments(page.payments);
        setNext(page.next);
      })
      .catch((failure) => {
        if (!current()) return;
        reportError(failure, 'TournamentPaymentStatus.load');
        setError('Payment Status Could Not Be Loaded');
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      ++sequence.current;
      loadingMoreRef.current = false;
    };
  }, [userId, tournamentId, clubId, attempt, isScopeCurrent]);

  const loadMore = async () => {
    if (!next || loadingMoreRef.current || !isScopeCurrent()) return;
    loadingMoreRef.current = true;
    const cursor = next;
    const seenIds = new Set(payments.map((payment) => payment.id));
    const request = ++requestSequence.current;
    const current = () => requestSequence.current === request && isScopeCurrent();
    setLoadingMore(true);
    setMoreError(null);
    try {
      const rawPage = await getMyTournamentPayments(userId, { tournamentId, clubId }, cursor);
      const page = parsePaymentPage(rawPage, {
        filter: { tournamentId, clubId },
        requestedCursor: cursor,
        seenIds,
      });
      if (!current()) return;
      setPayments((prior) => [...prior, ...page.payments]);
      setNext(page.next);
    } catch (failure) {
      if (!current()) return;
      reportError(failure, 'TournamentPaymentStatus.loadMore');
      setMoreError('More Payment Records Could Not Be Loaded');
    } finally {
      if (current()) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  const recordCount = payments.length;
  const unavailable = Boolean(error && recordCount === 0);
  const pill = loading
    ? 'Loading'
    : unavailable
      ? 'Unavailable'
      : recordCount === 0
        ? 'Unconfirmed'
        : `${recordCount} ${recordCount === 1 ? 'Record' : 'Records'}`;

  return (
    <SpadeConsole
      className="tournament-payments"
      family="shark"
      crest="spade"
      eyebrow="Player Ledger"
      title="Tournament Payments"
      pill={pill}
      pillInk={unavailable ? 'red' : loading ? 'muted' : recordCount === 0 ? 'gold' : 'blue'}
      plates={{
        primary: {
          label: loading ? 'Loading...' : 'Refresh',
          ink: unavailable ? 'red' : 'white',
          onClick: () => setAttempt((value) => value + 1),
          disabled: loading || loadingMore,
        },
      }}
      aria-label="Your Tournament Payments"
      aria-busy={loading || undefined}
    >
      <p className="tournament-payments__note sc-copy sc-ink--muted">
        A Completed Tournament May Still Have Amounts Owed. Only Paid Amounts Have Settled.
      </p>
      {loading ? (
        <p className="tournament-payments__message sc-copy sc-copy--center" role="status">
          Loading Payment Status...
        </p>
      ) : (
        <>
          {error && (
            <div className="tournament-payments__message sc-copy sc-ink--red" role="alert">
              {error}
            </div>
          )}
          {!error && payments.length === 0 && (
            <p className="tournament-payments__message sc-copy sc-copy--center sc-ink--gold">
              No Payment Records Available. Payment Status Is Unconfirmed.
            </p>
          )}
          <ul className="tournament-payments__list">
            {payments.map((payment) => {
              const stateInk =
                payment.state === 'owed' || payment.state === 'partially_paid'
                  ? 'gold'
                  : payment.state === 'paid'
                    ? 'green'
                    : 'muted';
              return (
                <li key={payment.id} className="tournament-payments__row">
                  <div className="tournament-payments__identity">
                    <strong className="sc-ink--silver">{titleCase(payment.tournamentName)}</strong>
                    <span className="sc-ink--blue">
                      {KIND[payment.kind] ?? titleCase(payment.kind.replace(/_/g, ' '))}
                    </span>
                  </div>
                  <strong
                    className={`tournament-payments__state sc-ink--${stateInk}`}
                    data-state={payment.state}
                  >
                    {payment.kind === 'seat' && payment.state === 'paid'
                      ? 'Transferred'
                      : STATE[payment.state]}
                  </strong>
                  <div className="tournament-payments__amounts sc-ink--silver">
                    <span>
                      {payment.kind === 'seat' ? 'Transferred' : 'Paid'}:{' '}
                      {paymentChips(payment.amountPaid)}
                    </span>
                    <span>Owed: {paymentChips(payment.remaining)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
          {next && (
            <button
              type="button"
              className="tournament-payments__word sc-ink--blue"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading...' : 'Load Earlier Payment Records'}
            </button>
          )}
          {moreError && (
            <div className="tournament-payments__message sc-copy sc-ink--red" role="alert">
              {moreError}
            </div>
          )}
        </>
      )}
    </SpadeConsole>
  );
}

export default function TournamentPaymentStatus(filter: TournamentPaymentFilter) {
  const { user } = useAuthUser();
  const viewIdentity = JSON.stringify([
    'tournament-payments',
    filter.tournamentId ?? null,
    filter.clubId ?? null,
  ]);
  const scopeKey = useCashoutScopeKey(user?.id, viewIdentity);
  if (!user?.id) return null;
  return (
    <PaymentRows
      key={scopeKey}
      userId={user.id}
      tournamentId={filter.tournamentId}
      clubId={filter.clubId}
      viewKey={viewIdentity}
    />
  );
}
