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

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import './TableChat.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { useButtonImage } from '../../hooks/useButtonImage';
import QuickChatPresets from './QuickChatPresets';
/**
 * The microphone. Voice chat is a separate agent's component with a fixed
 * contract - `<VoiceControls tableId={...} userId={...} />` - and it is
 * entirely self-contained: its own stylesheet, its own hook, its own
 * push-to-talk button and speaking roster. This file only gives it a slot in
 * the header, to the LEFT of the close X.
 *
 * The import is static because the file EXISTS: a stub that renders nothing
 * was written at that exact path (VoiceControls.tsx) so the sheet could ship
 * before voice did. The voice agent overwrites it wholesale. A lazy/optional
 * import would only convert a compile error into a silent blank at runtime,
 * which is the harder failure to notice.
 */
import VoiceControls from './VoiceControls';

/**
 * ChatBubbleIcon renders the custom chat bubbles image provided by Dan.
 * The image has a dark background that blends naturally with the dark button.
 */
function ChatBubbleIcon() {
  const chatIcon = useButtonImage('icon-chat');

  return <img src={chatIcon} className="chat-collapsed__icon-img" alt="" draggable={false} />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ChatMessageType = 'PLAYER' | 'SYSTEM' | 'DEALER' | 'EMOJI';

/**
 * How long the compose box refuses a second send.
 *
 * Must stay >= `RATE_LIMIT_MS` in `useTableChat`. That one is the real limit
 * (it guards the database write); this one exists so the refusal happens while
 * the player's text is still in the box. If this drops below it, messages
 * silently disappear again.
 */
export const SEND_COOLDOWN_MS = 1000;

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  playerId?: string;
  playerName?: string;
  playerAvatar?: string;
  content: string;
  timestamp: Date;
  isHighlighted?: boolean;
  /**
   * The insert into `table_chat` was refused.
   *
   * Before 2026-08-25 a failed send was handled by filtering the optimistic
   * message out of the list. The player typed a line, watched it appear, and
   * watched it disappear with no explanation and nothing in the UI to say why.
   * That is a failed write rendered as an empty success state, which is exactly
   * what the house rules forbid one layer up in the query code.
   *
   * `club_chat` already had the right treatment for this and table chat did not;
   * this is that treatment.
   */
  isFailed?: boolean;
}

