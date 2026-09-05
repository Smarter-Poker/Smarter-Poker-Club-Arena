/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AVATAR CUSTOMIZER — Quick Avatar (icon + background), rebuilt 2026-08-25
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS WRONG WITH IT
 *
 * This component shipped with a "Save Avatar" button that saved nothing. It
 * called an OPTIONAL `onSave` prop, and no file in the app rendered it — it was
 * exported from customization/index.ts and imported by nobody. Three separate
 * failures stacked on top of each other:
 *
 *   1. NOT REACHABLE. Zero mount sites, so the feature did not exist.
 *   2. COULD NOT PERSIST EVEN IF IT WERE. It emitted the string
 *      `preset:<emoji>:<hex>`, and AvatarService.isLibraryAvatarUrl — the write
 *      point that enforces "they can now only use avatars" — refuses anything
 *      that is not library art, a generated SVG, or AI-generated art. Every
 *      save would have been refused at the service and returned false.
 *   3. THE UPLOAD TAB WAS A GHOST. Photos were removed platform-wide on
 *      2026-08-21; the file input here would have produced a base64 JPEG data
 *      URL, which the same guard refuses. It is gone.
 *
 * WHAT IT DOES NOW
 *
 * It composes the choice into an SVG DATA URL — which the library-only guard
 * explicitly accepts, because it is drawn locally and contains no photograph —
 * then writes it through avatarService.setUserAvatar (profiles.arena_avatar_url
 * plus a user_avatars history row), toasts, and publishes on the MasterBus so
 * the header orb and every other avatar surface repaint without a reload.
 *
 * The glyphs are card-suit and geometric Unicode symbols, NOT emoji. The old
 * list was sixteen emoji (shark, wolf, unicorn, crown...) written as surrogate
 * pairs; these render identically on every platform, carry no colour font, and
 * keep the house "no emoji in source" rule true by construction rather than by
 * escaping around it.
 *
 * Mobile-first: the grids are 6-up at 375px and grow from there.
 */

import React, { useMemo, useRef, useState } from 'react';
import { avatarService } from '../../services/AvatarService';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { haptic } from '../../services/SoundService';
import { reportError } from '../../utils/errorReporter';
import './AvatarCustomizer.css';

interface AvatarCustomizerProps {
  /** Whose avatar this writes. Without it the component cannot save. */
  userId: string;
  currentAvatar?: string;
  /** Fired with the saved data URL once the write succeeded. */
  onSaved?: (avatarUrl: string) => void;
}

const PRESET_ICONS = [
  '♠', // spade
  '♥', // heart
  '♦', // diamond
  '♣', // club
  '♛', // queen
  '♞', // knight
  '★', // star
  '◆', // solid diamond shape
  '▲', // triangle
  '●', // disc
  '✦', // four-point star
  '❖', // florette
];

const AVATAR_BACKGROUNDS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

/**
 * Compose the choice into an SVG data URL.
 *
 * Deliberately tiny (a few hundred bytes): this string is stored in
 * profiles.arena_avatar_url and is therefore re-sent to every client that
 * renders this player at a table. The base64 photo blobs that used to live in
 * that column are exactly why the upload path was removed.
 */
