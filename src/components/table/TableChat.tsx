/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE CHAT — In-Game Chat Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium table chat featuring:
 * - Message history with auto-scroll
 * - Player mentions with highlighting
 * - Emoji support
 * - System messages (joins, wins, etc.)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import './TableChat.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ChatMessageType = 'PLAYER' | 'SYSTEM' | 'DEALER' | 'EMOJI';

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  playerId?: string;
  playerName?: string;
  playerAvatar?: string;
  content: string;
  timestamp: Date;
  isHighlighted?: boolean;
}

export interface TableChatProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  myPlayerId?: string;
  tableId?: string;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  maxMessages?: number;
  isDisabled?: boolean;
  placeholder?: string;
  isMuted?: boolean;
  unreadCount?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface MessageRowProps {
  message: ChatMessage;
  isOwnMessage: boolean;
  isNew?: boolean;
}

function MessageRow({ message, isOwnMessage, isNew = false }: MessageRowProps) {
  if (message.type === 'SYSTEM') {
    return (
      <div className="chat-message chat-message--system">
        <span className="chat-message__system-text">{message.content}</span>
      </div>
    );
  }

  if (message.type === 'DEALER') {
    return (
      <div className="chat-message chat-message--dealer">
        <span className="chat-message__dealer-icon">♠</span>
        <span className="chat-message__dealer-text">{message.content}</span>
      </div>
    );
  }

  if (message.type === 'EMOJI') {
    return (
      <div
        className={`chat-message chat-message--emoji ${isOwnMessage ? 'chat-message--own' : ''} ${isNew ? 'chat-message--emoji-pop' : ''}`}
      >
        <span className="chat-message__emoji-large">{message.content}</span>
        <span className="chat-message__sender">{message.playerName}</span>
      </div>
    );
  }

  return (
    <div
      className={`chat-message ${isOwnMessage ? 'chat-message--own' : ''} ${message.isHighlighted ? 'chat-message--highlighted' : ''} ${isNew ? 'chat-message--slide-in' : ''}`}
    >
      {!isOwnMessage && (
        <div className="chat-message__avatar">
          {message.playerAvatar ? (
            <img
              loading="lazy"
              decoding="async"
              src={message.playerAvatar}
              alt="Player avatar"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
          ) : (
            <span>{message.playerName?.[0]?.toUpperCase() || '?'}</span>
          )}
        </div>
      )}
      <div className="chat-message__bubble">
        {!isOwnMessage && <span className="chat-message__name">{message.playerName}</span>}
        <span className="chat-message__content">{message.content}</span>
        <span className="chat-message__time">{formatTime(message.timestamp)}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function TableChat({
  messages,
  onSendMessage,
  myPlayerId,
  tableId,
  isCollapsed = false,
  onToggleCollapse,
  maxMessages = 100,
  isDisabled = false,
  placeholder = 'Type a message...',
  isMuted = false,
  unreadCount = 0,
}: TableChatProps) {
  const [inputValue, setInputValue] = useState('');
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousMessagesLengthRef = useRef(0);
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef<number>(0);

  // Auto-scroll to bottom on new messages and track which are new
  useEffect(() => {
    if (messages.length > previousMessagesLengthRef.current) {
      const newIds = new Set<string>();
      const newMessages = messages.slice(previousMessagesLengthRef.current);
      newMessages.forEach((msg) => newIds.add(msg.id));
      setNewMessageIds(newIds);

      // Clear previous animation timer if still running
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current);

      // Clear animation after 600ms
      animationTimerRef.current = setTimeout(() => {
        animationTimerRef.current = null;
        setNewMessageIds(new Set());
      }, 600);
    }
    previousMessagesLengthRef.current = messages.length;
    // Only auto-scroll if user hasn't scrolled up
    if (!isScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    return () => {
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
  }, [messages.length, isScrolledUp]);

  // Track scroll position to show/hide scroll-to-bottom FAB
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsScrolledUp(distFromBottom > 60);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsScrolledUp(false);
  }, []);

  // Trim messages to max limit before rendering
  const displayMessages = [...messages]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(-maxMessages);

  // Handle send
  const handleSend = useCallback(() => {
    const now = Date.now();
    if (now - lastSentRef.current < 300) return; // 300ms cooldown
    lastSentRef.current = now;

    if (inputValue.trim() && !isDisabled) {
      onSendMessage(inputValue.trim());
      setInputValue('');
    }
  }, [inputValue, isDisabled, onSendMessage]);

  // Handle key press
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // When muted, don't render the chat at all — just a silent icon
  if (isMuted) {
    return (
      <button
        className="chat-collapsed chat-collapsed--muted"
        onClick={onToggleCollapse}
        title="Chat is muted"
      >
        <span className="chat-collapsed__icon" style={{ opacity: 0.4 }}>
          ✉
        </span>
      </button>
    );
  }

  if (isCollapsed) {
    return (
      <button className="chat-collapsed" onClick={onToggleCollapse}>
        <span className="chat-collapsed__icon">✉</span>
        {unreadCount > 0 && <span className="chat-collapsed__badge">{unreadCount}</span>}
      </button>
    );
  }

  return (
    <div className="table-chat">
      {/* Header */}
      <div className="table-chat__header">
        <span className="table-chat__title">Table Chat</span>
        <button className="table-chat__minimize" onClick={onToggleCollapse} title="Minimize chat">
          ▾
        </button>
      </div>

      {/* Messages */}
      <div className="table-chat__messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {displayMessages.length === 0 ? (
          <div className="table-chat__empty">
            <span>No Messages Yet</span>
            <span>Be The First To Say Hello! </span>
          </div>
        ) : (
          displayMessages.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              isOwnMessage={msg.playerId === myPlayerId}
              isNew={newMessageIds.has(msg.id)}
            />
          ))
        )}
        <div ref={messagesEndRef} />

        {/* Scroll-to-bottom FAB */}
        {isScrolledUp && (
          <button
            className="table-chat__scroll-fab"
            onClick={scrollToBottom}
            title="Jump to latest"
          >
            ↓
          </button>
        )}
      </div>

      {/* Input */}

      <div className="table-chat__input-container">
        {/* Emoji toggle removed */}
        <input
          ref={inputRef}
          type="text"
          className="table-chat__input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyPress}
          placeholder={placeholder}
          disabled={isDisabled}
          maxLength={200}
        />
        <button
          className="table-chat__send"
          onClick={handleSend}
          disabled={!inputValue.trim() || isDisabled}
        >
          ➤
        </button>
      </div>
    </div>
  );
}

export default TableChat;
