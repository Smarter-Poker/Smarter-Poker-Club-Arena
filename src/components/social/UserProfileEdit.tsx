/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  USER PROFILE EDIT — Customization
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Deep profile customization.
 * - Change Avatar (uses dicebear.com API for avatars)
 * - Update Display Name
 * - Edit Bio / About Me
 * - Manage Player Tags (e.g., "Aggressive", "Grinder")
 */

import React, { useState, useEffect, useId, useRef } from 'react';
import { sanitizeInput } from '../../utils/sanitizeInput';
import './UserProfileEdit.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

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
}

const AVAILABLE_AVATARS = [
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Aneka',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Bob',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Molly',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Jack',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah',
];

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

export function UserProfileEdit({ isOpen, onClose, initialData, onSave }: UserProfileEditProps) {
  const [formData, setFormData] = useState<UserProfileData>(initialData);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
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
      setShowAvatarPicker(false);
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
    setSaving(true);
    setSaveError('');
    try {
      await onSave({
        ...formData,
        username: sanitizeInput(formData.username),
        bio: sanitizeInput(formData.bio),
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
                loading="lazy"
                decoding="async"
                src={formData.avatarUrl}
                alt="Avatar"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = generateDefaultAvatar();
                }}
              />
              <button
                type="button"
                className="edit-avatar-btn"
                onClick={() => setShowAvatarPicker(!showAvatarPicker)}
                aria-expanded={showAvatarPicker}
                aria-label="Choose Profile Avatar"
              >
                Edit
              </button>
            </div>
            {showAvatarPicker && (
              <div className="avatar-picker">
                {AVAILABLE_AVATARS.map((url) => (
                  <button
                    type="button"
                    key={url}
                    className={`avatar-choice ${formData.avatarUrl === url ? 'selected' : ''}`}
                    aria-label="Select This Avatar"
                    aria-pressed={formData.avatarUrl === url}
                    onClick={() => {
                      setFormData({ ...formData, avatarUrl: url });
                      setShowAvatarPicker(false);
                    }}
                  >
                    <img loading="lazy" decoding="async" src={url} alt="" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={handleSave} className="profile-form">
            <div className="form-group">
              <label htmlFor={aliasId}>Poker Alias</label>
              <input
                id={aliasId}
                value={formData.username || ''}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                maxLength={16}
                required
                autoFocus
                autoComplete="nickname"
              />
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
