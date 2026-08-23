import React, { useState } from 'react';
import './ClubProfileModal.css';

export interface ClubProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  username: string;
  avatarUrl: string;
  clubName?: string;
  freeEmojisLeft?: number;
  freeTimeBanksLeft?: number;
}

export function ClubProfileModal({
  isOpen,
  onClose,
  userId,
  username,
  avatarUrl,
  clubName = 'Unknown',
  freeEmojisLeft = 0,
  freeTimeBanksLeft = 1,
}: ClubProfileModalProps) {
  const [activeTab, setActiveTab] = useState<'time' | 'star' | 'v' | 'smile'>('time');
  const [tag, setTag] = useState('');

  if (!isOpen) return null;

  return (
    <div className="cpm-overlay" onClick={onClose}>
      <div className="cpm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cpm-header">
          <h2 className="cpm-title">PROFILE</h2>
          <button className="cpm-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="cpm-body">
          <div className="cpm-user-section">
            <div className="cpm-avatar-container">
              {avatarUrl ? (
                <img src={avatarUrl} alt={username} className="cpm-avatar" />
              ) : (
                <div className="cpm-avatar-placeholder" />
              )}
            </div>
            <div className="cpm-user-info">
              <div className="cpm-username-row">
                <span className="cpm-username">{username}</span>
                <span className="cpm-chat-icon">
                  💬<span className="cpm-chat-check">✓</span>
                </span>
              </div>
              <div className="cpm-user-id">ID:{userId}</div>
              <div className="cpm-user-club">Club: {clubName}</div>
            </div>
          </div>

          <div className="cpm-tag-input-container">
            <input
              type="text"
              className="cpm-tag-input"
              placeholder="Tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
          </div>

          <div className="cpm-badges">
            <div className="cpm-badge">
              <div className="cpm-badge-icon newb-icon" />
              <div className="cpm-badge-info">
                <div className="cpm-badge-title newb-title">Newbie</div>
                <div className="cpm-badge-desc">
                  <span className="cpm-q">?</span> Playstyle
                </div>
              </div>
            </div>
            <div className="cpm-badge">
              <div className="cpm-badge-icon heat-icon" />
              <div className="cpm-badge-info">
                <div className="cpm-badge-title heat-title">Normal</div>
                <div className="cpm-badge-desc">
                  <span className="cpm-q">?</span> Heat Index
                </div>
              </div>
            </div>
          </div>

          <div className="cpm-free-counts">
            <div>Free Emojis Left: {freeEmojisLeft}</div>
            <div>Free Time Banks Left: {freeTimeBanksLeft}</div>
          </div>

          <div className="cpm-tabs">
            <button
              className={`cpm-tab ${activeTab === 'time' ? 'active' : ''}`}
              onClick={() => setActiveTab('time')}
            >
              🕓
            </button>
            <button
              className={`cpm-tab ${activeTab === 'star' ? 'active' : ''}`}
              onClick={() => setActiveTab('star')}
            >
              ❄️
            </button>
            <button
              className={`cpm-tab ${activeTab === 'v' ? 'active' : ''}`}
              onClick={() => setActiveTab('v')}
            >
              V
            </button>
            <button
              className={`cpm-tab ${activeTab === 'smile' ? 'active' : ''}`}
              onClick={() => setActiveTab('smile')}
            >
              😊
            </button>
          </div>

          <div className="cpm-recently-used">Recently Used</div>
          <div className="cpm-recently-used-area"></div>

          <div className="cpm-section-title">Character Emojis</div>
          <div className="cpm-emojis-grid">
            {/* Mock emojis as per image */}
            {[...Array(10)].map((_, i) => (
              <div key={i} className="cpm-emoji-item">
                <div className="cpm-emoji-img-placeholder" />
                <div className="cpm-emoji-price">💎 2</div>
              </div>
            ))}
          </div>

          <div className="cpm-footer">
            <button className="cpm-confirm-btn" onClick={onClose}>
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ClubProfileModal;
