/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGING SERVICE — Direct Messages
 * User-to-user messaging with real-time updates
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase, getAuthUser } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { clubMessagingPermissions } from './ClubMessagingPermissions';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { STORAGE_KEYS } from '../lib/storage';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  content: string;
  isRead: boolean;
  createdAt: string;
}

export interface Conversation {
  id: string;
  participantIds: string[];
  participants: {
    id: string;
    displayName: string;
    avatarUrl?: string;
    isOnline: boolean;
  }[];
  lastMessage?: Message;
  unreadCount: number;
  updatedAt: string;
}

interface MessageCallbacks {
  onNewMessage?: (message: Message) => void;
  onMessageRead?: (messageId: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class MessagingServiceClass {
  private channel: RealtimeChannel | null = null;
  private currentUserId: string | null = null;

  /**
   * Sanitize message content to prevent HTML/XSS injection
   */
  private sanitizeMessage(content: string): string {
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Subscribe to real-time messages
   */
  async subscribe(userId: string, callbacks: MessageCallbacks): Promise<void> {
    if (this.channel) {
      await this.unsubscribe();
    }

    this.currentUserId = userId;

    this.channel = supabase
      .channel(`messages:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${userId}`,
        },
        async (payload) => {
          if (callbacks.onNewMessage && payload.new) {
            const message = await this.mapMessage(payload.new as Record<string, unknown>);
            callbacks.onNewMessage(message);
            masterBus.emit('MESSAGE_RECEIVED', {
              message: message as unknown as Record<string, unknown>,
            });
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'MessagingService._Channel_error_on_messages');
        }
        if (status === 'TIMED_OUT') {
          console.warn(`[MessagingService] ⏱️ Channel messages:${userId} timed out`);
        }
      });
  }

  /**
   * Unsubscribe from messages
   */
  async unsubscribe(): Promise<void> {
    if (this.channel) {
      await supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  /**
   * Get all conversations for a user
   */
  async getConversations(userId: string): Promise<Conversation[]> {
    const { data, error } = await supabase
      .from('conversations')
      .select(
        `
                *,
                messages(id, conversation_id, sender_id, content, is_read, created_at)
            `
      )
      .contains('participant_ids', [userId])
      .order('updated_at', { ascending: false })
      .limit(100);

    if (error) {
      reportError(error, 'MessagingService.Failed_to_get_conversations');
      return [];
    }

    const conversations: Conversation[] = [];

    for (const conv of data || []) {
      // Get participant profiles
      const participantIds = conv.participant_ids as string[];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url, is_online')
        .in('id', participantIds);

      // Get unread count
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', conv.id)
        .eq('receiver_id', userId)
        .eq('is_read', false);

      // Get last message
      const messages = (conv.messages as Record<string, unknown>[]) || [];
      const lastMsg = messages.sort(
        (a, b) =>
          new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()
      )[0];

      conversations.push({
        id: conv.id,
        participantIds,
        participants: (profiles || []).map((p) => ({
          id: p.id,
          displayName: p.display_name || 'Unknown',
          avatarUrl: p.avatar_url,
          isOnline: p.is_online || false,
        })),
        lastMessage: lastMsg ? await this.mapMessage(lastMsg) : undefined,
        unreadCount: count || 0,
        updatedAt: conv.updated_at,
      });
    }

    return conversations;
  }

  /**
   * Get messages in a conversation
   */
  async getMessages(conversationId: string, limit: number = 50): Promise<Message[]> {
    const { data, error } = await supabase
      .from('messages')
      .select(
        `
                *,
                sender:sender_id(display_name, avatar_url)
            `
      )
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      reportError(error, 'MessagingService.Failed_to_get_messages');
      return [];
    }

    return (data || [])
      .map((m) => ({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_id,
        senderName: (m.sender as Record<string, unknown>)?.display_name as string,
        senderAvatar: (m.sender as Record<string, unknown>)?.avatar_url as string,
        content: m.content,
        isRead: m.is_read,
        createdAt: m.created_at,
      }))
      .reverse();
  }

  /**
   * Send a message
   */
  async sendMessage(
    conversationId: string,
    senderId: string,
    receiverId: string,
    content: string
  ): Promise<Message | null> {
    const sanitizedContent = this.sanitizeMessage(content);
    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        receiver_id: receiverId,
        content: sanitizedContent,
        is_read: false,
      })
      .select()
      .maybeSingle();

    if (error || !data) {
      reportError(error, 'MessagingService.Failed_to_send');
      return null;
    }

    const mapped = await this.mapMessage(data);
    masterBus.emit('MESSAGE_SENT', {
      message: mapped as unknown as Record<string, unknown>,
      conversationId,
    });

    // Update conversation's updated_at
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    return mapped;
  }

