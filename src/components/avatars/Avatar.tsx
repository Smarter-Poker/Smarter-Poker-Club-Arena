import React from 'react';
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

export const Avatar: React.FC<AvatarProps> = ({
  src,
  alt = 'Avatar',
  name,
  size = 'medium',
  status,
  badge,
  onClick,
}) => {
  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
    : '?';

  return (
    <div className={`avatar size-${size}`} onClick={onClick}>
      {src ? (
        <img loading="lazy" decoding="async" src={src} alt={alt} />
      ) : (
        <span className="avatar-initials">{initials.toUpperCase()}</span>
      )}
      {status && <span className={`avatar-status status-${status}`} />}
      {badge !== undefined && <span className="avatar-badge">{badge}</span>}
    </div>
  );
};

export default Avatar;
