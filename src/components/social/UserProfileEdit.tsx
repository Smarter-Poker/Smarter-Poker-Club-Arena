/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  USER PROFILE EDIT — Customization
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Deep profile customization.
 * - Update Poker Alias (the arena handle: profiles.alias + profiles.username)
 * - Edit Bio / About Me
 * - Manage Player Tags (e.g., "Aggressive", "Grinder")
 *
 * 2026-09-04: the dicebear avatar picker is gone. It let a player choose one
 * of six external cartoon avatars, showed the choice in the dialog, and then
 * nothing persisted it - ProfilePage never wrote avatarUrl (and must not: the
 * arena avatar is library art written through AvatarService, the social photo
 * belongs to the World Hub). A control that looks like it works and does
 * nothing is a lie, so the portrait here is read-only and the caller owns the
 * real avatar flow (ProfilePage opens AvatarGallery).
 */

import React, { useState, useEffect, useId, useRef } from 'react';
import { sanitizeInput } from '../../utils/sanitizeInput';
import './UserProfileEdit.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { ALIAS_MAX, ALIAS_MIN, BIO_MAX, aliasProblem } from '../../utils/aliasRules';

export interface UserProfileData {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bio: string;
  tags: string[];
}

export interface UserProfileEditProps {
  isOpen: boolean;
  onClose: () => void;
  initialData: UserProfileData;
  onSave: (data: UserProfileData) => void | Promise<void>;
  /** Optional: lets the caller open the real avatar flow from inside the dialog. */
  onChangeAvatar?: () => void;
}

const AVAILABLE_TAGS = [
  'Aggressive',
  'Passive',
  'Grinder',
  'Casual',
  'Pro',
  'Shark',
  'Fish',
  'Nit',
];

export function UserProfileEdit({
  isOpen,
  onClose,
  initialData,
  onSave,
  onChangeAvatar,
}: UserProfileEditProps) {
  const [formData, setFormData] = useState<UserProfileData>(initialData);
  const [mounted, setMounted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [aliasTouched, setAliasTouched] = useState(false);
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialDataRef = useRef(initialData);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(saving);
  const titleId = useId();
  const aliasId = useId();
  const aliasHintId = useId();
  const bioId = useId();
  initialDataRef.current = initialData;
  onCloseRef.current = onClose;
  savingRef.current = saving;
  useEffect(() => {
    if (isOpen) {
      setFormData(initialDataRef.current);
      setSaving(false);
      setSaveError('');
      setAliasTouched(false);
      if (mountTimerRef.current) clearTimeout(mountTimerRef.current);
      mountTimerRef.current = setTimeout(() => {
        mountTimerRef.current = null;
        setMounted(true);
      }, 50);
    } else {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
      setMounted(false);
    }
    return () => {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKeys);
    return () => {
      document.removeEventListener('keydown', handleDialogKeys);
      previouslyFocused?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const aliasError = aliasProblem(formData.username || '');
  const showAliasError = aliasTouched && aliasError;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (aliasError) {
      setAliasTouched(true);
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await onSave({
        ...formData,
        username: sanitizeInput(formData.username).trim(),
        bio: sanitizeInput(formData.bio).trim(),
        tags: formData.tags,
      });
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Profile could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const toggleTag = (tag: string) => {
    setFormData((prev) => {
      if (prev.tags.includes(tag)) {
        return { ...prev, tags: prev.tags.filter((t) => t !== tag) };
      }
      if (prev.tags.length >= 3) return prev; // Max 3 tags
      return { ...prev, tags: [...prev.tags, tag] };
    });
  };

  return (
    <div className="profile-overlay" onClick={() => !saving && onClose()}>
      <div
        ref={dialogRef}
        className="profile-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="profile-header">
          <div>
            <span className="profile-eyebrow">Identity Record // Edit</span>
            <h2 id={titleId}>Edit Profile</h2>
          </div>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            disabled={saving}
            aria-label="Close Profile Editor"
          >
            ×
          </button>
        </div>

        <div className="profile-content">
          <div className="avatar-section">
            <div className="current-avatar">
              <img
                decoding="async"
                src={formData.avatarUrl || generateDefaultAvatar()}
                alt=""
                onError={(e) => {
                  (e.target as HTMLImageElement).src = generateDefaultAvatar();
                }}
              />
            </div>
            <p className="avatar-note">
              {onChangeAvatar ? (
                <button type="button" className="avatar-link" onClick={onChangeAvatar}>
                  Change Table Avatar
                </button>
              ) : (
                'Table Avatar Is Set From The Profile Page'
              )}
            </p>
          </div>

          <form onSubmit={handleSave} className="profile-form" noValidate>
            <div className="form-group">
              <label htmlFor={aliasId}>Poker Alias</label>
              <input
                id={aliasId}
                value={formData.username || ''}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                onBlur={() => setAliasTouched(true)}
                maxLength={ALIAS_MAX}
                required
                autoFocus
                autoComplete="nickname"
                spellCheck={false}
                aria-describedby={aliasHintId}
                aria-invalid={showAliasError ? true : undefined}
              />
              <span
                id={aliasHintId}
                className={`field-hint${showAliasError ? ' field-hint--error' : ''}`}
                role={showAliasError ? 'alert' : undefined}
              >
                {showAliasError
                  ? aliasError
                  : `${ALIAS_MIN}-${ALIAS_MAX} Characters. Letters, Numbers, Underscores. Shown At Every Table.`}
              </span>
            </div>

            <div className="form-group">
              <label htmlFor={bioId}>Bio</label>
              <textarea
                id={bioId}
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                maxLength={BIO_MAX}
                rows={3}
              />
              <span className="field-hint field-hint--count" aria-live="polite">
                {formData.bio.length} / {BIO_MAX}
              </span>
            </div>

            <div className="form-group">
              <span className="form-group-label" id={`${bioId}-tags`}>
                Player Tags (Select Up To 3)
              </span>
              <div className="tags-grid" role="group" aria-labelledby={`${bioId}-tags`}>
                {AVAILABLE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`tag-choice ${formData.tags.includes(tag) ? 'active' : ''}`}
                    onClick={() => toggleTag(tag)}
                    aria-pressed={formData.tags.includes(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="form-actions">
              {saveError && (
                <p className="profile-save-error" role="alert">
                  {saveError}
                </p>
              )}
              <button type="button" className="cancel-btn" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="save-btn-blue" disabled={saving}>
                {saving ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default UserProfileEdit;
