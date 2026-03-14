/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NEW CONVERSATION PAGE — Compose New DM or Group Chat
 * ═══════════════════════════════════════════════════════════════════════════════
 * Features: User search/picker, group naming, create and navigate to thread
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { messagingService } from '../services/MessagingService';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { PlayerAvatar } from '../components/avatars/PlayerAvatar';
import { useDebounce } from '../hooks/useDebounce';
import './NewConversationPage.css';

interface UserResult {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isOnline: boolean;
}

export default function NewConversationPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<UserResult[]>([]);
  const [groupName, setGroupName] = useState('');
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);

  const isGroup = selectedUsers.length > 1;

  // Debounced search
  const debouncedSearch = useDebounce(async (query: string) => {
    if (!query.trim() || !user?.id) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, is_online')
        .neq('id', user.id)
        .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
        .limit(20);
      if (error) console.error('[NewConversation] Profile search failed:', error.message);

      // Exclude already selected users
      const selectedIds = new Set(selectedUsers.map((u) => u.id));
      setSearchResults(
        (data || [])
          .filter((u: any) => !selectedIds.has(u.id))
          .map((u: any) => ({
            id: u.id,
            username: u.username,
            displayName: u.display_name,
            avatarUrl: u.avatar_url,
            isOnline: u.is_online || false,
          }))
      );
    } catch (err) {
      console.error('[NewConversation] Search error:', err);
    }
    setSearching(false);
  }, 300);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      debouncedSearch(value);
    },
    [debouncedSearch]
  );

  const selectUser = (user: UserResult) => {
    setSelectedUsers((prev) => [...prev, user]);
    setSearchQuery('');
    setSearchResults([]);
  };

  const removeUser = (userId: string) => {
    setSelectedUsers((prev) => prev.filter((u) => u.id !== userId));
  };

  const handleCreate = async () => {
    if (!user?.id || selectedUsers.length === 0) return;

    setCreating(true);
    try {
      if (isGroup) {
        // Create group conversation
        const name = groupName.trim() || selectedUsers.map((u) => u.username).join(', ');
        const conv = await messagingService.createGroupConversation(
          user.id,
          selectedUsers.map((u) => u.id),
          name
        );
        if (conv) {
          masterBus.emit('CONVERSATION_UPDATED', { conversationId: conv.id });
          navigate(`/messages/${conv.id}`, { replace: true });
        } else {
          toast.error('Failed to create group');
        }
      } else {
        // 1:1 DM
        const conv = await messagingService.startConversation(user.id, selectedUsers[0].id);
        if (conv) {
          masterBus.emit('CONVERSATION_UPDATED', { conversationId: conv.id });
          navigate(`/messages/${conv.id}`, { replace: true });
        } else {
          toast.error('Failed to start conversation');
        }
      }
    } catch (err) {
      console.error('[NewConversation] Create error:', err);
      toast.error('Failed to create conversation');
    }
    setCreating(false);
  };

  return (
    <div className="new-conversation-page">
      {/* Header */}
      <div className="new-conv-header">
        <button className="back-btn" onClick={() => navigate(-1)}>
          ←
        </button>
        <h2>New Message</h2>
        <button
          className="create-btn"
          onClick={handleCreate}
          disabled={selectedUsers.length === 0 || creating}
        >
          {creating ? '...' : isGroup ? 'Create Group' : 'Start Chat'}
        </button>
      </div>

      {/* Selected Users Chips */}
      {selectedUsers.length > 0 && (
        <div className="selected-users">
          <span className="to-label">To:</span>
          {selectedUsers.map((u) => (
            <div key={u.id} className="user-chip">
              <img
                src={u.avatarUrl || '/default-avatar.png'}
                alt={u.username}
                className="chip-avatar"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = '/default-avatar.png';
                }}
              />
              <span>{u.username}</span>
              <button className="chip-remove" onClick={() => removeUser(u.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Group Name (when 2+ users selected) */}
      {isGroup && (
        <div className="group-name-field">
          <input
            type="text"
            placeholder="Group name (optional)"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            maxLength={50}
          />
        </div>
      )}

      {/* Search Input */}
      <div className="user-search">
        <input
          type="text"
          placeholder="Search players by username..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          autoFocus
        />
        {searching && <div className="search-spinner" />}
      </div>

      {/* Search Results */}
      <div className="search-results">
        {searchResults.length === 0 && searchQuery.trim() && !searching ? (
          <div className="no-results">
            <p>No players found matching "{searchQuery}"</p>
          </div>
        ) : (
          searchResults.map((result) => (
            <div key={result.id} className="result-item" onClick={() => selectUser(result)}>
              <PlayerAvatar
                src={result.avatarUrl || '/default-avatar.png'}
                name={result.username}
                size="sm"
                presenceStatus={result.isOnline ? 'online' : 'offline'}
                showPresence={true}
                showLevelBadge={false}
                showXpRing={false}
                showVipRing={false}
              />
              <div className="result-info">
                <span className="result-name">{result.displayName || result.username}</span>
                <span className="result-handle">@{result.username}</span>
              </div>
              <span className="result-status">
                {result.isOnline ? (
                  <span className="online-dot" />
                ) : (
                  <span className="offline-text">Offline</span>
                )}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Empty state when nothing searched */}
      {!searchQuery.trim() && selectedUsers.length === 0 && (
        <div className="empty-prompt">
          <span className="empty-icon">✉</span>
          <p>Search for a player to start a conversation</p>
          <p className="hint">You can add multiple people to create a group chat</p>
        </div>
      )}
    </div>
  );
}
