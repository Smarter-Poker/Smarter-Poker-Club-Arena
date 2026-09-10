import { useCallback, useEffect, useRef, useState } from 'react';
import {
  castTournamentDealVote,
  formatDealCents,
  getTournamentDealProposal,
  type TournamentDealProposal,
} from '../../services/TournamentDealService';
import { reportError } from '../../utils/errorReporter';
import './TournamentDealReview.css';

interface Props {
  tournamentId: string;
  actorId: string;
  players: Array<{ user_id: string; username?: string | null }>;
}

export default function TournamentDealReview({ tournamentId, actorId, players }: Props) {
  const [proposal, setProposal] = useState<TournamentDealProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ proposalId: string; text: string } | null>(null);
  const alive = useRef(false);
  const request = useRef(0);
  const context = useRef(0);
  const votingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (votingRef.current) return;
    const mine = ++request.current;
    setLoading(true);
    try {
      const next = await getTournamentDealProposal(tournamentId, actorId);
      if (!alive.current || mine !== request.current) return;
      setProposal(next);
      setError(null);
    } catch (failure) {
      if (!alive.current || mine !== request.current) return;
      reportError(failure, 'TournamentDealReview.proposal');
      setProposal(null);
      setError(
        failure instanceof Error ? failure.message : 'Could Not Load This Split. Please Retry.'
      );
    } finally {
      if (alive.current && mine === request.current) setLoading(false);
    }
  }, [tournamentId, actorId]);

  useEffect(() => {
    alive.current = true;
    ++context.current;
    votingRef.current = false;
    setVoting(false);
    setError(null);
    setProposal(null);
    setNotice(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      alive.current = false;
      ++context.current;
      ++request.current;
      clearInterval(timer);
    };
  }, [refresh]);

  const vote = async () => {
    if (!proposal || loading || votingRef.current || proposal.voterIds.includes(actorId)) return;
    const voteContext = context.current;
    votingRef.current = true;
    setVoting(true);
    ++request.current;
    setNotice(null);
    try {
      await castTournamentDealVote(proposal);
      if (!alive.current || voteContext !== context.current) return;
      setNotice({
        proposalId: proposal.proposalId,
        text: 'Your Vote Was Recorded For The Reviewed Split.',
      });
    } catch (failure) {
      if (!alive.current || voteContext !== context.current) return;
      reportError(failure, 'TournamentDealReview.vote');
      setNotice({
        proposalId: proposal.proposalId,
        text:
          failure instanceof Error
            ? failure.message
            : 'Could Not Confirm Your Vote. Review The Latest Split.',
      });
    } finally {
      if (alive.current && voteContext === context.current) {
        votingRef.current = false;
        setVoting(false);
        // This only reads the latest proposal. A replacement always needs a new click.
        void refresh();
      }
    }
  };

  const current =
    proposal?.tournamentId === tournamentId && proposal.actorId === actorId ? proposal : null;
  const names = new Map(players.map((player) => [player.user_id, player.username]));
  return (
    <section className="tl-panel dov-deal deal-review" aria-label="Review Final Table Deal">
      <div className="dov-deal__head">
        <h3 className="dov-deal__label">Final Table Deal</h3>
        {current && (
          <span>
            {current.voterIds.length}/{current.shares.length} Votes For This Split
          </span>
        )}
      </div>
      {loading && <p role="status">Checking The Current Split...</p>}
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p role="status">
          {current && current.proposalId !== notice.proposalId
            ? 'The Split Changed. Review The Latest Split Before Voting Again.'
            : notice.text}
        </p>
      )}
      {current && (
        <>
          <p>Review Every Player's Proposed Payment Before Agreeing.</p>
          <dl className="deal-review__totals">
            <div>
              <dt>Finalized Prize Pool</dt>
              <dd>{formatDealCents(current.poolCents)}</dd>
            </div>
            <div>
              <dt>Remaining Deal Pool</dt>
              <dd>{formatDealCents(current.dealCents)}</dd>
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
              {current.shares.map((share) => (
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
          {current.voterIds.includes(actorId) ? (
            <p>Your Vote Is Recorded For This Split.</p>
          ) : (
            <button
              type="button"
              className="dov-deal__btn"
              disabled={loading || voting}
              onClick={() => void vote()}
            >
              {voting ? 'Recording Your Vote...' : 'Agree To This Split'}
            </button>
          )}
        </>
      )}
      {!current && !loading && (
        <button type="button" className="dov-deal__btn" onClick={() => void refresh()}>
          Retry Deal Review
        </button>
      )}
    </section>
  );
}
