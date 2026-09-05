/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  USER PROFILE EDIT — Arena Identity
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * - Arena handle (profiles.alias - the name the tables call you)
 * - Bio / about me
 * - Player tags (e.g. "Aggressive", "Grinder"), up to three
 *
 * 2026-09-04: the avatar picker that lived here is gone. It offered six
 * dicebear.com URLs that the production CSP (img-src) does not allow, so every
 * choice rendered as a broken image, and the page that opened this dialog
 * never wrote `avatarUrl` back anyway - a control that showed nothing and
 * saved nothing. Avatars are library art on `arena_avatar_url`, chosen in the
 * World Hub avatar studio the profile's "Change Avatar" button opens.
 *
 * The name field used to write `profiles.username`. That column carries a
 * case-insensitive unique index, so a taken name failed with a generic "could
 * not be saved", and the tables do not even read it first: the arena resolver
 * (`playerDisplayName`) reads `alias` before `username`. The field is the
 * alias now, and the caller checks availability before it writes.
 */

import React, { useState, useEffect, useId, useRef } from 'react';
import { sanitizeInput } from '../../utils/sanitizeInput';
import './UserProfileEdit.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

export interface UserProfileData {
  id: string;
  /** Arena handle: profiles.alias. What the felt calls this player. */
  handle: string;
  avatarUrl: string;
  bio: string;
  tags: string[];
}

export interface UserProfileEditProps {
  isOpen: boolean;
  onClose: () => void;
  initialData: UserProfileData;
  onSave: (data: UserProfileData) => void | Promise<void>;
  /** Opens the avatar studio; rendered as a real control beside the portrait. */
  onChangeAvatar?: () => void;
}

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 16;
export const HANDLE_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function validateHandle(raw: string): string | null {
  const value = raw.trim();
  if (value.length < HANDLE_MIN) return `Handle Needs At Least ${HANDLE_MIN} Characters`;
  if (value.length > HANDLE_MAX) return `Handle Is Limited To ${HANDLE_MAX} Characters`;
  if (!HANDLE_PATTERN.test(value)) return 'Letters, Numbers, Dot, Dash And Underscore Only';
  return null;
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
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialDataRef = useRef(initialData);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(saving);
  const titleId = useId();
  const aliasId = useId();
  const bioId = useId();
  initialDataRef.current = initialData;
  onCloseRef.current = onClose;
  savingRef.current = saving;
  useEffect(() => {
    if (isOpen) {
      setFormData(initialDataRef.current);
      setSaving(false);
      setSaveError('');
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const handle = sanitizeInput(formData.handle).trim();
    const handleProblem = validateHandle(handle);
    if (handleProblem) {
      setSaveError(handleProblem);
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await onSave({
        ...formData,
        handle,
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
          <h2 id={titleId}>Edit Profile</h2>
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
                alt="Current Arena Avatar"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = generateDefaultAvatar();
                }}
              />
              {onChangeAvatar && (
                <button
                  type="button"
                  className="edit-avatar-btn"
                  onClick={onChangeAvatar}
                  aria-label="Open The Avatar Studio"
                >
                  Studio
                </button>
              )}
            </div>
            <p className="avatar-note">
              Arena Avatars Are Library Art, Chosen In The Avatar Studio. Your Social Photo Is Never
              Shown At The Tables.
            </p>
          </div>

          <form onSubmit={handleSave} className="profile-form">
            <div className="form-group">
              {/* Validation is validateHandle() on submit, not native pattern/
                  minLength: the native path blocks the submit silently and
                  never trims, so " RiverKing " could not be saved at all. */}
              <label htmlFor={aliasId}>Arena Handle</label>
              <input
                id={aliasId}
                value={formData.handle || ''}
                onChange={(e) => {
                  setSaveError('');
                  setFormData({ ...formData, handle: e.target.value });
                }}
                maxLength={HANDLE_MAX}
                autoFocus
                autoComplete="nickname"
                spellCheck={false}
                aria-describedby={`${aliasId}-hint`}
              />
              <small id={`${aliasId}-hint`} className="field-hint">
                The Name Every Table Shows. {HANDLE_MIN}-{HANDLE_MAX} Characters, No Spaces.
              </small>
            </div>

            <div className="form-group">
              <label htmlFor={bioId}>Bio (Max 100 Chars)</label>
              <textarea
                id={bioId}
                value={formData.bio}
                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                maxLength={100}
                rows={3}
              />
            </div>

            <div className="form-group">
              <label>Player Tags (Select Up To 3)</label>
              <div className="tags-grid">
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
