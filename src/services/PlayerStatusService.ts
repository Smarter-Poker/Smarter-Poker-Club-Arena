/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER STATUS SERVICE — Q3 Social: "Playing At" + Status Updates
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages player activity status ("Playing at Table X"), custom status messages,
 * and "Playing At" visibility for friends.
 */

import { supabase } from '../lib/supabase';
import { readPresence } from '../lib/ownProfile';
import { masterBus } from '../core/MasterBus';
import { generateDefaultAvatar } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';
import { publicOrigin } from '../lib/appBase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlayerStatus {
  userId: string;
  statusText: string | null; // Custom status: "Grinding MTTs"
  playingAt: string | null; // Current table name
  playingAtTableId: string | null; // Current table ID for deep-link
  isOnline: boolean;
  /** Never filled: a player's last-seen time is theirs alone (ruling 25). */
  lastSeen?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class PlayerStatusServiceClass {
  private currentStatus: PlayerStatus | null = null;

  /* setStatusText is GONE (2026-10-05). It UPDATEd profiles.status_text
     directly, and `authenticated` holds neither UPDATE nor SELECT on that
     column - every call was a 42501 - and nothing in the app called it. A
     custom status needs a sanctioned writer and reader (definer RPCs) first;
     until then there is no status to set or show. */

  /**
   * Update the user's "playing at" table status
   * NOTE: current_table and current_table_id columns do not exist in profiles table.
   * This method is retained for API compatibility but does not perform any updates.
   */
  async setPlayingAt(
    userId: string,
    tableName: string | null,
    tableId: string | null
  ): Promise<void> {
    // No-op: profiles table does not have current_table or current_table_id columns
    this.currentStatus = this.currentStatus
      ? { ...this.currentStatus, playingAt: tableName, playingAtTableId: tableId }
      : null;
  }

  /**
   * Clear the user's "playing at" status (when leaving a table)
   */
  async clearPlayingAt(userId: string): Promise<void> {
    await this.setPlayingAt(userId, null, null);
  }

  /**
   * Get a friend's current status
   */
  async getPlayerStatus(userId: string): Promise<PlayerStatus | null> {
    const { data, error } = await supabase
      .from('profiles')
      /**
       * `id` only. This read used to name `status_text`, and `authenticated`
       * holds no SELECT on that column, so the WHOLE read was refused (42501)
       * and the profile page lost its online dot along with the status. There
       * is no sanctioned read path for status_text yet (no granted column, no
       * RPC), so the custom status stays null rather than failing the read it
       * rides on. It once read `status_text:status` instead - the ACCOUNT
       * state shown as if the player had written it; that is not coming back.
       */
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) return null;

    /* Online-now is the presence door's answer (the flag AND a heartbeat
       under five minutes old), never the raw is_online flag, which stays true
       long after somebody leaves. One definition for every surface:
       tests/presence-has-one-definition.law.test.ts. */
    let isOnline = false;
    try {
      isOnline = (await readPresence([data.id])).get(data.id) === true;
    } catch (e) {
      reportError(e, 'PlayerStatusService.getPlayerStatus.presence');
    }

    return {
      userId: data.id,
      statusText: null,
      playingAt: null,
      playingAtTableId: null,
      isOnline,
    };
  }

  /**
   * Get the "playing at" status of all online friends
   * NOTE: Friendships are bidirectional — query BOTH directions.
   * Uses two-step query since friendships table has no FK constraints.
   */
  async getFriendsStatus(userId: string): Promise<PlayerStatus[]> {
    // Step 1: Get all friend IDs (bidirectional)
    const [{ data: dir1 }, { data: dir2 }] = await Promise.all([
      supabase
        .from('friendships')
        .select('friend_id')
        .eq('user_id', userId)
        .eq('status', 'accepted'),
      supabase
        .from('friendships')
        .select('user_id')
        .eq('friend_id', userId)
        .eq('status', 'accepted'),
    ]);

    // Collect unique friend IDs
    const friendIds = new Set<string>();
    (dir1 || []).forEach((f: any) => f.friend_id && friendIds.add(f.friend_id));
    (dir2 || []).forEach((f: any) => f.user_id && friendIds.add(f.user_id));

    if (friendIds.size === 0) return [];

    // Step 2: who of them is online now, by the presence door - not a filter
    // on the raw is_online flag, which stays true long after somebody leaves.
    let presence: Map<string, boolean>;
    try {
      presence = await readPresence(Array.from(friendIds));
    } catch (e) {
      reportError(e, 'PlayerStatusService.getFriendsStatus.presence');
      return [];
    }
    const onlineIds = Array.from(friendIds).filter((id) => presence.get(id) === true);
    if (onlineIds.length === 0) return [];

    // No third read for "their public status lines": it selected
    // profiles.status_text, which `authenticated` cannot read, so it refused
    // and this returned nobody. There is no status to show until a sanctioned
    // reader exists (see getPlayerStatus).
    return onlineIds.map((id) => ({
      userId: id,
      statusText: null,
      playingAt: null,
      playingAtTableId: null,
      isOnline: true,
    }));
  }

  /**
   * Generate a shareable profile link
   */
  generateProfileLink(userId: string): string {
    return `${publicOrigin()}/hub/club-arena/profile/${userId}`;
  }

  /**
   * Generate a shareable profile card (for messaging or external sharing)
   */
  generateProfileCard(profile: {
    userId: string;
    username: string;
    avatarUrl?: string;
    level?: number;
  }): {
    type: 'profile_card';
    userId: string;
    username: string;
    avatarUrl: string;
    level: number;
    link: string;
  } {
    return {
      type: 'profile_card',
      userId: profile.userId,
      username: profile.username,
      avatarUrl: profile.avatarUrl || generateDefaultAvatar(),
      level: profile.level || 1,
      link: this.generateProfileLink(profile.userId),
    };
  }

  /**
   * Share a profile card into a conversation
   */
  async shareProfileToConversation(
    senderId: string,
    conversationId: string,
    targetUserId: string,
    targetUsername: string,
    targetAvatarUrl?: string
  ): Promise<void> {
    const card = this.generateProfileCard({
      userId: targetUserId,
      username: targetUsername,
      avatarUrl: targetAvatarUrl,
    });

    const content = `Shared a contact: @${card.username}\n${card.link}`;

    // Destructure 'type' from card to avoid duplication in metadata,
    // as metadata will have its own 'type' property.
    const { type: _, ...cardData } = card;

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        content,
        metadata: {
          type: 'contact_card', // Explicit type for the message metadata
          ...cardData, // All other properties from the card
        },
      })
      .select()
      .maybeSingle();

    if (error) {
      reportError(error, 'PlayerStatusService.shareProfileToConversation');
      return;
    }

    // Update conversation timestamp so it bubbles to top of list
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    // Emit bus event so conversation list updates in real-time
    if (data) {
      masterBus.emit('MESSAGE_SENT', {
        message: data as Record<string, unknown>,
        conversationId,
      });
    }
  }
}

export const playerStatusService = new PlayerStatusServiceClass();
