/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📢 CLUB ANNOUNCEMENTS — News Feed
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Announcements and news for club members.
 * - Stickied important posts
 * - Chronological feed
 * - Admin controls (Create/Delete)
 */

import React, { useState } from 'react';
import './ClubAnnouncements.css';

export interface Announcement {
    id: string;
    author: string;
    title: string;
    content: string;
    date: string;
    isSticky: boolean;
    tags: string[];
}

export interface ClubAnnouncementsProps {
    isOpen: boolean;
    onClose: () => void;
    announcements: Announcement[];
    isAdmin: boolean;
    onCreate?: (title: string, content: string) => void;
    onDelete?: (id: string) => void;
}

export function ClubAnnouncements({
    isOpen,
    onClose,
    announcements,
    isAdmin,
    onCreate,
    onDelete,
}: ClubAnnouncementsProps) {
    const [showCreate, setShowCreate] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newContent, setNewContent] = useState('');

    if (!isOpen) return null;

    const sortedPosts = [...announcements].sort((a, b) => {
        if (a.isSticky && !b.isSticky) return -1;
        if (!a.isSticky && b.isSticky) return 1;
        return 0; // Assume already date sorted or handle date parse
    });

    const handleCreate = (e: React.FormEvent) => {
        e.preventDefault();
        if (onCreate && newTitle && newContent) {
            onCreate(newTitle, newContent);
            setNewTitle('');
            setNewContent('');
            setShowCreate(false);
        }
    };

    return (
        <div className="news-overlay" onClick={onClose}>
            <div className="news-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="news-header">
                    <div className="news-title-group">
                        <span className="news-icon">📢</span>
                        <h2 className="news-title">Club News</h2>
                    </div>
                    <div className="header-controls">
                        {isAdmin && !showCreate && (
                            <button className="create-btn" onClick={() => setShowCreate(true)}>
                                + New Post
                            </button>
                        )}
                        <button className="news-close" onClick={onClose}>×</button>
                    </div>
                </div>

                {/* Content */}
                <div className="news-content">
                    {/* Create Form */}
                    {showCreate && (
                        <form className="create-form" onSubmit={handleCreate}>
                            <h3 className="form-title">Create Announcement</h3>
                            <input
                                className="news-input"
                                placeholder="Title"
                                value={newTitle}
                                onChange={(e) => setNewTitle(e.target.value)}
                                required
                            />
                            <textarea
                                className="news-textarea"
                                placeholder="Write your announcement..."
                                value={newContent}
                                onChange={(e) => setNewContent(e.target.value)}
                                rows={4}
                                required
                            />
                            <div className="form-actions">
                                <button type="button" className="cancel-btn" onClick={() => setShowCreate(false)}>Cancel</button>
                                <button type="submit" className="post-btn">Post Announcement</button>
                            </div>
                        </form>
                    )}

                    {/* List */}
                    <div className="post-list">
                        {sortedPosts.length > 0 ? (
                            sortedPosts.map((post) => (
                                <div key={post.id} className={`news-item ${post.isSticky ? 'sticky' : ''}`}>
                                    <div className="post-header">
                                        <div className="post-meta">
                                            {post.isSticky && <span className="sticky-tag">📌 PINNED</span>}
                                            <span className="post-date">{post.date}</span>
                                            <span className="post-author">• {post.author}</span>
                                        </div>
                                        {isAdmin && onDelete && (
                                            <button className="delete-post-btn" onClick={() => onDelete(post.id)}>🗑️</button>
                                        )}
                                    </div>
                                    <h3 className="post-title">{post.title}</h3>
                                    <p className="post-body">{post.content}</p>
                                    {post.tags.length > 0 && (
                                        <div className="post-tags">
                                            {post.tags.map(tag => <span key={tag} className="tag">#{tag}</span>)}
                                        </div>
                                    )}
                                </div>
                            ))
                        ) : (
                            <div className="news-empty">No announcements yet.</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ClubAnnouncements;
