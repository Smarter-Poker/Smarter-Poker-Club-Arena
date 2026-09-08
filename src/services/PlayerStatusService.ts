/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER STATUS SERVICE — Q3 Social: "Playing At" + Status Updates
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages player activity status ("Playing at Table X"), custom status messages,
 * and "Playing At" visibility for friends.
 */

import { supabase } from '../lib/supabase';
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
  lastSeen: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class PlayerStatusServiceClass {
  private currentStatus: PlayerStatus | null = null;

  /**
   * Set the user's custom status text (e.g., "Taking a break 🌴")
   */
  async setStatusText(userId: string, text: string | null): Promise<void> {
    const { error } = await supabase
      .from('profiles')
      .update({ status_text: text })
      .eq('id', userId);

    if (error) {
      reportError(error, 'PlayerStatusService.setStatusText');
      return;
    }

    this.currentStatus = this.currentStatus ? { ...this.currentStatus, statusText: text } : null;
    masterBus.emit('PROFILE_UPDATED', {
      userId,
      updates: { status_text: text } as Record<string, unknown>,
    });
  }

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
       * This used to read `status_text:status` - aliasing the ACCOUNT STATUS
       * column into the custom-status field, because profiles.status_text did
       * not exist. A profile therefore rendered "active" under the player's
       * name as if they had written it. The column exists now
       * (20260828034000_profiles_status_text.sql), so read the real one.
       */
      .select('id, status_text, is_online, last_seen')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) return null;

    return {
      userId: data.id,
      statusText: data.status_text || null,
      playingAt: null,
      playingAtTableId: null,
      isOnline: data.is_online || false,
      lastSeen: data.last_seen || new Date().toISOString(),
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

    // Step 2: Batch-fetch profiles for all friend IDs
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, status_text, is_online, last_seen')
      .in('id', Array.from(friendIds))
      .eq('is_online', true);

    if (error || !profiles) return [];

    return profiles.map((p: any) => ({
      userId: p.id,
      statusText: p.status_text || null,
      playingAt: null,
      playingAtTableId: null,
      isOnline: true,
      lastSeen: p.last_seen || new Date().toISOString(),
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
