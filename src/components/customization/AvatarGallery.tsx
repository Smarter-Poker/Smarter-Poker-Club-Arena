/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AVATAR GALLERY — Choose Avatar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Four things a player can do here:
 *   1. See their current avatar next to the one they are about to pick
 *   2. Use the photo from the account they signed in with
 *   3. Create a new VIP avatar (opens the Hub AI avatar creator)
 *   4. Choose a new avatar - presets, their own saved avatars, or an upload
 *
 * WHY THIS WAS REWRITTEN
 *   - The grid was always empty. storage.objects had exactly one SELECT policy,
 *     USING (owner = auth.uid()), and all 436 presets have owner NULL, so
 *     .list() returned nothing and every tab read "(0)". Fixed in migration
 *     20260819_allow_listing_preset_avatars.
 *   - The VIP tab could never populate: nothing in the codebase ever produced
 *     an Avatar with category 'vip'. It was a permanently empty tab.
 *   - Conversely, avatars with category 'custom' WERE loaded from user_avatars
 *     and then discarded, because the tab filter only matched 'free' or 'vip'.
 *     A user's own saved avatars were unreachable. That tab is now "Mine".
 *   - Upload turned the file into a base64 data URL and stored the whole blob
 *     in profiles.avatar_url, which is then re-sent to every client rendering
 *     that player at a table. It now uploads to storage and stores the URL.
 *   - Rejected uploads (wrong type, too large) returned silently with no UI
 *     feedback at all. They now explain themselves.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { avatarService, type Avatar } from '../../services/AvatarService';
