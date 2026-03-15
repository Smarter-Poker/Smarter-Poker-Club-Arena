import React from 'react';
import './AvatarWithName.css';

interface AvatarWithNameProps {
  src?: string;
  name: string;
  subtitle?: string;
  size?: 'small' | 'medium' | 'large';
  status?: 'online' | 'offline' | 'away';
  onClick?: () => void;
}

export const AvatarWithName: React.FC<AvatarWithNameProps> = ({
  src,
  name,
  subtitle,
  size = 'medium',
  status,
  onClick,
}) => {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2);

  return (
    <div className={`avatar-with-name size-${size}`} onClick={onClick}>
      <div className="avatar-wrapper">
        {src ? (
          <img loading="lazy" decoding="async" src={src} alt={name} />
        ) : (
          <span className="initials">{initials.toUpperCase()}</span>
        )}
        {status && <span className={`status status-${status}`} />}
      </div>
      <div className="name-wrapper">
        <span className="name">{name}</span>
        {subtitle && <span className="subtitle">{subtitle}</span>}
      </div>
    </div>
  );
};

export default AvatarWithName;
