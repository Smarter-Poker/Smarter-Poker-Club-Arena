import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';

export const CLUB_MESSAGE_LIMITS = {
  tagline: 72,
  lobbyMessage: 72,
  description: 500,
  announcementTitle: 100,
  announcementContent: 2000,
} as const;

export interface ClubIdentityMessages {
  tagline: string;
  lobbyMessage: string;
  description: string;
}

export interface ManagedClubAnnouncement {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  isActive: boolean;
  createdAt: string;
}

interface MessageManagementPayload {
  ok?: boolean;
  reason?: string;
  identity?: Record<string, unknown>;
  announcements?: Array<Record<string, unknown>>;
}

function assertOk(value: unknown, fallback: string): MessageManagementPayload {
  const payload = (value || {}) as MessageManagementPayload;
  if (!payload.ok) {
    const messages: Record<string, string> = {
      not_authorized: 'You do not have permission to manage messages for this club.',
      character_limit: 'One or more messages exceeds its character limit.',
      message_required: 'Announcement title and message are required.',
      announcement_not_found: 'That announcement no longer exists.',
    };
    throw new Error(messages[payload.reason || ''] || fallback);
  }
  return payload;
}

export const clubMessageManagementService = {
  async get(clubId: string): Promise<{
    identity: ClubIdentityMessages;
    announcements: ManagedClubAnnouncement[];
  }> {
    const { data, error } = await supabase.rpc('fn_get_club_message_management', {
      p_club_id: clubId,
    });
    if (error) throw new Error(error.message || 'Could not load club messages.');
    const payload = assertOk(data, 'Could not load club messages.');
    const identity = payload.identity || {};
    return {
      identity: {
        tagline: String(identity.tagline || ''),
        lobbyMessage: String(identity.lobby_message || ''),
        description: String(identity.description || ''),
      },
      announcements: (payload.announcements || []).map((item) => ({
        id: String(item.id),
        title: String(item.title || ''),
        content: String(item.content || ''),
        isPinned: item.is_pinned === true,
        isActive: item.is_active !== false,
        createdAt: String(item.created_at || ''),
      })),
    };
  },

  async saveIdentity(clubId: string, identity: ClubIdentityMessages): Promise<void> {
    const { data, error } = await supabase.rpc('fn_save_club_identity_messages', {
      p_club_id: clubId,
      p_tagline: identity.tagline,
      p_lobby_message: identity.lobbyMessage,
      p_description: identity.description,
    });
    if (error) throw new Error(error.message || 'Could not save club messages.');
    assertOk(data, 'Could not save club messages.');
    masterBus.emit('CLUB_UPDATED', { clubId });
  },

  async manageAnnouncement(
    clubId: string,
    action: 'save' | 'delete' | 'set_pin' | 'set_active',
    announcement: Partial<ManagedClubAnnouncement> & { id?: string }
  ): Promise<void> {
    const { data, error } = await supabase.rpc('fn_manage_club_announcement', {
      p_action: action,
      p_club_id: clubId,
      p_announcement_id: announcement.id || null,
      p_title: announcement.title || null,
      p_content: announcement.content || null,
      p_is_pinned: announcement.isPinned ?? false,
      p_is_active: announcement.isActive ?? true,
    });
    if (error) throw new Error(error.message || 'Could not update the announcement.');
    assertOk(data, 'Could not update the announcement.');
    masterBus.emit('ANNOUNCEMENT_CHANGED', {
      clubId,
      action: action === 'delete' ? 'deleted' : 'created',
    });
  },
};