import { masterBus } from '../../core/MasterBus';
import { haptic } from '../../services/SoundService';
import './AvatarGallery.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type GalleryTab = 'free' | 'vip' | 'custom' | 'upload';

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
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep the preview honest if the caller swaps the current avatar underneath us
  useEffect(() => {
    if (isOpen) setSelectedAvatar(currentAvatarUrl);
  }, [isOpen, currentAvatarUrl]);

  // Load the library and the provider photo together
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;

    setLoading(true);
    setNotice(null);

    Promise.all([avatarService.getAvatarLibrary(userId), avatarService.getProfilePhotoUrl()])
      .then(([library, photo]) => {
        if (cancelled) return;
        setAvatars(library);
        setProfilePhotoUrl(photo);
        if (library.length === 0) {
          setNotice('No avatars available right now. You can still upload a photo.');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        reportError(e, 'AvatarGallery.load');
        setNotice('Could not load avatars. You can still upload a photo.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, userId]);

  const freeAvatars = useMemo(() => avatars.filter((a) => a.category === 'free'), [avatars]);
  /* Dan 2026-08-20: 'vip' used to be folded into "Mine", which was correct
     only while nothing produced a VIP avatar. AvatarService now serves the
     Hub's 74-strong VIP library (the 26 new transparent designs among them),
     so VIP gets its own tab and "Mine" goes back to meaning the user's own
     saved avatars. */
  const vipAvatars = useMemo(() => avatars.filter((a) => a.category === 'vip'), [avatars]);
  const myAvatars = useMemo(() => avatars.filter((a) => a.category === 'custom'), [avatars]);

  const filteredAvatars = useMemo(() => {
    if (activeTab === 'free') return freeAvatars;
    if (activeTab === 'vip') return vipAvatars;
    if (activeTab === 'custom') return myAvatars;
    return [];
  }, [activeTab, freeAvatars, vipAvatars, myAvatars]);

  const handleSelect = useCallback(
    (avatar: Avatar) => {
      // VIP artwork is VIP artwork. Say so instead of letting the pick appear
      // to take and then quietly not stick.
      if (avatar.category === 'vip' && !isVip) {
        haptic.light();
        setNotice('This avatar is part of the VIP collection. Upgrade to VIP to use it.');
        return;
      }
      haptic.light();
      setNotice(null);
      setSelectedAvatar(avatar.imageUrl);
    },
    [isVip]
  );

  const handleUseProfilePhoto = useCallback(() => {
    if (!profilePhotoUrl) return;
    haptic.light();
    setNotice(null);
    setSelectedAvatar(profilePhotoUrl);
  }, [profilePhotoUrl]);

  const handleCreateVipAvatar = useCallback(() => {
    haptic.medium();
    // The Hub owns AI avatar generation. It writes straight to the user's
    // profile, so the gallery just reloads when the player comes back.
    avatarService.openAvatarSelector();
    setNotice('Finish your new avatar in the Hub window, then reopen this to pick it.');
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so re-picking the same file still fires a change event
      e.target.value = '';
      if (!file) return;

      setNotice(null);
      setUploading(true);

      // Show something immediately while the upload is in flight
      const localPreview = URL.createObjectURL(file);
      setUploadPreview(localPreview);

      try {
        const { url, error } = await avatarService.uploadAvatar(userId, file);
        if (error || !url) {
          setNotice(error ?? 'Upload failed. Please try again.');
          setUploadPreview(null);
          return;
        }
        // Store the storage URL, never the file contents
        setSelectedAvatar(url);
        setUploadPreview(url);
      } finally {
        URL.revokeObjectURL(localPreview);
        setUploading(false);
      }
    },
    [userId]
  );

  const handleApply = useCallback(async () => {
    if (!userId || selectedAvatar === currentAvatarUrl) {
      onClose();
      return;
    }

    setSaving(true);
    setNotice(null);
    haptic.medium();

    try {
      const success = await avatarService.setUserAvatar(userId, selectedAvatar);
      if (!success) {
        // Previously this failed silently and closed as though it had worked
        setNotice('Could not save your avatar. Please try again.');
        return;
      }
      onAvatarChanged?.(selectedAvatar);
      masterBus.emit('USER_PROFILE_LOADED', {
        avatarUrl: selectedAvatar,
        userId,
      });
      onClose();
    } catch (err) {
      reportError(err, 'AvatarGallery.Failed_to_save_avatar');
      setNotice('Could not save your avatar. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [userId, selectedAvatar, currentAvatarUrl, onAvatarChanged, onClose]);

  if (!isOpen) return null;

  const unchanged = selectedAvatar === currentAvatarUrl;

  return (
    <div className="avatar-gallery-overlay" onClick={onClose}>
      <div
        className="avatar-gallery"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose Avatar"
      >
        {/* Header */}
        <div className="ag-header">
          <h3 className="ag-title">Choose Avatar</h3>
          <button className="ag-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {/* Current vs selected */}
        <div className="ag-preview">
          <div className="ag-preview__current">
            <img
              decoding="async"
              src={currentAvatarUrl}
              alt="Current avatar"
              className="ag-preview__img ag-preview__img--current"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
            <span className="ag-preview__label">Current</span>
          </div>
          <div className="ag-preview__arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="ag-preview__selected">
            <img
              decoding="async"
              src={selectedAvatar}
              alt="Selected avatar"
              className="ag-preview__img ag-preview__img--selected"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
            <span className="ag-preview__label">{unchanged ? 'Unchanged' : 'New'}</span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="ag-actions">
          <button
            className="ag-action"
            onClick={handleUseProfilePhoto}
            disabled={!profilePhotoUrl}
            title={
              profilePhotoUrl
                ? 'Use the photo from the account you signed in with'
                : 'Your account has no profile photo to use'
            }
          >
            Use Profile Photo
          </button>
          <button className="ag-action ag-action--vip" onClick={handleCreateVipAvatar}>
            {isVip ? 'Create VIP Avatar' : 'Create Custom Avatar'}
          </button>
        </div>

        {/* Tabs */}
        <div className="ag-tabs">
          <button
            className={`ag-tab ${activeTab === 'free' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('free')}
          >
            Presets ({freeAvatars.length})
          </button>
          <button
            className={`ag-tab ${activeTab === 'vip' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('vip')}
          >
            VIP ({vipAvatars.length})
          </button>
          <button
            className={`ag-tab ${activeTab === 'custom' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('custom')}
          >
            Mine ({myAvatars.length})
          </button>
          <button
            className={`ag-tab ${activeTab === 'upload' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('upload')}
          >
            Upload
          </button>
        </div>

        {notice && (
          <div className="ag-notice" role="status">
            {notice}
          </div>
        )}

        {/* Grid / upload */}
        <div className="ag-content">
          {activeTab !== 'upload' ? (
            loading ? (
              <div className="ag-empty">Loading avatars...</div>
            ) : filteredAvatars.length === 0 ? (
              <div className="ag-empty">
                {activeTab === 'custom'
                  ? 'You have not created any avatars yet. Use Create Custom Avatar above.'
                  : activeTab === 'vip'
                    ? 'VIP avatars could not be loaded.'
                    : 'No preset avatars available.'}
              </div>
            ) : (
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
                      title={isLocked ? `${avatar.name} (VIP)` : avatar.name}
                    >
                      <img
                        loading="lazy"
                        decoding="async"
                        /* Tiles render the lightweight derivative when one
                           exists; imageUrl stays the canonical asset that gets
                           saved to the profile. */
                        src={avatar.thumbUrl || avatar.imageUrl}
                        alt={avatar.name}
                        className="ag-item__img"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = generateDefaultAvatar();
                        }}
                      />
                      {isLocked && <div className="ag-item__lock">VIP</div>}
                      {isSelected && !isLocked && <div className="ag-item__check">&#10003;</div>}
                      <span className="ag-item__name">{avatar.name}</span>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="ag-upload">
              <div
                className="ag-upload__zone"
                onClick={() => !uploading && fileInputRef.current?.click()}
              >
                {uploading ? (
                  <span className="ag-upload__text">Uploading...</span>
                ) : uploadPreview ? (
                  <img
                    decoding="async"
                    src={uploadPreview}
                    alt="Upload preview"
                    className="ag-upload__preview"
                  />
                ) : (
                  <>
                    <span className="ag-upload__text">Click to upload a photo</span>
                    <span className="ag-upload__hint">Max 5MB, JPG PNG or WebP</span>
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

        {/* Apply */}
        <div className="ag-footer">
          <button
            className={`ag-apply ${saving ? 'ag-apply--saving' : ''} ${unchanged ? 'ag-apply--disabled' : ''}`}
            onClick={handleApply}
            disabled={saving || uploading || unchanged}
          >
            {saving ? 'Saving...' : 'Apply Avatar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AvatarGallery;
