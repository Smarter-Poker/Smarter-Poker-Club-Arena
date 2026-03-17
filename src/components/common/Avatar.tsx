/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AVATAR — User Avatar Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import './Avatar.css';

interface AvatarProps {
  src?: string | null;
  alt?: string;
  name?: string;
  size?: 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';
  variant?: 'circle' | 'rounded' | 'square';
  status?: 'online' | 'offline' | 'away' | 'busy';
  border?: boolean;
  className?: string;
  onClick?: () => void;
}

/**
 * Get initials from name
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Generate a consistent color based on name
 */
function getColorFromName(name: string): string {
  const colors = [
    '#4169E1', // Royal Blue
    '#22c55e', // Green
    '#f59e0b', // Amber
    '#ef4444', // Red
    '#8b5cf6', // Purple
    '#0ea5e9', // Sky
    '#ec4899', // Pink
    '#14b8a6', // Teal
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Main avatar component
 */
export function Avatar({
  src,
  alt = 'Avatar',
  name = '',
  size = 'medium',
  variant = 'circle',
  status,
  border = false,
  className = '',
  onClick,
}: AvatarProps) {
  const initials = name ? getInitials(name) : '?';
  const bgColor = name ? getColorFromName(name) : '#666';

  return (
    <div
      className={`avatar avatar-${size} avatar-${variant} ${border ? 'avatar-border' : ''} ${onClick ? 'avatar-clickable' : ''} ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {src ? (
        <img
          loading="lazy"
          decoding="async"
          src={src}
          alt={alt}
          className="avatar-image"
          onError={(e) => {
            (e.target as HTMLImageElement).src = '/default-avatar.png';
          }}
        />
      ) : (
        <div className="avatar-fallback" style={{ backgroundColor: bgColor }}>
          {initials}
        </div>
      )}
      {status && <span className={`avatar-status avatar-status-${status}`} />}
    </div>
  );
}

/**
 * Avatar group for showing multiple users
 */
export function AvatarGroup({
  children,
  max = 4,
  size = 'medium',
}: {
  children: React.ReactNode;
  max?: number;
  size?: AvatarProps['size'];
}) {
  const childrenArray = React.Children.toArray(children);
  const visible = childrenArray.slice(0, max);
  const remaining = childrenArray.length - max;

  return (
    <div className={`avatar-group avatar-group-${size}`}>
      {visible.map((child, index) => {
        if (React.isValidElement<AvatarProps>(child)) {
          return React.cloneElement(child, {
            key: index,
            size,
            border: true,
          });
        }
        return child;
      })}
      {remaining > 0 && (
        <div className={`avatar avatar-${size} avatar-circle avatar-border avatar-more`}>
          <div className="avatar-fallback">+{remaining}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Poker player avatar with stack display
 */
export function PlayerAvatar({
  src,
  name = '',
  stack,
  isActive = false,
  isFolded = false,
  isWinner = false,
  size = 'medium',
}: {
  src?: string | null;
  name?: string;
  stack?: number;
  isActive?: boolean;
  isFolded?: boolean;
  isWinner?: boolean;
  size?: AvatarProps['size'];
}) {
  return (
    <div
      className={`player-avatar ${isActive ? 'active' : ''} ${isFolded ? 'folded' : ''} ${isWinner ? 'winner' : ''}`}
    >
      <Avatar src={src} name={name} size={size} />
      {stack !== undefined && <div className="player-stack">{stack.toLocaleString()}</div>}
    </div>
  );
}

export default Avatar;
