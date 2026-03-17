/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGE THREAD — Real-time Chat View (SNGINE-inspired)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Features: Chat bubbles, typing indicator, seen status, reactions, infinite scroll
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useAuthUser } from '../../hooks/useAuthUser';
import { messagingService } from '../../services/MessagingService';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import { PlayerAvatar } from '../avatars/PlayerAvatar';
import { ThrowableLayer, useThrowableReactions } from './ThrowableReaction';
import { useMessageDraft } from '../../hooks/useMessageDraft';
import MessageSearchBar from './MessageSearchBar';
import ForwardMessageModal from './ForwardMessageModal';
import ScheduledMessagePanel from './ScheduledMessagePanel';
import styles from './MessageThread.module.css';

interface Reaction {
  emoji: string;
  userId: string;
  userName: string;
  timestamp: number;
}

interface Message {
  id: string;
  conversationId: string;
  userId: string;
  userFullname: string;
  userPicture: string;
  content: string;
  imageUrl?: string;
  audioUrl?: string;
  createdAt: string;
  isSeen: boolean;
  isEdited?: boolean;
  editedAt?: string;
  reactions: { [emoji: string]: number };
  myReaction?: string;
  reactionDetails?: Reaction[];
  threadReplyCount?: number;
}

interface Participant {
  userId: string;
  username: string;
  avatar: string;
  isOnline: boolean;
  isTyping: boolean;
}

interface MessageThreadProps {
  conversationId: string;
  onBack?: () => void;
}

