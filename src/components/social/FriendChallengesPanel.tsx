/**
 * FriendChallengesPanel — the receive/track side of friend challenges.
 * Incoming pending → accept/decline; active → live progress race; completed → winner.
 * Complements FriendChallengeModal (the send side).
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { useIsMounted } from '../../hooks/useIsMounted';

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
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  if (d > 0) return `${d}d ${h}h left`;
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

export default function FriendChallengesPanel({ userId }: { userId: string }) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const [rows, setRows] = useState<ChallengeRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const { data } = await supabase
        .from('friend_challenges')
        .select(
          'id, challenger_id, challengee_id, challenge_type, challenger_progress, challengee_progress, status, expires_at, winner_id'
        )
        .or(`challenger_id.eq.${userId},challengee_id.eq.${userId}`)
        .order('created_at', { ascending: false })
        .limit(50);
      const list = (data || []) as ChallengeRow[];
      if (!isMounted.current) return;
      setRows(list);
      const ids = [...new Set(list.flatMap((r) => [r.challenger_id, r.challengee_id]))].filter(
        (id) => id && id !== userId
      );
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, username')
          .in('id', ids);
        if (isMounted.current && profs) {
          const m: Record<string, string> = {};
          for (const p of profs) m[p.id] = p.username || 'Player';
          setNames(m);
        }
      }
    } catch (e) {
      reportError(e, 'FriendChallengesPanel.load');
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
      const { data, error } = await supabase.rpc('fn_respond_friend_challenge', {
        p_challenge_id: id,
        p_accept: accept,
      });
      if (error || !data?.success) throw new Error(data?.error || error?.message || 'Failed');
      toast.success(accept ? 'Challenge accepted!' : 'Challenge declined');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Could not respond');
      reportError(e, 'FriendChallengesPanel.respond');
    } finally {
      if (isMounted.current) setBusyId(null);
    }
  };

  if (loading) {
    return <div style={{ padding: '1.5rem', textAlign: 'center', opacity: 0.6 }}>Loading…</div>;
  }

  const incoming = rows.filter((r) => r.status === 'pending' && r.challengee_id === userId);
  const outgoingPending = rows.filter((r) => r.status === 'pending' && r.challenger_id === userId);
  const active = rows.filter((r) => r.status === 'active');
  const done = rows.filter((r) => r.status === 'completed');

  if (rows.length === 0) {
    return (
      <div style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
        <span
          style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.5rem', opacity: 0.5 }}
        >
          ⚔
        </span>
        <p style={{ fontWeight: 600, margin: '0 0 0.35rem' }}>No Challenges Yet</p>
        <p style={{ color: 'var(--soft-white,#B0B3B8)', fontSize: '0.85rem', margin: 0 }}>
          Challenge A Friend From Their Profile To Start A Race.
        </p>
      </div>
    );
  }

  const meVsThem = (r: ChallengeRow) => {
    const iAmChallenger = r.challenger_id === userId;
    const myProg = iAmChallenger ? r.challenger_progress : r.challengee_progress;
    const theirProg = iAmChallenger ? r.challengee_progress : r.challenger_progress;
    const themId = iAmChallenger ? r.challengee_id : r.challenger_id;
    return { myProg: myProg || 0, theirProg: theirProg || 0, themName: names[themId] || 'Player' };
  };

  const card = (children: React.ReactNode, key: string) => (
    <div
      key={key}
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        padding: '12px 14px',
        marginBottom: '10px',
      }}
    >
      {children}
    </div>
  );

  const header = (r: ChallengeRow) => {
    const meta = TYPE_META[r.challenge_type] || { label: r.challenge_type, icon: '⚔' };
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '1.1rem' }}>{meta.icon}</span>
        <span style={{ fontWeight: 700 }}>{meta.label}</span>
      </div>
    );
  };

  return (
    <div style={{ padding: '4px 2px' }}>
      {incoming.length > 0 && (
        <>
          <h4 style={{ margin: '4px 0 8px', fontSize: '0.85rem', opacity: 0.7 }}>Incoming</h4>
          {incoming.map((r) =>
            card(
              <>
                {header(r)}
                <p style={{ margin: '0 0 10px', fontSize: '0.85rem' }}>
                  <strong>{names[r.challenger_id] || 'A friend'}</strong> Challenged You -{' '}
                  {timeLeft(r.expires_at)}
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => respond(r.id, true)}
                    disabled={busyId === r.id}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '9px',
                      border: 'none',
                      fontWeight: 700,
                      color: '#fff',
                      background: 'linear-gradient(135deg,#31A24C,#248a3d)',
                      cursor: 'pointer',
                    }}
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => respond(r.id, false)}
                    disabled={busyId === r.id}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '9px',
                      border: '1px solid rgba(255,255,255,0.15)',
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.7)',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    Decline
                  </button>
                </div>
              </>,
              r.id
            )
          )}
        </>
      )}

      {active.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 8px', fontSize: '0.85rem', opacity: 0.7 }}>Active</h4>
          {active.map((r) => {
            const { myProg, theirProg, themName } = meVsThem(r);
            const total = Math.max(1, myProg + theirProg);
            return card(
              <>
                {header(r)}
                <div style={{ fontSize: '0.8rem', marginBottom: '6px' }}>
                  Vs <strong>{themName}</strong> · {timeLeft(r.expires_at)}
                </div>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}
                >
                  <span>You: {myProg}</span>
                  <span>
                    {themName}: {theirProg}
                  </span>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: 'rgba(255,255,255,0.08)',
                    overflow: 'hidden',
                    marginTop: 4,
                    display: 'flex',
                  }}
                >
                  <div
                    style={{ width: `${(myProg / total) * 100}%`, background: '#31A24C' }}
                    aria-label="your progress"
                  />
                  <div style={{ width: `${(theirProg / total) * 100}%`, background: '#E4A11B' }} />
                </div>
              </>,
              r.id
            );
          })}
        </>
      )}

      {outgoingPending.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 8px', fontSize: '0.85rem', opacity: 0.7 }}>Sent</h4>
          {outgoingPending.map((r) =>
            card(
              <>
                {header(r)}
                <p style={{ margin: 0, fontSize: '0.85rem', opacity: 0.8 }}>
                  Waiting For <strong>{names[r.challengee_id] || 'friend'}</strong> To Accept ·{' '}
                  {timeLeft(r.expires_at)}
                </p>
              </>,
              r.id
            )
          )}
        </>
      )}

      {done.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 8px', fontSize: '0.85rem', opacity: 0.7 }}>Completed</h4>
          {done.map((r) => {
            const { myProg, theirProg, themName } = meVsThem(r);
            const iWon = r.winner_id === userId;
            const tie = !r.winner_id;
            return card(
              <>
                {header(r)}
                <div style={{ fontSize: '0.85rem' }}>
                  {tie ? (
                    <span>Tie Vs {themName}</span>
                  ) : iWon ? (
                    <span style={{ color: '#31A24C', fontWeight: 700 }}>You Won Vs {themName}</span>
                  ) : (
                    <span style={{ opacity: 0.8 }}>{themName} Won</span>
                  )}
                  <span style={{ opacity: 0.6 }}>
                    {' '}
                    ({myProg}-{theirProg})
                  </span>
                </div>
              </>,
              r.id
            );
          })}
        </>
      )}
    </div>
  );
}
