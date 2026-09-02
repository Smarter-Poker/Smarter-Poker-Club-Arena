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

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useToast } from '../common/Toast';

import { createPortal } from 'react-dom';
import { avatarService, type Avatar } from '../../services/AvatarService';
import { masterBus } from '../../core/MasterBus';
import { haptic } from '../../services/SoundService';
import './AvatarGallery.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';
import { AvatarCustomizer } from './AvatarCustomizer';
import AvatarCosmetics from '../avatars/AvatarCosmetics';
import type { AvatarCosmetic, CosmeticKind } from '../../cosmetics/avatarCosmetics';
import { useHeaderDataStore } from '../../stores/useHeaderDataStore';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 'upload' was a fourth tab until 2026-08-21. Photos are gone.
 *
 * 'style' arrived 2026-08-25 and is the first UI anywhere in Club Arena that
 * reads or writes `equipped_frame` / `equipped_aura`. It lives here rather than
 * on a page of its own because a frame is only meaningful against the avatar it
 * frames, and this modal is already the one surface that shows current-versus-
 * pending side by side. It is also already mounted in three places
 * (HamburgerMenu, TableMenu, SettingsPanel), so the feature reaches the felt and
 * the lobby without three new entry points.
 */
type GalleryTab = 'free' | 'vip' | 'custom' | 'style';

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
  const [search, setSearch] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  // ── Style tab: frames + auras ───────────────────────────────────────────
  const [cosmetics, setCosmetics] = useState<(AvatarCosmetic & { isOwned: boolean })[]>([]);
  /* Same distinction the avatar library makes. `false` means ownership is
     UNKNOWN, not "owns nothing" — the tab says so and refuses to equip, rather
     than drawing a purchase the player made as a lock they never bought. */
  const [cosmeticsOk, setCosmeticsOk] = useState(true);
  const [cosmeticsLoading, setCosmeticsLoading] = useState(false);
  const [equippedFrame, setEquippedFrame] = useState<string | null>(null);
  const [equippedAura, setEquippedAura] = useState<string | null>(null);
  const [savingCosmetic, setSavingCosmetic] = useState(false);
  const cosmeticInFlightRef = useRef(false);
  const selectedAvatarRef = useRef(selectedAvatar);
  const confirmedAvatarRef = useRef(currentAvatarUrl);
  const avatarRevisionRef = useRef(0);
  const pendingAvatarWritesRef = useRef(0);
  const mutationInstanceRef = useRef(`avatar-gallery-${Math.random().toString(36).slice(2)}`);
  const cosmeticRevisionRef = useRef(0);

  // Keep the preview honest if the caller swaps the current avatar underneath us
  useEffect(() => {
    if (isOpen && pendingAvatarWritesRef.current === 0) {
      selectedAvatarRef.current = currentAvatarUrl;
      confirmedAvatarRef.current = currentAvatarUrl;
      setSelectedAvatar(currentAvatarUrl);
    }
  }, [isOpen, currentAvatarUrl]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex="0"]'
        ) || []
      );
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  // A shop redemption or VIP reward can land while this modal is already
  // open (and can originate in another tab). Re-read both the avatar library
  // and style ledger immediately so the purchased tile unlocks without a
  // close/reopen cycle.
  useEffect(() => {
    if (!isOpen || !userId) return undefined;
    return masterBus.subscribe('COSMETIC_OWNERSHIP_CHANGED', (event) => {
      if (event.payload.userId !== userId || event.payload.category !== 'avatar') return;
      setReloadKey((revision) => revision + 1);
    });
  }, [isOpen, userId]);

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

  /* Loaded on its own effect rather than folded into the library fetch above:
     the library is a 100-entry catalog behind a Hub API call and this is two
     small queries against Supabase. Chaining them would make the Style tab wait
     on a request it does not use, and a Hub outage would blank a tab that has
     nothing to do with the Hub. */
  useEffect(() => {
    if (!isOpen || !userId) return undefined;
    let cancelled = false;

    setCosmeticsLoading(true);
    Promise.all([avatarService.getCosmeticCatalog(userId), avatarService.getCosmetics(userId)])
      .then(([catalog, equipped]) => {
        if (cancelled) return;
        setCosmetics(catalog.cosmetics);
        setCosmeticsOk(catalog.ok && equipped.ok);
        setEquippedFrame(equipped.frame);
        setEquippedAura(equipped.aura);
      })
      .catch((e) => {
        if (cancelled) return;
        reportError(e, 'AvatarGallery.loadCosmetics');
        setCosmeticsOk(false);
      })
      .finally(() => {
        if (!cancelled) setCosmeticsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, userId, reloadKey]);

  const frames = useMemo(() => cosmetics.filter((c) => c.kind === 'frame'), [cosmetics]);
  const auras = useMemo(() => cosmetics.filter((c) => c.kind === 'aura'), [cosmetics]);

  /**
   * Equip or clear one cosmetic.
   *
   * OPTIMISTIC, THEN RECONCILED. The tile highlights on tap and the preview
   * updates immediately, because the write is a round trip and a frame that
   * appears half a second after the tap reads as a tile that did not take. If
   * the write is refused, the previous value is put back — the player must never
   * be left looking at a frame they do not have.
   */
  const equipCosmetic = useCallback(
    async (kind: CosmeticKind, id: string | null) => {
      if (cosmeticInFlightRef.current) return;
      if (!userId) {
        toast.error('Sign In To Change Your Style');
        return;
      }
      if (!cosmeticsOk) {
        toast.error('Could Not Check What You Own. Please Try Again.');
        return;
      }

      const prevFrame = equippedFrame;
      const prevAura = equippedAura;
      const nextFrame = kind === 'frame' ? id : equippedFrame;
      const nextAura = kind === 'aura' ? id : equippedAura;
      const mutationId = `${mutationInstanceRef.current}:cosmetic:${++cosmeticRevisionRef.current}`;

      if (nextFrame === prevFrame && nextAura === prevAura) {
        toast.success(kind === 'frame' ? 'Frame Already Applied' : 'Aura Already Applied');
        return;
      }

      haptic.light();
      setNotice(null);
      cosmeticInFlightRef.current = true;
      setSavingCosmetic(true);
      setEquippedFrame(nextFrame);
      setEquippedAura(nextAura);
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: userId,
        mutationId,
        state: 'pending',
      });
      /* Push to the header store straight away so the orb and the hamburger
         change in the same frame as the tile. The profiles realtime handler in
         that store will deliver the same values a moment later and its
         self-echo guard drops the duplicate. */
      useHeaderDataStore.getState().setCosmetics(nextFrame, nextAura);
      masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
        userId,
        frame: nextFrame,
        aura: nextAura,
        mutationId,
        source: 'cosmetic-picker',
      });

      const result = await avatarService.setCosmetics(userId, nextFrame, nextAura);

      if (!result.ok) {
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'player-appearance',
          scope: userId,
          mutationId,
          state: 'rolling-back',
        });
        setEquippedFrame(prevFrame);
        setEquippedAura(prevAura);
        useHeaderDataStore.getState().setCosmetics(prevFrame, prevAura);
        masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
          userId,
          frame: prevFrame,
          aura: prevAura,
          mutationId,
          source: 'rollback',
        });
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'player-appearance',
          scope: userId,
          mutationId,
          state: 'rolled-back',
        });
        if (result.reason === 'not-owned') {
          toast.error('You Have Not Unlocked That Yet');
          setNotice('Frames and auras are a VIP benefit, or can be granted in your club shop.');
        } else if (result.reason === 'unknown-cosmetic') {
          toast.error('That Style Is No Longer Available');
        } else {
          toast.error('Could Not Update Your Style. Please Try Again.');
        }
      } else if (id === null) {
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'player-appearance',
          scope: userId,
          mutationId,
          state: 'confirmed',
        });
        toast.success(kind === 'frame' ? 'Frame Removed' : 'Aura Removed');
      } else {
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'player-appearance',
          scope: userId,
          mutationId,
          state: 'confirmed',
        });
        toast.success(kind === 'frame' ? 'Frame Equipped' : 'Aura Equipped');
      }

      cosmeticInFlightRef.current = false;
      setSavingCosmetic(false);
    },
    [userId, cosmeticsOk, equippedFrame, equippedAura, toast]
  );

  const freeAvatars = useMemo(() => avatars.filter((a) => a.category === 'free'), [avatars]);
  /* Dan 2026-08-20: 'vip' used to be folded into "Mine", which was correct
     only while nothing produced a VIP avatar. AvatarService now serves the
     Hub's 74-strong VIP library (the 26 new transparent designs among them),
     so VIP gets its own tab and "Mine" goes back to meaning the user's own
     saved avatars. */
  const vipAvatars = useMemo(() => avatars.filter((a) => a.category === 'vip'), [avatars]);
  const myAvatars = useMemo(() => avatars.filter((a) => a.category === 'custom'), [avatars]);

  const filteredAvatars = useMemo(() => {
    const source =
      activeTab === 'free'
        ? freeAvatars
        : activeTab === 'vip'
          ? vipAvatars
          : activeTab === 'custom'
            ? myAvatars
            : [];
    const query = search.trim().toLowerCase();
    return query ? source.filter((avatar) => avatar.name.toLowerCase().includes(query)) : source;
  }, [activeTab, freeAvatars, vipAvatars, myAvatars, search]);

  const saveAvatar = useCallback(
    async (newUrl: string, previousUrl: string) => {
      if (!userId) {
        toast.error('Sign In To Change Your Avatar');
        return;
      }
      if (newUrl === previousUrl) {
        /* This used to return in silence. Tapping the avatar you already wear
           is the single most likely tap in this grid, and it produced no toast,
           no state change and no explanation - indistinguishable from a dead
           tile. Compare to the synchronous selection ref, not the render-time
           prop: while B is saving, a rapid B -> A tap must still enqueue A even
           when A was the avatar at the start of this render. */
        toast.success('Avatar Already Applied');
        return;
      }
      const revision = ++avatarRevisionRef.current;
      const mutationId = `${mutationInstanceRef.current}:avatar:${revision}`;
      pendingAvatarWritesRef.current += 1;
      setSaving(true);
      onAvatarChanged?.(newUrl);
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: userId,
        mutationId,
        state: 'pending',
      });
      masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
        userId,
        avatar: newUrl,
        mutationId,
        source: 'avatar-picker',
      });
      masterBus.emit('USER_PROFILE_LOADED', { avatarUrl: newUrl, userId });
      try {
        const success = await avatarService.setUserAvatar(userId, newUrl);
        if (!success) {
          if (avatarRevisionRef.current === revision) {
            masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
              kind: 'player-appearance',
              scope: userId,
              mutationId,
              state: 'rolling-back',
            });
            const rollbackUrl = confirmedAvatarRef.current || previousUrl;
            selectedAvatarRef.current = rollbackUrl;
            setSelectedAvatar(rollbackUrl);
            onAvatarChanged?.(rollbackUrl);
            masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
              userId,
              avatar: rollbackUrl,
              mutationId,
              source: 'rollback',
            });
            masterBus.emit('USER_PROFILE_LOADED', { avatarUrl: rollbackUrl, userId });
          }
          masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
            kind: 'player-appearance',
            scope: userId,
            mutationId,
            state: 'rolled-back',
          });
          toast.error('Could Not Update Avatar. Please Try Again.');
        } else {
          confirmedAvatarRef.current = newUrl;
          masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
            kind: 'player-appearance',
            scope: userId,
            mutationId,
            state: 'confirmed',
          });
          toast.success('Avatar Updated');
          // We do not close the modal here to let them see it apply
        }
      } catch (err) {
        if (avatarRevisionRef.current === revision) {
          masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
            kind: 'player-appearance',
            scope: userId,
            mutationId,
            state: 'rolling-back',
          });
          const rollbackUrl = confirmedAvatarRef.current || previousUrl;
          selectedAvatarRef.current = rollbackUrl;
          setSelectedAvatar(rollbackUrl);
          onAvatarChanged?.(rollbackUrl);
          masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
            userId,
            avatar: rollbackUrl,
            mutationId,
            source: 'rollback',
          });
          masterBus.emit('USER_PROFILE_LOADED', { avatarUrl: rollbackUrl, userId });
        }
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'player-appearance',
          scope: userId,
          mutationId,
          state: 'rolled-back',
        });
        toast.error('Could Not Update Avatar. Please Try Again.');
        reportError(err, 'AvatarGallery.Unexpected_update_error');
      } finally {
        pendingAvatarWritesRef.current = Math.max(0, pendingAvatarWritesRef.current - 1);
        if (pendingAvatarWritesRef.current === 0) setSaving(false);
      }
    },
    [userId, onAvatarChanged, toast]
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
      const previousUrl = selectedAvatarRef.current;
      selectedAvatarRef.current = avatar.imageUrl;
      setSelectedAvatar(avatar.imageUrl);
      void saveAvatar(avatar.imageUrl, previousUrl);
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

  /**
   * 2026-08-26: this was a close button wearing a commit label.
   *
   * Avatars save on tile TAP (`handleSelect` -> `saveAvatar`), so by the time
   * "Apply Avatar" is reachable the work is already done — and its handler
   * was a bare `onClose()`. That is fine mechanically and dishonest in the
   * UI: a player who taps a tile and then closes WITHOUT pressing the button
   * has still changed their avatar, while the button implies the opposite
   * (that nothing counts until you press it). The `disabled={unchanged}`
   * state reinforces the lie by looking like a pending commit.
   *
   * It now says what it does. The save path is untouched.
   */
  const handleApply = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tab: GalleryTab) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs: GalleryTab[] = ['free', 'vip', 'custom', 'style'];
      const current = tabs.indexOf(tab);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setActiveTab(tabs[next]);
      document.getElementById(`avatar-tab-${tabs[next]}`)?.focus();
    },
    []
  );

  if (!isOpen) return null;

  const unchanged = selectedAvatar === currentAvatarUrl;
  /** Did the source behind the ACTIVE tab fail, as opposed to return nothing? */
  const tabFailed = activeTab === 'custom' ? customFailed : presetsFailed;

  const content = (
    <div className="avatar-gallery-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="avatar-gallery"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-gallery-title"
      >
        {/* Header */}
        <div className="ag-header">
          <div>
            <span className="ag-eyebrow">PLAYER IDENTITY STUDIO</span>
            <h3 id="avatar-gallery-title" className="ag-title">
              Avatar Gallery
            </h3>
            <p className="ag-subtitle">Choose From Your 97-Avatar Library And Live Styles</p>
          </div>
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
              alt="Current Avatar"
              className="ag-preview__img ag-preview__img--current"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
            {/* The equipped frame/aura is drawn on BOTH previews, not just the
                pending one: a player changing only their frame leaves the two
                images identical otherwise, and the whole point of this row is
                showing the difference. */}
            <AvatarCosmetics frame={equippedFrame} aura={equippedAura} />
            <span className="ag-preview__label">Current</span>
          </div>
          <div className="ag-preview__arrow" aria-hidden="true">
            &rarr;
          </div>
          <div className="ag-preview__selected">
            <img
              decoding="async"
              src={selectedAvatar}
              alt="Selected Avatar"
              className="ag-preview__img ag-preview__img--selected"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
            <AvatarCosmetics frame={equippedFrame} aura={equippedAura} />
            <span className="ag-preview__label">{unchanged ? 'Unchanged' : 'New'}</span>
          </div>
          <div className="ag-preview__status" aria-live="polite">
            <span className={saving || savingCosmetic ? 'is-saving' : ''} />
            {saving || savingCosmetic ? 'Saving Live Change' : 'Changes Apply Instantly'}
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
        <div className="ag-tabs" role="tablist" aria-label="Avatar Gallery Categories">
          <button
            id="avatar-tab-free"
            className={`ag-tab ${activeTab === 'free' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('free')}
            role="tab"
            aria-selected={activeTab === 'free'}
            aria-controls="avatar-gallery-panel"
            tabIndex={activeTab === 'free' ? 0 : -1}
            onKeyDown={(event) => handleTabKeyDown(event, 'free')}
          >
            Presets ({freeAvatars.length})
          </button>
          <button
            id="avatar-tab-vip"
            className={`ag-tab ${activeTab === 'vip' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('vip')}
            role="tab"
            aria-selected={activeTab === 'vip'}
            aria-controls="avatar-gallery-panel"
            tabIndex={activeTab === 'vip' ? 0 : -1}
            onKeyDown={(event) => handleTabKeyDown(event, 'vip')}
          >
            VIP ({vipAvatars.length})
          </button>
          <button
            id="avatar-tab-custom"
            className={`ag-tab ${activeTab === 'custom' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('custom')}
            role="tab"
            aria-selected={activeTab === 'custom'}
            aria-controls="avatar-gallery-panel"
            tabIndex={activeTab === 'custom' ? 0 : -1}
            onKeyDown={(event) => handleTabKeyDown(event, 'custom')}
          >
            Mine ({myAvatars.length})
          </button>
          <button
            id="avatar-tab-style"
            className={`ag-tab ${activeTab === 'style' ? 'ag-tab--active' : ''}`}
            onClick={() => setActiveTab('style')}
            role="tab"
            aria-selected={activeTab === 'style'}
            aria-controls="avatar-gallery-panel"
            tabIndex={activeTab === 'style' ? 0 : -1}
            onKeyDown={(event) => handleTabKeyDown(event, 'style')}
          >
            Style
          </button>
        </div>

        {activeTab !== 'style' && (
          <label className="ag-search">
            <span className="sr-only">Search Avatars</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search This Collection"
            />
            <span aria-hidden="true">⌕</span>
          </label>
        )}

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
        <div
          id="avatar-gallery-panel"
          className="ag-content"
          role="tabpanel"
          aria-labelledby={`avatar-tab-${activeTab}`}
        >
          {activeTab === 'style' ? (
            cosmeticsLoading ? (
              <div className="ag-empty">Loading Styles...</div>
            ) : !cosmeticsOk ? (
              /* Ownership is UNKNOWN. Not rendered as "you own nothing" — that
                 is the empty-success-state defect, and here it would tell a
                 paying member their VIP frames were never real. */
              <div className="ag-empty ag-empty--error" role="alert">
                <p className="ag-empty__msg">Your Frames And Auras Could Not Be Loaded.</p>
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
            ) : (
              <div className="ag-style">
                {(
                  [
                    {
                      kind: 'frame' as CosmeticKind,
                      label: 'Frames',
                      items: frames,
                      equipped: equippedFrame,
                    },
                    {
                      kind: 'aura' as CosmeticKind,
                      label: 'Auras',
                      items: auras,
                      equipped: equippedAura,
                    },
                  ] as const
                ).map((group) => (
                  <section className="ag-style__group" key={group.kind}>
                    <h4 className="ag-style__heading">{group.label}</h4>
                    <div className="ag-style__row">
                      {/* "None" is a real choice and gets a real tile. Without
                          it the only way to take a frame off would be to guess
                          that tapping the equipped one toggles it. */}
                      <button
                        type="button"
                        className={`ag-style__tile ${group.equipped === null ? 'ag-style__tile--selected' : ''}`}
                        disabled={savingCosmetic}
                        onClick={() => equipCosmetic(group.kind, null)}
                        aria-pressed={group.equipped === null}
                      >
                        <span
                          className="ag-style__swatch ag-style__swatch--none"
                          aria-hidden="true"
                        >
                          &#8709;
                        </span>
                        <span className="ag-style__name">None</span>
                      </button>

                      {group.items.map((cosmetic) => {
                        const isSelected = group.equipped === cosmetic.id;
                        const isLocked = !cosmetic.isOwned;
                        return (
                          <button
                            type="button"
                            key={cosmetic.id}
                            className={[
                              'ag-style__tile',
                              isSelected ? 'ag-style__tile--selected' : '',
                              isLocked ? 'ag-style__tile--locked' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            disabled={savingCosmetic}
                            aria-pressed={isSelected}
                            title={isLocked ? `${cosmetic.label} (VIP)` : cosmetic.label}
                            onClick={() => {
                              /* Locked tiles still respond. A tile that does
                                 nothing on tap is indistinguishable from a dead
                                 one, which is the note already written against
                                 the avatar grid above. Say why instead. */
                              if (isLocked) {
                                haptic.light();
                                setNotice(
                                  'Frames and auras are a VIP benefit, or can be granted in your club shop.'
                                );
                                return;
                              }
                              equipCosmetic(group.kind, cosmetic.id);
                            }}
                          >
                            {/* The swatch IS the cosmetic, drawn on a neutral
                                disc. There is no artwork file to show: these
                                are CSS, so the preview is the real thing at
                                tile size rather than a picture of it. */}
                            <span className="ag-style__swatch" aria-hidden="true">
                              <AvatarCosmetics
                                frame={group.kind === 'frame' ? cosmetic.id : null}
                                aura={group.kind === 'aura' ? cosmetic.id : null}
                              />
                            </span>
                            {isLocked && <span className="ag-style__lock">VIP</span>}
                            <span className="ag-style__name">{cosmetic.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )
          ) : loading ? (
            <div className="ag-empty">Loading Avatars...</div>
          ) : filteredAvatars.length === 0 && tabFailed ? (
            /* A source that did not answer is NOT an empty source. This branch
               exists because both used to print the same calm sentence, so a
               dead API read to the player as "there is nothing here". */
            <div className="ag-empty ag-empty--error" role="alert">
              <p className="ag-empty__msg">
                {activeTab === 'custom'
                  ? 'Your Avatars Could Not Be Loaded.'
                  : 'The Avatar Library Could Not Be Loaded.'}
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
                ? 'You Have Not Created Any Avatars Yet. Use Quick Avatar Above.'
                : activeTab === 'vip'
                  ? 'No VIP Avatars Available.'
                  : 'No Preset Avatars Available.'}
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
                  <button
                    type="button"
                    key={avatar.id}
                    className={[
                      'ag-item',
                      isSelected ? 'ag-item--selected' : '',
                      isLocked ? 'ag-item--locked' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => handleSelect(avatar)}
                    aria-pressed={isSelected}
                    aria-label={`${avatar.name}${isLocked ? ', VIP Required' : isUnlockedByPurchase ? ', Owned' : ''}`}
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
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Apply */}
        <div className="ag-footer">
          {/* On the Style tab this button is a way OUT, not a commit: frames
              and auras apply the moment they are tapped, so gating it on
              `unchanged` (which only tracks the avatar) would leave a player
              who came here purely to change their frame staring at a disabled
              button with no way to close but the X. */}
          {activeTab === 'style' ? (
            <button
              className={`ag-apply ${savingCosmetic ? 'ag-apply--saving' : ''}`}
              onClick={handleApply}
              disabled={savingCosmetic}
            >
              {savingCosmetic ? 'Saving...' : 'Done'}
            </button>
          ) : (
            <button
              className={`ag-apply ${saving ? 'ag-apply--saving' : ''}`}
              onClick={handleApply}
              disabled={saving}
            >
              {saving ? 'Saving...' : unchanged ? 'Done' : 'Done · Avatar Applied'}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

export default AvatarGallery;
