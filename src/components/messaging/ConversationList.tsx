/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONVERSATION LIST — Premium Chat List (SNGINE-inspired)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Features: Online indicators, unread badges, last message preview, search
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { messagingService } from '../../services/MessagingService';
import styles from './ConversationList.module.css';

interface Conversation {
  id: string;
  name: string;
  picture: string;
  isOnline: boolean;
  lastMessage: string;
  lastMessageTime: string;
  lastMessageUserId: string;
  unreadCount: number;
  isGroup: boolean;
  isPinned: boolean;
  participantCount?: number;
}

interface ConversationListProps {
  clubId?: string; // Optional - shows all conversations if not specified
  onSelectConversation?: (conversationId: string) => void;
  selectedId?: string;
}

export default function ConversationList({
  clubId,
  onSelectConversation,
  selectedId,
}: ConversationListProps) {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [visibleConversations, setVisibleConversations] = useState<Set<number>>(new Set());
  const heartbeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Club Messages widget state
  const [clubUnreadTotal, setClubUnreadTotal] = useState(0);
  const [clubConversationCount, setClubConversationCount] = useState(0);
  const [isClubMember, setIsClubMember] = useState(false);

  // Load club membership and messages count for widget
  const loadClubMessagesCount = useCallback(async () => {
    if (!user?.id) return;

    try {
      // First check if user is a member of any club
      const { count: membershipCount } = await supabase
        .from('club_members')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);

      const hasMembership = (membershipCount || 0) > 0;
      setIsClubMember(hasMembership);

      if (!hasMembership) {
        setClubConversationCount(0);
        setClubUnreadTotal(0);
        return;
      }

      // Query conversations where user is a participant and category is 'club'
      const { data: clubConvs, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .contains('participant_ids', [user.id])
        .eq('category', 'club');

      if (convError || !clubConvs) {
        console.error('Failed to load club conversations:', convError);
        return;
      }

      setClubConversationCount(clubConvs.length);

      if (clubConvs.length === 0) {
        setClubUnreadTotal(0);
        return;
      }

      // Count unread messages across all club conversations
      const convIds = clubConvs.map((c) => c.id);
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .in('conversation_id', convIds)
        .eq('receiver_id', user.id)
        .eq('is_read', false);

      setClubUnreadTotal(count || 0);
    } catch (error) {
      console.error('Failed to load club messages count:', error);
    }
  }, [user?.id]);

  // Load conversations from Supabase
  const loadConversations = useCallback(
    async (replace = false) => {
      if (!user?.id) return;

      try {
        const { data, error } = await supabase
          .from('conversation_participants')
          .select(
            `
                    conversation_id,
                    unread_count,
                    is_pinned,
                    conversations(
                        id,
                        name,
                        is_group,
                        last_message,
                        last_message_time,
                        last_message_user_id,
                        conversation_participants(
                            user_id,
                            profiles(id, username, avatar_url, is_online)
                        )
                    )
                `
          )
          .eq('user_id', user.id)
          .order('conversations(last_message_time)', { ascending: false })
          .range(offset, offset + 19);

        if (!error && data) {
          const mapped: Conversation[] = data
            .map((item: any) => {
              const conv = item.conversations;
              // Get other participant for 1:1 chats
              const otherParticipant = conv?.conversation_participants?.find(
                (p: any) => p.user_id !== user.id
              )?.profiles;

              return {
                id: conv?.id,
                name: conv?.is_group ? conv?.name : otherParticipant?.username || 'Unknown',
                picture: otherParticipant?.avatar_url || '/default-avatar.png',
                isOnline: otherParticipant?.is_online || false,
                lastMessage: conv?.last_message || '',
                lastMessageTime: conv?.last_message_time,
                lastMessageUserId: conv?.last_message_user_id,
                unreadCount: item.unread_count || 0,
                isGroup: conv?.is_group || false,
                isPinned: item.is_pinned || false,
                participantCount: conv?.conversation_participants?.length,
              };
            })
            .filter((c: Conversation) => c.id);

          if (replace) {
            setConversations(mapped);
            // Stagger entrance
            setVisibleConversations(new Set());
            mapped.forEach((_, i) => {
              setTimeout(() => setVisibleConversations((prev) => new Set(prev).add(i)), i * 40);
            });
          } else {
            setConversations((prev) => [...prev, ...mapped]);
          }
          setHasMore(data.length === 20);
        }
      } catch (error) {
        console.error('Failed to load conversations:', error);
      }
      setLoading(false);
    },
    [user?.id, offset]
  );

  // Heartbeat for refreshing (SNGINE pattern)
  const initHeartbeat = useCallback(() => {
    heartbeatRef.current = setInterval(() => {
      loadConversations(true);
    }, 10000); // 10 second heartbeat
  }, [loadConversations]);

  useEffect(() => {
    loadConversations(true);
    loadClubMessagesCount();
    initHeartbeat();

    // Real-time subscription for new messages
    const channelKey = 'conversations-updates';

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
        },
        () => {
          loadConversations(true);
          loadClubMessagesCount();
        }
      )
      .subscribe();

    // Bus listeners for cross-component sync (instant, no RT delay)
    const unsubSent = masterBus.subscribe('MESSAGE_SENT', () => {
      loadConversations(true);
    });
    const unsubReceived = masterBus.subscribe('MESSAGE_RECEIVED', () => {
      loadConversations(true);
      loadClubMessagesCount();
    });
    const unsubDeleted = masterBus.subscribe('MESSAGE_DELETED', () => {
      loadConversations(true);
    });
    const unsubUpdated = masterBus.subscribe('CONVERSATION_UPDATED', () => {
      loadConversations(true);
      loadClubMessagesCount();
    });

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      masterBus.removeRegisteredChannel(channelKey);
      unsubSent();
      unsubReceived();
      unsubDeleted();
      unsubUpdated();
    };
  }, [loadConversations, loadClubMessagesCount, initHeartbeat]);

  // Filter by search
  // Q3: Pin/unpin handler
  const handlePin = useCallback(
    async (e: React.MouseEvent, convId: string, isPinned: boolean) => {
      e.stopPropagation();
      if (!user?.id) return;
      if (isPinned) {
        await messagingService.unpinConversation(user.id, convId);
      } else {
        await messagingService.pinConversation(user.id, convId);
      }
      // Update local state
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, isPinned: !isPinned } : c))
      );
    },
    [user?.id]
  );

  const filteredConversations = conversations
    .filter(
      (c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.lastMessage.toLowerCase().includes(searchQuery.toLowerCase())
    )
    // Q3: Pinned conversations float to top
    .sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return 0;
    });

  // Format relative time
  const formatTime = (dateStr: string): string => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString();
  };

  const handleSelect = (id: string) => {
    if (onSelectConversation) {
      onSelectConversation(id);
    } else {
      navigate(`/messages/${id}`);
    }
  };

  return (
    <div className={styles.container}>
      {/* Search Bar */}
      <div className={styles.searchContainer}>
        <input
          type="text"
          placeholder=" Search conversations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={styles.searchInput}
        />
      </div>

      {/*  Club Messages Widget — Only shows for club members */}
      {isClubMember && (
        <div className={styles.clubWidget} onClick={() => navigate('/messages/clubs')}>
          <div className={styles.clubWidgetIcon}></div>
          <div className={styles.clubWidgetContent}>
            <span className={styles.clubWidgetTitle}>Club Messages</span>
            <span className={styles.clubWidgetPreview}>
              {clubUnreadTotal > 0
                ? `${clubUnreadTotal} new message${clubUnreadTotal !== 1 ? 's' : ''}`
                : 'No new messages'}
            </span>
          </div>
          {clubUnreadTotal > 0 && <span className={styles.clubWidgetBadge}>{clubUnreadTotal}</span>}
          <span className={styles.clubWidgetChevron}>›</span>
        </div>
      )}

      {/* Conversation List */}
      <div className={styles.list}>
        {loading ? (
          <div className={styles.loading}>
            <div className={styles.spinner} />
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}></span>
            <p>No conversations yet</p>
            <p className={styles.hint}>Start chatting with friends!</p>
          </div>
        ) : (
          filteredConversations.map((conv, idx) => (
            <div
              key={conv.id}
              className={`${styles.item} ${selectedId === conv.id ? styles.selected : ''} ${conv.unreadCount > 0 ? styles.unread : ''}`}
              onClick={() => handleSelect(conv.id)}
              style={{
                opacity: visibleConversations.has(idx) ? 1 : 0,
                transform: visibleConversations.has(idx) ? 'translateX(0)' : 'translateX(-8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              {/* Avatar */}
              <div className={styles.avatarContainer}>
                <img
                  src={conv.picture}
                  alt={conv.name}
                  className={styles.avatar}
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = '/default-avatar.png';
                  }}
                />
                {conv.isOnline && !conv.isGroup && <span className={styles.onlineIndicator} />}
              </div>

              {/* Content */}
              <div className={styles.content}>
                <div className={styles.header}>
                  <span className={styles.name}>
                    {conv.isPinned && (
                      <span className={styles.pinIcon} title="Pinned">
                        📌
                      </span>
                    )}
                    {conv.isGroup && ' '}
                    {conv.name}
                  </span>
                  <span className={styles.time}>{formatTime(conv.lastMessageTime)}</span>
                </div>
                <div className={styles.preview}>
                  <span className={styles.message}>
                    {conv.lastMessageUserId === user?.id && ' '}
                    {conv.lastMessage || 'No messages yet'}
                    {(conv as any).lastReaction && (
                      <span className={styles.reactionPreview}> {(conv as any).lastReaction}</span>
                    )}
                  </span>
                  <div className={styles.previewActions}>
                    <button
                      className={`${styles.pinBtn} ${conv.isPinned ? styles.pinActive : ''}`}
                      onClick={(e) => handlePin(e, conv.id, conv.isPinned)}
                      title={conv.isPinned ? 'Unpin' : 'Pin'}
                    >
                      📌
                    </button>
                    {conv.unreadCount > 0 && (
                      <span className={styles.badge}>{conv.unreadCount}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* New Message FAB */}
      <button className={styles.fab} onClick={() => navigate('/messages/new')}>
        +
      </button>
    </div>
  );
}
