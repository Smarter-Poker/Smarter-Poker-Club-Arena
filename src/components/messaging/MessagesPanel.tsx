/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGES PANEL — Direct Messaging UI
 * Conversation list and chat interface
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from './MessagesPanel.module.css';

interface Conversation {
  id: string;
  participantId: string;
  participantName: string;
  participantAvatar?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  unreadCount: number;
  isParticipant1: boolean; // true if current user is participant1
}

interface Message {
  id: string;
  senderId: string;
  content: string;
  createdAt: string;
  isOwn: boolean;
}

interface MessagesPanelProps {
  initialConversationId?: string;
  onClose?: () => void;
}

export default function MessagesPanel({ initialConversationId, onClose }: MessagesPanelProps) {
  const { user } = useAuthUser();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvo, setSelectedConvo] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [visibleMessages, setVisibleMessages] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user?.id) {
      loadConversations();
    }
  }, [user?.id]);

  useEffect(() => {
    if (selectedConvo) {
      loadMessages(selectedConvo.id);
      markAsRead(selectedConvo.id);
    }
  }, [selectedConvo?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    messages.forEach((_, i) => {
      setTimeout(() => setVisibleMessages((prev) => new Set(prev).add(i)), i * 50);
    });
  }, [messages]);

  // Real-time subscription
  useEffect(() => {
    if (!selectedConvo) return;

    const channelKey = `messages:${selectedConvo.id}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${selectedConvo.id}`,
        },
        (payload) => {
          const msg = payload.new as any;
          setMessages((prev) => [
            ...prev,
            {
              id: msg.id,
              senderId: msg.sender_id,
              content: msg.content,
              createdAt: msg.created_at,
              isOwn: msg.sender_id === user?.id,
            },
          ]);
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [selectedConvo?.id, user?.id]);

  const loadConversations = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('conversations')
        .select(
          `
                    id,
                    participant1_id,
                    participant2_id,
                    last_message,
                    last_message_at,
                    unread_count_1,
                    unread_count_2
                `
        )
        .or(`participant1_id.eq.${user?.id},participant2_id.eq.${user?.id}`)
        .order('last_message_at', { ascending: false });

      if (error) throw error;

      // Get participant profiles
      const convos: Conversation[] = await Promise.all(
        (data || []).map(async (c: any) => {
          const participantId =
            c.participant1_id === user?.id ? c.participant2_id : c.participant1_id;
          const { data: profile } = await supabase
            .from('profiles')
            .select('display_name, avatar_url')
            .eq('id', participantId)
            .maybeSingle();

          const isParticipant1 = c.participant1_id === user?.id;
          return {
            id: c.id,
            participantId,
            participantName: profile?.display_name || 'Unknown',
            participantAvatar: profile?.avatar_url,
            lastMessage: c.last_message,
            lastMessageAt: c.last_message_at,
            unreadCount: isParticipant1 ? c.unread_count_1 : c.unread_count_2,
            isParticipant1,
          };
        })
      );

      setConversations(convos);

      // Auto-select if initial ID provided
      if (initialConversationId) {
        const initial = convos.find((c) => c.id === initialConversationId);
        if (initial) setSelectedConvo(initial);
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
    setLoading(false);
  };

  const loadMessages = async (conversationId: string) => {
    const { data, error } = await supabase
      .from('messages')
      .select('id, sender_id, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (!error && data) {
      setMessages(
        data.map((m: any) => ({
          id: m.id,
          senderId: m.sender_id,
          content: m.content,
          createdAt: m.created_at,
          isOwn: m.sender_id === user?.id,
        }))
      );
    }
  };

  const markAsRead = async (conversationId: string) => {
    // Reset the correct unread_count column for the CURRENT user
    // isParticipant1 = true means current user is participant1, so reset unread_count_1
    const column = selectedConvo?.isParticipant1 ? 'unread_count_1' : 'unread_count_2';
    const { error } = await supabase
      .from('conversations')
      .update({ [column]: 0 })
      .eq('id', conversationId);
    if (error) console.warn('[Messages] markAsRead failed:', error.message);
  };

  const sendMessage = async () => {
    if (!newMessage.trim() || !selectedConvo || !user?.id) return;
    setSending(true);

    try {
      const { error: insertError } = await supabase.from('messages').insert({
        conversation_id: selectedConvo.id,
        sender_id: user.id,
        content: newMessage.trim(),
      });

      if (insertError) throw insertError;

      // Update conversation
      const { error: updateError } = await supabase
        .from('conversations')
        .update({
          last_message: newMessage.trim().slice(0, 100),
          last_message_at: new Date().toISOString(),
        })
        .eq('id', selectedConvo.id);

      if (updateError) console.warn('[Messages] conversation update failed:', updateError.message);

      setNewMessage('');
    } catch (error) {
      console.error('Failed to send message:', error);
      // User needs to know their message didn't send
    }
    setSending(false);
  };

  const formatTime = (dateStr?: string): string => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);

    if (diffDays === 0) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString(undefined, { weekday: 'short' });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className={styles.panel}>
      {/* Conversation List */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h3> Messages</h3>
          {onClose && (
            <button onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </div>

        <div className={styles.conversationList}>
          {loading ? (
            <div className={styles.loading}>Loading...</div>
          ) : conversations.length === 0 ? (
            <div className={styles.empty}>No conversations yet</div>
          ) : (
            conversations.map((convo) => (
              <div
                key={convo.id}
                className={`${styles.conversationItem} ${selectedConvo?.id === convo.id ? styles.selected : ''}`}
                onClick={() => setSelectedConvo(convo)}
              >
                <div className={styles.avatar}>
                  {convo.participantAvatar ? (
                    <img loading="lazy" decoding="async" src={convo.participantAvatar} alt="" />
                  ) : (
                    <span>●</span>
                  )}
                </div>
                <div className={styles.convoInfo}>
                  <span className={styles.convoName}>{convo.participantName}</span>
                  <span className={styles.lastMsg}>{convo.lastMessage}</span>
                </div>
                <div className={styles.convoMeta}>
                  <span className={styles.time}>{formatTime(convo.lastMessageAt)}</span>
                  {convo.unreadCount > 0 && (
                    <span className={styles.unread}>{convo.unreadCount}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div className={styles.chatArea}>
        {selectedConvo ? (
          <>
            <div className={styles.chatHeader}>
              <div className={styles.avatar}>
                {selectedConvo.participantAvatar ? (
                  <img
                    loading="lazy"
                    decoding="async"
                    src={selectedConvo.participantAvatar}
                    alt=""
                  />
                ) : (
                  <span>●</span>
                )}
              </div>
              <span>{selectedConvo.participantName}</span>
            </div>

            <div className={styles.messages}>
              {messages.map((msg, i) => (
                <div
                  key={msg.id}
                  className={`${styles.message} ${msg.isOwn ? styles.own : styles.other}`}
                  style={{
                    opacity: visibleMessages.has(i) ? 1 : 0,
                    transform: visibleMessages.has(i) ? 'translateY(0)' : 'translateY(8px)',
                    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                  }}
                >
                  <div className={styles.bubble}>{msg.content}</div>
                  <span className={styles.msgTime}>{formatTime(msg.createdAt)}</span>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className={styles.inputArea}>
              <input
                type="text"
                placeholder="Type a message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              />
              <button onClick={sendMessage} disabled={sending || !newMessage.trim()}>
                {sending ? '...' : '➤'}
              </button>
            </div>
          </>
        ) : (
          <div className={styles.noChat}>
            <span>◈</span>
            <p>Select a conversation to start messaging</p>
          </div>
        )}
      </div>
    </div>
  );
}
