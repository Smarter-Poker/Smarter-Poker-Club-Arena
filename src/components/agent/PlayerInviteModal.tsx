/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER INVITE MODAL — Add Players to Agent
 * Allows agents to invite new players under their hierarchy
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import styles from './PlayerInviteModal.module.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PlayerInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  clubId: string;
  onPlayerAdded?: () => void;
}

interface ExistingPlayer {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  email?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function PlayerInviteModal({
  isOpen,
  onClose,
  agentId,
  clubId,
  onPlayerAdded,
}: PlayerInviteModalProps) {
  const isMounted = useIsMounted();
  const [mode, setMode] = useState<'search' | 'invite'>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ExistingPlayer[]>([]);
  const [searching, setSearching] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviting, setInviting] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setSearchResults([]);
      setInviteEmail('');
      setInviteCode('');
      setMessage(null);
    }
  }, [isOpen]);

  // Search for existing players
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setMessage(null);

    try {
      // Search profiles by username or display name
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, email')
        .or(`username.ilike.%${searchQuery}%,display_name.ilike.%${searchQuery}%`)
        .limit(10);

      if (error) throw error;

      // Filter out players already in club
      const { data: existingMembers } = await supabase
        .from('club_members')
        .select('user_id')
        .eq('club_id', await resolveClubUUID(clubId));

      const existingIds = new Set(existingMembers?.map((m) => m.user_id) || []);

      setSearchResults(
        (data || [])
          .filter((p) => !existingIds.has(p.id))
          .map((p) => ({
            id: p.id,
            username: p.username,
            displayName: p.display_name || p.username,
            avatarUrl: p.avatar_url,
            email: p.email,
          }))
      );
    } catch (err) {
      reportError(err, 'PlayerInviteModal.Search_failed');
      if (isMounted.current) setMessage({ type: 'error', text: 'Search failed' });
    }
    setSearching(false);
  };

  // Add existing player to agent
  const handleAddPlayer = async (player: ExistingPlayer) => {
    setAdding(player.id);
    if (isMounted.current) setMessage(null);

    try {
      // First add to club_memberships
      const { error: membershipError } = await supabase.from('club_members').insert({
        club_id: clubId,
        user_id: player.id,
        role: 'player',
        referrer_id: agentId,
        status: 'active',
      });

      if (membershipError && !membershipError.message.includes('duplicate')) {
        throw membershipError;
      }

      // Update player's agent assignment in credit_assignments
      const { error: assignmentError } = await supabase.from('credit_assignments').upsert(
        {
          club_id: clubId,
          player_id: player.id,
          agent_id: agentId,
          credit_limit: 0,
          credits_used: 0,
          status: 'active',
        },
        { onConflict: 'club_id,player_id' }
      );

      if (assignmentError) throw assignmentError;

      if (isMounted.current)
        setMessage({ type: 'success', text: `${player.displayName} added successfully!` });
      setSearchResults((prev) => prev.filter((p) => p.id !== player.id));
      onPlayerAdded?.();
    } catch (err) {
      reportError(err, 'PlayerInviteModal.Failed_to_add_player');
      if (isMounted.current) setMessage({ type: 'error', text: 'Failed to add player' });
    }
    setAdding(null);
  };

  // Generate invite code
  const generateInviteCode = async () => {
    setInviting(true);
    if (isMounted.current) setMessage(null);

    try {
      // Generate a unique invite code
      const code = `${clubId.slice(0, 4)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      const { error } = await supabase.from('club_invites').insert({
        club_id: clubId,
        agent_id: agentId,
        code: code,
        email: inviteEmail || null,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
        status: 'pending',
      });

      if (error) throw error;

      setInviteCode(code);
      if (isMounted.current) setMessage({ type: 'success', text: 'Invite code generated!' });
    } catch (err) {
      reportError(err, 'PlayerInviteModal.Failed_to_generate_invite');
      if (isMounted.current) setMessage({ type: 'error', text: 'Failed to generate invite code' });
    }
    setInviting(false);
  };

  // Copy invite code
  const copyCode = () => {
    navigator.clipboard.writeText(inviteCode);
    setMessage({ type: 'success', text: 'Code copied!' });
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        {/* Header */}
        <div className={styles.header}>
          <h2> Add Player</h2>
          <button className={styles.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Mode Tabs */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${mode === 'search' ? styles.active : ''}`}
            onClick={() => setMode('search')}
          >
            Find Existing
          </button>
          <button
            className={`${styles.tab} ${mode === 'invite' ? styles.active : ''}`}
            onClick={() => setMode('invite')}
          >
            Invite New
          </button>
        </div>

        {/* Message */}
        {message && (
          <div className={`${styles.message} ${styles[message.type]}`}>{message.text}</div>
        )}

        {/* Search Mode */}
        {mode === 'search' && (
          <div className={styles.searchSection}>
            <div className={styles.searchBar}>
              <input
                type="text"
                placeholder="Search by username..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              />
              <button onClick={handleSearch} disabled={searching || !searchQuery.trim()}>
                {searching ? '...' : ''}
              </button>
            </div>

            <div className={styles.results}>
              {searchResults.length === 0 ? (
                <div className={styles.noResults}>
                  {searchQuery ? 'No players found' : 'Search for players to add'}
                </div>
              ) : (
                searchResults.map((player) => (
                  <div key={player.id} className={styles.resultCard}>
                    <div className={styles.playerAvatar}>
                      {player.avatarUrl ? (
                        <img loading="lazy" decoding="async" src={player.avatarUrl} alt="" />
                      ) : (
                        <span>{player.displayName.charAt(0)}</span>
                      )}
                    </div>
                    <div className={styles.playerInfo}>
                      <span className={styles.playerName}>{player.displayName}</span>
                      <span className={styles.playerUsername}>@{player.username}</span>
                    </div>
                    <button
                      className={styles.addBtn}
                      onClick={() => handleAddPlayer(player)}
                      disabled={adding === player.id}
                    >
                      {adding === player.id ? '...' : '+ Add'}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Invite Mode */}
        {mode === 'invite' && (
          <div className={styles.inviteSection}>
            <div className={styles.inviteForm}>
              <label>Email (Optional)</label>
              <input
                type="email"
                placeholder="player@email.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <p className={styles.hint}>Leave Blank To Generate A Shareable Code</p>
            </div>

            {!inviteCode ? (
              <button
                className={styles.generateBtn}
                onClick={generateInviteCode}
                disabled={inviting}
              >
                {inviting ? 'Generating...' : 'Generate Invite Code'}
              </button>
            ) : (
              <div className={styles.codeDisplay}>
                <span className={styles.code}>{inviteCode}</span>
                <button onClick={copyCode}> Copy</button>
              </div>
            )}

            <div className={styles.inviteInfo}>
              <p> Share This Code With New Players</p>
              <p> Code Expires In 7 Days</p>
              <p> Player Will Be Assigned To You</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
