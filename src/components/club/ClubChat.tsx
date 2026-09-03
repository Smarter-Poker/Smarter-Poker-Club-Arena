/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ClubChat — Club-Wide Group Chat Panel
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Ported from World Hub → Club Arena (March 2026)
 *
 *  Collapsible panel in the lobby with realtime message updates.
 *  Uses Supabase postgres_changes for live message subscription.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { reportError } from '../../utils/errorReporter';

const FB = {
  bg: '#1c1c1e',
  card: '#242526',
  text: '#E4E6EB',
  dim: '#B0B3B8',
  border: '#3E4042',
  primary: '#1877F2',
  success: '#31A24C',
};

function timeShort(date: string): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface ClubChatMessage {
  id: string;
  user_id: string;
  message: string;
  display_name?: string;
  message_type: string;
  created_at: string;
}

interface ClubChatProps {
  clubId: string;
  userId: string;
  userName?: string;
}

export default function ClubChat({ clubId, userId, userName }: ClubChatProps) {
  const [messages, setMessages] = useState<ClubChatMessage[]>([]);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const [isBannedFromChat, setIsBannedFromChat] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeenRef = useRef(0);
  const expandedRef = useRef(expanded);
  const failedTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const isMounted = useIsMounted();

  const loadMessages = useCallback(async () => {
    if (!clubId) return;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error } = await supabase
        .from('club_chat')
        .select('id, user_id, message, display_name, message_type, created_at')
        .eq('club_id', clubId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (!isMounted.current) return;
      if (error) throw error;
      const msgs = (data as ClubChatMessage[]).reverse();
      setMessages(msgs);
      if (expandedRef.current) {
        lastSeenRef.current = msgs.length;
        setUnread(0);
      }
    } catch (err) {
      reportError(err, 'ClubChat.Failed_to_load_messages');
    }
  }, [clubId]);

  // Initial load
  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Realtime subscription
  useEffect(() => {
    if (!clubId) return;
    const channelKey = `club-chat:${clubId}`;
    const channel = masterBus
      .getOrCreateChannel(channelKey)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'club_chat',
          filter: `club_id=eq.${clubId}`,
        },
        (payload) => {
          const newMsg = payload.new as ClubChatMessage;
          setMessages((prev) => {
            // Remove optimistic temp message from same sender to prevent duplicates
            const filtered = prev.filter(
              (m) =>
                !(
                  m.id.startsWith('temp-') &&
                  m.user_id === newMsg.user_id &&
                  m.message === newMsg.message
                )
            );
            return [...filtered.slice(-99), newMsg];
          });
          if (!expandedRef.current) setUnread((prev) => prev + 1);
          // Notify other components about incoming chat
          try {
            masterBus.emit('CHAT_MESSAGE_RECEIVED', {
              clubId,
              senderId: newMsg.user_id,
              message: newMsg.message,
            });
          } catch (err) {
            reportError(err, 'ClubChat.Error');
            /* silent */
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'ClubChat._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[ClubChat] Realtime channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (listRef.current && expanded) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, expanded]);

  // Clear unread when expanding
  useEffect(() => {
    expandedRef.current = expanded;
    if (expanded) {
      setUnread(0);
      lastSeenRef.current = messages.length;
    }
  }, [expanded, messages.length]);

  const sendMessage = async () => {
    if (!text.trim() || sending || isBannedFromChat) return;
    setSending(true);
    const tempId = `temp-${Date.now()}`;
    try {
      // Optimistic add
      const optimistic: ClubChatMessage = {
        id: tempId,
        user_id: userId,
        message: text.trim(),
        display_name: userName || 'You',
        message_type: 'message',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev.slice(-99), optimistic]);
      setText('');

      const { error } = await supabase.from('club_chat').insert({
        club_id: clubId,
        user_id: userId,
        message: optimistic.message,
        display_name: userName || 'Player',
        message_type: 'message',
      });
      if (error) {
        reportError(error, 'ClubChat.Send_error');
        /* 2026-08-26: club chat now refuses a member with an unexpired
           `blacklists` row (fn_club_chat_is_silenced, called from the INSERT
           policy). A banned member cannot read their own blacklist row -
           blacklists_select is owner/admin/agent only - so the ONLY way they
           learn is the refusal itself. 42501 is the RLS code; anything else is
           a genuine failure and keeps the old wording. */
        if ((error as { code?: string }).code === '42501') {
          setIsBannedFromChat(true);
        }
        // Mark message as failed instead of silently removing
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...m, message_type: 'failed' } : m))
        );
        // Auto-remove failed message after 4 seconds
        const tid = setTimeout(() => {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
        }, 4000);
        failedTimersRef.current.push(tid);
      }
    } catch (err) {
      reportError(err, 'ClubChat.Error');
      // Mark as failed on any exception
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, message_type: 'failed' } : m))
      );
      const tid = setTimeout(() => {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
      }, 4000);
      failedTimersRef.current.push(tid);
    } finally {
      setSending(false);
    }
  };

  if (!clubId) return null;

  return (
    <div
      style={{
        margin: '0 0 12px',
        borderRadius: 12,
        overflow: 'hidden',
        border: `1px solid ${FB.border}`,
        background: FB.card,
      }}
    >
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded((p) => !p)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <span style={{ color: FB.text, fontSize: 13, fontWeight: 700 }}>Club Chat</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {unread > 0 && (
            <span
              style={{
                background: FB.primary,
                color: '#fff',
                fontSize: 10,
                fontWeight: 800,
                minWidth: 18,
                height: 18,
                borderRadius: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 5px',
              }}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
          <span style={{ color: FB.dim, fontSize: 12 }}>{expanded ? '▼' : '▶'}</span>
        </div>
      </button>

      {/* Chat body — collapsible */}
      {expanded && (
        <div>
          <div
            aria-live="polite"
            ref={listRef}
            style={{
              height: 200,
              overflowY: 'auto',
              padding: '4px 12px',
              borderTop: `1px solid ${FB.border}`,
            }}
          >
            {messages.length === 0 ? (
              <div style={{ textAlign: 'center', color: FB.dim, fontSize: 12, padding: '40px 0' }}>
                No Messages Yet. Say Hello!
              </div>
            ) : (
              messages.map((m, i) => {
                const isMe = String(m.user_id) === String(userId);
                const isSystem = m.message_type === 'system' || m.message_type === 'announcement';
                const isFailed = m.message_type === 'failed';
                return (
                  <div key={m.id || i} style={{ marginBottom: 6 }}>
                    {isFailed ? (
                      <div style={{ opacity: 0.5 }}>
                        <span style={{ color: '#FA383E', fontSize: 11, fontWeight: 700 }}>
                          ⚠ Failed To Send
                        </span>
                        <div
                          style={{
                            color: '#FA383E',
                            fontSize: 12,
                            lineHeight: 1.4,
                            marginTop: 1,
                            textDecoration: 'line-through',
                          }}
                        >
                          {m.message}
                        </div>
                      </div>
                    ) : isSystem ? (
                      <div
                        style={{
                          textAlign: 'center',
                          color: '#F5A623',
                          fontSize: 11,
                          fontStyle: 'italic',
                          padding: '2px 0',
                        }}
                      >
                        {m.message}
                      </div>
                    ) : (
                      <div>
                        <span
                          style={{
                            color: isMe ? FB.primary : FB.success,
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          {isMe ? 'You' : m.display_name || 'Player'}
                        </span>
                        <span style={{ color: FB.dim, fontSize: 9, marginLeft: 6 }}>
                          {timeShort(m.created_at)}
                        </span>
                        <div
                          style={{ color: FB.text, fontSize: 12, lineHeight: 1.4, marginTop: 1 }}
                        >
                          {m.message}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Input */}
          <div style={{ display: 'flex', borderTop: `1px solid ${FB.border}`, padding: 6, gap: 6 }}>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 500))}
              disabled={isBannedFromChat}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) sendMessage();
              }}
              placeholder={
                isBannedFromChat ? 'You Cannot Post In This Club Chat' : 'Type A Message...'
              }
              maxLength={500}
              style={{
                flex: 1,
                background: FB.bg,
                border: `1px solid ${FB.border}`,
                borderRadius: 8,
                padding: '8px 12px',
                color: FB.text,
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              onClick={sendMessage}
              disabled={!text.trim() || sending || isBannedFromChat}
              style={{
                background: text.trim() && !isBannedFromChat ? FB.primary : FB.border,
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 700,
                cursor: text.trim() ? 'pointer' : 'default',
                opacity: sending ? 0.5 : 1,
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
