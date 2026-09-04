import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import {
  ManagementContentError,
  type ManagementContentErrorReason,
} from './ManagementContentError';

export const CLUB_MESSAGE_LIMITS = {
  tagline: 72,
  lobbyMessage: 240,
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
  updatedAt: string;
  revision: number;
}

interface MessageManagementPayload {
  ok?: boolean;
  reason?: string;
  identity?: Record<string, unknown>;
  identity_revision?: unknown;
  revision?: unknown;
  current_revision?: unknown;
  announcements?: Array<Record<string, unknown>>;
}

function assertOk(value: unknown, fallback: string): MessageManagementPayload {
  const payload = (value || {}) as MessageManagementPayload;
  if (!payload.ok) {
    const messages: Partial<Record<ManagementContentErrorReason, string>> = {
      not_authenticated: 'Sign in again before managing club messages.',
      not_authorized: 'You do not have permission to manage messages for this club.',
      character_limit: 'One or more messages exceeds its character limit.',
      message_required: 'Announcement title and message are required.',
      announcement_not_found: 'That announcement no longer exists.',
      club_not_found: 'This club no longer exists.',
      version_conflict: 'Another operator saved a newer version. Your draft was not overwritten.',
    };
    const reason =
      typeof payload.reason === 'string' && payload.reason in messages
        ? (payload.reason as ManagementContentErrorReason)
        : 'unavailable';
    const currentRevision = Number(payload.current_revision);
    throw new ManagementContentError(
      reason,
      messages[reason] || fallback,
      Number.isFinite(currentRevision) ? currentRevision : null
    );
  }
  return payload;
}

function boundedRevision(value: unknown, allowZero = false): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < (allowZero ? 0 : 1)) {
    throw new ManagementContentError('invalid_payload', 'The server returned an invalid revision.');
  }
  return revision;
}

export const clubMessageManagementService = {
  async get(clubId: string): Promise<{
    identity: ClubIdentityMessages;
    identityRevision: number;
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
      identityRevision: boundedRevision(payload.identity_revision),
      announcements: (payload.announcements || []).map((item) => ({
        id: String(item.id),
        title: String(item.title || ''),
        content: String(item.content || ''),
        isPinned: item.is_pinned === true,
        isActive: item.is_active !== false,
        createdAt: String(item.created_at || ''),
        updatedAt: String(item.updated_at || item.created_at || ''),
        revision: boundedRevision(item.revision),
      })),
    };
  },

  async saveIdentity(
    clubId: string,
    identity: ClubIdentityMessages,
    expectedRevision: number
  ): Promise<{ identity: ClubIdentityMessages; revision: number }> {
    const { data, error } = await supabase.rpc('fn_save_club_identity_messages_versioned', {
      p_club_id: clubId,
      p_expected_revision: expectedRevision,
      p_tagline: identity.tagline,
      p_lobby_message: identity.lobbyMessage,
      p_description: identity.description,
    });
    if (error) {
      throw new ManagementContentError(
        'unavailable',
        error.message || 'Could not save club messages.'
      );
    }
    const payload = assertOk(data, 'Could not save club messages.');
    const normalized = payload.identity || {};
    masterBus.emit('CLUB_UPDATED', { clubId });
    return {
      identity: {
        tagline: String(normalized.tagline || ''),
        lobbyMessage: String(normalized.lobby_message || ''),
        description: String(normalized.description || ''),
      },
      revision: boundedRevision(payload.revision),
    };
  },

  async manageAnnouncement(
    clubId: string,
    action: 'save' | 'delete' | 'set_pin' | 'set_active',
    announcement: Partial<ManagedClubAnnouncement> & { id?: string },
    expectedRevision: number
  ): Promise<{ id: string; revision: number | null }> {
    const { data, error } = await supabase.rpc('fn_manage_club_announcement_versioned', {
      p_action: action,
      p_club_id: clubId,
      p_announcement_id: announcement.id || null,
      p_expected_revision: expectedRevision,
      p_title: announcement.title || null,
      p_content: announcement.content || null,
      p_is_pinned: announcement.isPinned ?? false,
      p_is_active: announcement.isActive ?? true,
    });
    if (error) {
      throw new ManagementContentError(
        'unavailable',
        error.message || 'Could not update the announcement.'
      );
    }
    const payload = assertOk(data, 'Could not update the announcement.');
    masterBus.emit('ANNOUNCEMENT_CHANGED', {
      clubId,
      action: action === 'delete' ? 'deleted' : 'created',
    });
    return {
      id: String((data as Record<string, unknown>)?.id || announcement.id || ''),
      revision: action === 'delete' ? null : boundedRevision(payload.revision),
    };
  },
};
