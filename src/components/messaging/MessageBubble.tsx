/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGE BUBBLE — Enhanced message display with reactions, threading, and images
 * ═══════════════════════════════════════════════════════════════════════════════
 * Features: Sender info, reactions, thread indicator, image support, rich interactions
 */

import { useState, useEffect, ReactNode } from 'react';
import styles from './ChatBubble.module.css';
import { ImageThumbnail, ImageLightbox } from './ImageMessage';
import EmojiReactions from './EmojiReactions';
import { ReadReceipt } from './ReadReceipt';
import LinkPreview, { extractUrl } from './LinkPreview';

interface Reaction {
  emoji: string;
  userId: string;
  userName: string;
  timestamp: number;
}

interface Message {
  id: string;
  userId: string;
  userFullname: string;
  userPicture: string;
  content: string;
  imageUrl?: string;
  audioUrl?: string;
  createdAt: string;
  reactions: { [emoji: string]: number };
  myReaction?: string;
  reactionDetails?: Reaction[];
  threadReplyCount?: number;
  isSeen?: boolean;
  isEdited?: boolean;
}

interface MessageBubbleProps {
  message: Message;
  isCurrentUser: boolean;
  showAvatar?: boolean;
  onReact?: (messageId: string, emoji: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, newContent: string) => void;
  onReply?: (messageId: string) => void;
  onForward?: (messageId: string) => void;
  onViewThread?: (messageId: string) => void;
}

