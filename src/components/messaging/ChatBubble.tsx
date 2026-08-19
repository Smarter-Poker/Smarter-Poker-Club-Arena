/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHAT BUBBLE — Message Display (SNGINE-inspired)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Features: Sent/received styling, reactions, timestamp, long-press actions
 */

import { useState, useEffect, useRef } from 'react';
import { PlayerAvatar } from '../avatars/PlayerAvatar';
import { haptic } from '../../services/HapticService';
import { formatTime } from '../../lib/date';
import styles from './ChatBubble.module.css';

interface Message {
  id: string;
  userId: string;
  userFullname: string;
  userPicture: string;
  content: string;
  imageUrl?: string;
  createdAt: string;
  reactions: { [emoji: string]: number };
  myReaction?: string;
}

interface ChatBubbleProps {
  message: Message;
  isCurrentUser: boolean;
  showAvatar?: boolean;
  onReact?: (messageId: string, emoji: string) => void;
  onDelete?: (messageId: string) => void;
  onReply?: (message: any) => void;
}

// Emoji here are DATA, not decoration: this is the reaction picker, and the
// values are written to the database and rendered back on other clients.
// RULE 7 exempt for the same reason the emoji picker is.
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '😡'];

export default function ChatBubble({
  message,
  isCurrentUser,
  showAvatar = true,
  onReact,
  onDelete,
  onReply,
}: ChatBubbleProps) {
  const [showReactions, setShowReactions] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const swipeRef = useRef({ startX: 0, startY: 0, swiping: false });

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const totalReactions = Object.values(message.reactions).reduce((sum, count) => sum + count, 0);

  const handleLongPress = () => {
    setShowMenu(true);
  };

  const handleReact = (emoji: string) => {
    onReact?.(message.id, emoji);
    setShowReactions(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setShowMenu(false);
  };

  const handleDelete = () => {
    onDelete?.(message.id);
    setShowMenu(false);
  };

  // ── Swipe-to-Reply touch gesture ──
  const handleTouchStart = (e: React.TouchEvent) => {
    swipeRef.current.startX = e.touches[0].clientX;
    swipeRef.current.startY = e.touches[0].clientY;
    swipeRef.current.swiping = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - swipeRef.current.startX;
    const dy = e.touches[0].clientY - swipeRef.current.startY;
    // Only start swiping if horizontal movement > vertical
    if (!swipeRef.current.swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      swipeRef.current.swiping = true;
    }
    if (swipeRef.current.swiping) {
      // Only allow right swipe (for reply)
      const clampedDx = Math.max(0, Math.min(dx, 100));
      setSwipeX(clampedDx);
    }
  };

  const handleTouchEnd = () => {
    if (swipeX > 60 && onReply) {
      haptic.selection();
      onReply(message);
    }
    setSwipeX(0);
    swipeRef.current.swiping = false;
  };

  return (
    <div
      className={`${styles.container} ${isCurrentUser ? styles.sent : styles.received}`}
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? `translateY(0) translateX(${swipeX}px)` : 'translateY(8px)',
        transition: swipeRef.current.swiping
          ? 'opacity 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
          : 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Swipe reply indicator */}
      {swipeX > 10 && (
        <span className={styles.swipeReplyIndicator} style={{ opacity: Math.min(swipeX / 60, 1) }}>
          ↩
        </span>
      )}
      {/* Avatar (for received messages) */}
      {!isCurrentUser && showAvatar && (
        <PlayerAvatar
          src={message.userPicture}
          name={message.userFullname}
          size="sm"
          showPresence={false}
          showLevelBadge={false}
          showVipRing={false}
          alt={message.userFullname}
        />
      )}

      <div className={styles.bubbleWrapper}>
        {/* Username (for group chats) */}
        {!isCurrentUser && showAvatar && (
          <span className={styles.username}>{message.userFullname}</span>
        )}

        {/* Bubble */}
        <div
          className={styles.bubble}
          onContextMenu={(e) => {
            e.preventDefault();
            handleLongPress();
          }}
          onDoubleClick={() => setShowReactions(true)}
        >
          {/* Image */}
          {message.imageUrl && (
            <div className={styles.imageContainer}>
              <img
                loading="lazy"
                decoding="async"
                src={message.imageUrl}
                alt=""
                className={styles.image}
              />
            </div>
          )}

          {/* Text */}
          {message.content && <p className={styles.text}>{message.content}</p>}

          {/* Reactions Display */}
          {totalReactions > 0 && (
            <div className={styles.reactionsDisplay} onClick={() => setShowReactions(true)}>
              {Object.entries(message.reactions)
                .filter(([_, count]) => count > 0)
                .slice(0, 3)
                .map(([emoji]) => (
                  <span key={emoji} className={styles.reactionEmoji}>
                    {emoji}
                  </span>
                ))}
              <span className={styles.reactionCount}>{totalReactions}</span>
            </div>
          )}
        </div>

        {/* Timestamp */}
        <span className={styles.timestamp}>{formatTime(message.createdAt)}</span>

        {/* Reactions Picker */}
        {showReactions && (
          <>
            <div className={styles.overlay} onClick={() => setShowReactions(false)} />
            <div className={styles.reactionsPicker}>
              {REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  className={`${styles.reactionBtn} ${message.myReaction === emoji ? styles.active : ''}`}
                  onClick={() => {
                    haptic.light();
                    handleReact(emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Context Menu */}
        {showMenu && (
          <>
            <div className={styles.overlay} onClick={() => setShowMenu(false)} />
            <div className={styles.menu}>
              <button
                className={styles.menuItem}
                onClick={() => {
                  setShowReactions(true);
                  setShowMenu(false);
                }}
              >
                React
              </button>
              <button className={styles.menuItem} onClick={handleCopy}>
                Copy
              </button>
              {isCurrentUser && (
                <button className={`${styles.menuItem} ${styles.danger}`} onClick={handleDelete}>
                  Delete
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
