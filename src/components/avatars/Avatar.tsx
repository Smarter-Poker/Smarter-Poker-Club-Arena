import React, { useEffect, useState } from 'react';
import { sizedStorageUrl } from '../../utils/avatarGenerator';
import './Avatar.css';

interface AvatarProps {
  src?: string;
  alt?: string;
  name?: string;
  size?: 'xs' | 'small' | 'medium' | 'large' | 'xl';
  status?: 'online' | 'offline' | 'away' | 'busy';
  badge?: string | number;
  onClick?: () => void;
}

const SIZE_PX: Record<string, number> = { xs: 24, small: 32, medium: 44, large: 60, xl: 80 };

export const Avatar: React.FC<AvatarProps> = ({
  src,
  alt = 'Avatar',
  name,
  size = 'medium',
  status,
  badge,
  onClick,
}) => {
  /* 2026-08-24 mobile-avatar hardening: a dead URL used to leave a broken
     image glyph. On error the component now falls back to initials, and a
     NEW src gets a fresh attempt. Storage objects load through the
     /render/image/ resize endpoint (the raw object endpoint was observed
     intermittently failing while render stayed up, and a 24-80px circle
     does not need the original upload). */
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const resolvedSrc = src && !failed ? sizedStorageUrl(src, SIZE_PX[size] || 44) : undefined;
  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
    : '?';

  return (
    <div className={`avatar size-${size}`} onClick={onClick}>
      {resolvedSrc ? (
        <img
          loading="lazy"
          decoding="async"
          src={resolvedSrc}
          alt={alt}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="avatar-initials">{initials.toUpperCase()}</span>
      )}
      {status && <span className={`avatar-status status-${status}`} />}
      {badge !== undefined && <span className="avatar-badge">{badge}</span>}
    </div>
  );
};

export default Avatar;
