/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🔐 CLUB MESSAGING PERMISSIONS — Role-Based Message Authorization
 * ═══════════════════════════════════════════════════════════════════════════════
 * Hierarchical messaging rules:
 *
 * UNION OWNER/ADMIN → Can message ANY player in any club under the union
 * CLUB OWNER → Can message ANY player in their club
 * CLUB ADMIN → Can message ANY player in their club
 * AGENT → Can message: their players, club owners, club admins
 * PLAYER → Can message: their agent, designated club admin only
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { resolveClubUUID } from '../utils/clubIdResolver';

// Role hierarchy for messaging
export type ClubRole =
  | 'union_owner'
  | 'union_admin'
  | 'club_owner'
  | 'club_admin'
  | 'agent'
  | 'player';

// Permission result
interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

// User role info within a club
interface UserClubRole {
  userId: string;
  clubId: string;
  role: ClubRole;
  agentId?: string; // For players - their assigned agent
  playerIds?: string[]; // For agents - their recruited players
}

class ClubMessagingPermissionsClass {
  /**
   * Check if sender can message recipient within club context
   */
  async canMessage(
    senderId: string,
    recipientId: string,
    clubId: string
  ): Promise<PermissionResult> {
    try {
      // Get sender's role in the club
      const senderRole = await this.getUserClubRole(senderId, clubId);
      if (!senderRole) {
        return { allowed: false, reason: 'Sender is not a member of this club' };
      }

      // Get recipient's role in the club
      const recipientRole = await this.getUserClubRole(recipientId, clubId);
      if (!recipientRole) {
        return { allowed: false, reason: 'Recipient is not a member of this club' };
      }

      // Check based on sender's role
      return this.checkPermission(senderRole, recipientRole);
    } catch (error: unknown) {
      console.error('[ClubMessagingPermissions] Error checking permissions:', error);
      return { allowed: false, reason: 'Failed to verify permissions' };
    }
  }

  /**
   * Get user's role within a club
   */
  async getUserClubRole(userId: string, clubId: string): Promise<UserClubRole | null> {
    const resolvedClubId = await resolveClubUUID(clubId);
    // Check if user is union owner/admin (highest privilege)
    const { data: unionRole } = await supabase
      .from('union_members')
      .select(
        `
                role,
                unions!inner(id, clubs(id))
            `
      )
      .eq('user_id', userId)
      .in('unions.clubs.id', [resolvedClubId])
      .maybeSingle();

    if (unionRole) {
      const role = unionRole.role === 'owner' ? 'union_owner' : 'union_admin';
      return { userId, clubId, role };
    }

    // Check club membership
    const { data: clubMember } = await supabase
      .from('club_members')
      .select('role, agent_id')
      .eq('user_id', userId)
      .eq('club_id', resolvedClubId)
      .maybeSingle();

    if (!clubMember) {
      return null;
    }

    // Map role
    let role: ClubRole;
    switch (clubMember.role) {
      case 'owner':
        role = 'club_owner';
        break;
      case 'admin':
        role = 'club_admin';
        break;
      case 'agent':
        role = 'agent';
        break;
      default:
        role = 'player';
    }

    // For agents, get their player list
    let playerIds: string[] | undefined;
    if (role === 'agent') {
      const { data: players } = await supabase
        .from('club_members')
        .select('user_id')
        .eq('club_id', resolvedClubId)
        .eq('agent_id', userId);

      playerIds = players?.map((p) => p.user_id) || [];
    }

    return {
      userId,
      clubId,
      role,
      agentId: clubMember.agent_id || undefined,
      playerIds,
    };
  }

  /**
   * Check permission based on roles
   */
  private checkPermission(sender: UserClubRole, recipient: UserClubRole): PermissionResult {
    switch (sender.role) {
      // UNION OWNER/ADMIN → Can message ANYONE
      case 'union_owner':
      case 'union_admin':
        return { allowed: true };

      // CLUB OWNER → Can message ANYONE in the club
      case 'club_owner':
        return { allowed: true };

      // CLUB ADMIN → Can message ANYONE in the club
      case 'club_admin':
        return { allowed: true };

      // AGENT → Can message: their players, club owners, club admins
      case 'agent':
        // Can message club owner/admin
        if (recipient.role === 'club_owner' || recipient.role === 'club_admin') {
          return { allowed: true };
        }
        // Can message their own players
        if (sender.playerIds?.includes(recipient.userId)) {
          return { allowed: true };
        }
        // Can message other agents
        if (recipient.role === 'agent') {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: 'Agents can only message their players and club management',
        };

      // PLAYER → Can message: their agent, designated club admin only
      case 'player':
        // Can message their assigned agent
        if (sender.agentId && recipient.userId === sender.agentId) {
          return { allowed: true };
        }
        // Can message club admin
        if (recipient.role === 'club_admin' || recipient.role === 'club_owner') {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: 'Players can only message their agent and club admin',
        };

      default:
        return { allowed: false, reason: 'Unknown role' };
    }
  }

  /**
   * Get list of users that a given user CAN message within a club
   */
  async getMessagableUsers(userId: string, clubId: string): Promise<string[]> {
    const userRole = await this.getUserClubRole(userId, clubId);
    if (!userRole) return [];

    const messagableUserIds: string[] = [];

    switch (userRole.role) {
      // UNION/CLUB OWNER/ADMIN → All club members
      case 'union_owner':
      case 'union_admin':
      case 'club_owner':
      case 'club_admin': {
        const { data: allMembers } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', await resolveClubUUID(clubId))
          .neq('user_id', userId);

        return allMembers?.map((m) => m.user_id) || [];
      }

      // AGENT → Their players + owners/admins + other agents
      case 'agent': {
        // Get their players
        const { data: players } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', await resolveClubUUID(clubId))
          .eq('agent_id', userId);

        players?.forEach((p) => messagableUserIds.push(p.user_id));

        // Get owners/admins/agents
        const { data: management } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', await resolveClubUUID(clubId))
          .in('role', ['owner', 'admin', 'agent'])
          .neq('user_id', userId);

        management?.forEach((m) => messagableUserIds.push(m.user_id));
        break;
      }

      // PLAYER → Their agent + owners/admins
      case 'player': {
        // Their agent
        if (userRole.agentId) {
          messagableUserIds.push(userRole.agentId);
        }

        // Owners/admins
        const { data: admins } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', await resolveClubUUID(clubId))
          .in('role', ['owner', 'admin']);

        admins?.forEach((a) => messagableUserIds.push(a.user_id));
        break;
      }
    }

    return [...new Set(messagableUserIds)]; // Remove duplicates
  }
}

// Export singleton
export const clubMessagingPermissions = new ClubMessagingPermissionsClass();
