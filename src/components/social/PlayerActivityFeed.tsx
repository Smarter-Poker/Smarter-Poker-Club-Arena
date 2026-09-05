/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER ACTIVITY FEED — Timeline of recent gamification events
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './PlayerActivityFeed.css';
import { reportError } from '../../utils/errorReporter';

interface ActivityItem {
  id: string;
  icon: string;
  label: string;
  detail: string;
  time: string;
}

interface PlayerActivityFeedProps {
  userId: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function PlayerActivityFeed({ userId }: PlayerActivityFeedProps) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  const loadActivity = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const feed: ActivityItem[] = [];

      // Fetch recent achievements
      const { data: achievements } = await supabase
        .from('training_user_achievements')
        .select('id, achievement_id, unlocked_at')
        .eq('user_id', userId)
        .not('unlocked_at', 'is', null)
        .order('unlocked_at', { ascending: false })
        .limit(5);

      if (achievements) {
        for (const a of achievements) {
          feed.push({
            id: `ach-${a.id}`,
            icon: '★',
            label: 'Achievement Unlocked',
            detail: a.achievement_id
              .replace(/_/g, ' ')
              .replace(/\b\w/g, (c: string) => c.toUpperCase()),
            time: a.unlocked_at,
          });
        }
      }

      // Fetch recent daily challenge claims
      const { data: challenges } = await supabase
        .from('user_daily_challenges')
        .select('id, challenge_id, claimed, assigned_date')
        .eq('user_id', userId)
        .eq('claimed', true)
        .order('assigned_date', { ascending: false })
        .limit(5);

      if (challenges) {
        for (const c of challenges) {
          feed.push({
            id: `chal-${c.id}`,
            icon: '◎',
            label: 'Mission Completed',
            detail: c.challenge_id
              .replace(/_/g, ' ')
              .replace(/\b\w/g, (ch: string) => ch.toUpperCase()),
            time: c.assigned_date,
          });
        }
      }

      // Fetch recent wheel spins
      const { data: spins } = await supabase
        .from('user_lucky_wheel_spins')
        .select('user_id, total_spins, last_spin_date')
        .eq('user_id', userId)
        .limit(1);

      if (spins && spins.length > 0 && spins[0].last_spin_date) {
        feed.push({
          id: `spin-${spins[0].user_id}`,
          icon: '▦',
          label: 'Lucky Wheel Spin',
          detail: `${spins[0].total_spins} total spins`,
          time: spins[0].last_spin_date,
        });
      }

      // Fetch recent daily reward claims
      const { data: rewards } = await supabase
        .from('user_daily_rewards')
        .select('id, last_claim_date, current_streak')
        .eq('user_id', userId)
        .limit(1);

      if (rewards && rewards.length > 0 && rewards[0].last_claim_date) {
        feed.push({
          id: `reward-${rewards[0].id}`,
          icon: '▲',
          label: 'Daily Login Reward',
          detail: `${rewards[0].current_streak}-day streak`,
          time: rewards[0].last_claim_date,
        });
      }

      // Sort all by time descending
      feed.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

      if (isMounted.current) setItems(feed.slice(0, 10));
    } catch (err) {
      reportError(err, 'PlayerActivityFeed.load_error');
    }
    if (isMounted.current) setLoading(false);
  }, [userId]);

  // Load on mount and when userId changes
  useEffect(() => {
    if (!userId) return;
    loadActivity();
  }, [userId, loadActivity]);

  // Auto-refresh when gamification events fire
  const debouncedRefresh = useCallback(() => {
    const timer = setTimeout(() => loadActivity(), 1500);
    return () => clearTimeout(timer);
  }, [loadActivity]);

  useMasterBusSubscription('MISSION_CLAIMED', debouncedRefresh);
  useMasterBusSubscription('DAILY_REWARD_CLAIMED', debouncedRefresh);
  /* WHEEL_SPIN_RESULT removed 2026-09-05: its only emitter was the
     unmounted LuckyDrawWheel, so this handler could never run. */

  if (loading) {
    return (
      <div className="paf-container">
        <h3 className="paf-title">Recent Activity</h3>
        <div className="paf-skeleton" />
        <div className="paf-skeleton" />
        <div className="paf-skeleton" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="paf-container">
        <h3 className="paf-title">Recent Activity</h3>
        <p className="paf-empty">No Recent Activity Yet. Start Playing!</p>
      </div>
    );
  }

  return (
    <div className="paf-container">
      <h3 className="paf-title">Recent Activity</h3>
      <div className="paf-list">
        {items.map((item, i) => (
          <div key={item.id} className="paf-item" style={{ animationDelay: `${i * 60}ms` }}>
            <span className="paf-icon">{item.icon}</span>
            <div className="paf-content">
              <span className="paf-label">{item.label}</span>
              <span className="paf-detail">{item.detail}</span>
            </div>
            <span className="paf-time">{relativeTime(item.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
