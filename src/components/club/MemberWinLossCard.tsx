import { useEffect, useState } from 'react';
import ClubRosterService, {
  type MemberWinLoss,
  type WinLossFigure,
} from '../../services/ClubRosterService';
import { reportError } from '../../utils/errorReporter';
import { winLossChips } from '../../utils/format';
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
 * add-ons), never tournament chips. Days are UTC, matching the record's own
 * date ranges.
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

function tone(value: number): string {
  if (value > 0) return ' mm-stat--up';
  if (value < 0) return ' mm-stat--down';
  return '';
}

function WinLossRow({ label, figure }: { label: string; figure: WinLossFigure }) {
  return (
    <div className={`mm-stat mm-winloss__row${tone(figure.net)}`}>
      <span className="mm-stat__label">{label}</span>
      <span className="mm-stat__value">{winLossChips(figure.net)}</span>
      <span className="mm-winloss__split">
        Cash {winLossChips(figure.cash)} / Tournaments {winLossChips(figure.mtt)}
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
  const [data, setData] = useState<MemberWinLoss | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'hidden'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    // Inside a promise so a synchronous throw is handled like a failed read.
    Promise.resolve()
      .then(() => ClubRosterService.getMemberWinLoss(clubId, userId, controller.signal))
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setState(result ? 'ready' : 'hidden');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        reportError(error, 'MemberWinLossCard.Load');
        setState('error');
      });
    return () => controller.abort();
  }, [clubId, userId, refreshKey]);

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
          <p className="mm-winloss__note">Club Chips. Days Run Midnight To Midnight UTC.</p>
        </>
      )}
    </section>
  );
}
