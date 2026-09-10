import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelTournamentDealReview,
  castTournamentDealVote,
  formatDealCents,
  getTournamentDealReview,
  requestTournamentDealReview,
  type TournamentDealReviewState,
} from '../../services/TournamentDealService';
import { reportError } from '../../utils/errorReporter';
import './details/DetailOverviewTab.css';
import './TournamentDealReview.css';

interface Props {
  tournamentId: string;
  actorId: string;
  players: Array<{ user_id: string; username?: string | null }>;
}
type Action = 'request' | 'vote' | 'cancel';
const statusText = {
  none: 'Request A Deal Review To Pause Play At A Safe Hand Boundary.',
  requested: 'Waiting For Play To Pause At A Safe Hand Boundary.',
  reviewing: 'Play Is Paused While Remaining Players Review This Split.',
  completed: 'Deal Review Is Closed. Check The Tournament Payment Status.',
  cancelled: 'Deal Review Was Cancelled. Play Resumes When The Table Confirms.',
  expired: 'Deal Review Expired. Play Resumes When The Table Confirms.',
};

export default function TournamentDealReview({ tournamentId, actorId, players }: Props) {
  const [review, setReview] = useState<TournamentDealReviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ proposalId: string | null; text: string } | null>(null);
  const alive = useRef(false);
  const request = useRef(0);
  const context = useRef(0);
  const busyRef = useRef(false);
  const contextAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    const mine = ++request.current;
    setLoading(true);
    try {
      const next = await getTournamentDealReview(
        tournamentId,
        actorId,
        contextAbort.current?.signal
      );
      if (!alive.current || mine !== request.current) return;
      setReview(next);
      setError(null);
    } catch (failure) {
      if (!alive.current || mine !== request.current) return;
      reportError(failure, 'TournamentDealReview.proposal');
      setReview(null);
      setError(
        failure instanceof Error ? failure.message : 'Could Not Load This Review. Please Retry.'
      );
    } finally {
      if (alive.current && mine === request.current) setLoading(false);
    }
  }, [tournamentId, actorId]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    contextAbort.current = controller;
    ++context.current;
    busyRef.current = false;
    setBusy(null);
    setError(null);
    setReview(null);
    setNotice(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      alive.current = false;
      controller.abort();
      ++context.current;
      ++request.current;
      clearInterval(timer);
    };
  }, [refresh]);

  const current =
    review?.tournamentId === tournamentId && review.actorId === actorId ? review : null;
  const proposal = current?.state === 'reviewing' ? current.proposal : null;
  const perform = async (action: Action) => {
    if (!current || loading || busyRef.current) return;
    if (action === 'vote' && (!proposal || proposal.voterIds.includes(actorId))) return;
    if (action === 'request' && ['requested', 'reviewing'].includes(current.state)) return;
    if (action === 'cancel' && !['requested', 'reviewing'].includes(current.state)) return;
    const actionContext = context.current;
    busyRef.current = true;
    setBusy(action);
    ++request.current;
    setNotice(null);
    try {
      if (action === 'request')
        await requestTournamentDealReview(tournamentId, actorId, contextAbort.current?.signal);
      else if (action === 'cancel')
        await cancelTournamentDealReview(current, contextAbort.current?.signal);
      else await castTournamentDealVote(proposal!, contextAbort.current?.signal);
      if (!alive.current || actionContext !== context.current) return;
      setNotice({
        proposalId: action === 'vote' ? proposal!.proposalId : null,
        text:
          action === 'vote'
            ? 'Your Vote Was Recorded For The Reviewed Split.'
            : action === 'request'
              ? 'Your Review Request Was Recorded.'
              : 'The Review Status Was Confirmed.',
      });
    } catch (failure) {
      if (!alive.current || actionContext !== context.current) return;
      reportError(failure, 'TournamentDealReview.' + action);
      setNotice({
        proposalId: action === 'vote' ? proposal!.proposalId : null,
        text:
          failure instanceof Error
            ? failure.message
            : 'Could Not Confirm This Action. Checking The Current Review.',
      });
    } finally {
      if (alive.current && actionContext === context.current) {
        busyRef.current = false;
        setBusy(null);
        // Unknown responses only trigger a read. Neither requests nor votes are automatically repeated.
        void refresh();
      }
    }
  };

  const names = new Map(players.map((player) => [player.user_id, player.username]));
  return (
    <section className="tl-panel dov-deal deal-review" aria-label="Review Final Table Deal">
      <div className="dov-deal__head">
        <h3 className="dov-deal__label">Final Table Deal</h3>
        {proposal && (
          <span>
            {proposal.voterIds.length}/{proposal.shares.length} Votes For This Split
          </span>
        )}
      </div>
      {loading && <p role="status">Checking The Current Review...</p>}
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p role="status">
          {notice.proposalId && proposal && proposal.proposalId !== notice.proposalId
            ? 'The Split Changed. Review The Latest Split Before Voting Again.'
            : notice.text}
        </p>
      )}
      {current && (
        <>
          <p role="status">{statusText[current.state]}</p>
          {['requested', 'reviewing'].includes(current.state) && current.expiresAt && (
            <p>
              {current.state === 'reviewing' ? 'Review Ends At: ' : 'Request Expires At: '}
              <time dateTime={current.expiresAt}>
                {new Date(current.expiresAt).toLocaleString()}
              </time>
            </p>
          )}
          {['none', 'completed', 'cancelled', 'expired'].includes(current.state) && (
            <button
              type="button"
              className="dov-deal__btn"
              disabled={loading || busy !== null}
              onClick={() => void perform('request')}
            >
              {busy === 'request' ? 'Requesting Review...' : 'Request Deal Review'}
            </button>
          )}
        </>
      )}
      {proposal && (
        <>
          <p>Review Every Player's Proposed Payment Before Agreeing.</p>
          <dl className="deal-review__totals">
            <div>
              <dt>Finalized Prize Pool</dt>
              <dd>{formatDealCents(proposal.poolCents)}</dd>
            </div>
            <div>
              <dt>Remaining Deal Pool</dt>
              <dd>{formatDealCents(proposal.dealCents)}</dd>
            </div>
          </dl>
          <table className="deal-review__shares">
            <caption>Proposed Split</caption>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Payment</th>
              </tr>
            </thead>
            <tbody>
              {proposal.shares.map((share) => (
                <tr key={share.userId}>
                  <th scope="row">
                    {names.get(share.userId) || share.userId}
                    {share.userId === actorId ? ' (You)' : ''}
                    <small>Stack: {share.chips}</small>
                  </th>
                  <td>{formatDealCents(share.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {proposal.voterIds.includes(actorId) ? (
            <p>Your Vote Is Recorded For This Split.</p>
          ) : (
            <button
              type="button"
              className="dov-deal__btn"
              disabled={loading || busy !== null}
              onClick={() => void perform('vote')}
            >
              {busy === 'vote' ? 'Recording Your Vote...' : 'Agree To This Split'}
            </button>
          )}
        </>
      )}
      {current && ['requested', 'reviewing'].includes(current.state) && (
        <button
          type="button"
          className="dov-deal__btn"
          disabled={loading || busy !== null}
          onClick={() => void perform('cancel')}
        >
          {busy === 'cancel' ? 'Cancelling Review...' : 'Cancel Deal Review'}
        </button>
      )}
      {!current && !loading && (
        <button type="button" className="dov-deal__btn" onClick={() => void refresh()}>
          Retry Deal Review
        </button>
      )}
    </section>
  );
}
