import React from 'react';
import './PlayerCard.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

interface PlayerCardProps {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  level: number;
  isOnline: boolean;
  isFriend: boolean;
  stats?: {
    handsPlayed: number;
    winRate: number;
    totalWinnings: number;
  };
  onClick?: () => void;
  onAddFriend?: () => void;
  onMessage?: () => void;
}

export const PlayerCard: React.FC<PlayerCardProps> = ({
  id,
  username,
  displayName,
  avatarUrl,
  level,
  isOnline,
  isFriend,
  stats,
  onClick,
  onAddFriend,
  onMessage,
}) => {
  return (
    <div className="player-card" onClick={onClick}>
      <div className="player-avatar">
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
        <span className={`online-dot ${isOnline ? 'online' : 'offline'}`} />
      </div>

      <div className="player-info">
        <div className="player-name">{displayName}</div>
        <div className="player-username">@{username}</div>
        <div className="player-level">Level {level}</div>
      </div>

      {stats && (
        <div className="player-stats">
          <div className="stat">
            <span className="stat-value">{stats.handsPlayed.toLocaleString()}</span>
            <span className="stat-label">Hands</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.winRate}%</span>
            <span className="stat-label">Win Rate</span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {stats.totalWinnings.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <span className="stat-label">Winnings</span>
          </div>
        </div>
      )}

      <div className="player-actions">
        {!isFriend && (
          <button
            className="add-friend-btn"
            onClick={(e) => {
              e.stopPropagation();
              onAddFriend?.();
            }}
          >
            + Add
          </button>
        )}
        <button
          className="message-btn"
          aria-label="Send Message"
          onClick={(e) => {
            e.stopPropagation();
            onMessage?.();
          }}
        ></button>
      </div>
    </div>
  );
};

export default PlayerCard;
