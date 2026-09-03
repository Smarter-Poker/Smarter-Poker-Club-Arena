/**
 * 🌐 FACEBOOK-STYLE UI COMPONENTS
 * Ported from World Hub Social System
 *
 * Features:
 * - Facebook color palette (light/dark themes)
 * - FBAvatar with online status indicator
 * - Messaging UI primitives
 */

import React from 'react';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

// ═══════════════════════════════════════════════════════════════════════════
// 🎨 FACEBOOK COLOR PALETTE
// ═══════════════════════════════════════════════════════════════════════════

export const FB_COLORS = {
  blue: '#1877F2',
  blueHover: '#166FE5',
  blueLight: '#E7F3FF',
  bgMain: '#F0F2F5',
  bgWhite: '#FFFFFF',
  bgHover: '#F2F2F2',
  textPrimary: '#050505',
  textSecondary: '#65676B',
  divider: '#E4E6EB',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.1)',
  // Poker accents
  pokerOrange: '#FF6B35',
  pokerGreen: '#22C55E',
  pokerGold: '#FFD700',
};

// ═══════════════════════════════════════════════════════════════════════════
// 👤 USER AVATAR WITH ONLINE STATUS
// ═══════════════════════════════════════════════════════════════════════════

interface FBAvatarProps {
  src?: string;
  name?: string;
  size?: number;
  online?: boolean;
}

export const FBAvatar: React.FC<FBAvatarProps> = ({ src, name, size = 40, online = false }) => (
  <div style={{ position: 'relative', width: size, height: size }}>
    <img
      loading="lazy"
      decoding="async"
      src={src || generateDefaultAvatar()}
      alt={name || ''}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        objectFit: 'cover',
      }}
    />
    {online && (
      <span
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: 12,
          height: 12,
          background: '#31A24C',
          border: '2px solid white',
          borderRadius: '50%',
        }}
      />
    )}
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════
// 💬 MESSAGE BUBBLE (for chat windows)
// ═══════════════════════════════════════════════════════════════════════════

interface MessageBubbleProps {
  message: {
    text: string;
    time?: string;
    reactions?: { emoji: string }[];
  };
  isOwn: boolean;
  showAvatar?: boolean;
  user?: {
    avatar?: string;
    name?: string;
  };
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isOwn,
  showAvatar,
  user,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'flex-end',
      gap: 8,
      marginBottom: 2,
      padding: '0 12px',
      flexDirection: isOwn ? 'row-reverse' : 'row',
    }}
  >
    {!isOwn && showAvatar && <FBAvatar src={user?.avatar} size={28} />}
    {!isOwn && !showAvatar && <div style={{ width: 28 }} />}

    <div
      style={{
        maxWidth: '65%',
        padding: '8px 12px',
        borderRadius: 18,
        fontSize: 15,
        lineHeight: 1.34,
        position: 'relative',
        background: isOwn ? FB_COLORS.blue : FB_COLORS.bgMain,
        color: isOwn ? 'white' : FB_COLORS.textPrimary,
        borderBottomRightRadius: isOwn ? 4 : 18,
        borderBottomLeftRadius: isOwn ? 18 : 4,
      }}
    >
      {message.text}

      {/* Reactions */}
      {message.reactions && message.reactions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: -8,
            right: 8,
            background: 'white',
            borderRadius: 10,
            padding: '2px 4px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            fontSize: 12,
          }}
        >
          {message.reactions.map((r, i) => (
            <span key={i}>{r.emoji}</span>
          ))}
        </div>
      )}
    </div>

    {/* Timestamp (on hover) */}
    <span
      style={{
        fontSize: 11,
        color: FB_COLORS.textSecondary,
        opacity: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {message.time}
    </span>
  </div>
);

export default {
  FB_COLORS,
  FBAvatar,
  MessageBubble,
};