export default function MessageThread({ conversationId, onBack }: MessageThreadProps) {
  const { user } = useAuthUser();
  const [messages, setMessages] = useState<Message[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [seenBy, setSeenBy] = useState<string[]>([]);
  const [visibleMessages, setVisibleMessages] = useState<Set<number>>(new Set());
  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyingToMessage, setReplyingToMessage] = useState<Message | null>(null);
  // Q3: Search & Forward state
  const [showSearch, setShowSearch] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const heartbeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Draft persistence
  const [draft, setDraft, clearDraft] = useMessageDraft(conversationId);

  // Throwable reactions
  const { activeThrowables, throwReaction, handleComplete } = useThrowableReactions();

  // Load conversation details
  const loadConversation = useCallback(async () => {
    if (!conversationId || !user?.id) return;

    try {
      // Load participants
      const { data: participantData } = await supabase
        .from('social_conversation_participants')
        .select(
          `
                    user_id,
                    is_typing,
                    last_seen_message_id,
                    profiles(id, username, avatar_url, is_online)
                `
        )
        .eq('conversation_id', conversationId);

      if (participantData) {
        setParticipants(
          participantData.map((p: any) => ({
            userId: p.user_id,
            username: p.profiles?.username || 'Unknown',
            avatar: p.profiles?.avatar_url || '/default-avatar.png',
            isOnline: p.profiles?.is_online || false,
            isTyping: p.is_typing || false,
          }))
        );

        // Get typing users
        const typing = participantData
          .filter((p: any) => p.is_typing && p.user_id !== user.id)
          .map((p: any) => p.profiles?.username || 'Someone');
        setTypingUsers(typing);
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  }, [conversationId, user?.id]);

  // Load messages — `replace` resets to newest page; otherwise prepends older messages
  const loadMessages = useCallback(
    async (replace = false) => {
      if (!conversationId) return;

      // When replacing (fresh load), always start from offset 0
      const currentOffset = replace ? 0 : offset;

      try {
        const { data, error } = await supabase
          .from('messages')
          .select(
            `
                    id,
                    conversation_id,
                    sender_id,
                    content,
                    image_url,
                    audio_url,
                    created_at,
                    is_seen,
                    edited_at,
                    is_edited,
                    profiles(id, username, avatar_url)
                `
          )
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: false })
          .range(currentOffset, currentOffset + 29);

        if (!error && data) {
          const mapped: Message[] = data
            .map((m: any) => ({
              id: m.id,
              conversationId: m.conversation_id,
              userId: m.sender_id,
              userFullname: m.profiles?.username || 'Unknown',
              userPicture: m.profiles?.avatar_url || '/default-avatar.png',
              content: m.content,
              imageUrl: m.image_url,
              audioUrl: m.audio_url,
              createdAt: m.created_at,
              isSeen: m.is_seen,
              isEdited: m.is_edited || false,
              editedAt: m.edited_at || null,
              reactions: {},
              myReaction: undefined,
              reactionDetails: [],
              threadReplyCount: 0,
            }))
            .reverse();

          if (replace) {
            setMessages(mapped);
            setOffset(0); // Reset offset on fresh load
          } else {
            // Prepend older messages, deduplicating by ID
            setMessages((prev) => {
              const existingIds = new Set(prev.map((m) => m.id));
              const newMsgs = mapped.filter((m) => !existingIds.has(m.id));
              return [...newMsgs, ...prev];
            });
          }
          setHasMore(data.length === 30);

          // Mark unseen messages from others as seen
          const unseenIds = mapped
            .filter((m) => !m.isSeen && m.userId !== user?.id)
            .map((m) => m.id);

          if (unseenIds.length > 0) {
            // Fire-and-forget update
            (async () => {
              try {
                // SECURITY: Only mark messages where current user is the receiver
                await supabase
                  .from('messages')
                  .update({ is_seen: true })
                  .in('id', unseenIds)
                  .eq('receiver_id', user?.id || '');
                // Update local state to avoid re-triggering
                setMessages((current) =>
                  current.map((m) => (unseenIds.includes(m.id) ? { ...m, isSeen: true } : m))
                );
              } catch (err) {
                console.warn('[MessageThread] mark-as-seen failed:', err);
              }
            })();
          }
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
      }
      setLoading(false);
    },
    [conversationId, offset]
  );

  // Load older messages — increments offset to fetch next page
  const loadOlderMessages = useCallback(() => {
    if (!hasMore || loading) return;
    setOffset((prev) => prev + 30);
  }, [hasMore, loading]);

  // When offset changes (and isn't 0), load the next page
  useEffect(() => {
    if (offset > 0) {
      loadMessages(false);
    }
  }, [offset]);

  // Send message
  const sendMessage = async (text: string, imageUrl?: string, audioUrl?: string) => {
    if (!text.trim() && !imageUrl && !audioUrl) return;
    if (!user?.id || !conversationId) return;

    setSending(true);
    try {
      const otherParticipant = participants.find((p) => p.userId !== user.id);
      const receiverId = otherParticipant?.userId || null;

      const { data, error } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: user.id,
          receiver_id: receiverId,
          content: text.trim(),
          image_url: imageUrl || null,
          audio_url: audioUrl || null,
          reply_to_message_id: replyingToId || null,
        })
        .select()
        .maybeSingle();

      if (error) throw error;

      if (data) {
        // Add to local state immediately
        const newMessage: Message = {
          id: data.id,
          conversationId: data.conversation_id,
          userId: data.sender_id,
          userFullname: user.username || 'You',
          userPicture: user.avatar_url || '/default-avatar.png',
          content: data.content,
          imageUrl: data.image_url,
          audioUrl: data.audio_url,
          createdAt: data.created_at,
          isSeen: false,
          reactions: {},
          myReaction: undefined,
          reactionDetails: [],
          threadReplyCount: 0,
        };
        setMessages((prev) => [...prev, newMessage]);

        // Cross-tab perfect sync natively on local client
        masterBus.emit('MESSAGE_SENT', {
          conversationId,
          message: newMessage as unknown as Record<string, unknown>,
        });

        // Scroll to bottom
        setTimeout(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        }, 100);

        // Update conversation's last_message
        const { error: updateErr } = await supabase
          .from('conversations')
          .update({
            last_message: audioUrl
              ? '🎤 Voice message'
              : imageUrl
                ? '📷 Image'
                : text.trim().substring(0, 100),
            last_message_time: new Date().toISOString(),
            last_message_user_id: user.id,
          })
          .eq('id', conversationId);
        if (updateErr)
          console.warn('[MessageThread] conversation update failed:', updateErr.message);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
    }
    setSending(false);
  };

  // Set typing status
  const setTyping = async (isTyping: boolean) => {
    if (!user?.id || !conversationId) return;
    try {
      await supabase
        .from('social_conversation_participants')
        .update({ is_typing: isTyping })
        .eq('conversation_id', conversationId)
        .eq('user_id', user.id);
    } catch (err) {
      // Non-critical: typing indicator failure should not surface to user
      console.debug('[MessageThread] setTyping failed:', err);
    }
  };

  // Handle reply to message
  const handleReply = (messageId: string) => {
    const message = messages.find((m) => m.id === messageId);
    setReplyingToId(messageId);
    setReplyingToMessage(message || null);
  };

  // Cancel reply
  const cancelReply = () => {
    setReplyingToId(null);
    setReplyingToMessage(null);
  };

  // React to message — optimistic local update + background sync
  const reactToMessage = async (messageId: string, emoji: string) => {
    if (!user?.id) return;

    // Optimistic: update local state immediately
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const newReactions = { ...m.reactions };
        const isToggleOff = m.myReaction === emoji;
        if (isToggleOff) {
          // Remove my reaction
          newReactions[emoji] = Math.max(0, (newReactions[emoji] || 1) - 1);
          if (newReactions[emoji] === 0) delete newReactions[emoji];
          return { ...m, reactions: newReactions, myReaction: undefined };
        } else {
          // Remove old reaction if any
          if (m.myReaction && newReactions[m.myReaction]) {
            newReactions[m.myReaction] = Math.max(0, newReactions[m.myReaction] - 1);
            if (newReactions[m.myReaction] === 0) delete newReactions[m.myReaction];
          }
          // Add new reaction
          newReactions[emoji] = (newReactions[emoji] || 0) + 1;
          return { ...m, reactions: newReactions, myReaction: emoji };
        }
      })
    );

    // Background sync with Supabase
    try {
      const { data: existing } = await supabase
        .from('message_reactions')
        .select('id, reaction')
        .eq('message_id', messageId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existing) {
        if (existing.reaction === emoji) {
          const { error: delErr } = await supabase
            .from('message_reactions')
            .delete()
            .eq('id', existing.id);
          if (delErr) throw delErr;
        } else {
          const { error: updErr } = await supabase
            .from('message_reactions')
            .update({ reaction: emoji })
            .eq('id', existing.id);
          if (updErr) throw updErr;
        }
      } else {
        const { error: insErr } = await supabase.from('message_reactions').insert({
          message_id: messageId,
          user_id: user.id,
          reaction: emoji,
        });
        if (insErr) throw insErr;
      }
    } catch (error) {
      // Rollback on error — refetch from server
      console.error('Failed to sync reaction:', error);
      loadMessages(true);
    }
  };

  // Delete message
  const deleteMessage = async (messageId: string) => {
    try {
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)
        .eq('sender_id', user?.id);
      if (error) throw error;
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      masterBus.emit('MESSAGE_DELETED', { messageId });
    } catch (error) {
      console.error('Failed to delete:', error);
    }
  };

  // Edit message (calls service method with 5-min window enforcement)
  const editMessage = async (messageId: string, newContent: string) => {
    if (!user?.id) return;
    try {
      const success = await messagingService.editMessage(messageId, user.id, newContent);
      if (success) {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: newContent, isEdited: true } : m))
        );
      }
    } catch (error) {
      console.error('Failed to edit:', error);
    }
  };

  // Heartbeat
  useEffect(() => {
    loadConversation();
    loadMessages(true);

    heartbeatRef.current = setInterval(() => {
      loadConversation();
    }, 5000);

    // Real-time subscription
    const channelKey = `messages-${conversationId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          // Only sync if not from current user (they already have it via optimistic update)
          if (payload.new && (payload.new as any).sender_id !== user?.id) {
            loadMessages(true);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const updated = payload.new as any;
          if (!updated) return;

          setMessages((current) =>
            current.map((m) => {
              if (m.id !== updated.id) return m;
              const changes: Partial<Message> = {};
              // Seen status update
              if (updated.is_seen && !m.isSeen) changes.isSeen = true;
              // Edit update
              if (updated.is_edited && !m.isEdited) {
                changes.isEdited = true;
                changes.content = updated.content;
                changes.editedAt = updated.edited_at;
              }
              return Object.keys(changes).length > 0 ? { ...m, ...changes } : m;
            })
          );
        }
      )
      .subscribe();

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [conversationId, loadConversation, loadMessages, user?.id]);

  // ── Bus Listener: cross-tab message sync ──
  useMasterBusSubscription('MESSAGE_RECEIVED', () => {
    loadMessages(true);
  });

  useMasterBusSubscription('MESSAGE_SENT', (payload) => {
    if (payload.conversationId === conversationId) {
      setMessages((prev) => {
        // Prevent duplicate from optimistic UI
        if (prev.some((m) => m.id === (payload.message as any).id)) return prev;
        return [...prev, payload.message as unknown as Message];
      });
      setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }, 50);
    }
  });

  // Q3 Phase 15: Bus listener for edited messages
  useMasterBusSubscription('MESSAGE_SENT', (payload) => {
    if ((payload.message as any)?.edited) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === (payload.message as any).id
            ? { ...m, content: (payload.message as any).content, isEdited: true }
            : m
        )
      );
    }
  });

  // Q3 Phase 15: Bus listener for deleted messages
  useMasterBusSubscription('MESSAGE_DELETED', (payload) => {
    if (payload?.messageId) {
      setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
    }
  });

  // Q3 Phase 15: Bus listener for conversation metadata updates
  useMasterBusSubscription('CONVERSATION_UPDATED', (payload) => {
    if (payload?.conversationId === conversationId) {
      loadConversation();
    }
  });

  // Auto-scroll on new messages
  useEffect(() => {
    if (messages.length > 0) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      // Stagger message entrance
      setVisibleMessages(new Set());
      messages.forEach((_, i) => {
        setTimeout(() => setVisibleMessages((prev) => new Set(prev).add(i)), i * 30);
      });
    }
  }, [messages.length]);

  const otherParticipant = participants.find((p) => p.userId !== user?.id);

  // Q3: Handle search result navigation
  const handleSearchResult = useCallback((messageId: string) => {
    setHighlightedMessageId(messageId);
    // Scroll to the message
    const el = document.getElementById(`msg-${messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    // Clear highlight after 2s
    setTimeout(() => setHighlightedMessageId(null), 2000);
  }, []);

  // Q3: Forward action
  const handleForward = useCallback(
    (messageId: string) => {
      const msg = messages.find((m) => m.id === messageId);
      if (msg) setForwardingMessage(msg);
    },
    [messages]
  );

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        {onBack && (
          <button className={styles.backBtn} onClick={onBack}>
            ←
          </button>
        )}
        {otherParticipant && (
          <div className={styles.headerUser}>
            <PlayerAvatar
              src={otherParticipant.avatar}
              name={otherParticipant.username}
              size="sm"
              presenceStatus={otherParticipant.isOnline ? 'online' : 'offline'}
              showPresence={true}
              showLevelBadge={false}
              showXpRing={false}
              showVipRing={false}
            />
            <div className={styles.headerInfo}>
              <span className={styles.headerName}>{otherParticipant.username}</span>
              <span className={styles.headerStatus}>
                {typingUsers.length > 0 ? (
                  <span className={styles.typing}>typing...</span>
                ) : otherParticipant.isOnline ? (
                  <span className={styles.online}>Online</span>
                ) : (
                  'Offline'
                )}
              </span>
            </div>
          </div>
        )}
        {/* Q3: Search toggle button */}
        <button
          className={styles.searchToggle}
          onClick={() => setShowSearch((prev) => !prev)}
          title="Search messages"
        >
          🔍
        </button>
        <button
          className={styles.searchToggle}
          onClick={() => setShowSchedule((prev) => !prev)}
          title="Schedule message"
        >
          ⏰
        </button>
      </div>

      {/* Q3: Search Bar */}
      {showSearch && (
        <MessageSearchBar
          conversationId={conversationId}
          onResultSelect={handleSearchResult}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Messages */}
      <div
        className={styles.messages}
        ref={scrollRef}
        aria-live="polite"
        onScroll={(e) => {
          // Infinite scroll: load older messages when scrolled near the top
          const target = e.currentTarget;
          if (target.scrollTop < 80 && hasMore && !loading) {
            loadOlderMessages();
          }
        }}
      >
        {loading ? (
          <div className={styles.loading}>
            <div className={styles.spinner} />
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}></span>
            <p>Start the conversation!</p>
          </div>
        ) : (
          (() => {
            // Q3 Phase 17: Compute unread boundary ONCE (was O(n²) inside map)
            const firstUnreadIdx = messages.findIndex(
              (m, i) => i > 0 && !m.isSeen && messages[i - 1]?.isSeen && m.userId !== user?.id
            );
            const totalUnread =
              firstUnreadIdx >= 0
                ? messages.slice(firstUnreadIdx).filter((m) => !m.isSeen && m.userId !== user?.id)
                    .length
                : 0;

            return messages.map((message, idx) => {
              const showUnreadSep = idx === firstUnreadIdx;

              return (
                <div key={message.id}>
                  {showUnreadSep && (
                    <div
                      className={styles.unreadSeparator || ''}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '8px 16px',
                        margin: '4px 0',
                        color: '#00d4ff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                      }}
                    >
                      <div style={{ flex: 1, height: '1px', background: 'rgba(0,212,255,0.3)' }} />
                      <span>
                        {totalUnread} new message{totalUnread !== 1 ? 's' : ''}
                      </span>
                      <div style={{ flex: 1, height: '1px', background: 'rgba(0,212,255,0.3)' }} />
                    </div>
                  )}
                  <div
                    id={`msg-${message.id}`}
                    style={{
                      opacity: visibleMessages.has(idx) ? 1 : 0,
                      transform: visibleMessages.has(idx) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                      background:
                        highlightedMessageId === message.id ? 'rgba(0, 212, 255, 0.08)' : undefined,
                      borderRadius: highlightedMessageId === message.id ? '12px' : undefined,
                    }}
                  >
                    <MessageBubble
                      message={message}
                      isCurrentUser={message.userId === user?.id}
                      onReact={reactToMessage}
                      onDelete={deleteMessage}
                      onEdit={editMessage}
                      onReply={handleReply}
                      onForward={handleForward}
                    />
                    {/* Q3: Reply count indicator */}
                    {message.threadReplyCount && message.threadReplyCount > 0 && (
                      <div
                        style={{
                          fontSize: '0.7rem',
                          color: '#00d4ff',
                          padding: '2px 48px',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        💬 {message.threadReplyCount} repl
                        {message.threadReplyCount !== 1 ? 'ies' : 'y'}
                      </div>
                    )}
                  </div>
                </div>
              );
            });
          })()
        )}

        {/* Typing Indicator */}
        {typingUsers.length > 0 && (
          <div className={styles.typingIndicator}>
            <div className={styles.typingDots}>
              <span />
              <span />
              <span />
            </div>
            <span className={styles.typingText}>{typingUsers.join(', ')} typing...</span>
          </div>
        )}

        {/* Seen Status */}
        {seenBy.length > 0 && <div className={styles.seenStatus}>Seen by {seenBy.join(', ')}</div>}
      </div>

      {/* Reply Preview */}
      {replyingToMessage && (
        <div className={styles.replyPreview}>
          <div className={styles.replyContent}>
            <span className={styles.replyLabel}>Replying to {replyingToMessage.userFullname}</span>
            <p className={styles.replyText}>
              {replyingToMessage.content
                ? replyingToMessage.content.substring(0, 80)
                : replyingToMessage.imageUrl
                  ? '📷 Image'
                  : ''}
            </p>
          </div>
          <button className={styles.replyCancel} onClick={cancelReply}>
            ✕
          </button>
        </div>
      )}

      {/* Q3 Phase 14: Compose bar extras */}
      <div style={{ display: 'flex', gap: '4px', padding: '0 8px', alignItems: 'center' }}>
        <button
          onClick={() => {
            const recipientId = participants?.[0]?.userId;
            if (recipientId && user?.id) {
              // Send a contact card as a message
              sendMessage(`📇 Shared contact card — /profile/${user.id}`, undefined, undefined);
            }
          }}
          title="Share Contact Card"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '1.1rem',
            padding: '4px 8px',
            borderRadius: '8px',
            color: 'var(--text-secondary, #8b9dc3)',
          }}
        >
          📇
        </button>
      </div>

      {/* Input */}
      <MessageInput
        onSend={(text, imageUrl, audioUrl) => {
          sendMessage(text, imageUrl, audioUrl);
          clearDraft();
        }}
        onTyping={setTyping}
        disabled={sending}
        initialDraft={draft}
        onDraftChange={setDraft}
      />

      {/* Q3: Forward Message Modal */}
      {forwardingMessage && (
        <ForwardMessageModal
          messageId={forwardingMessage.id}
          messageContent={forwardingMessage.content}
          onClose={() => setForwardingMessage(null)}
          onForwarded={() => setForwardingMessage(null)}
        />
      )}

      {/* Q3: Scheduled Message Panel */}
      {showSchedule && user?.id && (
        <ScheduledMessagePanel
          conversationId={conversationId}
          senderId={user.id}
          onClose={() => setShowSchedule(false)}
          onScheduled={() => setShowSchedule(false)}
        />
      )}

      {/* Throwable Animation Layer */}
      <ThrowableLayer throwables={activeThrowables} onComplete={handleComplete} />
    </div>
  );
}