export function composeQuickAvatar(glyph: string, background: string, size = 128): string {
  const safeGlyph = glyph.replace(/[<>&"]/g, '');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.15)}" fill="${background}"/>` +
    `<text x="50%" y="54%" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="system-ui,-apple-system,sans-serif" font-size="${Math.round(size * 0.58)}" ` +
    `fill="#ffffff">${safeGlyph}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const AvatarCustomizer: React.FC<AvatarCustomizerProps> = ({
  userId,
  currentAvatar,
  onSaved,
}) => {
  /* Defaults to a real selection, not ''. The old component opened with an
     empty glyph, so the preview was a blank coloured square and Save produced
     `preset::#ef4444`. */
  const [selectedIcon, setSelectedIcon] = useState(PRESET_ICONS[0]);
  const [selectedBg, setSelectedBg] = useState(AVATAR_BACKGROUNDS[0]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const mutationInstanceRef = useRef(`avatar-customizer-${Math.random().toString(36).slice(2)}`);
  const mutationRevisionRef = useRef(0);

  const previewUrl = useMemo(
    () => composeQuickAvatar(selectedIcon, selectedBg),
    [selectedIcon, selectedBg]
  );

  const alreadyApplied = currentAvatar === previewUrl;

  const handleSave = async () => {
    if (saving) return;

    if (!userId) {
      toast.error('Sign In To Save An Avatar');
      return;
    }

    if (alreadyApplied) {
      // Silence is not confirmation. Say the state out loud.
      toast.success('Avatar Already Applied');
      return;
    }

    setSaving(true);
    haptic.medium();
    const mutationId = `${mutationInstanceRef.current}:${++mutationRevisionRef.current}`;
    masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
      kind: 'player-appearance',
      scope: userId,
      mutationId,
      state: 'pending',
    });
    masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
      userId,
      avatar: previewUrl,
      mutationId,
      source: 'avatar-picker',
    });
    masterBus.emit('USER_PROFILE_LOADED', { avatarUrl: previewUrl, userId });
    try {
      const saved = await avatarService.setUserAvatar(userId, previewUrl);
      if (!saved) {
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'player-appearance',
          scope: userId,
          mutationId,
          state: 'rolling-back',
        });
        if (currentAvatar) {
          masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
            userId,
            avatar: currentAvatar,
            mutationId,
            source: 'rollback',
          });
          masterBus.emit('USER_PROFILE_LOADED', { avatarUrl: currentAvatar, userId });
        }
        masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
          kind: 'player-appearance',
          scope: userId,
          mutationId,
          state: 'rolled-back',
        });
        toast.error('Could Not Save Avatar. Please Try Again.');
        return;
      }
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: userId,
        mutationId,
        state: 'confirmed',
      });
      toast.success('Avatar Saved');
      onSaved?.(previewUrl);
    } catch (err) {
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: userId,
        mutationId,
        state: 'rolling-back',
      });
      if (currentAvatar) {
        masterBus.emit('PLAYER_APPEARANCE_CHANGED', {
          userId,
          avatar: currentAvatar,
          mutationId,
          source: 'rollback',
        });
        masterBus.emit('USER_PROFILE_LOADED', { avatarUrl: currentAvatar, userId });
      }
      masterBus.emit('CUSTOMIZATION_MUTATION_STATE', {
        kind: 'player-appearance',
        scope: userId,
        mutationId,
        state: 'rolled-back',
      });
      reportError(err, 'AvatarCustomizer.handleSave');
      toast.error('Could Not Save Avatar. Please Try Again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="avatar-customizer">
      <div className="avatar-preview-large">
        <img src={previewUrl} alt="Avatar Preview" />
      </div>

      <div className="preset-options">
        <div className="option-section">
          <label>Icon</label>
          <div className="emoji-grid">
            {PRESET_ICONS.map((glyph) => (
              <button
                key={glyph}
                type="button"
                className={`emoji-btn ${selectedIcon === glyph ? 'selected' : ''}`}
                aria-pressed={selectedIcon === glyph}
                onClick={() => {
                  haptic.light();
                  setSelectedIcon(glyph);
                }}
              >
                {glyph}
              </button>
            ))}
          </div>
        </div>

        <div className="option-section">
          <label>Background</label>
          <div className="color-grid">
            {AVATAR_BACKGROUNDS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Background ${color}`}
                className={`avatar-customizer__color-btn ${selectedBg === color ? 'selected' : ''}`}
                style={{ background: color }}
                aria-pressed={selectedBg === color}
                onClick={() => {
                  haptic.light();
                  setSelectedBg(color);
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <button
        className="save-avatar-btn"
        type="button"
        onClick={handleSave}
        disabled={saving || !userId}
      >
        {saving ? 'Saving...' : 'Save Avatar'}
      </button>
    </div>
  );
};

export default AvatarCustomizer;
