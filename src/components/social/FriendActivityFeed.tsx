/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FRIEND ACTIVITY FEED — Real-time friend activity from Supabase
 * ═══════════════════════════════════════════════════════════════════════════════
 * Fetches recent friend activities from Supabase (achievements, challenges,
 * wheel spins) and augments with real-time bus events.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './FriendActivityFeed.css';

interface ActivityItem {
  id: string;
  userId: string;
  username: string;
  avatar?: string;
  action: string;
  target?: string;
  timestamp: Date;
  icon: string;
}

export default function FriendActivityFeed({ friends }: { friends: any[] }) {
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useRef(true);

  // Build a lookup map for friend data
  const friendMap = useRef(new Map<string, { username: string; avatar_url?: string }>());

  useEffect(() => {
    const map = new Map<string, { username: string; avatar_url?: string }>();
    for (const f of friends) {
      if (f.user_id) map.set(f.user_id, { username: f.username, avatar_url: f.avatar_url });
    }
    friendMap.current = map;
  }, [friends]);

  const loadRealActivities = useCallback(async () => {
    if (friends.length === 0) {
      if (isMounted.current) setLoading(false);
      return;
    }

    const friendIds = friends.map((f) => f.user_id).filter(Boolean);
    if (friendIds.length === 0) {
      if (isMounted.current) setLoading(false);
      return;
    }

    try {
      const feed: ActivityItem[] = [];

      // Fetch friends' recent achievements
      const { data: achievements } = await supabase
        .from('user_achievements')
        .select('id, user_id, achievement_id, unlocked_at')
        .in('user_id', friendIds)
        .not('unlocked_at', 'is', null)
        .order('unlocked_at', { ascending: false })
        .limit(10);

      if (achievements) {
        for (const a of achievements) {
          const friend = friendMap.current.get(a.user_id);
          if (friend) {
            feed.push({
              id: `ach-${a.id}`,
              userId: a.user_id,
              username: friend.username || 'Player',
              avatar: friend.avatar_url,
              action: 'unlocked',
              target: a.achievement_id
                .replace(/_/g, ' ')
                .replace(/\b\w/g, (c: string) => c.toUpperCase()),
              timestamp: new Date(a.unlocked_at),
              icon: '🏆',
            });
          }
        }
      }

      // Fetch friends' recent daily challenge completions
      const { data: challenges } = await supabase
        .from('user_daily_challenges')
        .select('id, user_id, challenge_id, completed, assigned_date')
        .in('user_id', friendIds)
        .eq('completed', true)
        .order('assigned_date', { ascending: false })
        .limit(10);

      if (challenges) {
        for (const c of challenges) {
          const friend = friendMap.current.get(c.user_id);
          if (friend) {
            feed.push({
              id: `chal-${c.id}`,
              userId: c.user_id,
              username: friend.username || 'Player',
              avatar: friend.avatar_url,
              action: 'completed mission',
              target: c.challenge_id
                .replace(/_/g, ' ')
                .replace(/\b\w/g, (ch: string) => ch.toUpperCase()),
              timestamp: new Date(c.assigned_date),
              icon: '🎯',
            });
          }
        }
      }

      // Sort all by timestamp descending, limit to 15
      feed.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      if (isMounted.current) {
        setActivities(feed.slice(0, 15));
        setLoading(false);
      }
    } catch (err) {
      console.error('[FriendActivityFeed] load error:', err);
      if (isMounted.current) setLoading(false);
    }
  }, [friends]);

  useEffect(() => {
    isMounted.current = true;
    loadRealActivities();

    // Real-time bus listeners — augment feed with live events
    const unsubComplete = masterBus.subscribe('HAND_COMPLETED', (payload: any) => {
      if (!isMounted.current) return;
      if (payload?.winnerId && friendMap.current.has(payload.winnerId)) {
        const friend = friendMap.current.get(payload.winnerId)!;
        setActivities((prev) =>
          [
            {
              id: `live-${Date.now()}`,
              userId: payload.winnerId,
              username: friend.username,
              avatar: friend.avatar_url,
              action: 'won a massive pot',
              timestamp: new Date(),
              icon: '💰',
            },
            ...prev,
          ].slice(0, 20)
        );
      }
    });

    const unsubFriend = masterBus.subscribe('FRIEND_REQUEST_ACCEPTED', (payload: any) => {
      if (!isMounted.current) return;
      if (payload?.friendId || payload?.username) {
        setActivities((prev) =>
          [
            {
              id: `live-${Date.now()}`,
              userId: payload.friendId || '',
              username: payload.username || 'A player',
              avatar: payload.avatarUrl,
              action: 'became friends with you',
              timestamp: new Date(),
              icon: '🤝',
            },
            ...prev,
          ].slice(0, 20)
        );
      }
    });

    // Refresh feed when achievements are unlocked
    const unsubAchieve = masterBus.subscribe('ACHIEVEMENT_UNLOCKED', () => {
      if (isMounted.current) setTimeout(loadRealActivities, 1500);
    });

    return () => {
      isMounted.current = false;
      unsubComplete();
      unsubFriend();
      unsubAchieve();
    };
  }, [friends, loadRealActivities]);

  if (loading) {
    return (
      <div className="friend-activity-feed">
        <div className="activity-header">
          <h3>Friend Activity</h3>
          <div className="live-indicator">
            <span className="live-dot"></span> Live
          </div>
        </div>
        <div className="activity-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="activity-item" style={{ opacity: 0.4 }}>
              <div className="activity-avatar">
                <span>⏳</span>
              </div>
              <div className="activity-content">
                <p
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    borderRadius: 4,
                    width: '70%',
                    height: 14,
                  }}
                >
                  &nbsp;
                </p>
                <span
                  className="activity-time"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: 4,
                    width: 40,
                    height: 10,
                    display: 'inline-block',
                  }}
                >
                  &nbsp;
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (activities.length === 0) return null;

  return (
    <div className="friend-activity-feed">
      <div className="activity-header">
        <h3>Friend Activity</h3>
        <div className="live-indicator">
          <span className="live-dot"></span> Live
        </div>
      </div>
      <div className="activity-list">
        {activities.map((item, index) => (
          <div
            key={item.id}
            className="activity-item"
            style={{ animationDelay: `${index * 100}ms` }}
          >
            <div className="activity-avatar">
              {item.avatar ? (
                <img src={item.avatar} alt="" />
              ) : (
                <span>{item.username[0]?.toUpperCase()}</span>
              )}
              <div className="activity-icon-badge">{item.icon}</div>
            </div>
            <div className="activity-content">
              <p>
                <span className="activity-username">{item.username}</span> {item.action}{' '}
                {item.target && <span className="activity-target">{item.target}</span>}
              </p>
              <span className="activity-time">{formatTimeAgo(item.timestamp)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimeAgo(date: Date) {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
