import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import './FriendActivityFeed.css';

interface FeedFriend {
  user_id: string;
  username: string;
  avatar_url?: string;
}

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

export default function FriendActivityFeed({ friends }: { friends: FeedFriend[] }) {
  const { user } = useAuthUser();
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const achievementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const friendMap = useRef(new Map<string, { username: string; avatar_url?: string }>());

  useEffect(() => {
    const map = new Map<string, { username: string; avatar_url?: string }>();
    for (const friend of friends) {
      if (friend.user_id) {
        map.set(friend.user_id, { username: friend.username, avatar_url: friend.avatar_url });
      }
    }
    friendMap.current = map;
  }, [friends]);

  useEffect(() => {
    return () => {
      if (achievementTimerRef.current) clearTimeout(achievementTimerRef.current);
    };
  }, []);

  const loadRealActivities = useCallback(async () => {
    if (!user?.id || friends.length === 0) {
      if (isMounted.current) {
        setActivities([]);
        setLoading(false);
        setError(null);
      }
      return;
    }

    const friendIds = friends.map((friend) => friend.user_id).filter(Boolean);
    if (friendIds.length === 0) return;

    setLoading(true);
    setError(null);
    try {
      const [achievementResult, challengeResult] = await Promise.all([
        supabase
          .from('training_user_achievements')
          .select('id, user_id, achievement_id, unlocked_at')
          .in('user_id', friendIds)
          .not('unlocked_at', 'is', null)
          .order('unlocked_at', { ascending: false })
          .limit(10),
        supabase
          .from('user_daily_challenges')
          .select('id, user_id, challenge_id, completed, assigned_date')
          .in('user_id', friendIds)
          .eq('completed', true)
          .order('assigned_date', { ascending: false })
          .limit(10),
      ]);
      if (achievementResult.error) throw achievementResult.error;
      if (challengeResult.error) throw challengeResult.error;

      const feed: ActivityItem[] = [];
      for (const achievement of achievementResult.data || []) {
        const friend = friendMap.current.get(achievement.user_id);
        if (!friend) continue;
        feed.push({
          id: `ach-${achievement.id}`,
          userId: achievement.user_id,
          username: friend.username || 'Player',
          avatar: friend.avatar_url,
          action: 'unlocked',
          target: achievement.achievement_id
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter: string) => letter.toUpperCase()),
          timestamp: new Date(achievement.unlocked_at),
          icon: '◆',
        });
      }

      for (const challenge of challengeResult.data || []) {
        const friend = friendMap.current.get(challenge.user_id);
        if (!friend) continue;
        feed.push({
          id: `chal-${challenge.id}`,
          userId: challenge.user_id,
          username: friend.username || 'Player',
          avatar: friend.avatar_url,
          action: 'completed mission',
          target: challenge.challenge_id
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter: string) => letter.toUpperCase()),
          timestamp: new Date(challenge.assigned_date),
          icon: '◎',
        });
      }

      feed.sort((first, second) => second.timestamp.getTime() - first.timestamp.getTime());
      if (isMounted.current) setActivities(feed.slice(0, 30));
    } catch (loadError) {
      reportError(loadError, 'FriendActivityFeed.load_error');
      if (isMounted.current) setError('Live friend activity could not be reached.');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [friends, user?.id, isMounted]);

  useEffect(() => {
    loadRealActivities();
  }, [loadRealActivities]);

  useMasterBusSubscription('HAND_COMPLETED', (payload: any) => {
    if (!isMounted.current || !payload?.winnerId || !friendMap.current.has(payload.winnerId))
      return;
    const friend = friendMap.current.get(payload.winnerId)!;
    setActivities((previous) =>
      [
        {
          id: `live-${Date.now()}`,
          userId: payload.winnerId,
          username: friend.username,
          avatar: friend.avatar_url,
          action: 'won a massive pot',
          timestamp: new Date(),
          icon: '◆',
        },
        ...previous,
      ].slice(0, 20)
    );
  });

  useMasterBusSubscription('FRIEND_REQUEST_ACCEPTED', (payload: any) => {
    if (!isMounted.current || (!payload?.friendId && !payload?.username)) return;
    setActivities((previous) =>
      [
        {
          id: `live-${Date.now()}`,
          userId: payload.friendId || '',
          username: payload.username || 'A player',
          avatar: payload.avatarUrl,
          action: 'became friends with you',
          timestamp: new Date(),
          icon: '◈',
        },
        ...previous,
      ].slice(0, 20)
    );
  });

  useMasterBusSubscription('ACHIEVEMENT_UNLOCKED', () => {
    if (!isMounted.current) return;
    if (achievementTimerRef.current) clearTimeout(achievementTimerRef.current);
    achievementTimerRef.current = setTimeout(() => {
      if (isMounted.current) loadRealActivities();
    }, 1500);
  });

  if (loading) {
    return (
      <section className="friend-activity-feed" aria-labelledby="friend-activity-title">
        <ActivityHeader />
        <div className="activity-skeleton-list" role="status" aria-label="Loading Friend Activity">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="activity-skeleton" key={index}>
              <span />
              <div>
                <i />
                <i />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="friend-activity-feed" aria-labelledby="friend-activity-title">
        <ActivityHeader />
        <div className="activity-state is-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={loadRealActivities}>
            Retry Activity
          </button>
        </div>
      </section>
    );
  }

  if (activities.length === 0) {
    return (
      <section className="friend-activity-feed" aria-labelledby="friend-activity-title">
        <ActivityHeader />
        <div className="activity-state">
          <span aria-hidden="true">⌁</span>
          <p>No Recent Friend Activity. New Hands, Achievements, And Missions Will Appear Live.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="friend-activity-feed" aria-labelledby="friend-activity-title">
      <ActivityHeader />
      <div className="activity-list">
        {activities.map((item) => (
          <article className="activity-item" key={item.id}>
            <Link
              className="activity-avatar"
              to={`/profile/${item.userId}`}
              aria-label={`Open ${item.username}'S Profile`}
            >
              {item.avatar ? (
                <img loading="lazy" decoding="async" src={item.avatar} alt="" />
              ) : (
                <span>{item.username[0]?.toUpperCase()}</span>
              )}
              <i aria-hidden="true">{item.icon}</i>
            </Link>
            <div className="activity-content">
              <p>
                <Link to={`/profile/${item.userId}`}>{item.username}</Link> {item.action}{' '}
                {item.target && <strong>{item.target}</strong>}
              </p>
              <time dateTime={item.timestamp.toISOString()}>{formatTimeAgo(item.timestamp)}</time>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ActivityHeader() {
  return (
    <div className="activity-header">
      <div>
        <span>Verified Events</span>
        <h3 id="friend-activity-title">Friend Activity</h3>
      </div>
      <strong>
        <i /> Live
      </strong>
    </div>
  );
}

function formatTimeAgo(date: Date) {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
