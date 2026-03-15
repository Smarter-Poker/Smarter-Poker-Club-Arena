/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONVERSATION LIST — Message Inbox
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import './ConversationList.css';

interface ConversationListProps {
  onSelectConversation: (userId: string, username: string, avatarUrl: string) => void;
}

interface Conversation {
  partnerId: string;
  partnerName: string;
  partnerAvatar: string;
  lastMessage: string;
  lastMessageAt: Date;
  unreadCount: number;
}

export function ConversationList({ onSelectConversation }: ConversationListProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    conversations.forEach((_, i) => {
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
    });
  }, [conversations.length]);

  useEffect(() => {
    if (user?.id) {
      loadConversations();
    }
  }, [user?.id]);

  // Q3: Bus listener — refresh list when a message is sent from any source
  useEffect(() => {
    const unsubSent = masterBus.subscribe('MESSAGE_SENT', () => {
      loadConversations();
    });
    const unsubProfile = masterBus.subscribe('PROFILE_UPDATED', () => {
      // Friend status changes may affect display name / avatar
      loadConversations();
    });
    return () => {
      unsubSent();
      unsubProfile();
    };
  }, [user?.id]);

  const loadConversations = async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      const { data, error } = await supabase.rpc('fn_get_conversations', { p_user_id: user.id });

      if (!error && data) {
        setConversations(
          data.map((c: any) => ({
            partnerId: c.partner_id,
            partnerName: c.partner_name,
            partnerAvatar: c.partner_avatar || '',
            lastMessage: c.last_message,
            lastMessageAt: new Date(c.last_message_at),
            unreadCount: c.unread_count || 0,
          }))
        );
      }
    } catch (error) {
      if (isMounted.current) toast.error('Failed to load conversations');
    }
    if (isMounted.current) setLoading(false);
  };

  const formatTime = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    if (hours < 48) return 'Yesterday';
    return date.toLocaleDateString();
  };

  if (loading) {
    return <div className="conversation-list loading">Loading...</div>;
  }

  return (
    <div className="conversation-list">
      <div className="conversation-list__header">
        <h3> Messages</h3>
      </div>

      {conversations.length === 0 ? (
        <div className="empty-state">No conversations yet</div>
      ) : (
        <div className="conversations">
          {conversations.map((conv, i) => (
            <div
              key={conv.partnerId}
              className={`conversation-item ${conv.unreadCount > 0 ? 'unread' : ''}`}
              onClick={() =>
                onSelectConversation(conv.partnerId, conv.partnerName, conv.partnerAvatar)
              }
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="avatar">{conv.partnerAvatar}</span>
              <div className="info">
                <span className="name">{conv.partnerName}</span>
                <span className="preview">{conv.lastMessage}</span>
              </div>
              <div className="meta">
                <span className="time">{formatTime(conv.lastMessageAt)}</span>
                {conv.unreadCount > 0 && <span className="badge">{conv.unreadCount}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ConversationList;
