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
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './TableChat.css';

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
  tableId?: string; // Enhancement #4: filter bus messages by table
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  maxMessages?: number;
  isDisabled?: boolean;
  placeholder?: string;
  isMuted?: boolean;
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

// Quick emoji buttons (REMOVED as per request)
const QUICK_EMOJIS: string[] = [];

// Quick Chat preset phrases for one-tap sending (REMOVED as per request)
const QUICK_CHAT_PHRASES: string[] = [];

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
            <img loading="lazy" decoding="async" src={message.playerAvatar} alt="Player avatar" />
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
}: TableChatProps) {
  const [inputValue, setInputValue] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousMessagesLengthRef = useRef(0);
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });

    return () => {
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
  }, [messages.length]);

  // ── Internal state for bus-received messages from other players ──
  const [busMessages, setBusMessages] = useState<ChatMessage[]>([]);

  // ── Bus listener: receive incoming chat messages from other players ──
  useMasterBusSubscription('TABLE_CHAT_MESSAGE', (data: any) => {
    // QuickChatPresets emits { tableId, userId, message, type }
    // Guard: if myPlayerId is undefined, skip to prevent own-message duplication
    // Enhancement #4: filter by tableId to prevent cross-table message leaks
    if (
      data &&
      myPlayerId &&
      data.userId !== myPlayerId &&
      (!tableId || data.tableId === tableId)
    ) {
      setBusMessages((prev) => {
        const newMsg: ChatMessage = {
          id: `bus-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'PLAYER',
          playerId: data.userId,
          playerName: data.playerName || 'Player',
          content: data.message,
          timestamp: new Date(),
        };
        return [...prev, newMsg].slice(-50); // Cap at 50 bus messages
      });
    }
  });

  useMasterBusSubscription('TABLE_REACTION', (data: any) => {
    // QuickChatPresets emits { tableId, userId, emoji }
    if (
      data &&
      myPlayerId &&
      data.userId !== myPlayerId &&
      (!tableId || data.tableId === tableId)
    ) {
      setBusMessages((prev) => {
        const reactionMsg: ChatMessage = {
          id: `react-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'EMOJI',
          playerId: data.userId,
          playerName: data.playerName || 'Player',
          content: data.emoji || '👏',
          timestamp: new Date(),
        };
        return [...prev, reactionMsg].slice(-50);
      });
    }
  });

  useMasterBusSubscription('PRE_ACTION_EXECUTED', (data: any) => {
    if (data && (!tableId || data.tableId === tableId)) {
      const actionText =
        data.action === 'fold'
          ? 'auto-folded'
          : data.action === 'check'
            ? 'auto-checked'
            : 'auto-called';

      setBusMessages((prev) => {
        const sysMsg: ChatMessage = {
          id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'SYSTEM',
          content: `Player ${data.playerId.substring(0, 4)} ${actionText}`,
          timestamp: new Date(),
        };
        return [...prev, sysMsg].slice(-50);
      });
    }
  });

  useMasterBusSubscription('STRADDLE_TOGGLED', (data: any) => {
    if (data && (!tableId || data.tableId === tableId)) {
      setBusMessages((prev) => {
        const sysMsg: ChatMessage = {
          id: `sys-straddle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'SYSTEM',
          content: `Player ${data.playerId.substring(0, 4)} turned ${data.enabled ? 'ON' : 'OFF'} Auto-Straddle`,
          timestamp: new Date(),
        };
        return [...prev, sysMsg].slice(-50);
      });
    }
  });

  useMasterBusSubscription('TIME_BANK_ACTIVATED', (data: any) => {
    if (data && (!tableId || data.tableId === tableId)) {
      setBusMessages((prev) => {
        const sysMsg: ChatMessage = {
          id: `sys-timebank-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'SYSTEM',
          content: `Player ${data.playerId.substring(0, 4)} activated Time Bank (+${data.addedSeconds}s)`,
          timestamp: new Date(),
        };
        return [...prev, sysMsg].slice(-50);
      });
    }
  });

  // Merge prop messages with bus-received messages, trim to max
  const allMessages = [...messages, ...busMessages].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );
  const displayMessages = allMessages.slice(-maxMessages);

  // Handle send
  const handleSend = useCallback(() => {
    if (inputValue.trim() && !isDisabled) {
      onSendMessage(inputValue.trim());
      setInputValue('');
      setShowEmojis(false);
    }
  }, [inputValue, isDisabled, onSendMessage]);

  // Handle key press
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Quick emoji click
  const handleQuickEmoji = (emoji: string) => {
    onSendMessage(emoji);
    setShowEmojis(false);
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
        {messages.length > 0 && <span className="chat-collapsed__badge">{messages.length}</span>}
      </button>
    );
  }

  return (
    <div className="table-chat">
      {/* Header */}
      <div className="table-chat__header">
        <span className="table-chat__title">Table Chat</span>
        <div className="table-chat__actions">
          {onToggleCollapse && (
            <button className="table-chat__minimize" onClick={onToggleCollapse}>
              —
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="table-chat__messages">
        {displayMessages.length === 0 ? (
          <div className="table-chat__empty">
            <span>No messages yet</span>
            <span>Be the first to say hello! </span>
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
      </div>

      {/* Quick Emojis removed */}

      {/* Input */}
      {/* Quick Chat Phrases removed */}

      <div className="table-chat__input-container">
        {/* Emoji toggle removed */}
        <input
          ref={inputRef}
          type="text"
          className="table-chat__input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
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
