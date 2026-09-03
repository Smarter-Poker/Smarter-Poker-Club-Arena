import { useState, useEffect, useRef, useCallback } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import './GamificationLeaderboard.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

interface LeaderboardEntry {
  id: string;
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  score: number;
}

export default function GamificationLeaderboard() {
  const [activeTab, setActiveTab] = useState<'wheel' | 'missions'>('wheel');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hook calls at top level
  useMasterBusSubscription('WHEEL_SPIN_RESULT', () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      fetchLeaderboard();
    }, 1500);
  });

  useMasterBusSubscription('MISSION_CLAIMED', () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      fetchLeaderboard();
    }, 1500);
  });

  const fetchLeaderboard = useCallback(async () => {
    try {
      if (activeTab === 'wheel') {
        // Fetch top wheel spinners
        const { data, error } = await supabase
          .from('user_lucky_wheel_spins')
          .select(
            `
            user_id,
            total_spins,
            profiles(
              username,
              avatar_url:arena_avatar_url
            )
          `
          )
          .order('total_spins', { ascending: false })
          .limit(10);

        if (error) throw error;

        setEntries(
          data.map((row: any, index: number) => ({
            id: `wheel-${row.user_id}`,
            rank: index + 1,
            userId: row.user_id,
            username: row.profiles?.username || 'Unknown Player',
            avatarUrl: row.profiles?.avatar_url || null,
            score: row.total_spins || 0,
          }))
        );
      } else {
        // Fetch top mission completers
        const { data, error } = await supabase.rpc('get_top_mission_completers');

        if (error) throw error;

        setEntries(
          data.map((row: any, index: number) => ({
            id: `mission-${row.user_id}`,
            rank: index + 1,
            userId: row.user_id,
            username: row.username || 'Unknown Player',
            avatarUrl: row.avatar_url || null,
            score: row.completed_count || 0,
          }))
        );
      }
    } catch (err) {
      reportError(err, 'GamificationLeaderboard.Failed_to_fetch');
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    setLoading(true);
    fetchLeaderboard();

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [activeTab, fetchLeaderboard]);

  return (
    <div className="gl-container">
      <div className="gl-header">
        <h3 className="gl-title">Top Performers</h3>
        <div className="gl-tabs">
          <button
            className={`gl-tab ${activeTab === 'wheel' ? 'active' : ''}`}
            onClick={() => setActiveTab('wheel')}
          >
            Lucky Wheel
          </button>
          <button
            className={`gl-tab ${activeTab === 'missions' ? 'active' : ''}`}
            onClick={() => setActiveTab('missions')}
          >
            Missions
          </button>
        </div>
      </div>

      <div className="gl-list">
        {loading ? (
          <div className="gl-loading">Loading Rankings...</div>
        ) : entries.length === 0 ? (
          <div className="gl-empty">No Data Available Yet.</div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="gl-item">
              <div className="gl-rank">
                {entry.rank === 1
                  ? '★'
                  : entry.rank === 2
                    ? '☆'
                    : entry.rank === 3
                      ? '☆'
                      : `#${entry.rank}`}
              </div>
              <img
                loading="lazy"
                decoding="async"
                src={entry.avatarUrl || generateDefaultAvatar()}
                alt={entry.username}
                className="gl-avatar"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = generateDefaultAvatar();
                }}
              />
              <div className="gl-info">
                <span className="gl-username">{entry.username}</span>
              </div>
              <div className="gl-score">
                <span className="gl-score-val">{entry.score.toLocaleString()}</span>
                <span className="gl-score-label">
                  {activeTab === 'wheel' ? 'Spins' : 'Missions'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
