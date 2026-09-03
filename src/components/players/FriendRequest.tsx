import React from 'react';
import { formatRelativeShort } from '../../lib/date';
import './FriendRequest.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

interface FriendRequestProps {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  mutualFriends?: number;
  sentAt: Date;
  isOutgoing?: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
}

export const FriendRequest: React.FC<FriendRequestProps> = ({
  id,
  username,
  displayName,
  avatarUrl,
  mutualFriends = 0,
  sentAt,
  isOutgoing = false,
  onAccept,
  onDecline,
  onCancel,
}) => {
  return (
    <div className="friend-request">
      <div className="request-avatar">
        {avatarUrl ? (
          <img
            loading="lazy"
            decoding="async"
            src={avatarUrl}
            alt={displayName}
            onError={(e) => {
              (e.target as HTMLImageElement).src = generateDefaultAvatar();
            }}
          />
        ) : (
          <span>{displayName[0]}</span>
        )}
      </div>

      <div className="request-info">
        <div className="request-name">{displayName}</div>
        <div className="request-username">@{username}</div>
        {mutualFriends > 0 && (
          <div className="mutual-friends">
            {mutualFriends} Mutual Friend{mutualFriends > 1 ? 's' : ''}
          </div>
        )}
        <div className="request-time">{formatRelativeShort(sentAt)}</div>
      </div>

      <div className="request-actions">
        {isOutgoing ? (
          <button className="cancel-btn" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <>
            <button className="accept-btn" onClick={onAccept}>
              Accept
            </button>
            <button className="decline-btn" onClick={onDecline}>
              Decline
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default FriendRequest;
