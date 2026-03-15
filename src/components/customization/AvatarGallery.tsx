/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AVATAR GALLERY — Selectable Avatar Store with Upload
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tabbed gallery UI:
 *   - Free (25 avatars)
 *   - VIP (50 avatars, gated)
 *   - Upload (custom photo with preview)
 *
 * Integrates with AvatarService for library + Supabase persistence.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { avatarService, type Avatar } from '../../services/AvatarService';
import { masterBus } from '../../core/MasterBus';
import { haptic } from '../../services/SoundService';
import './AvatarGallery.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type GalleryTab = 'free' | 'vip' | 'upload';

export interface AvatarGalleryProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  currentAvatarUrl: string;
  isVip?: boolean;
  onAvatarChanged?: (newUrl: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function AvatarGallery({
  isOpen,
  onClose,
  userId,
  currentAvatarUrl,
  isVip = false,
  onAvatarChanged,
}: AvatarGalleryProps) {
  const [activeTab, setActiveTab] = useState<GalleryTab>('free');
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [selectedAvatar, setSelectedAvatar] = useState<string>(currentAvatarUrl);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load avatars
  useEffect(() => {
    if (!isOpen) return;
    avatarService.getAvatarLibrary(userId).then(setAvatars);
  }, [isOpen, userId]);

  // Filter by tab
  const filteredAvatars = useMemo(() => {
    if (activeTab === 'upload') return [];
    return avatars.filter((a) => a.category === activeTab);
  }, [avatars, activeTab]);

  const handleSelect = useCallback(
    (avatar: Avatar) => {
      if (avatar.category === 'vip' && !isVip) return;
      haptic.light();
      setSelectedAvatar(avatar.imageUrl);
    },
    [isVip]
  );

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) return;
    if (file.size > 5 * 1024 * 1024) return; // 5MB limit

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setUploadPreview(result);
      setSelectedAvatar(result);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleApply = useCallback(async () => {
    if (!userId || selectedAvatar === currentAvatarUrl) {
      onClose();
      return;
    }

    setSaving(true);
    haptic.medium();

    try {
      const success = await avatarService.setUserAvatar(userId, selectedAvatar);
      if (success) {
        onAvatarChanged?.(selectedAvatar);
        masterBus.emit('USER_PROFILE_LOADED', {
          avatarUrl: selectedAvatar,
          userId,
        });
      }
    } catch (err) {
      console.error('Failed to save avatar:', err);
    } finally {
      setSaving(false);
      onClose();
    }
  }, [userId, selectedAvatar, currentAvatarUrl, onAvatarChanged, onClose]);

  if (!isOpen) return null;

  return (
    <div className="avatar-gallery-overlay" onClick={onClose}>
      <div className="avatar-gallery" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ag-header">
          <h3 className="ag-title">Choose Avatar</h3>
          <button className="ag-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Preview */}
        <div className="ag-preview">
          <div className="ag-preview__current">
            <img
              loading="lazy"
              decoding="async"
              src={currentAvatarUrl}
              alt="Current avatar"
              className="ag-preview__img ag-preview__img--current"
            />
            <span className="ag-preview__label">Current</span>
          </div>
          <div className="ag-preview__arrow">→</div>
          <div className="ag-preview__selected">
            <img
              loading="lazy"
              decoding="async"
              src={selectedAvatar}
              alt="Selected avatar"
              className="ag-preview__img ag-preview__img--selected"
            />
            <span className="ag-preview__label">New</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="ag-tabs">
          <button
            className={`ag-tab ${activeTab === 'free' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('free')}
          >
            Free ({avatars.filter((a) => a.category === 'free').length})
          </button>
          <button
            className={`ag-tab ${activeTab === 'vip' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('vip')}
          >
            👑 VIP ({avatars.filter((a) => a.category === 'vip').length})
          </button>
          <button
            className={`ag-tab ${activeTab === 'upload' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('upload')}
          >
            📷 Upload
          </button>
        </div>

        {/* Grid */}
        <div className="ag-content">
          {activeTab !== 'upload' ? (
            <div className="ag-grid">
              {filteredAvatars.map((avatar) => {
                const isSelected = selectedAvatar === avatar.imageUrl;
                const isLocked = avatar.category === 'vip' && !isVip;

                return (
                  <div
                    key={avatar.id}
                    className={[
                      'ag-item',
                      isSelected ? 'ag-item--selected' : '',
                      isLocked ? 'ag-item--locked' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => handleSelect(avatar)}
                    title={avatar.name}
                  >
                    <img
                      loading="lazy"
                      decoding="async"
                      src={avatar.imageUrl}
                      alt={avatar.name}
                      className="ag-item__img"
                    />
                    {isLocked && <div className="ag-item__lock">👑</div>}
                    {isSelected && <div className="ag-item__check">✓</div>}
                    <span className="ag-item__name">{avatar.name}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="ag-upload">
              <div className="ag-upload__zone" onClick={() => fileInputRef.current?.click()}>
                {uploadPreview ? (
                  <img
                    loading="lazy"
                    decoding="async"
                    src={uploadPreview}
                    alt="Upload preview"
                    className="ag-upload__preview"
                  />
                ) : (
                  <>
                    <span className="ag-upload__icon">📷</span>
                    <span className="ag-upload__text">Click to upload photo</span>
                    <span className="ag-upload__hint">Max 5MB • JPG, PNG, WebP</span>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="ag-upload__input"
                onChange={handleFileChange}
              />
            </div>
          )}
        </div>

        {/* Apply Button */}
        <div className="ag-footer">
          <button
            className={`ag-apply ${saving ? 'ag-apply--saving' : ''} ${selectedAvatar === currentAvatarUrl ? 'ag-apply--disabled' : ''}`}
            onClick={handleApply}
            disabled={saving || selectedAvatar === currentAvatarUrl}
          >
            {saving ? 'Saving...' : 'Apply Avatar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AvatarGallery;
