import { useEffect, useState } from 'react';
import ClubRosterService, { type MemberUplineLevel } from '../../services/ClubRosterService';
import { roleLabel } from '../../types/clubRoles';
import { reportError } from '../../utils/errorReporter';
import MemberAssignAgent from './MemberAssignAgent';
// The record's own sheet: the card is drawn from its info rows.
import '../../pages/MemberManagementPage.css';

/**
 * UPLINE AGENTS ON THE PLAYER RECORD (Dan 2026-10-21)
 *
 * "WHEN YOU CLICK ON ANY PLAYER INSIDE MY CLUB, I SHOULD BE ABLE TO SEE WHO IS
 * UPLINE AGENT(S) ARE."
 *
 * Every agent above the player, closest first, from
 * ca_club_member_upline_chain: the direct agent, the agent above them, and so
 * on to the top of the chain. Each row prints the agent's club role, Arena name
 * and player ID. Rendered only where the record already shows financials; the
 * RPC applies the same access rule again and returns NULL to anyone else.
 */
export function uplineLabel(level: MemberUplineLevel): string {
  const role = level.role ? roleLabel(level.role) : 'Agent';
  return level.depth === 1 ? `Direct Upline (${role})` : `Upline Level ${level.depth} (${role})`;
}

export function uplineValue(level: MemberUplineLevel): string {
  return level.player_number ? `${level.name} (ID: ${level.player_number})` : level.name;
}

export default function MemberUplineCard({
  clubId,
  userId,
  refreshKey = 0,
}: {
  clubId: string;
  userId: string;
  refreshKey?: number;
}) {
  const scope = `${clubId}:${userId}`;
  type Result = {
    scope: string;
    state: 'loading' | 'ready' | 'error' | 'hidden';
    data: MemberUplineLevel[] | null;
  };
  const [result, setResult] = useState<Result>({ scope, state: 'loading', data: null });
  // Bumped after an assignment so the chain re-reads the new upline.
  const [moved, setMoved] = useState(0);
  const current: Result = result.scope === scope ? result : { scope, state: 'loading', data: null };
  const { data, state } = current;

  useEffect(() => {
    const controller = new AbortController();
    setResult((previous) =>
      previous.scope === scope && previous.state === 'ready'
        ? previous
        : { scope, state: 'loading', data: null }
    );
    Promise.resolve()
      .then(() => ClubRosterService.getMemberUplineChain(clubId, userId, controller.signal))
      .then((chain) => {
        if (controller.signal.aborted) return;
        setResult({ scope, data: chain, state: chain ? 'ready' : 'hidden' });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        reportError(error, 'MemberUplineCard.Load');
        setResult((previous) =>
          previous.scope === scope && previous.state === 'ready' && previous.data
            ? previous
            : { scope, data: null, state: 'error' }
        );
      });
    return () => controller.abort();
  }, [clubId, userId, scope, refreshKey, moved]);

  if (state === 'hidden') return null;

  return (
    <section
      className="mm-card mm-provenance mm-upline"
      aria-labelledby="mm-upline-title"
      aria-busy={state === 'loading'}
    >
      <h2 id="mm-upline-title" className="mm-card__title">
        Upline Agents
      </h2>
      {state === 'error' ? (
        <p className="mm-winloss__note" role="status">
          Upline Agents Could Not Be Loaded.
        </p>
      ) : state === 'loading' || !data ? (
        <p className="mm-winloss__note" role="status">
          Loading Upline Agents...
        </p>
      ) : data.length === 0 ? (
        <p className="mm-winloss__note">
          No Agent Assigned. This Player Sits Directly Under The Club Owner.
        </p>
      ) : (
        <>
          {data.map((level) => (
            <div className="mm-info" key={`${level.depth}:${level.user_id}`}>
              <span className="mm-info__label">{uplineLabel(level)}</span>
              <span className="mm-info__value">{uplineValue(level)}</span>
            </div>
          ))}
          <p className="mm-winloss__note">
            {data[0]?.assigned === false
              ? 'No Agent Assigned. This Player Sits Directly Under The Club Owner.'
              : 'Closest Agent First, Up To The Top Agent.'}
          </p>
        </>
      )}
      {state === 'ready' && data && (
        <MemberAssignAgent
          clubId={clubId}
          userId={userId}
          currentAgentId={data[0] && data[0].assigned !== false ? data[0].user_id : null}
          shownUplineId={data[0]?.user_id ?? null}
          underOwner={!data[0] || data[0].role === 'owner'}
          onAssigned={() => setMoved((value) => value + 1)}
        />
      )}
    </section>
  );
}
