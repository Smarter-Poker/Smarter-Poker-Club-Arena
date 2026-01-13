/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 👤 USER PROFILE EDIT — Customization
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Deep profile customization.
 * - Change Avatar (Mock selection)
 * - Update Display Name
 * - Edit Bio / About Me
 * - Manage Player Tags (e.g., "Aggressive", "Grinder")
 */

import React, { useState } from 'react';
import './UserProfileEdit.css';

export interface UserProfileData {
    id: string;
    displayName: string;
    avatarUrl: string;
    bio: string;
    tags: string[];
}

export interface UserProfileEditProps {
    isOpen: boolean;
    onClose: () => void;
    initialData: UserProfileData;
    onSave: (data: UserProfileData) => void;
}

const AVAILABLE_AVATARS = [
    'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=Aneka',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=Bob',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=Molly',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=Jack',
    'https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah',
];

const AVAILABLE_TAGS = ['Aggressive', 'Passive', 'Grinder', 'Casual', 'Pro', 'Shark', 'Fish', 'Nit'];

export function UserProfileEdit({
    isOpen,
    onClose,
    initialData,
    onSave,
}: UserProfileEditProps) {
    const [formData, setFormData] = useState<UserProfileData>(initialData);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);

    if (!isOpen) return null;

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(formData);
        onClose();
    };

    const toggleTag = (tag: string) => {
        setFormData(prev => {
            if (prev.tags.includes(tag)) {
                return { ...prev, tags: prev.tags.filter(t => t !== tag) };
            }
            if (prev.tags.length >= 3) return prev; // Max 3 tags
            return { ...prev, tags: [...prev.tags, tag] };
        });
    };

    return (
        <div className="profile-overlay" onClick={onClose}>
            <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
                <div className="profile-header">
                    <h2>Edit Profile</h2>
                    <button className="close-btn" onClick={onClose}>×</button>
                </div>

                <div className="profile-content">
                    <div className="avatar-section">
                        <div className="current-avatar">
                            <img src={formData.avatarUrl} alt="Avatar" />
                            <button className="edit-avatar-btn" onClick={() => setShowAvatarPicker(!showAvatarPicker)}>
                                ✏️
                            </button>
                        </div>
                        {showAvatarPicker && (
                            <div className="avatar-picker">
                                {AVAILABLE_AVATARS.map((url) => (
                                    <img
                                        key={url}
                                        src={url}
                                        alt="Choice"
                                        className={`avatar-choice ${formData.avatarUrl === url ? 'selected' : ''}`}
                                        onClick={() => {
                                            setFormData({ ...formData, avatarUrl: url });
                                            setShowAvatarPicker(false);
                                        }}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    <form onSubmit={handleSave} className="profile-form">
                        <div className="form-group">
                            <label>Display Name</label>
                            <input
                                value={formData.displayName}
                                onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                                maxLength={12}
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label>Bio (Max 100 chars)</label>
                            <textarea
                                value={formData.bio}
                                onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                                maxLength={100}
                                rows={3}
                            />
                        </div>

                        <div className="form-group">
                            <label>Player Tags (Select up to 3)</label>
                            <div className="tags-grid">
                                {AVAILABLE_TAGS.map(tag => (
                                    <button
                                        key={tag}
                                        type="button"
                                        className={`tag-choice ${formData.tags.includes(tag) ? 'active' : ''}`}
                                        onClick={() => toggleTag(tag)}
                                    >
                                        {tag}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="form-actions">
                            <button type="button" className="cancel-btn" onClick={onClose}>Cancel</button>
                            <button type="submit" className="save-btn">Save Profile</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

export default UserProfileEdit;
