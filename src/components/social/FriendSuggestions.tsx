/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FRIEND SUGGESTIONS — "People You May Know" Widget
 * ═══════════════════════════════════════════════════════════════════════════════
 * Horizontal scroll of suggestion cards with shared context
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useNavigate } from 'react-router-dom';
import {
  friendSuggestionService,
  type FriendSuggestion,
} from '../../services/FriendSuggestionService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import styles from './FriendSuggestions.module.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

export default function FriendSuggestions() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [suggestions, setSuggestions] = useState<FriendSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [sendingRequest, setSendingRequest] = useState<string | null>(null);

  const isMounted = useIsMounted();

  useEffect(() => {
    if (!user?.id) return;
    friendSuggestionService
      .getSuggestions(user.id, 12)
      .then((s) => {
        if (isMounted.current) setSuggestions(s);
      })
      .catch((e) => console.warn('[FriendSuggestions] Failed to load suggestions:', e))
      .finally(() => {
        if (isMounted.current) setLoading(false);
      });
  }, [user?.id, isMounted]);

  // Auto-dismiss when friend request sent/accepted elsewhere
  useMasterBusSubscription('FRIEND_REQUEST_SENT', (payload: any) => {
    if (isMounted.current) {
      setDismissed((prev) => new Set(prev).add(payload?.toUserId));
    }
  });

  useMasterBusSubscription('FRIEND_REQUEST_ACCEPTED', () => {
    // Refresh suggestions after an acceptance (friend list changed)
    if (isMounted.current && user?.id) {
      friendSuggestionService
        .getSuggestions(user.id, 12)
        .then((s) => {
          if (isMounted.current) setSuggestions(s);
        })
        .catch((e) => console.warn('[FriendSuggestions] Refresh after accept failed:', e));
    }
  });

  useMasterBusSubscription('PROFILE_UPDATED', () => {
    // Refresh suggestions when profiles change — scores may shift
    if (isMounted.current && user?.id) {
      friendSuggestionService
        .getSuggestions(user.id, 12)
        .then((s) => {
          if (isMounted.current) setSuggestions(s);
        })
        .catch((e) => console.warn('[FriendSuggestions] Refresh after profile update failed:', e));
    }
  });

  const handleAddFriend = async (userId: string) => {
    if (!user?.id) return;
    setSendingRequest(userId);
    try {
      const { error } = await supabase.from('friendships').insert({
        user_id: user.id,
        friend_id: userId,
        status: 'pending',
      });
      if (error) throw error;
      if (!isMounted.current) return;
      toast.success('Friend request sent!');
      setDismissed((prev) => new Set(prev).add(userId));
      // Emit bus event so other components react too
      masterBus.emit('FRIEND_REQUEST_SENT', { fromUserId: user.id, toUserId: userId });
    } catch (err) {
      reportError(err, 'FriendSuggestions.Error');
      if (isMounted.current) toast.error('Failed to send request');
    }
    if (isMounted.current) setSendingRequest(null);
  };

  const handleDismiss = (userId: string) => {
    setDismissed((prev) => new Set(prev).add(userId));
  };

  const visible = suggestions.filter((s) => !dismissed.has(s.userId));

  if (loading || visible.length === 0) return null;

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>People You May Know</h3>
      <div className={styles.scrollContainer}>
        {visible.map((suggestion) => (
          <div key={suggestion.userId} className={styles.card}>
            <button
              className={styles.dismissBtn}
              onClick={(e) => {
                e.stopPropagation();
                handleDismiss(suggestion.userId);
              }}
            >
              ✕
            </button>
            <img
              loading="lazy"
              decoding="async"
              src={suggestion.avatarUrl || generateDefaultAvatar()}
              alt={suggestion.username}
              className={styles.avatar}
              onClick={() => navigate(`/profile/${suggestion.userId}`)}
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
            <span className={styles.name} onClick={() => navigate(`/profile/${suggestion.userId}`)}>
              {suggestion.displayName || suggestion.username}
            </span>
            <span className={styles.reason}>
              {suggestion.reasons[0]?.label || 'Suggested for you'}
            </span>
            {suggestion.isOnline && <span className={styles.onlineDot} />}
            <button
              className={styles.addBtn}
              onClick={() => handleAddFriend(suggestion.userId)}
              disabled={sendingRequest === suggestion.userId}
            >
              {sendingRequest === suggestion.userId ? '...' : '+ Add Friend'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
