import { useCallback, useEffect, useState } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { useToast } from '../common/Toast';
import './FriendChallengesPanel.css';

const TYPE_META: Record<string, { label: string; icon: string }> = {
  streak_battle: { label: 'Streak Battle', icon: '▲' },
  mission_race: { label: 'Mission Race', icon: '◎' },
  spin_master: { label: 'Spin Master', icon: '▦' },
  hand_grinder: { label: 'Hand Grinder', icon: '♠' },
};

interface ChallengeRow {
  id: string;
  challenger_id: string;
  challengee_id: string;
  challenge_type: string;
  challenger_progress: number;
  challengee_progress: number;
  status: string;
  expires_at: string;
  winner_id: string | null;
}

function timeLeft(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h left`;
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

function ChallengeHeader({ row }: { row: ChallengeRow }) {
  const meta = TYPE_META[row.challenge_type] || { label: row.challenge_type, icon: '◇' };
  return (
    <div className="challenge-card-heading">
      <span aria-hidden="true">{meta.icon}</span>
      <strong>{meta.label}</strong>
      <small>{row.status}</small>
    </div>
  );
}

export default function FriendChallengesPanel({ userId }: { userId: string }) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const [rows, setRows] = useState<ChallengeRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: challengeError } = await supabase
        .from('friend_challenges')
        .select(
          'id, challenger_id, challengee_id, challenge_type, challenger_progress, challengee_progress, status, expires_at, winner_id'
        )
        .or(`challenger_id.eq.${userId},challengee_id.eq.${userId}`)
        .order('created_at', { ascending: false })
        .limit(50);
      if (challengeError) throw challengeError;

      const list = (data || []) as ChallengeRow[];
      if (!isMounted.current) return;
      setRows(list);
      const playerIds = [
        ...new Set(list.flatMap((row) => [row.challenger_id, row.challengee_id])),
      ].filter((id) => id && id !== userId);

      if (playerIds.length > 0) {
        const { data: profiles, error: profileError } = await supabase
          .from('profiles')
          .select('id, username')
          .in('id', playerIds);
        if (profileError) {
          reportError(profileError, 'FriendChallengesPanel.profile_lookup');
        } else if (isMounted.current) {
          const nextNames: Record<string, string> = {};
          for (const profile of profiles || [])
            nextNames[profile.id] = profile.username || 'Player';
          setNames(nextNames);
        }
      }
    } catch (loadError) {
      reportError(loadError, 'FriendChallengesPanel.load');
      if (isMounted.current) setError('Challenge records could not be reached.');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [userId, isMounted]);

  useEffect(() => {
    load();
  }, [load]);

  const respond = async (id: string, accept: boolean) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const { data, error: responseError } = await supabase.rpc('fn_respond_friend_challenge', {
        p_challenge_id: id,
        p_accept: accept,
      });
      if (responseError || !data?.success) {
        throw new Error(data?.error || responseError?.message || 'Challenge response failed');
      }
      toast.success(accept ? 'Challenge accepted!' : 'Challenge declined');
      await load();
    } catch (responseError) {
      const message = responseError instanceof Error ? responseError.message : 'Could not respond';
      toast.error(message);
      reportError(responseError, 'FriendChallengesPanel.respond');
    } finally {
      if (isMounted.current) setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="challenge-panel-state" role="status">
        <span className="challenge-panel-loader" />
        <p>Syncing Challenge Ledger…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="challenge-panel-state is-error" role="alert">
        <span aria-hidden="true">!</span>
        <h3>Challenge Link Interrupted</h3>
        <p>{error}</p>
        <button type="button" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="challenge-panel-state">
        <span aria-hidden="true">◇</span>
        <h3>No Challenges Yet</h3>
        <p>Choose Challenge Beside A Friend To Start A Streak, Mission, Spin, Or Hand Race.</p>
      </div>
    );
  }

  const incoming = rows.filter((row) => row.status === 'pending' && row.challengee_id === userId);
  const outgoing = rows.filter((row) => row.status === 'pending' && row.challenger_id === userId);
  const active = rows.filter((row) => row.status === 'active');
  const history = rows.filter((row) => row.status !== 'pending' && row.status !== 'active');

  const versus = (row: ChallengeRow) => {
    const iAmChallenger = row.challenger_id === userId;
    const myProgress = iAmChallenger ? row.challenger_progress : row.challengee_progress;
    const theirProgress = iAmChallenger ? row.challengee_progress : row.challenger_progress;
    const opponentId = iAmChallenger ? row.challengee_id : row.challenger_id;
    return {
      myProgress: myProgress || 0,
      theirProgress: theirProgress || 0,
      opponentName: names[opponentId] || 'Player',
    };
  };

  return (
    <div className="challenge-panel">
      {incoming.length > 0 && (
        <section className="challenge-section" aria-labelledby="challenge-incoming">
          <h3 id="challenge-incoming">
            Incoming <span>{incoming.length}</span>
          </h3>
          <div className="challenge-card-list">
            {incoming.map((row) => (
              <article className="challenge-card is-incoming" key={row.id}>
                <ChallengeHeader row={row} />
                <p>
                  <strong>{names[row.challenger_id] || 'A Friend'}</strong> Challenged You ·{' '}
                  {timeLeft(row.expires_at)}
                </p>
                <div className="challenge-actions">
                  <button
                    className="is-accept"
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => respond(row.id, true)}
                  >
                    {busyId === row.id ? 'Working…' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => respond(row.id, false)}
                  >
                    Decline
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section className="challenge-section" aria-labelledby="challenge-active">
          <h3 id="challenge-active">
            Active <span>{active.length}</span>
          </h3>
          <div className="challenge-card-list">
            {active.map((row) => {
              const { myProgress, theirProgress, opponentName } = versus(row);
              const scale = Math.max(1, myProgress, theirProgress);
              return (
                <article className="challenge-card is-active" key={row.id}>
                  <ChallengeHeader row={row} />
                  <p>
                    Versus <strong>{opponentName}</strong> · {timeLeft(row.expires_at)}
                  </p>
                  <div className="challenge-progress">
                    <label>
                      You <span>{myProgress}</span>
                      <progress max={scale} value={myProgress} />
                    </label>
                    <label>
                      {opponentName} <span>{theirProgress}</span>
                      <progress max={scale} value={theirProgress} />
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {outgoing.length > 0 && (
        <section className="challenge-section" aria-labelledby="challenge-sent">
          <h3 id="challenge-sent">
            Sent <span>{outgoing.length}</span>
          </h3>
          <div className="challenge-card-list">
            {outgoing.map((row) => (
              <article className="challenge-card" key={row.id}>
                <ChallengeHeader row={row} />
                <p>
                  Waiting For <strong>{names[row.challengee_id] || 'Your Friend'}</strong> ·{' '}
                  {timeLeft(row.expires_at)}
                </p>
              </article>
            ))}
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="challenge-section" aria-labelledby="challenge-history">
          <h3 id="challenge-history">
            History <span>{history.length}</span>
          </h3>
          <div className="challenge-card-list">
            {history.map((row) => {
              const { myProgress, theirProgress, opponentName } = versus(row);
              const result =
                row.status !== 'completed'
                  ? row.status
                  : !row.winner_id
                    ? `Tie with ${opponentName}`
                    : row.winner_id === userId
                      ? `You won against ${opponentName}`
                      : `${opponentName} won`;
              return (
                <article className="challenge-card is-history" key={row.id}>
                  <ChallengeHeader row={row} />
                  <p>
                    <strong>{result}</strong> · {myProgress}-{theirProgress}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