export default function MessageBubble({
  message,
  isCurrentUser,
  showAvatar = true,
  onReact,
  onDelete,
  onEdit,
  onReply,
  onForward,
  onViewThread,
}: MessageBubbleProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const formatTime = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const linkifyText = (text: string): (string | ReactNode)[] => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    return parts.map((part, idx) => {
      // Use a fresh regex for test() to avoid stateful lastIndex with /g
      if (/^https?:\/\//.test(part)) {
        return (
          <a
            key={idx}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
            onClick={(e) => e.stopPropagation()}
          >
            {part.replace(/^https?:\/\//, '')}
          </a>
        );
      }
      return part;
    });
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setShowMenu(false);
  };

  const handleDelete = () => {
    onDelete?.(message.id);
    setShowMenu(false);
  };

  const handleReply = () => {
    onReply?.(message.id);
    setShowMenu(false);
  };

  const handleForward = () => {
    onForward?.(message.id);
    setShowMenu(false);
  };

  const handleStartEdit = () => {
    setEditText(message.content);
    setIsEditing(true);
    setShowMenu(false);
  };

  const handleSaveEdit = () => {
    if (editText.trim() && editText.trim() !== message.content) {
      onEdit?.(message.id, editText.trim());
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditText(message.content);
    setIsEditing(false);
  };

  // Can edit within 5-minute window
  const canEdit =
    isCurrentUser && onEdit && Date.now() - new Date(message.createdAt).getTime() < 5 * 60 * 1000;

  const handleLongPress = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
  };

  return (
    <div
      className={`${styles.container} ${isCurrentUser ? styles.sent : styles.received}`}
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      {/* Avatar (for received messages) */}
      {!isCurrentUser && showAvatar && (
        <img
          loading="lazy"
          decoding="async"
          src={message.userPicture}
          alt={message.userFullname}
          className={styles.avatar}
          onError={(e) => {
            (e.target as HTMLImageElement).src = '/default-avatar.png';
          }}
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
          onContextMenu={handleLongPress}
          onDoubleClick={() => onReact?.(message.id, message.myReaction || '👍')}
        >
          {/* Image */}
          {message.imageUrl && (
            <div className={styles.imageContainer}>
              <ImageThumbnail imageUrl={message.imageUrl} onClick={() => setShowLightbox(true)} />
            </div>
          )}

          {/* Audio */}
          {message.audioUrl && (
            <div className={styles.audioContainer}>
              <audio
                controls
                src={message.audioUrl}
                style={{ width: '100%', maxWidth: '240px', height: '40px' }}
              />
            </div>
          )}

          {/* Text */}
          {message.content &&
            (message.content.startsWith('📇 Shared contact card') ? (
              <div
                className={styles.contactCard}
                style={{
                  background:
                    'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))',
                  borderRadius: '12px',
                  padding: '10px 14px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: '1.1rem' }}>📇</span>
                <span style={{ fontWeight: 600, marginLeft: 6 }}>
                  {message.content
                    .replace('📇 Shared contact card — ', '')
                    .replace(/\/profile\/.*/, 'Profile Card') || 'Contact'}
                </span>
                <span style={{ display: 'block', fontSize: '0.75rem', opacity: 0.6, marginTop: 2 }}>
                  Tap to view profile
                </span>
              </div>
            ) : isEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  autoFocus
                  rows={2}
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(0,212,255,0.3)',
                    borderRadius: '8px',
                    color: '#fff',
                    padding: '6px 8px',
                    fontSize: '0.85rem',
                    resize: 'none',
                    outline: 'none',
                    width: '100%',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveEdit();
                    }
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                />
                <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={handleCancelEdit}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'rgba(255,255,255,0.5)',
                      fontSize: '0.7rem',
                      cursor: 'pointer',
                      padding: '2px 6px',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    style={{
                      background: 'rgba(0,212,255,0.2)',
                      border: '1px solid rgba(0,212,255,0.3)',
                      borderRadius: '6px',
                      color: '#00d4ff',
                      fontSize: '0.7rem',
                      cursor: 'pointer',
                      padding: '2px 8px',
                      fontWeight: 600,
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <p className={styles.text}>{linkifyText(message.content)}</p>
            ))}

          {/* Q3: Link Preview */}
          {message.content && extractUrl(message.content) && (
            <LinkPreview url={extractUrl(message.content)!} />
          )}
        </div>

        {/* Timestamp + Read Receipt */}
        <span className={styles.timestamp}>
          {formatTime(message.createdAt)}
          {message.isEdited && (
            <span style={{ opacity: 0.5, marginLeft: 4, fontSize: '0.65rem' }}>(edited)</span>
          )}
          {isCurrentUser && <ReadReceipt status={message.isSeen ? 'seen' : 'delivered'} />}
        </span>

        {/* Reactions */}
        {Object.values(message.reactions).reduce((sum, count) => sum + count, 0) > 0 && (
          <div className={styles.reactionsWrapper}>
            <EmojiReactions
              reactions={message.reactions}
              myReaction={message.myReaction}
              onReact={(emoji) => onReact?.(message.id, emoji)}
              reactionDetails={message.reactionDetails}
            />
          </div>
        )}

        {/* Thread Indicator */}
        {message.threadReplyCount ? (
          <button className={styles.threadIndicator} onClick={() => onViewThread?.(message.id)}>
            {message.threadReplyCount} {message.threadReplyCount === 1 ? 'reply' : 'replies'} →
          </button>
        ) : null}

        {/* Context Menu */}
        {showMenu && (
          <>
            <div className={styles.overlay} onClick={() => setShowMenu(false)} />
            <div className={styles.menu}>
              <button className={styles.menuItem} onClick={handleReply}>
                Reply
              </button>
              <button
                className={styles.menuItem}
                onClick={() => {
                  onReact?.(message.id, message.myReaction || '👍');
                  setShowMenu(false);
                }}
              >
                React
              </button>
              <button className={styles.menuItem} onClick={handleCopy}>
                Copy
              </button>
              <button className={styles.menuItem} onClick={handleForward}>
                ↪ Forward
              </button>
              {isCurrentUser && canEdit && (
                <button className={styles.menuItem} onClick={handleStartEdit}>
                  ✏️ Edit
                </button>
              )}
              {isCurrentUser && (
                <button className={`${styles.menuItem} ${styles.danger}`} onClick={handleDelete}>
                  Delete
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Lightbox */}
      {showLightbox && message.imageUrl && (
        <ImageLightbox imageUrl={message.imageUrl} onClose={() => setShowLightbox(false)} />
      )}
    </div>
  );
}
