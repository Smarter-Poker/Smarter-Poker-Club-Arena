/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRIVATE CHAT — Direct Messaging
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1-on-1 messaging interface between players.
 * - Real-time message list
 * - Typing indicators
 * - Text-based messaging (media attachments planned for future)
 * - Online status header
 */

import React, { useState, useEffect, useRef } from 'react';
import './PrivateChat.css';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
  isSelf: boolean;
  status: 'sent' | 'delivered' | 'read';
}

export interface PrivateChatProps {
  friendId: string;
  friendName: string;
  friendAvatar?: string;
  isOnline: boolean;
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onClose: () => void;
}

export function PrivateChat({
  friendId,
  friendName,
  friendAvatar,
  isOnline,
  messages,
  onSendMessage,
  onClose,
}: PrivateChatProps) {
  const [inputText, setInputText] = useState('');
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    animTimers.current.forEach(clearTimeout);
    animTimers.current = [];
    messages.forEach((_, i) => {
      const t = setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
      animTimers.current.push(t);
    });
    return () => {
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, [messages]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText);
    setInputText('');
  };

  return (
    <div className="chat-window">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-user-info">
          <div className="chat-avatar">
            {friendAvatar ? (
              <img loading="lazy" decoding="async" src={friendAvatar} alt={friendName} />
            ) : (
              <span>{(friendName || '?')[0]?.toUpperCase() || '?'}</span>
            )}
            <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
          </div>
          <div className="chat-details">
            <h3 className="chat-username">{friendName}</h3>
            <span className="chat-status">{isOnline ? 'Online' : 'Offline'}</span>
          </div>
        </div>
        <button className="chat-close" onClick={onClose}>
          ×
        </button>
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {messages.length > 0 ? (
          messages.map((msg, i) => (
            <div
              key={msg.id}
              className={`message-row ${msg.isSelf ? 'self' : 'friend'}`}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="message-bubble">
                <p className="message-text">{msg.text}</p>
                <div className="message-meta">
                  <span className="message-time">{msg.timestamp}</span>
                  {msg.isSelf && (
                    <span className={`message-tick ${msg.status}`}>
                      {msg.status === 'read' ? '' : ''}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="chat-empty">
            <span className="empty-emoji"></span>
            <p>Say hello to {friendName}!</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form className="chat-input-area" onSubmit={handleSend}>
        <input
          type="text"
          className="chat-input"
          placeholder="Type a message..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <button type="submit" className="chat-send-btn" disabled={!inputText.trim()}>
          ➤
        </button>
      </form>
    </div>
  );
}

export default PrivateChat;
