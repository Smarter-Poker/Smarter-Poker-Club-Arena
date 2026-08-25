/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AVATAR GALLERY — Choose Avatar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three things a player can do here:
 *   1. See their current avatar next to the one they are about to pick
 *   2. Create a new custom avatar (opens the Hub AI avatar creator)
 *   3. Choose a new avatar - presets, VIP art, or their own saved avatars
 *
 * PROFILE PICTURES WERE REMOVED 2026-08-21 (Dan: "they can now only use
 * avatars"). Two routes went, not one: the Upload tab, and a separate
 * "Use Profile Photo" button that wrote the Google OAuth photo URL. The rule
 * itself lives in AvatarService.isLibraryAvatarUrl, at the write point -
 * removing the buttons alone would have been a locked door in a building with
 * no walls.
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
 *     in profiles.avatar_url, which was re-sent to every client rendering that
 *     player at a table. That was fixed to store a storage URL instead, and
 *     then the whole path was removed - kept here as the reason the column can
 *     still contain surprising values in old rows.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '../common/Toast';

import { createPortal } from 'react-dom';
import { avatarService, type Avatar } from '../../services/AvatarService';
import { masterBus } from '../../core/MasterBus';
import { haptic } from '../../services/SoundService';
import './AvatarGallery.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';
import { AvatarCustomizer } from './AvatarCustomizer';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** 'upload' was a fourth tab until 2026-08-21. Photos are gone. */
type GalleryTab = 'free' | 'vip' | 'custom';

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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  /* The Hub preset API did not answer. Distinct from "the library is empty",
     which is what this modal used to render for both. */
  const [presetsFailed, setPresetsFailed] = useState(false);
  const [customFailed, setCustomFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showQuickAvatar, setShowQuickAvatar] = useState(false);

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
    setPresetsFailed(false);
    setCustomFailed(false);

    avatarService
      .getAvatarLibraryResult(userId)
      .then((result) => {
        if (cancelled) return;
        setAvatars(result.avatars);
        setPresetsFailed(result.presetsFailed);
        setCustomFailed(result.customFailed);
        /* Only claim "there are none" when the sources actually ANSWERED.
           A failed fetch used to land here as the same reassuring sentence,
           which is a failed query rendered as an empty success state. */
        if (result.avatars.length === 0 && !result.presetsFailed && !result.customFailed) {
          // The old copy here offered "You can still upload a photo" as the
          // consolation. There is no longer a photo to fall back to, so say
          // what is actually true instead of pointing at a removed feature.
          setNotice('No avatars available right now. Please try again shortly.');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        reportError(e, 'AvatarGallery.load');
        setPresetsFailed(true);
        setCustomFailed(true);
        setNotice('Could not load avatars. Please try again shortly.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, userId, reloadKey]);

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

  const saveAvatar = useCallback(
    async (newUrl: string) => {
      if (!userId) {
        toast.error('Sign In To Change Your Avatar');
        return;
      }
      if (newUrl === currentAvatarUrl) {
        /* This used to return in silence. Tapping the avatar you already wear
           is the single most likely tap in this grid, and it produced no toast,
           no state change and no explanation - indistinguishable from a dead
           tile. Confirm the state instead. */
        toast.success('Avatar Already Applied');
        return;
      }
      setSaving(true);
      try {
        const success = await avatarService.setUserAvatar(userId, newUrl);
        if (!success) {
          toast.error('Could Not Update Avatar. Please Try Again.');
        } else {
          toast.success('Avatar Updated');
          onAvatarChanged?.(newUrl);
          masterBus.emit('USER_PROFILE_LOADED', {
            avatarUrl: newUrl,
            userId,
          });
          // We do not close the modal here to let them see it apply
        }
      } catch (err) {
        toast.error('Could Not Update Avatar. Please Try Again.');
        reportError(err, 'AvatarGallery.Unexpected_update_error');
      }
      setSaving(false);
    },
    [userId, currentAvatarUrl, onAvatarChanged, toast]
  );

  const handleSelect = useCallback(
    (avatar: Avatar) => {
      /* VIP art is gated by VIP membership OR by an unlock the player already
         holds. `avatar.isOwned` now carries the avatar_unlocks answer; before
         2026-08-25 this line read `category === 'vip' && !isVip` and nothing in
         the app ever consulted the unlock ledger, so an avatar bought in the
         club shop stayed locked behind the badge the purchase was meant to
         stand in for. */
      if (avatar.category === 'vip' && !isVip && !avatar.isOwned) {
        haptic.light();
        setNotice('This avatar is part of the VIP collection. Upgrade to VIP to use it.');
        return;
      }
      haptic.light();
      setNotice(null);
      setSelectedAvatar(avatar.imageUrl);
      saveAvatar(avatar.imageUrl);
    },
    [isVip, saveAvatar]
  );

  /** Applies immediately and toasts from inside AvatarCustomizer. */
  const handleQuickAvatarSaved = useCallback(
    (url: string) => {
      setSelectedAvatar(url);
      onAvatarChanged?.(url);
      setShowQuickAvatar(false);
      setReloadKey((k) => k + 1);
    },
    [onAvatarChanged]
  );

  const handleCreateVipAvatar = useCallback(() => {
    haptic.medium();
    avatarService.openAvatarSelector();
    setNotice('Finish your new avatar in the Hub window, then reopen this to pick it.');
  }, []);

  const handleApply = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const unchanged = selectedAvatar === currentAvatarUrl;
  /** Did the source behind the ACTIVE tab fail, as opposed to return nothing? */
  const tabFailed = activeTab === 'custom' ? customFailed : presetsFailed;

  const content = (
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

        {/* Quick actions.
            "Use Profile Photo" lived here until 2026-08-21. It pulled the photo
            from the account the player signed in with (Google, via auth user
            metadata) and wrote that external URL into profiles.avatar_url —
            a profile picture by a different route than the upload tab, and
            removed for the same reason. */}
        <div className="ag-actions">
          {/* Quick Avatar is the in-app path. The Hub creator below opens a
              popup window and then asks the player to come back and reopen this
              modal, which is not something a phone can reasonably do; this one
              composes an SVG avatar, saves it and applies it here. */}
          <button
            className="ag-action ag-action--quick"
            onClick={() => {
              haptic.light();
              setShowQuickAvatar((v) => !v);
            }}
            aria-expanded={showQuickAvatar}
          >
            {showQuickAvatar ? 'Close Quick Avatar' : 'Quick Avatar'}
          </button>
          <button className="ag-action ag-action--vip" onClick={handleCreateVipAvatar}>
            {isVip ? 'Create VIP Avatar' : 'Create Custom Avatar'}
          </button>
        </div>

        {showQuickAvatar && (
          <div className="ag-quick">
            <AvatarCustomizer
              userId={userId}
              currentAvatar={selectedAvatar}
              onSaved={handleQuickAvatarSaved}
            />
          </div>
        )}

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
        </div>

        {notice && (
          <div className="ag-notice" role="status">
            {notice}
          </div>
        )}

        {/* Grid. The fourth tab here was Upload: a drop zone and a file input
            that pushed a photo to the `avatars` storage bucket. Removed
            2026-08-21 — players choose from the library or generate a custom
            avatar, and AvatarService.isLibraryAvatarUrl now refuses anything
            else at the write point, so this is the affordance going away rather
            than the rule itself. */}
        <div className="ag-content">
          {loading ? (
            <div className="ag-empty">Loading Avatars...</div>
          ) : filteredAvatars.length === 0 && tabFailed ? (
            /* A source that did not answer is NOT an empty source. This branch
               exists because both used to print the same calm sentence, so a
               dead API read to the player as "there is nothing here". */
            <div className="ag-empty ag-empty--error" role="alert">
              <p className="ag-empty__msg">
                {activeTab === 'custom'
                  ? 'Your avatars could not be loaded.'
                  : 'The avatar library could not be loaded.'}
              </p>
              <button
                className="ag-retry"
                onClick={() => {
                  haptic.light();
                  setReloadKey((k) => k + 1);
                }}
              >
                Try Again
              </button>
            </div>
          ) : filteredAvatars.length === 0 ? (
            <div className="ag-empty">
              {activeTab === 'custom'
                ? 'You have not created any avatars yet. Use Quick Avatar above.'
                : activeTab === 'vip'
                  ? 'No VIP avatars available.'
                  : 'No preset avatars available.'}
            </div>
          ) : (
            <div className="ag-grid">
              {filteredAvatars.map((avatar) => {
                const isSelected = selectedAvatar === avatar.imageUrl;
                const isLocked = avatar.category === 'vip' && !isVip && !avatar.isOwned;
                /* VIP art the player owns outright rather than through the
                   badge. Worth its own mark: otherwise a purchased avatar is
                   visually identical to one that merely happens to be
                   unlocked because the player is currently VIP. */
                const isUnlockedByPurchase = avatar.category === 'vip' && !isVip && avatar.isOwned;

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
                    {isUnlockedByPurchase && <div className="ag-item__owned">Owned</div>}
                    {isSelected && !isLocked && <div className="ag-item__check">&#10003;</div>}
                    <span className="ag-item__name">{avatar.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Apply */}
        <div className="ag-footer">
          <button
            className={`ag-apply ${saving ? 'ag-apply--saving' : ''} ${unchanged ? 'ag-apply--disabled' : ''}`}
            onClick={handleApply}
            disabled={saving || unchanged}
          >
            {saving ? 'Saving...' : 'Apply Avatar'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

export default AvatarGallery;
