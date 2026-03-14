/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TableChatHUD — Real-Time Table Chat Overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Ported from World Hub → Club Arena (March 2026)
 */

import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { triggerHaptic } from '../../services/HapticService';
import { masterBus } from '../../core/MasterBus';

const Z_FLOATING_CHAT = 900;

interface ChatMessage {
  id: string;
  table_id: string;
  sender_id: string;
  sender_name?: string;
  message: string;
  message_type: 'player' | 'dealer' | 'system';
  created_at: string;
}

interface TableChatHUDProps {
  tableId: string;
  userId: string;
  isMuted?: boolean;
}

export default function TableChatHUD({ tableId, userId, isMuted = false }: TableChatHUDProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [mutedPlayers, setMutedPlayers] = useState<string[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const isOpenRef = useRef(isOpen);

  useEffect(() => {
    const loadMutes = () => {
      try {
        const mutedStr = localStorage.getItem('ca_muted_players');
        setMutedPlayers(mutedStr ? JSON.parse(mutedStr) : []);
      } catch {
        /* ignore */
      }
    };
    loadMutes();
    window.addEventListener('ca_mute_updated', loadMutes);
    return () => window.removeEventListener('ca_mute_updated', loadMutes);
  }, []);

  useEffect(() => {
    if (!tableId) return;
    const loadMessages = async () => {
      const { data } = await supabase
        .from('table_chat')
        .select('*')
        .eq('table_id', tableId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (data) setMessages((data as ChatMessage[]).reverse());
    };
    loadMessages();

    const channel = supabase
      .channel(`table_chat:${tableId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'table_chat',
          filter: `table_id=eq.${tableId}`,
        },
        (payload) => {
          const msg = payload.new as ChatMessage;
          setMessages((prev) => {
            // Remove optimistic temp message from same sender to prevent duplicates
            const filtered = prev.filter(
              (m) =>
                !(
                  m.id.startsWith('temp-') &&
                  m.sender_id === msg.sender_id &&
                  m.message === msg.message
                )
            );
            return [...filtered.slice(-49), msg];
          });
          try {
            masterBus.emit('CHAT_MESSAGE_RECEIVED', {
              clubId: msg.table_id || tableId,
              senderId: msg.sender_id,
              message: msg.message,
            });
          } catch {
            /* */
          }
          if (!isOpenRef.current) {
            setUnreadCount((c) => c + 1);
            triggerHaptic(
              msg.message_type === 'dealer' || msg.message_type === 'system' ? 'warning' : 'light'
            );
          }
          setTimeout(() => {
            if (chatRef.current) {
              chatRef.current.scrollTop = chatRef.current.scrollHeight;
            }
          }, 50);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tableId]);

  useEffect(() => {
    isOpenRef.current = isOpen;
    if (isOpen && chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
      setUnreadCount(0);
    }
  }, [isOpen]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || isMuted || !userId) return;
    const text = newMessage.trim();
    setNewMessage('');
    const tempId = `temp-${Date.now()}`;
    const optMsg: ChatMessage = {
      id: tempId,
      table_id: tableId,
      sender_id: userId,
      sender_name: 'You',
      message: text,
      message_type: 'player',
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev.slice(-49), optMsg]);
    triggerHaptic('light');
    try {
      const { error } = await supabase.from('table_chat').insert({
        table_id: tableId,
        sender_id: userId,
        message: text,
        message_type: 'player',
      });
      if (error) {
        console.error('Failed to send:', error);
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
      }
    } catch {
      // Rollback on network/exception failure
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    }
  };

  const sendQuickPhrase = async (phrase: string) => {
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev.slice(-49),
      {
        id: tempId,
        table_id: tableId,
        sender_id: userId,
        sender_name: 'You',
        message: phrase,
        message_type: 'player' as const,
        created_at: new Date().toISOString(),
      },
    ]);
    triggerHaptic('light');
    try {
      const { error } = await supabase
        .from('table_chat')
        .insert({ table_id: tableId, sender_id: userId, message: phrase, message_type: 'player' });
      if (error) {
        console.error('[TableChat] Quick phrase failed:', error);
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
      }
    } catch {
      // Rollback on network/exception failure
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    }
  };

  if (isMobile && !isOpen) {
    return (
      <button onClick={() => setIsOpen(true)} style={S.chatBubble}>
        💬{unreadCount > 0 && <span style={S.badge}>{unreadCount}</span>}
      </button>
    );
  }

  return (
    <div style={{ ...S.container, ...(isMobile ? S.mobileFull : S.desktop) }}>
      <div style={S.header}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#E4E6EB' }}>Table Chat</span>
        {isMobile && (
          <button onClick={() => setIsOpen(false)} style={S.closeBtn}>
            ×
          </button>
        )}
      </div>
      <div style={S.messageList} ref={chatRef}>
        {messages.length === 0 && <div style={S.empty}>No messages yet. Say hi!</div>}
        {messages
          .filter((m) => !mutedPlayers.includes(m.sender_id))
          .map((msg) => {
            const isDealer = msg.message_type === 'dealer' || msg.message_type === 'system';
            const isMe = msg.sender_id === userId;
            return (
              <div
                key={msg.id}
                style={{
                  ...S.row,
                  justifyContent: isDealer ? 'center' : isMe ? 'flex-end' : 'flex-start',
                }}
              >
                {isDealer ? (
                  <div style={S.dealer}>
                    <span style={{ color: '#F1C40F', marginRight: 4 }}>♠️</span>
                    {msg.message}
                  </div>
                ) : (
                  <div
                    style={{
                      ...S.bubble,
                      background: isMe ? '#2374E1' : 'rgba(255,255,255,0.1)',
                      borderBottomRightRadius: isMe ? 2 : 12,
                      borderBottomLeftRadius: isMe ? 12 : 2,
                    }}
                  >
                    {!isMe && (
                      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', marginBottom: 2 }}>
                        {msg.sender_name || 'Player'}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.4,
                        wordBreak: 'break-word',
                        color: '#FFF',
                      }}
                    >
                      {msg.message}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </div>
      {isMuted ? (
        <div style={S.muted}>You are muted from table chat.</div>
      ) : (
        <form onSubmit={handleSendMessage} style={S.input}>
          <div style={{ display: 'flex', gap: 3, marginBottom: 4, flexWrap: 'wrap' }}>
            {['nh', 'ty', 'gg', 'lol', 'wp', 'gl'].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => sendQuickPhrase(p)}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  color: '#B0B3B8',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 10,
                  padding: '2px 8px',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Say something..."
              maxLength={120}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 20,
                padding: '8px 16px',
                color: '#FFF',
                fontSize: 13,
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={!newMessage.trim()}
              style={{
                background: '#2374E1',
                border: 'none',
                color: '#FFF',
                width: 32,
                height: 32,
                borderRadius: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: newMessage.trim() ? 1 : 0.5,
              }}
            >
              ➤
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255,255,255,0.1)',
    zIndex: Z_FLOATING_CHAT,
    overflow: 'hidden',
  },
  desktop: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    width: 300,
    height: 400,
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },
  mobileFull: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    background: 'rgba(0,0,0,0.9)',
    zIndex: 9999,
  },
  chatBubble: {
    position: 'absolute',
    bottom: 80,
    right: 20,
    width: 48,
    height: 48,
    borderRadius: 24,
    background: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(4px)',
    border: '1px solid rgba(255,255,255,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    color: '#FFF',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    zIndex: Z_FLOATING_CHAT,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    background: '#E74C3C',
    color: '#FFF',
    fontSize: 10,
    fontWeight: 800,
    width: 20,
    height: 20,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid #000',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    background: 'rgba(0,0,0,0.4)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#E4E6EB',
    fontSize: 24,
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
  },
  messageList: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  empty: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  row: { display: 'flex', width: '100%' },
  bubble: {
    maxWidth: '80%',
    padding: '8px 12px',
    borderRadius: 12,
    boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
  },
  dealer: {
    background: 'rgba(241,196,15,0.15)',
    border: '1px solid rgba(241,196,15,0.3)',
    color: '#F1C40F',
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 12px',
    borderRadius: 12,
    maxWidth: '90%',
    textAlign: 'center',
  },
  input: {
    display: 'flex',
    flexDirection: 'column',
    padding: '10px 12px',
    background: 'rgba(0,0,0,0.4)',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    gap: 4,
  },
  muted: {
    padding: 12,
    textAlign: 'center',
    color: '#E74C3C',
    fontSize: 11,
    fontWeight: 600,
    background: 'rgba(231,76,60,0.1)',
    borderTop: '1px solid rgba(255,255,255,0.05)',
  },
};
