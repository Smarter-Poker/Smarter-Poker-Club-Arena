/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB MESSAGES PAGE — Dedicated Club Conversations View
 * ═══════════════════════════════════════════════════════════════════════════════
 * Facebook Marketplace-style dedicated view for club messages
 * Separated from personal DMs for clean organization
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import ClubBottomNav from '../components/club/ClubBottomNav';
import MessageThread from '../components/messaging/MessageThread';
import './ClubMessagesPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';

interface ClubConversation {
  id: string;
  clubId: string;
  clubName: string;
  clubLogo: string;
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  participantCount: number;
}

export default function ClubMessagesPage() {
  const navigate = useNavigate();
  useVisibilityRefresh(() => loadClubConversations());
  const { conversationId, clubId: urlClubId } = useParams<{
    conversationId?: string;
    clubId?: string;
  }>();
  const { user } = useAuthUser();
  const toast = useToast();

  const [conversations, setConversations] = useState<ClubConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(
    conversationId || null
  );
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const [clubId, setClubId] = useState<string | undefined>(urlClubId);
  const [visibleConversations, setVisibleConversations] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState(false);
  const loadingRef = useRef(false);

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  // Hydrate userRole from club_members so BottomNav shows correct tabs
  useEffect(() => {
    if (!clubId || !user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { resolveClubUUID } = await import('../utils/clubIdResolver');
        const resolvedId = await resolveClubUUID(clubId);
        if (cancelled) return;
        const { data } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', resolvedId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (!cancelled && data?.role) {
          setUserRole(data.role as 'owner' | 'admin' | 'agent' | 'member');
        }
      } catch {
        /* non-critical */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id]);

  // Load club conversations
  const loadClubConversations = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!user?.id) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoadError(false);
      if (!getIsMounted || getIsMounted()) setLoading(true);
      try {
        const { data: clubConvs, error: convError } = await supabase
          .from('conversations')
          .select(
            `
                    id,
                    club_id,
                    updated_at,
                    clubs(id, name, logo_url)
                `
          )
          .contains('participant_ids', [user.id])
          .eq('category', 'club')
          .order('updated_at', { ascending: false });

        if (getIsMounted && !getIsMounted()) return;
        if (convError || !clubConvs) {
          console.error('Failed to load club conversations:', convError);
          return;
        }

        const mapped: ClubConversation[] = await Promise.all(
          clubConvs.map(async (conv: any) => {
            const { data: lastMsg } = await supabase
              .from('messages')
              .select('content, created_at')
              .eq('conversation_id', conv.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            const { count: unreadCount } = await supabase
              .from('messages')
              .select('*', { count: 'exact', head: true })
              .eq('conversation_id', conv.id)
              .eq('receiver_id', user.id)
              .eq('is_read', false);

            return {
              id: conv.id,
              clubId: conv.club_id,
              clubName: conv.clubs?.name || 'Unknown Club',
              clubLogo: conv.clubs?.logo_url || '/default-club.png',
              lastMessage: lastMsg?.content || '',
              lastMessageTime: lastMsg?.created_at || conv.updated_at,
              unreadCount: unreadCount || 0,
              participantCount: 0,
            };
          })
        );

        if (getIsMounted && !getIsMounted()) return;
        setConversations(mapped);
      } catch (error) {
        console.error('Failed to load club conversations:', error);
        setLoadError(true);
        if (!getIsMounted || getIsMounted()) toast.error('Failed to load club conversations');
      } finally {
        loadingRef.current = false;
        if (!getIsMounted || getIsMounted()) setLoading(false);
      }
    },
    [user?.id]
  );

  useEffect(() => {
    let isMounted = true;
    loadClubConversations(() => isMounted);

    const channelKey = 'club-messages-updates';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${user?.id}`,
        },
        () => {
          if (!isMounted) return;
          loadClubConversations(() => isMounted);
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadClubConversations]);

  // ── Bus Listeners: cross-page message event reactivity (debounced) ──
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('NOTIFICATION_READ', () => loadClubConversations(), 500),
      // Phase 4: Cross-page sync (ported from World Hub messages.js)
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', () => loadClubConversations(), 500),
      masterBus.subscribeDebounced('MESSAGE_RECEIVED', () => loadClubConversations(), 500),
      masterBus.subscribeDebounced('PLAYER_KICKED', () => loadClubConversations(), 500),
    ];
    return () => unsubs.forEach((u) => u());
  }, [loadClubConversations]);

  // Stagger animation for conversations
  useEffect(() => {
    if (conversations.length === 0) return;
    setVisibleConversations(new Set());
    const timers = conversations.map((conv, index) =>
      setTimeout(() => {
        setVisibleConversations((prev) => new Set(prev).add(conv.id));
      }, index * 60)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [conversations]);

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
    setSelectedConversation(id);
    if (isMobile) {
      navigate(`/messages/clubs/${id}`);
    }
  };

  const handleBack = () => {
    setSelectedConversation(null);
    if (isMobile) {
      navigate('/messages/clubs');
    }
  };

  // Mobile: Show thread if selected
  if (isMobile && selectedConversation) {
    return (
      <div className="club-messages-page full-height">
        <MessageThread conversationId={selectedConversation} onBack={handleBack} />
      </div>
    );
  }

  // Calculate total unread
  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <div className="club-messages-page">
      {/* Summary Bar */}
      <div className="club-messages-summary">
        <span className="summary-icon">◈</span>
        <span className="summary-text">
          {conversations.length} club{conversations.length !== 1 ? 's' : ''}
          {totalUnread > 0 && ` · ${totalUnread} unread`}
        </span>
      </div>

      {/* Club Conversation List */}
      <div className="club-messages-list">
        {loadError && !loading ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#aaa' }}>
            <p style={{ fontSize: '2rem', marginBottom: '8px' }}>⚠️</p>
            <p style={{ marginBottom: '16px' }}>Failed to load conversations</p>
            <button
              onClick={() => loadClubConversations()}
              style={{
                padding: '10px 24px',
                background: 'rgba(24, 119, 242, 0.15)',
                border: '1px solid rgba(24, 119, 242, 0.3)',
                borderRadius: '8px',
                color: '#1877f2',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="loading-state">
            <PageSkeleton variant="list" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">◈</span>
            <p>No club messages yet</p>
            <p className="hint">Join a club to start chatting!</p>
          </div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              className={`club-conversation-item ${selectedConversation === conv.id ? 'selected' : ''} ${conv.unreadCount > 0 ? 'unread' : ''} ${visibleConversations.has(conv.id) ? 'fadeInUp' : 'hidden'}`}
              style={
                visibleConversations.has(conv.id)
                  ? undefined
                  : { opacity: 0, transform: 'translateY(8px)' }
              }
              onClick={() => handleSelect(conv.id)}
            >
              {/* Club Logo */}
              <div className="club-logo-container">
                <img
                  src={conv.clubLogo}
                  alt={conv.clubName}
                  className="club-logo"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = '/default-club.png';
                  }}
                />
              </div>

              {/* Content */}
              <div className="club-conversation-content">
                <div className="club-conversation-header">
                  <span className="club-name">{conv.clubName}</span>
                  <span className="message-time">{formatTime(conv.lastMessageTime)}</span>
                </div>
                <div className="club-conversation-preview">
                  <span className="last-message">{conv.lastMessage || 'No messages yet'}</span>
                  {conv.unreadCount > 0 && <span className="unread-badge">{conv.unreadCount}</span>}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Desktop: Split view with thread */}
      {!isMobile && selectedConversation && (
        <div className="club-messages-thread">
          <MessageThread conversationId={selectedConversation} onBack={handleBack} />
        </div>
      )}

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}
