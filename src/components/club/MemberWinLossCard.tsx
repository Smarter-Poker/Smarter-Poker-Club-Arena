import { useEffect, useState } from 'react';
import ClubRosterService, {
  type MemberWinLoss,
  type WinLossFigure,
} from '../../services/ClubRosterService';
import { reportError } from '../../utils/errorReporter';
import { playerRecordMoney } from '../../utils/playerRecordMoney';
import { useChicagoStatsDay } from '../../hooks/useChicagoStatsDay';
// The record's own sheet: the card is drawn from its stat rows and inks.
import '../../pages/MemberManagementPage.css';

/**
 * WIN / LOSS ON THE PLAYER RECORD (Dan 2026-10-16)
 *
 * "WHEN YOU ARE ON THE PLAYERS OR PLAYER MANAGEMENT, YOU SHOULD BE ABLE TO SEE
 * THERE OVERALL WIN LOSS NUMBERS, AS WELL AS BROKEN DOWN BY DAILY, WEEKLY
 * MONTHLY ETC."
 *
 * Four windows from ca_club_member_win_loss: Today, This Week, This Month and
 * Overall. Each prints the net in the record's own up / down ink, with the
 * cash and tournament halves beneath it. Cash is signed hand results after
 * rake; tournaments are money (prizes and bounties minus buy-ins, rebuys and
 * add-ons), never tournament chips. Every window resets at 12 AM Chicago
 * time (Dan 2026-10-25): Today at midnight, This Week on Monday and This
 * Month on the 1st.
 *
 * Rendered only where the record already shows financials, and the RPC applies
 * the same access rule again, so a viewer who may not see wallets gets nothing.
 */
const WINDOWS: ReadonlyArray<{ key: keyof Omit<MemberWinLoss, 'as_of'>; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'overall', label: 'Overall' },
];

function tone(value: number | null): string {
  if (value === null) return '';
  if (value > 0) return ' mm-stat--up';
  if (value < 0) return ' mm-stat--down';
  return '';
}

function WinLossRow({ label, figure }: { label: string; figure: WinLossFigure }) {
  return (
    <div className={`mm-stat mm-winloss__row${tone(figure.net)}`}>
      <span className="mm-stat__label">{label}</span>
      <span className="mm-stat__value">
        {figure.net === null ? 'Unavailable' : playerRecordMoney(figure.net, true)}
      </span>
      <span className="mm-winloss__split">
        Cash {figure.cash === null ? 'Unavailable' : playerRecordMoney(figure.cash, true)} /
        Tournaments {playerRecordMoney(figure.mtt, true)}
      </span>
    </div>
  );
}

export default function MemberWinLossCard({
  clubId,
  userId,
  refreshKey = 0,
}: {
  clubId: string;
  userId: string;
  refreshKey?: number;
}) {
  const day = useChicagoStatsDay();
  const scope = `${clubId}:${userId}:${day}`;
  type Result = {
    scope: string;
    state: 'loading' | 'ready' | 'error' | 'hidden';
    data: MemberWinLoss | null;
    /** A background refresh failed; `data` is the previous successful read. */
    stale?: boolean;
  };
  const [result, setResult] = useState<Result>({ scope, state: 'loading', data: null });
  const current: Result = result.scope === scope ? result : { scope, state: 'loading', data: null };
  const { data, state, stale } = current;

  useEffect(() => {
    const controller = new AbortController();
    // Keep a verified card in place during a background refresh. A changed
    // club/member gets its own loading state and never sees the former record.
    setResult((previous) =>
      previous.scope === scope && previous.state === 'ready'
        ? previous
        : { scope, state: 'loading', data: null }
    );
    Promise.resolve()
      .then(() => ClubRosterService.getMemberWinLoss(clubId, userId, controller.signal))
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ scope, data, state: data ? 'ready' : 'hidden' });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        reportError(error, 'MemberWinLossCard.Load');
        // A failed background refresh keeps the verified figures and says they
        // are from the previous read; only a card with nothing to show errors.
        setResult((previous) =>
          previous.scope === scope && previous.state === 'ready' && previous.data
            ? { ...previous, stale: true }
            : { scope, data: null, state: 'error' }
        );
      });
    return () => controller.abort();
  }, [clubId, userId, scope, refreshKey]);

  if (state === 'hidden') return null;

  return (
    <section
      className="mm-card mm-stats mm-winloss"
      aria-labelledby="mm-winloss-title"
      aria-busy={state === 'loading'}
    >
      <h2 id="mm-winloss-title" className="mm-card__title">
        Win / Loss
      </h2>
      {state === 'error' ? (
        <p className="mm-winloss__note" role="status">
          Win And Loss Could Not Be Loaded.
        </p>
      ) : state === 'loading' || !data ? (
        <p className="mm-winloss__note" role="status">
          Loading Win And Loss...
        </p>
      ) : (
        <>
          {WINDOWS.map((window) => (
            <WinLossRow key={window.key} label={window.label} figure={data[window.key]} />
          ))}
          {WINDOWS.some((window) => data[window.key].net === null) && (
            <p className="mm-winloss__note" role="status">
              Some Historical Jackpot Club Records Are Missing. Affected Totals Are Unavailable.
            </p>
          )}
          {stale && (
            <p className="mm-winloss__note mm-winloss__note--stale" role="status">
              Could Not Refresh Win And Loss. Showing The Previous Successful Read.
            </p>
          )}
          <p className="mm-winloss__note">
            Club Chips. Today, Week And Month Reset At 12 AM Chicago Time.
          </p>
        </>
      )}
    </section>
  );
}
