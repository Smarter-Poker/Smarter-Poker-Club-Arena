/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TableChatHUD — Real-Time Table Chat Overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Ported from World Hub → Club Arena (March 2026)
 */

import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { STORAGE_KEYS } from '../../lib/storage';
import { triggerHaptic } from '../../services/HapticService';
import { masterBus } from '../../core/MasterBus';
import { useIsMounted } from '../../hooks/useIsMounted';
import type { ChatMessage } from './TableChat';

const Z_FLOATING_CHAT = 900;

interface TableChatHUDProps {
  tableId: string;
  userId: string;
  isMuted?: boolean;
  messages: ChatMessage[];
  onSendMessage: (msg: string) => void;
}

export default function TableChatHUD({
  tableId,
  userId,
  isMuted = false,
  messages,
  onSendMessage,
}: TableChatHUDProps) {
  const [newMessage, setNewMessage] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [mutedPlayers, setMutedPlayers] = useState<string[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
  const isOpenRef = useRef(isOpen);
  const prevMessageCountRef = useRef(messages.length);

  useEffect(() => {
    const loadMutes = () => {
      try {
        const mutedStr = localStorage.getItem(STORAGE_KEYS.MUTED_PLAYERS);
        setMutedPlayers(mutedStr ? JSON.parse(mutedStr) : []);
      } catch (err) {
        console.error('[TableChatHUD] Error:', err);
        /* ignore */
      }
    };
    loadMutes();
    window.addEventListener('ca_mute_updated', loadMutes);
    return () => window.removeEventListener('ca_mute_updated', loadMutes);
  }, []);

  // Unread badge logic based on incoming props messages
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current) {
      if (!isOpenRef.current) {
        setUnreadCount((c) => c + 1);
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.type) {
          triggerHaptic(
            lastMsg.type === 'DEALER' || lastMsg.type === 'SYSTEM' ? 'warning' : 'light'
          );
        } else {
          triggerHaptic('light');
        }
      }
      setTimeout(() => {
        if (chatRef.current) {
          chatRef.current.scrollTop = chatRef.current.scrollHeight;
        }
      }, 50);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    isOpenRef.current = isOpen;
    if (isOpen && chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
      setUnreadCount(0);
    }
  }, [isOpen]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || isMuted || !userId) return;
    const text = newMessage.trim();
    setNewMessage('');
    onSendMessage(text);
  };

  // Removed sendQuickPhrase entirely

  if (!isOpen) {
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
        <button onClick={() => setIsOpen(false)} style={S.closeBtn}>
          ×
        </button>
      </div>
      <div style={S.messageList} ref={chatRef} aria-live="polite">
        {messages.length === 0 && <div style={S.empty}>No messages yet. Say hi!</div>}
        {messages
          .filter((m) => !mutedPlayers.includes(m.playerId || ''))
          .map((msg) => {
            const isDealer = msg.type === 'DEALER' || msg.type === 'SYSTEM';
            const isMe = msg.playerId === userId;
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
                    {msg.content}
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
                        {msg.playerName || 'Player'}
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
                      {msg.content}
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
          {/* Quick Chat Phrases removed */}
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
