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

/**
 * Dan 2026-08-21 (bug list item 5): "change the email icon for chat into a true
 * chat icon — like the shape we have now for our messenger in the global
 * header, but white."
 *
 * The collapsed chat button was the ✉ envelope glyph, which reads as mail, not
 * as a conversation. This is the global header's messenger mark — the rounded
 * speech bubble with the tail at the bottom-left and the double-chevron bolt —
 * drawn as vector so it can be pure white at any size, rather than reusing the
 * header's brushed-metal PNG.
 */
function ChatBubbleIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 2.2C6.42 2.2 2 6.42 2 11.6c0 2.9 1.4 5.5 3.62 7.2v3.4l3.35-1.84c.96.27 1.98.41 3.03.41 5.58 0 10-4.22 10-9.4S17.58 2.2 12 2.2z"
        fill="#ffffff"
      />
      <path
        d="M6.5 14.9l3.85-4.05 2.28 2.35 3.37-2.35-3.85 4.05-2.28-2.35L6.5 14.9z"
        fill="#0f1420"
      />
    </svg>
  );
}

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
  const panelRef = useRef<HTMLDivElement>(null);
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

  /**
   * Dan 2026-08-23: "THERE IS NO 'X' OFF ONCE ITS OPEN, YOU SHOULD BE ABLE TO
   * CLICK THE X OR CLICK ANYWHERE ELSE ON THE SCREEN TO CLOSE IT."
   *
   * The panel had exactly one control, a "▾" titled "Minimize chat", and no
   * dismissal of any other kind: no X, no outside click, no Escape. On a phone
   * that chevron is a 22px target sitting over a live table, so a player who
   * opened chat mid-hand had to hit it precisely or play the rest of the hand
   * around a 280px box.
   *
   * Both listeners follow TableMenu.tsx (lines 332-353) deliberately — mousedown
   * for outside, keydown for Escape, both attached only while open — so the
   * table has ONE dismissal convention rather than two that drift apart.
   *
   * mousedown, not click: a click fires only after mouseup on the same element,
   * so a press that starts outside and drifts onto the panel would not dismiss.
   * mousedown also beats the action panel's own handlers to the event, which is
   * what makes "tap a bet button while chat is open" close chat and still land
   * the bet on the next tap rather than being swallowed.
   */
  const handleClose = useCallback(() => {
    onToggleCollapse?.();
  }, [onToggleCollapse]);

  const isOpen = !isCollapsed && !isMuted;

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, handleClose]);

  // When muted, don't render the chat at all — just a silent icon
  if (isMuted) {
    return (
      <button
        className="chat-collapsed chat-collapsed--muted"
        onClick={onToggleCollapse}
        title="Chat is muted"
      >
        <span className="chat-collapsed__icon" style={{ opacity: 0.4 }}>
          <ChatBubbleIcon />
        </span>
      </button>
    );
  }

  if (isCollapsed) {
    return (
      <button className="chat-collapsed" onClick={onToggleCollapse} aria-label="Open table chat">
        <span className="chat-collapsed__icon">
          <ChatBubbleIcon />
        </span>
        {unreadCount > 0 && <span className="chat-collapsed__badge">{unreadCount}</span>}
      </button>
    );
  }

  return (
    <div className="table-chat" ref={panelRef} role="dialog" aria-label="Table chat">
      {/* Header */}
      <div className="table-chat__header">
        <span className="table-chat__title">Table Chat</span>
        {/* The "▾" that used to live here read as MINIMIZE, and Dan's report is
            that there was no way to turn chat off. Same callback, but now it
            says what it does and is a 32px target instead of a 22px chevron.
            &#10005; is the multiplication X GameLobbyPanel's close already uses
            — one X glyph across the app, and no emoji (house rule: emoji break
            the SWC compiler). */}
        <button
          className="table-chat__close"
          onClick={handleClose}
          title="Close chat"
          aria-label="Close chat"
        >
          &#10005;
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