  /**
   * Start a new conversation
   */
  async startConversation(userId: string, otherUserId: string): Promise<Conversation | null> {
    // Check if conversation already exists
    const { data: existing } = await supabase
      .from('conversations')
      .select('id, participant_ids, updated_at')
      .contains('participant_ids', [userId, otherUserId])
      .maybeSingle();

    if (existing) {
      const convs = await this.getConversations(userId);
      return convs.find((c) => c.id === existing.id) || null;
    }

    // Create new conversation
    const { data, error } = await supabase
      .from('conversations')
      .insert({
        participant_ids: [userId, otherUserId],
      })
      .select()
      .maybeSingle();

    if (error) {
      reportError(error, 'MessagingService.Failed_to_create_conversation');
      return null;
    }

    const convs = await this.getConversations(userId);
    return convs.find((c) => c.id === data.id) || null;
  }

  /**
   * Start a new CLUB conversation (category = 'club')
   * Used for club-internal messaging
   * ENFORCES club membership verification AND role-based messaging permissions
   */
  async startClubConversation(
    userId: string,
    otherUserId: string,
    clubId: string
  ): Promise<Conversation | null> {
    // SECURITY: Verify user is a member of the club
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data: userMembership, error: membershipError } = await supabase
      .from('club_members')
      .select('role')
      .eq('club_id', resolvedClubId)
      .eq('user_id', userId)
      .maybeSingle();

    if (membershipError || !userMembership) {
      reportError(
        new Error('[Messaging] User is not a member of this club'),
        'MessagingService.User_is_not_a_member_of_this_club'
      );
      throw new Error('You must be a member of the club to start conversations');
    }

    // Check messaging permission based on roles
    const permission = await clubMessagingPermissions.canMessage(userId, otherUserId, clubId);
    if (!permission.allowed) {
      reportError(permission.reason, 'MessagingService.Permission_denied');
      throw new Error(permission.reason || 'Not allowed to message this user');
    }

    // Check if club conversation already exists between these users
    const { data: existing } = await supabase
      .from('conversations')
      .select('id, participant_ids, club_id, category, updated_at')
      .contains('participant_ids', [userId, otherUserId])
      .eq('club_id', resolvedClubId)
      .eq('category', 'club')
      .maybeSingle();

    if (existing) {
      const convs = await this.getConversations(userId);
      return convs.find((c) => c.id === existing.id) || null;
    }

    // Create new club conversation
    const { data, error } = await supabase
      .from('conversations')
      .insert({
        participant_ids: [userId, otherUserId],
        category: 'club',
        club_id: resolvedClubId, // FIX: was using raw clubId — must use resolved UUID
      })
      .select()
      .maybeSingle();

    if (error) {
      reportError(error, 'MessagingService.Failed_to_create_club_conversation');
      return null;
    }

