import React from 'react';
import './EditableAvatar.css';

interface EditableAvatarProps {
  src?: string;
  name?: string;
  onEdit?: () => void;
  size?: 'medium' | 'large';
}

export const EditableAvatar: React.FC<EditableAvatarProps> = ({
  src,
  name,
  onEdit,
  size = 'large',
}) => {
  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
    : '?';

  return (
    <div className={`editable-avatar size-${size}`} onClick={onEdit}>
      <div className="avatar-display">
        {src ? (
          <img loading="lazy" decoding="async" src={src} alt={name || 'Avatar'} />
        ) : (
          <span className="initials">{initials.toUpperCase()}</span>
        )}
      </div>
      <div className="edit-overlay">
        <span className="edit-icon">✎</span>
        <span className="edit-text">Edit</span>
      </div>
    </div>
  );
};

export default EditableAvatar;
