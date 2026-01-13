/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 👥 FRIENDS LIST — Social Hub
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manage friends and social connections.
 * - Online/Offline grouping
 * - Add Friend by ID/Username
 * - Actions: Chat, Remove, Invite to Table
 */

import React, { useState } from 'react';
import './FriendsList.css';

export interface Friend {
    id: string;
    name: string;
    avatar?: string;
    status: 'online' | 'offline' | 'in-game';
    lastSeen?: string;
}

export interface FriendsListProps {
    isOpen: boolean;
    onClose: () => void;
    friends: Friend[];
    onAddFriend: (username: string) => void;
    onOpenChat: (friendId: string) => void;
    onRemoveFriend: (friendId: string) => void;
    onInvite: (friendId: string) => void;
}

export function FriendsList({
    isOpen,
    onClose,
    friends,
    onAddFriend,
    onOpenChat,
    onRemoveFriend,
    onInvite,
}: FriendsListProps) {
    const [activeTab, setActiveTab] = useState<'all' | 'requests'>('all');
    const [addInput, setAddInput] = useState('');

    if (!isOpen) return null;

    const onlineFriends = friends.filter(f => f.status !== 'offline');
    const offlineFriends = friends.filter(f => f.status === 'offline');

    const handleAddSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (addInput.trim()) {
            onAddFriend(addInput.trim());
            setAddInput('');
        }
    };

    return (
        <div className="friends-panel">
            {/* Header */}
            <div className="friends-header">
                <h3 className="friends-title">Friends</h3>
                <button className="friends-close" onClick={onClose}>×</button>
            </div>

            {/* Toolbar / Add */}
            <div className="friends-toolbar">
                <form className="add-friend-form" onSubmit={handleAddSubmit}>
                    <input
                        type="text"
                        className="add-input"
                        placeholder="Add by username..."
                        value={addInput}
                        onChange={(e) => setAddInput(e.target.value)}
                    />
                    <button type="submit" className="add-btn" disabled={!addInput.trim()}>+</button>
                </form>
            </div>

            {/* Tabs (optional future expansion) */}
            <div className="friends-tabs">
                <button
                    className={`friends-tab ${activeTab === 'all' ? 'active' : ''}`}
                    onClick={() => setActiveTab('all')}
                >
                    All ({friends.length})
                </button>
                <button
                    className={`friends-tab ${activeTab === 'requests' ? 'active' : ''}`}
                    onClick={() => setActiveTab('requests')}
                >
                    Requests (0)
                </button>
            </div>

            {/* List */}
            <div className="friends-content">
                {friends.length === 0 ? (
                    <div className="friends-empty">No friends yet. Add some!</div>
                ) : (
                    <>
                        {/* Online Section */}
                        {onlineFriends.length > 0 && (
                            <div className="friends-section">
                                <h4 className="section-label">Online — {onlineFriends.length}</h4>
                                {onlineFriends.map(friend => (
                                    <FriendItem
                                        key={friend.id}
                                        friend={friend}
                                        onChat={onOpenChat}
                                        onRemove={onRemoveFriend}
                                        onInvite={onInvite}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Offline Section */}
                        {offlineFriends.length > 0 && (
                            <div className="friends-section">
                                <h4 className="section-label">Offline — {offlineFriends.length}</h4>
                                {offlineFriends.map(friend => (
                                    <FriendItem
                                        key={friend.id}
                                        friend={friend}
                                        onChat={onOpenChat}
                                        onRemove={onRemoveFriend}
                                        onInvite={onInvite}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

// Sub-component for individual rows
function FriendItem({ friend, onChat, onRemove, onInvite }: {
    friend: Friend,
    onChat: (id: string) => void,
    onRemove: (id: string) => void,
    onInvite: (id: string) => void
}) {
    const [showMenu, setShowMenu] = useState(false);

    return (
        <div className="friend-row" onMouseLeave={() => setShowMenu(false)}>
            <div className="friend-main" onClick={() => onChat(friend.id)}>
                <div className="friend-avatar">
                    {friend.avatar ? (
                        <img src={friend.avatar} alt={friend.name} />
                    ) : (
                        <span>{friend.name[0].toUpperCase()}</span>
                    )}
                    <span className={`status-badge ${friend.status}`} />
                </div>
                <div className="friend-info">
                    <span className="friend-name">{friend.name}</span>
                    <span className="friend-status-text">
                        {friend.status === 'in-game' ? 'Playing Poker' : friend.status === 'online' ? 'Online' : 'Offline'}
                    </span>
                </div>
            </div>

            <div className="friend-actions">
                <button className="action-icon-btn" onClick={() => onChat(friend.id)} title="Message">
                    💬
                </button>
                <button className="action-icon-btn" onClick={() => setShowMenu(!showMenu)} title="Menu">
                    ⋮
                </button>

                {showMenu && (
                    <div className="friend-dropdown">
                        <button onClick={() => onInvite(friend.id)}>Invite to Table</button>
                        <button onClick={() => onRemove(friend.id)} className="danger">Remove Friend</button>
                    </div>
                )}
            </div>
        </div>
    );
}

export default FriendsList;