export interface TableChatProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  myPlayerId?: string;
  /**
   * The table this chat belongs to.
   *
   * It was marked `@deprecated - accepted and never read` until 2026-08-27,
   * and the note asked TablePage to stop passing it. It is read again now, and
   * for a reason that is not chat's: the microphone in the sheet header is a
   * voice ROOM, and a voice room is per table. `VoiceControls` needs the id and
   * this is the only prop that carries it. Do not remove it from the call site.
   *
   * Text messaging still does not use it - the subscription, the insert and the
   * per-table filtering all live in `useTableChat`.
   */
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
      className={`chat-message ${isOwnMessage ? 'chat-message--own' : ''} ${message.isHighlighted ? 'chat-message--highlighted' : ''} ${isNew ? 'chat-message--slide-in' : ''} ${message.isFailed ? 'chat-message--failed' : ''}`}
    >
      {!isOwnMessage && (
        <div className="chat-message__avatar">
          {message.playerAvatar ? (
            <img
              loading="lazy"
              decoding="async"
              src={message.playerAvatar}
              alt="Player Avatar"
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
        {/* The one thing the player needs to know, in the place they are already
            looking. `role="status"` because it is an outcome, not decoration:
            the whole point is that a failed send is no longer silent. */}
        {message.isFailed && (
          <span className="chat-message__failed" role="status">
            Not Sent
          </span>
        )}
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
  /* `inputRef` used to live here, attached to the compose box and read by
     nothing. Removed rather than given a job: the only job on offer was
     autofocus on open, and on a phone that pops the software keyboard over a
     live hand the moment somebody glances at chat. */
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
    /* AUDIT 2026-08-25 — the cleanup that used to live here ran on EVERY re-run
       of this effect, not just on unmount, and `isScrolledUp` is one of its
       dependencies. So: a message arrives, the 600ms "new" timer starts, the
       player scrolls the panel a pixel, `isScrolledUp` flips, the cleanup kills
       the timer, and the effect body does not start another one because
       `messages.length` has not moved. `newMessageIds` is then never emptied and
       those messages keep their slide-in class for the rest of the session.

       The unmount cleanup that the return was really for is its own effect
       below, where it cannot be re-run by anything. */
  }, [messages.length, isScrolledUp]);

  useEffect(
    () => () => {
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    },
    []
  );

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

  /* Trim messages to max limit before rendering.
     Memoised because this component is a child of TablePage, which re-renders
     on every snapshot, every chip animation and — until the action clock was
     fixed today — thirty times a second for the whole of anybody's turn. A
     hundred-element copy, sort and slice on each of those is work nobody asked
     for, and it also produced a brand-new array identity every time, which is
     what stopped any downstream memo from ever holding. */
  const displayMessages = useMemo(
    () =>
      [...messages]
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        .slice(-maxMessages),
    [messages, maxMessages]
  );

  /**
   * The one send path. The compose box and the quick-chat presets BOTH go
   * through it, so a preset is rate-limited, filtered, bubbled over the seat
   * and marked as failed exactly like a typed line. A preset that took its own
   * route to the database would be a second definition of "send a message".
   *
   * Returns false when the send was REFUSED, which is what lets the preset row
   * tell the difference between "sent" and "swallowed".
   */
  const sendText = useCallback(
    (raw: string): boolean => {
      const text = raw.trim();
      if (!text || isDisabled) return false;
      const now = Date.now();
      /* SEND_COOLDOWN_MS, not the 300 this was.
         There are TWO rate limiters on this path and they disagreed. This one
         cleared the input at 300ms; `useTableChat.handleSendChatMessage` then
         refused anything inside 1000ms and returned in silence. So a player
         typing two quick messages had the second one taken out of the box and
         thrown away, with no message, no toast and no way to get the text back.
         Matching the hook's window means the refusal happens HERE, before the
         input is cleared, so the text stays where the player can send it again. */
      if (now - lastSentRef.current < SEND_COOLDOWN_MS) return false;
      lastSentRef.current = now;
      onSendMessage(text);
      return true;
    },
    [isDisabled, onSendMessage]
  );

  // Handle send from the compose box
  const handleSend = useCallback(() => {
    if (sendText(inputValue)) setInputValue('');
  }, [inputValue, sendText]);

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
  /**
   * ONE close per open cycle.
   *
   * There are now three ways out - the X, the backdrop, Escape - and the
   * backdrop is inside the document `mousedown` listener's definition of
   * "outside the panel" as well as carrying its own handler. One tap on the
   * backdrop therefore reaches `handleClose` twice, and `onToggleCollapse` is a
   * TOGGLE: two calls that each read a stale `isChatCollapsed` happen to
   * cancel out today only because TablePage's handler is not a functional
   * update. That is an accident, not a guarantee, and the failure mode is
   * "chat closes and instantly reopens". The latch makes the second call a
   * no-op; it is released whenever the open state actually changes.
   */
  const closingRef = useRef(false);

  const handleClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    onToggleCollapse?.();
  }, [onToggleCollapse]);

  const isOpen = !isCollapsed && !isMuted;

  useEffect(() => {
    closingRef.current = false;
  }, [isOpen]);

  /* Drag-down-to-dismiss, matching HandDetailModal and common/BottomSheet:
     past 100px of downward travel the sheet closes, anything less springs
     back. The transform is applied ONLY while a drag is in flight, so the CSS
     open animation is untouched on every other frame. */
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef(0);

  useEffect(() => {
    if (!isOpen) {
      setDragY(0);
      setDragging(false);
    }
  }, [isOpen]);

  const onGrabDown = useCallback((e: React.PointerEvent) => {
    dragStartY.current = e.clientY;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onGrabMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dy = e.clientY - dragStartY.current;
      if (dy > 0) setDragY(dy);
    },
    [dragging]
  );

  const onGrabUp = useCallback(() => {
    setDragging(false);
    if (dragY > 100) handleClose();
    setDragY(0);
  }, [dragY, handleClose]);

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
        title="Chat Is Muted"
        aria-label="Chat Is Muted"
      >
        <span className="chat-collapsed__icon" style={{ opacity: 0.4 }}>
          <ChatBubbleIcon />
        </span>
      </button>
    );
  }

  if (isCollapsed) {
    return (
      <button
        className="chat-collapsed"
        onClick={onToggleCollapse}
        aria-label={
          unreadCount > 0
            ? `Open Table Chat, ${unreadCount.toLocaleString()} Unread`
            : 'Open Table Chat'
        }
      >
        <span className="chat-collapsed__icon">
          <ChatBubbleIcon />
        </span>
        {/* The badge is an 18px circle. Beyond two digits the number stops
            fitting and starts stretching the pill across the chat glyph, and
            "how many exactly" was never the point past that. */}
        {unreadCount > 0 && (
          <span className="chat-collapsed__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>
    );
  }

  /* Only while a drag is in flight. An unconditional inline transform would
     override the CSS slide-up and the sheet would appear without animating. */
  const sheetStyle: React.CSSProperties | undefined = dragY
    ? {
        transform: `translateY(${dragY}px)`,
        transition: dragging ? 'none' : 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }
    : undefined;

  return (
    <>
      {/* The backdrop. Dan 2026-08-27 asked for the same shape the Previous
          Hand sheet just got: three quarters of the height, so the exposed
          quarter above it is a real target you can tap to dismiss.

          It is also what makes the sheet MODAL - while chat is open the table
          underneath must not take taps, which is the whole reason the sheet is
          allowed above the action panel (see TableChat.css, THE Z-INDEX
          DECISION). `mousedown`, not `click`, to match the document listener
          below and the rest of the table's dismissal convention. */}
      <div className="table-chat-backdrop" onMouseDown={handleClose} aria-hidden="true" />

      <div
        className="table-chat"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Table Chat"
        style={sheetStyle}
      >
        {/* Grab handle — the affordance that says "this drags". */}
        <div
          className="table-chat__grab"
          aria-hidden="true"
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
        >
          <span />
        </div>

        {/* Header */}
        <div className="table-chat__header">
          {/* THE MICROPHONE, on the left of the row (Dan 2026-08-27: "there
              should also be a microphone for voice as well"). The slot is a
              flex child that is allowed to grow, so the voice agent's
              push-to-talk button and its speaking roster have somewhere to go
              without the title or the X moving. */}
          <div className="table-chat__voice">
            <VoiceControls tableId={tableId} userId={myPlayerId ?? ''} />
          </div>
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
            title="Close Chat"
            aria-label="Close Chat"
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
              title="Jump To Latest"
              aria-label="Jump To Latest Message"
            >
              &#8595;
            </button>
          )}
        </div>

        {/* One-tap phrases. Typing on a phone while a hand is running means the
            software keyboard over the felt and an action clock that does not
            wait; a preset is a single tap. Same send path as the box below. */}
        <QuickChatPresets onSend={sendText} disabled={isDisabled} cooldownMs={SEND_COOLDOWN_MS} />

        {/* Input */}

        <div className="table-chat__input-container">
          {/* Emoji toggle removed */}
          <input
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
            aria-label="Send Message"
            title="Send"
          >
            &#10148;
          </button>
        </div>
      </div>
    </>
  );
}

export default TableChat;
