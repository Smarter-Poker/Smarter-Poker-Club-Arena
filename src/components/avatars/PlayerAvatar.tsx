/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ PLAYER AVATAR — Q3 Social Upgrade (Phase 1: Avatar Revolution)
 *
 * Composite avatar component with:
 *   - VIP status ring (color-coded glow border)
 *   - Animated presence dot (pulsing, integrated into the ring)
 *   - Level badge (metallic gradient pill)
 *   - "Playing Now" indicator (poker chip icon)
 *
 * Replaces basic Avatar across all Q3 social surfaces.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useMemo } from 'react';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import './PlayerAvatar.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type VipTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
export type PresenceStatus = 'online' | 'away' | 'playing' | 'offline';
export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface PlayerAvatarProps {
  /** Avatar image URL */
  src?: string;
  /** Player display name (used for initials fallback) */
  name?: string;
  /** Alt text for accessibility */
  alt?: string;

  /** Size variant */
  size?: AvatarSize;

  /** VIP tier for status ring color */
  vipTier?: VipTier;
  /** Player level (displayed in badge) */
  level?: number;

  /** Online presence status */
  presenceStatus?: PresenceStatus;
  /** Show presence dot */
  showPresence?: boolean;
  /** Show "Playing Now" chip indicator */
  isPlaying?: boolean;

  /** Show level badge */
  showLevelBadge?: boolean;
  /** Show VIP status ring */
  showVipRing?: boolean;

  /** Click handler */
  onClick?: () => void;
  /** Custom className */
  className?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POKER CHIP SVG (for "Playing Now" indicator)
// ═══════════════════════════════════════════════════════════════════════════════

const PokerChipIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6.5" fill="none" stroke="white" strokeWidth="1.5" />
    <circle cx="8" cy="8" r="4" fill="white" />
    <text x="8" y="10.5" textAnchor="middle" fontSize="7" fontWeight="bold" fill="#3b82f6">
      ♠
    </text>
  </svg>
);

// ═══════════════════════════════════════════════════════════════════════════════
// SIZE MAP (for SVG ring dimensions)
// ═══════════════════════════════════════════════════════════════════════════════

const SIZE_PX: Record<AvatarSize, number> = {
  xs: 28,
  sm: 36,
  md: 48,
  lg: 64,
  xl: 84,
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const PlayerAvatar: React.FC<PlayerAvatarProps> = ({
  src,
  name,
  alt = 'Player avatar',
  size = 'md',
  vipTier = 'bronze',
  level = 1,
  presenceStatus = 'offline',
  showPresence = true,
  isPlaying = false,
  showLevelBadge = true,
  showVipRing = true,
  onClick,
  className = '',
}) => {
  const initials = useMemo(() => {
    if (!name) return '?';
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }, [name]);

  const sizePx = SIZE_PX[size];

  return (
    <div
      className={`player-avatar size-${size} ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={alt}
    >
      {/* VIP Status Ring (outermost glow) */}
      {showVipRing && vipTier !== 'bronze' && <div className={`vip-status-ring tier-${vipTier}`} />}

      {/* Avatar Image/Initials */}
      <div className="player-avatar-image">
        {src ? (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).src = generateDefaultAvatar();
            }}
          />
        ) : (
          <span className="player-avatar-initials">{initials}</span>
        )}
      </div>

      {/* Presence Dot */}
      {showPresence && <span className={`avatar-presence-dot status-${presenceStatus}`} />}

      {/* Level Badge */}
      {showLevelBadge && size !== 'xs' && (
        <span className={`avatar-level-badge tier-${vipTier}`}>{level}</span>
      )}

      {/* "Playing Now" Chip Overlay */}
      {isPlaying && (
        <span className="avatar-playing-icon" title="Playing Now">
          <PokerChipIcon />
        </span>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER AVATAR WITH NAME (Composite)
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlayerAvatarWithNameProps extends PlayerAvatarProps {
  /** Subtitle text (e.g., role, status) */
  subtitle?: string;
}

export const PlayerAvatarWithName: React.FC<PlayerAvatarWithNameProps> = ({
  name,
  subtitle,
  size = 'md',
  onClick,
  ...avatarProps
}) => {
  return (
    <div className={`player-avatar-with-name name-size-${size}`} onClick={onClick}>
      <PlayerAvatar
        {...avatarProps}
        name={name}
        size={size}
        onClick={undefined} /* Handled by wrapper */
      />
      <div className="player-avatar-name-block">
        <span className="player-avatar-display-name">{name || 'Unknown'}</span>
        {subtitle && <span className="player-avatar-subtitle">{subtitle}</span>}
      </div>
    </div>
  );
};

export default PlayerAvatar;
