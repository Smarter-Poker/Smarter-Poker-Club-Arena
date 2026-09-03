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
import { AgentService } from '../../services/AgentService';
import styles from './PlayerInviteModal.module.css';
import { reportError } from '../../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PlayerInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The agent's USER id (Agent.userId), NOT the agents-table primary key.
   *
   * The caller used to pass `agent.id` here, which is the agents row's PK. It
   * was then written into columns that hold user ids, so even the writes that
   * did not fail outright were storing the wrong identifier.
   */
  agentUserId: string;
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
  agentUserId,
  clubId,
  onPlayerAdded,
}: PlayerInviteModalProps) {
  const isMounted = useIsMounted();
  const [mode, setMode] = useState<'search' | 'invite'>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ExistingPlayer[]>([]);
  const [searching, setSearching] = useState(false);
  // `inviteCode` holds the shareable invite LINK. The name is kept because the
  // styles and the copy button are keyed to it; what it contains changed when
  // the dead club_invites code was replaced by a link that actually redeems.
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
        .select('id, username, display_name, avatar_url:arena_avatar_url, email')
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
      // ONE permission-checked call that both creates the membership (at zero
      // chips, enforced by the BEFORE INSERT guard on club_members) and writes
      // agent_id, which is the column the hierarchy is built from.
      //
      // What this replaces: a direct insert carrying `referrer_id: agentId`.
      // club_members has no referrer_id column, so PostgREST rejected the whole
      // statement and this button had never once worked. It then wrote the
      // agent link into credit_assignments only, which the hierarchy does not
      // read, so even a hypothetical success would not have built a downline.
      const res = await AgentService.attachPlayerToAgent(clubId, agentUserId, player.id);

      if (!res.success) {
        if (isMounted.current) {
          setMessage({
            type: 'error',
            text: res.error || 'Failed to add player',
          });
        }
        return;
      }

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

  // Build the agent's shareable invite link.
  //
  // This used to write a row into `club_invites` and show a code like
  // "a414-X7QP". Nothing in the codebase has ever READ club_invites — the table
  // holds zero rows — so that code could not be redeemed by any path, and an
  // agent who shared it was sending a stranger a string that did nothing.
  //
  // The link below is the one the rest of the app already understands:
  // fn_redeem_club_invite_code resolves `ref` to the agent, attaches the new
  // player to their downline, and admits them to the club.
  const generateInviteCode = async () => {
    setInviting(true);
    if (isMounted.current) setMessage(null);

    try {
      const resolvedClubId = await resolveClubUUID(clubId);

      // player_number is what the redemption RPC matches on; the raw user id
      // works too and is the fallback when a profile has no number yet.
      const { data: profile } = await supabase
        .from('profiles')
        .select('player_number')
        .eq('id', agentUserId)
        .maybeSingle();

      const ref = profile?.player_number || agentUserId;
      const link = `${window.location.origin}/hub/club-arena/invite/${resolvedClubId}?ref=${ref}`;

      if (isMounted.current) {
        setInviteCode(link);
        setMessage({ type: 'success', text: 'Invite link ready!' });
      }
    } catch (err) {
      reportError(err, 'PlayerInviteModal.Failed_to_generate_invite');
      if (isMounted.current) setMessage({ type: 'error', text: 'Failed to generate invite link' });
    }
    setInviting(false);
  };

  // Copy the invite link
  const copyCode = () => {
    if (!inviteCode) return;
    navigator.clipboard.writeText(inviteCode);
    setMessage({ type: 'success', text: 'Link copied!' });
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
                placeholder="Search By Username..."
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
                  {searchQuery ? 'No Players Found' : 'Search For Players To Add'}
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
            {!inviteCode ? (
              <button
                className={styles.generateBtn}
                onClick={generateInviteCode}
                disabled={inviting}
              >
                {inviting ? 'Generating...' : 'Generate Invite Link'}
              </button>
            ) : (
              <div className={styles.codeDisplay}>
                <span className={styles.code}>{inviteCode}</span>
                <button onClick={copyCode}>Copy</button>
              </div>
            )}

            <div className={styles.inviteInfo}>
              <p>Share This Link With New Players</p>
              <p>Anyone Who Joins Through It Is Added To Your Downline</p>
              <p>New Players Always Start With Zero Chips</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