    const convs = await this.getConversations(userId);
    return convs.find((c) => c.id === data.id) || null;
  }

  async markAsRead(conversationId: string, userId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('messages')
        .update({ is_read: true })
        .eq('conversation_id', conversationId)
        .eq('receiver_id', userId)
        .eq('is_read', false);

      if (error) {
        reportError(error, 'MessagingService.Failed_to_mark_as_read');
        return false;
      }
      // Re-count unread messages so header badge updates instantly
      const { count: remaining } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('receiver_id', userId)
        .eq('is_read', false);
      masterBus.emit('UNREAD_DM_COUNT_CHANGED', { userId, count: remaining || 0 });
      return true;
    } catch (err: unknown) {
      reportError(err, 'MessagingService.markAsRead_error');
      return false;
    }
  }

  /**
   * Get total unread count
   */
  async getUnreadCount(userId: string): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('receiver_id', userId)
        .eq('is_read', false);

      if (error) {
        reportError(error, 'MessagingService.Failed_to_get_unread_count');
        return 0;
      }
      return count || 0;
    } catch (err: unknown) {
      reportError(err, 'MessagingService.getUnreadCount_error');
      return 0;
    }
  }

  /**
   * Map database record to Message
   */
  private async mapMessage(data: Record<string, unknown>): Promise<Message> {
    return {
      id: data.id as string,
      conversationId: data.conversation_id as string,
      senderId: data.sender_id as string,
      senderName: (data.sender as Record<string, unknown>)?.display_name as string,
      senderAvatar: (data.sender as Record<string, unknown>)?.avatar_url as string,
      content: data.content as string,
      isRead: data.is_read as boolean,
      createdAt: data.created_at as string,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Toggle a reaction on a message (add if not exists, remove if exists)
   */
  async toggleReaction(messageId: string, reaction: string): Promise<boolean> {
    const userId = (await getAuthUser()).data?.user?.id;
    if (!userId) {
      reportError(
        new Error('[Messaging] No user ID available for reaction'),
        'MessagingService.No_user_ID_available_for_reaction'
      );
      return false;
    }

    const { data, error } = await supabase.rpc('fn_toggle_message_reaction', {
      p_message_id: messageId,
      p_reaction: reaction,
      p_user_id: userId,
    });

    if (error) {
      reportError(error, 'MessagingService.Failed_to_toggle_reaction');
      return false;
    }

    return data as boolean; // true = added, false = removed
  }

  /**
   * Get reactions for a message
   */
  async getReactions(messageId: string): Promise<MessageReaction[]> {
    try {
      const { data, error } = await supabase.rpc('get_message_reactions', {
        p_message_id: messageId,
      });

      if (error) {
        reportError(
          new Error('[Messaging] get_message_reactions RPC not available - returning empty array'),
          'MessagingService.get_message_reactions_RPC_not_available_'
        );
        return [];
      }

      return (data || []).map((r: { reaction: string; count: number; user_reacted: boolean }) => ({
        reaction: r.reaction,
        count: r.count,
        userReacted: r.user_reacted,
      }));
    } catch (err: unknown) {
      reportError(err, 'MessagingService.Failed_to_get_reactions');
      return [];
    }
  }

  /**
   * Add a reaction to a message (direct insert)
   */
  async addReaction(messageId: string, userId: string, reaction: string): Promise<boolean> {
    const { error } = await supabase.from('message_reactions').insert({
      message_id: messageId,
      user_id: userId,
      reaction,
    });

    if (error) {
      // Might already exist (unique constraint)
      if (error.code === '23505') {
        return true; // Already reacted
      }
      reportError(error, 'MessagingService.Failed_to_add_reaction');
      return false;
    }

    return true;
  }

  /**
   * Remove a reaction from a message
   */
  async removeReaction(messageId: string, userId: string, reaction: string): Promise<boolean> {
    const { error } = await supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', userId)
      .eq('reaction', reaction);

    return !error;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Search messages within a conversation
   */
  async searchMessages(
    conversationId: string,
    query: string,
    limit: number = 50
  ): Promise<Message[]> {
    if (!query.trim()) return [];

    const { data, error } = await supabase
      .from('messages')
      .select(
        `
        *,
        sender:sender_id(display_name, avatar_url)
      `
      )
      .eq('conversation_id', conversationId)
      .ilike('content', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      reportError(error, 'MessagingService.Search_failed');
      return [];
    }

    return (data || []).map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      senderName: (m.sender as Record<string, unknown>)?.display_name as string,
      senderAvatar: (m.sender as Record<string, unknown>)?.avatar_url as string,
      content: m.content,
      isRead: m.is_read,
      createdAt: m.created_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP CHAT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a group conversation
   */
  async createGroupConversation(
    creatorId: string,
    participantIds: string[],
    name: string
  ): Promise<Conversation | null> {
    // INPUT VALIDATION: Prevent abuse via oversized inputs
    if (!name || name.trim().length === 0 || name.trim().length > 100) {
      reportError(
        new Error('[Messaging] Invalid group name: must be 1-100 characters'),
        'MessagingService.Invalid_group_name'
      );
      return null;
    }
    if (participantIds.length > 100) {
      reportError(
        new Error('[Messaging] Too many participants: maximum 100'),
        'MessagingService.Too_many_participants'
      );
      return null;
    }

    // Deduplicate participant IDs
    const uniqueParticipants = [...new Set(participantIds.filter((id) => id !== creatorId))];
    const allParticipants = [creatorId, ...uniqueParticipants];

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        participant_ids: allParticipants,
        name,
        is_group: true,
        created_by: creatorId,
      })
      .select()
      .maybeSingle();

    if (error) {
      reportError(error, 'MessagingService.Failed_to_create_group');
      return null;
    }

    // Create conversation_participants entries
    const participantInserts = allParticipants.map((uid) => ({
      conversation_id: data.id,
      user_id: uid,
      role: uid === creatorId ? 'admin' : 'member',
    }));

    const { error: participantErr } = await supabase
      .from('social_conversation_participants')
      .insert(participantInserts);
    if (participantErr) {
      reportError(participantErr, 'MessagingService.Failed_to_insert_group_participants_clea');
      await supabase.from('conversations').delete().eq('id', data.id);
      return null;
    }

    masterBus.emit('CONVERSATION_CREATED', {
      conversationId: data.id,
      isGroup: true,
    });

    const convs = await this.getConversations(creatorId);
    return convs.find((c) => c.id === data.id) || null;
  }

  /**
   * Add participant to group conversation
   */
  async addParticipant(conversationId: string, userId: string): Promise<boolean> {
    try {
      // Add to participant_ids array
      const { data: conv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', conversationId)
        .maybeSingle();

      if (!conv) return false;

      const ids = conv.participant_ids as string[];
      if (ids.includes(userId)) return true; // already in

      const { error } = await supabase
        .from('conversations')
        .update({ participant_ids: [...ids, userId] })
        .eq('id', conversationId);

      if (error) return false;

      // Create conversation_participants entry
      const { error: partErr } = await supabase.from('social_conversation_participants').insert({
        conversation_id: conversationId,
        user_id: userId,
        role: 'member',
      });
      if (partErr) reportError(partErr, 'MessagingService.Failed_to_insert_participant_entry');

      return true;
    } catch (err) {
      reportError(err, 'MessagingService.Error');
      return false;
    }
  }

  /**
   * Remove participant from group conversation
   */
  async removeParticipant(conversationId: string, userId: string): Promise<boolean> {
    try {
      const { data: conv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', conversationId)
        .maybeSingle();

      if (!conv) return false;

      const ids = (conv.participant_ids as string[]).filter((id) => id !== userId);

      const { error } = await supabase
        .from('conversations')
        .update({ participant_ids: ids })
        .eq('id', conversationId);

      if (error) return false;

      await supabase
        .from('social_conversation_participants')
        .delete()
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);

      return true;
    } catch (err) {
      reportError(err, 'MessagingService.Error');
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVERSATION PINNING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Pin a conversation for a user
   */
  async pinConversation(conversationId: string, userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('social_conversation_participants')
      .update({ is_pinned: true })
      .eq('conversation_id', conversationId)
      .eq('user_id', userId);

    if (!error) {
      masterBus.emit('CONVERSATION_PINNED', { conversationId });
    }
    return !error;
  }

  /**
   * Unpin a conversation for a user
   */
  async unpinConversation(conversationId: string, userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('social_conversation_participants')
      .update({ is_pinned: false })
      .eq('conversation_id', conversationId)
      .eq('user_id', userId);

    if (!error) {
      masterBus.emit('CONVERSATION_UNPINNED', { conversationId });
    }
    return !error;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE FORWARDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Forward a message to another conversation
   */
  async forwardMessage(
    messageId: string,
    targetConversationId: string,
    senderId: string
  ): Promise<Message | null> {
    // SECURITY FIX: Verify sender has access to the original message's conversation
    const { data: originalMsg } = await supabase
      .from('messages')
      .select('id, conversation_id')
      .eq('id', messageId)
      .maybeSingle();
    if (originalMsg?.conversation_id) {
      const { data: sourceConv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', originalMsg.conversation_id)
        .maybeSingle();
      if (sourceConv && !(sourceConv.participant_ids as string[]).includes(senderId)) {
        reportError(
          new Error('[Messaging] Sender is not a participant in the source conversation'),
          'MessagingService.Sender_is_not_a_participant_in_the_sourc'
        );
        return null;
      }
    }

    // Get original message content
    const { data: original } = await supabase
      .from('messages')
      .select('content, image_url, audio_url')
      .eq('id', messageId)
      .maybeSingle();

    if (!original) {
      reportError(
        new Error('[Messaging] Original message not found for forward'),
        'MessagingService.Original_message_not_found_for_forward'
      );
      return null;
    }

    // Get receiver from target conversation
    const { data: targetConv } = await supabase
      .from('conversations')
      .select('participant_ids')
      .eq('id', targetConversationId)
      .maybeSingle();

    const receiverId =
      (targetConv?.participant_ids as string[])?.find((id) => id !== senderId) || null;

    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: targetConversationId,
        sender_id: senderId,
        receiver_id: receiverId,
        content: this.sanitizeMessage(`↪ ${original.content || ''}`.trim()),
        image_url: original.image_url,
        audio_url: original.audio_url,
        is_forwarded: true,
      })
      .select()
      .maybeSingle();

    if (error || !data) {
      reportError(error, 'MessagingService.Forward_failed');
      return null;
    }

    // Update target conversation's last message
    await supabase
      .from('conversations')
      .update({
        last_message: `↪ ${(original.content || '').substring(0, 80)}`,
        last_message_time: new Date().toISOString(),
        last_message_user_id: senderId,
      })
      .eq('id', targetConversationId);

    return await this.mapMessage(data);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3: MESSAGE SCHEDULING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Schedule a message for future delivery (club admin announcements).
   * Stores in `scheduled_messages` table; a cron picks them up at send_at time.
   */
  async scheduleMessage(
    conversationId: string,
    senderId: string,
    content: string,
    sendAt: Date
  ): Promise<{ id: string } | null> {
    const { data, error } = await supabase
      .from('scheduled_messages')
      .insert({
        conversation_id: conversationId,
        sender_id: senderId,
        content,
        send_at: sendAt.toISOString(),
        status: 'pending',
      })
      .select('id')
      .maybeSingle();

    if (error) {
      reportError(error, 'MessagingService.Schedule_failed');
      return null;
    }

    return data;
  }

  /**
   * Get pending scheduled messages for a conversation
   */
  async getScheduledMessages(
    conversationId: string
  ): Promise<Array<{ id: string; content: string; sendAt: string; status: string }>> {
    const { data, error } = await supabase
      .from('scheduled_messages')
      .select('id, content, send_at, status')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('send_at', { ascending: true });

    if (error) return [];
    return (data || []).map((d: any) => ({
      id: d.id,
      content: d.content,
      sendAt: d.send_at,
      status: d.status,
    }));
  }

  /**
   * Cancel a scheduled message (only the sender can cancel)
   */
  async cancelScheduledMessage(messageId: string, senderId?: string): Promise<boolean> {
    // SECURITY FIX: senderId is mandatory — prevent unauthorized cancellation
    if (!senderId) {
      reportError(
        new Error('[Messaging] senderId required for cancelScheduledMessage'),
        'MessagingService.senderId_required_for_cancelScheduledMes'
      );
      return false;
    }
    const { error } = await supabase
      .from('scheduled_messages')
      .update({ status: 'cancelled' })
      .eq('id', messageId)
      .eq('status', 'pending')
      .eq('sender_id', senderId); // Only sender can cancel their own messages

    return !error;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3: NOTIFICATION PREFERENCES (per-type muting)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get user's notification preferences from localStorage
   */
  getNotificationPreferences(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.NOTIF_PREFERENCES);
      return raw
        ? JSON.parse(raw)
        : {
            messages: true,
            games: true,
            social: true,
            achievements: true,
            system: true,
          };
    } catch (err) {
      reportError(err, 'MessagingService.Error');
      return { messages: true, games: true, social: true, achievements: true, system: true };
    }
  }

  /**
   * Set user's notification preferences
   */
  setNotificationPreferences(prefs: Record<string, boolean>): void {
    localStorage.setItem(STORAGE_KEYS.NOTIF_PREFERENCES, JSON.stringify(prefs));
  }

  /**
   * Map a notification DB type to its preference category key
   * This bridges the gap between DB types and the UI preference keys
   */
  private mapNotifTypeToCategory(type: string): string {
    switch (type) {
      case 'message':
        return 'messages';
      case 'waitlist_ready':
      case 'table_invite':
        return 'games';
      case 'club_announcement':
      case 'friend_request':
        return 'social';
      case 'achievement':
      case 'bonus':
        return 'achievements';
      case 'settlement':
      case 'system':
      default:
        return 'system';
    }
  }

  /**
   * Check if a specific notification type is muted
   * Maps DB notification types → preference category keys before checking
   */
  isNotificationTypeMuted(type: string): boolean {
    const prefs = this.getNotificationPreferences();
    const category = this.mapNotifTypeToCategory(type);
    return prefs[category] === false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 11: MESSAGE EDIT / DELETE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Edit a message within 5-minute window */
  async editMessage(messageId: string, senderId: string, newContent: string): Promise<boolean> {
    const { data: msg } = await supabase
      .from('messages')
      .select('created_at, sender_id')
      .eq('id', messageId)
      .maybeSingle();

    if (!msg || msg.sender_id !== senderId) return false;

    // 5-minute edit window
    const elapsed = Date.now() - new Date(msg.created_at).getTime();
    if (elapsed > 5 * 60 * 1000) return false;

    // Sanitize edited content to prevent XSS
    const sanitizedContent = this.sanitizeMessage(newContent);
    const { error } = await supabase
      .from('messages')
      .update({
        content: sanitizedContent,
        edited_at: new Date().toISOString(),
        is_edited: true,
      })
      .eq('id', messageId)
      .eq('sender_id', senderId); // SECURITY: double-check sender owns the message

    if (!error)
      masterBus.emit('MESSAGE_SENT', {
        message: { id: messageId, content: newContent, edited: true },
        conversationId: '',
      });
    return !error;
  }

  /** Delete a message (sender deletes own, admin deletes any) */
  async deleteMessage(messageId: string, userId: string, isAdmin = false): Promise<boolean> {
    let query = supabase.from('messages').delete().eq('id', messageId);
    if (!isAdmin) query = query.eq('sender_id', userId);

    const { error } = await query;
    if (!error) {
      masterBus.emit('MESSAGE_DELETED', { messageId });
    }
    return !error;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 11: READ RECEIPT GRANULARITY
  // ═══════════════════════════════════════════════════════════════════════════

  /** Mark message as seen with timestamp and reader identity */
  async markSeenWithDetail(messageId: string, userId: string): Promise<void> {
    const { error: receiptErr } = await supabase.from('message_read_receipts').upsert(
      {
        message_id: messageId,
        user_id: userId,
        seen_at: new Date().toISOString(),
      },
      { onConflict: 'message_id,user_id' }
    );
    if (receiptErr) reportError(receiptErr, 'MessagingService.Read_receipt_upsert');
  }

  /** Get detailed read receipts for a message (for group conversations) */
  async getReadReceipts(
    messageId: string
  ): Promise<Array<{ userId: string; username: string; seenAt: string }>> {
    const { data } = await supabase
      .from('message_read_receipts')
      .select('user_id, seen_at, profiles(username)')
      .eq('message_id', messageId);

    return (data || []).map((r: any) => ({
      userId: r.user_id,
      username: r.profiles?.username || 'Unknown',
      seenAt: r.seen_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 11: PINNED MESSAGES (Club Channels)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Pin a message in a conversation (requires conversation access) */
  async pinMessage(messageId: string, conversationId: string, userId?: string): Promise<boolean> {
    // SECURITY FIX: userId is now mandatory for auth — reject if not provided
    if (!userId) {
      reportError(
        new Error('[Messaging] userId required for pinMessage authorization'),
        'MessagingService.userId_required_for_pinMessage_authoriza'
      );
      return false;
    }
    // Get the conversation and message to verify access
    const { data: conv } = await supabase
      .from('conversations')
      .select('participant_ids')
      .eq('id', conversationId)
      .maybeSingle();

    // Verify user is a participant (mandatory check)
    if (!conv || !(conv.participant_ids as string[]).includes(userId)) {
      reportError(
        new Error('[Messaging] User not a participant of this conversation'),
        'MessagingService.User_not_a_participant_of_this_conversat'
      );
      return false;
    }

    const { error } = await supabase
      .from('messages')
      .update({ is_pinned: true })
      .eq('id', messageId)
      .eq('conversation_id', conversationId);
    return !error;
  }

  /** Unpin a message (requires conversation access) */
  async unpinMessage(
    messageId: string,
    conversationId?: string,
    userId?: string
  ): Promise<boolean> {
    // SECURITY FIX: Require both conversationId and userId for authorization
    if (!conversationId || !userId) {
      reportError(
        new Error('[Messaging] conversationId and userId required for unpinMessage'),
        'MessagingService.conversationId_and_userId_required_for_u'
      );
      return false;
    }
    {
      const { data: conv } = await supabase
        .from('conversations')
        .select('participant_ids')
        .eq('id', conversationId)
        .maybeSingle();

      if (!conv || !(conv.participant_ids as string[]).includes(userId)) {
        reportError(
          new Error('[Messaging] User not a participant of this conversation'),
          'MessagingService.User_not_a_participant_of_this_conversat'
        );
        return false;
      }
    }

    const { error } = await supabase
      .from('messages')
      .update({ is_pinned: false })
      .eq('id', messageId);
    return !error;
  }

  /** Get pinned messages for a conversation */
  async getPinnedMessages(conversationId: string): Promise<any[]> {
    const { data } = await supabase
      .from('messages')
      .select('*, profiles:sender_id(username, avatar_url)')
      .eq('conversation_id', conversationId)
      .eq('is_pinned', true)
      .order('created_at', { ascending: false });
    return data || [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 12: CLUB ANNOUNCEMENT CHANNEL
  // ═══════════════════════════════════════════════════════════════════════════

  /** Create a read-only announcement channel for a club */
  async createAnnouncementChannel(clubId: string, adminId: string): Promise<string | null> {
    // FIX: Resolve clubId to UUID — conversations.club_id is a UUID FK
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase
      .from('conversations')
      .insert({
        name: 'Announcements',
        category: 'club_announcement',
        club_id: resolvedClubId,
        created_by: adminId,
        participant_ids: [adminId],
        is_read_only: true,
      })
      .select('id')
      .maybeSingle();
    return error || !data ? null : data.id;
  }

  /** Post an admin announcement (only club admins can post) */
  async postAnnouncement(
    conversationId: string,
    adminId: string,
    content: string
  ): Promise<boolean> {
    // SECURITY FIX: Verify the caller is actually a participant of this conversation
    // and that the conversation is indeed a club_announcement channel
    const { data: conv } = await supabase
      .from('conversations')
      .select('participant_ids, category, club_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv || conv.category !== 'club_announcement') {
      reportError(
        new Error(
          '[Messaging] postAnnouncement: Invalid conversation or not an announcement channel'
        ),
        'MessagingService.postAnnouncement'
      );
      return false;
    }
    // Verify admin is a club owner/admin
    if (conv.club_id) {
      const { data: membership } = await supabase
        .from('club_members')
        .select('role')
        .eq('club_id', conv.club_id)
        .eq('user_id', adminId)
        .maybeSingle();
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        reportError(
          new Error('[Messaging] postAnnouncement: User is not a club admin'),
          'MessagingService.postAnnouncement'
        );
        return false;
      }
    }

    const sanitized = this.sanitizeMessage(content);
    const { error } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: adminId,
      content: sanitized,
      message_type: 'announcement',
    });
    return !error;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 12: INVITE TRACKING ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get invite analytics for a club admin */
  async getInviteAnalytics(clubId: string): Promise<{
    totalSent: number;
    totalAccepted: number;
    pending: number;
    conversionRate: number;
    topInviters: Array<{ userId: string; username: string; sent: number; accepted: number }>;
  }> {
    const { data: invites } = await supabase
      .from('invites')
      .select('*, profiles:inviter_id(username)')
      .eq('club_id', await resolveClubUUID(clubId));

    const all = invites || [];
    const totalSent = all.length;
    const totalAccepted = all.filter((i: any) => i.status === 'accepted').length;
    const pending = all.filter((i: any) => i.status === 'pending').length;

    // Aggregate by inviter
    const inviterMap = new Map<
      string,
      { userId: string; username: string; sent: number; accepted: number }
    >();
    all.forEach((inv: any) => {
      const id = inv.inviter_id;
      const existing = inviterMap.get(id) || {
        userId: id,
        username: inv.profiles?.username || 'Unknown',
        sent: 0,
        accepted: 0,
      };
      existing.sent++;
      if (inv.status === 'accepted') existing.accepted++;
      inviterMap.set(id, existing);
    });

    const topInviters = Array.from(inviterMap.values())
      .sort((a, b) => b.accepted - a.accepted)
      .slice(0, 10);

    return {
      totalSent,
      totalAccepted,
      pending,
      conversionRate: totalSent > 0 ? Math.round((totalAccepted / totalSent) * 100) : 0,
      topInviters,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 12: RECENT PLAYERS "PLAYED WITH" COUNT
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get count of shared sessions with another player */
  async getPlayedWithCount(userId: string, otherUserId: string): Promise<number> {
    const { count } = await supabase
      .from('hand_history')
      .select('id', { count: 'exact', head: true })
      .contains('player_ids', [userId, otherUserId]);
    return count || 0;
  }

  /** Get "last played together" timestamp */
  async getLastPlayedTogether(userId: string, otherUserId: string): Promise<string | null> {
    const { data } = await supabase
      .from('hand_history')
      .select('created_at')
      .contains('player_ids', [userId, otherUserId])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.created_at || null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 13: TYPING INDICATOR OPTIMIZATION (Supabase Presence)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Track typing via Supabase Presence (replaces 5s heartbeat polling) */
  async setTypingPresence(
    conversationId: string,
    userId: string,
    isTyping: boolean
  ): Promise<void> {
    const channelKey = `typing-${conversationId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);

    if (isTyping) {
      await channel.track({ user_id: userId, typing: true, at: Date.now() });
    } else {
      await channel.untrack();
    }
  }

  /** Subscribe to typing presence for a conversation */
  subscribeToTypingPresence(
    conversationId: string,
    callback: (typingUserIds: string[]) => void
  ): () => void {
    const channelKey = `typing-${conversationId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const typingIds: string[] = [];
      Object.values(state).forEach((presences) => {
        (presences as any[]).forEach((p) => {
          if (p.typing && Date.now() - p.at < 10000) {
            typingIds.push(p.user_id);
          }
        });
      });
      callback(typingIds);
    });

    channel.subscribe((status: string, err?: Error) => {
      if (status === 'CHANNEL_ERROR') {
        if (err) reportError(err?.message || err, 'MessagingService._Typing_channel_error');
      }
      if (status === 'TIMED_OUT') {
        console.warn(`[MessagingService] ⏱️ Typing channel timed out`);
      }
    });

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 13: NOTIFICATION DIGEST MODE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get/set notification digest mode (batch non-urgent into hourly/daily) */
  getDigestMode(): 'instant' | 'hourly' | 'daily' {
    return (localStorage.getItem(STORAGE_KEYS.NOTIF_DIGEST_MODE) as any) || 'instant';
  }

  setDigestMode(mode: 'instant' | 'hourly' | 'daily'): void {
    localStorage.setItem(STORAGE_KEYS.NOTIF_DIGEST_MODE, mode);
  }

  /** Get/set notification sound preferences */
  getSoundPreferences(): Record<string, string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.NOTIF_SOUNDS);
      return raw
        ? JSON.parse(raw)
        : {
            messages: 'default',
            games: 'default',
            social: 'default',
            achievements: 'celebration',
            system: 'default',
          };
    } catch (err) {
      reportError(err, 'MessagingService.Error');
      return {
        messages: 'default',
        games: 'default',
        social: 'default',
        achievements: 'celebration',
        system: 'default',
      };
    }
  }

  setSoundPreferences(prefs: Record<string, string>): void {
    localStorage.setItem(STORAGE_KEYS.NOTIF_SOUNDS, JSON.stringify(prefs));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Q3 PHASE 13: PROFILE QR CODE GENERATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Generate a QR code data URL for a player's profile */
  generateProfileQRData(userId: string): string {
    const profileUrl = `${window.location.origin}/profile/${userId}`;
    // Return a Google Charts QR API URL for now (no library needed)
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(profileUrl)}`;
  }
}

// Reaction type
export interface MessageReaction {
  reaction: string;
  count: number;
  userReacted: boolean;
}

// Export singleton
export const messagingService = new MessagingServiceClass();
