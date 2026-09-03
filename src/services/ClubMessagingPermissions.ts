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
import { reportError } from '../utils/errorReporter';

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
      reportError(error, 'ClubMessagingPermissions.checkPermissions');
      return { allowed: false, reason: 'Failed to verify permissions' };
    }
  }

  /**
   * Get user's role within a club
   */
  async getUserClubRole(userId: string, clubId: string): Promise<UserClubRole | null> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      // Check if user is union owner/admin (highest privilege). Union linkage:
      // union_clubs maps club->union; unions.owner_id is the owner; union_admins
      // holds union staff. (There is no union_members table.)
      const { data: unionLink, error: ulErr } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedClubId)
        .maybeSingle();
      if (ulErr) reportError(ulErr, 'ClubMessagingPermissions.getUserClubRole_union_link');

      if (unionLink?.union_id) {
        const [{ data: unionRow }, { data: unionAdmin }] = await Promise.all([
          supabase.from('unions').select('owner_id').eq('id', unionLink.union_id).maybeSingle(),
          supabase
            .from('union_admins')
            .select('role')
            .eq('union_id', unionLink.union_id)
            .eq('user_id', userId)
            .maybeSingle(),
        ]);

        if (unionRow?.owner_id === userId) {
          return { userId, clubId, role: 'union_owner' };
        }
        if (unionAdmin) {
          const role = unionAdmin.role === 'owner' ? 'union_owner' : 'union_admin';
          return { userId, clubId, role };
        }
      }

      // Check club membership
      const { data: clubMember, error: cErr } = await supabase
        .from('club_members')
        .select('role, agent_id')
        .eq('user_id', userId)
        .eq('club_id', resolvedClubId)
        .maybeSingle();
      if (cErr) reportError(cErr, 'ClubMessagingPermissions.getUserClubRole_member_query');

      if (!clubMember) {
        return null;
      }

      // Map the seven club roles onto the messaging vocabulary.
      //
      // This switch knew three of them, so co_owner, super_agent and sub_agent
      // all fell through `default` and were treated as players - a co-owner
      // could not message their own club, and a sub agent could not message the
      // players who report to them.
      let role: ClubRole;
      switch (clubMember.role) {
        case 'owner':
        case 'co_owner':
          role = 'club_owner';
          break;
        case 'admin':
          role = 'club_admin';
          break;
        case 'super_agent':
        case 'agent':
        case 'sub_agent':
          role = 'agent';
          break;
        default:
          role = 'player';
      }

      // For agents, get their player list
      let playerIds: string[] | undefined;
      if (role === 'agent') {
        const { data: players, error: pErr } = await supabase
          .from('club_members')
          .select('user_id')
          .eq('club_id', resolvedClubId)
          .eq('agent_id', userId);
        if (pErr) reportError(pErr, 'ClubMessagingPermissions.getUserClubRole_players_query');
        playerIds = players?.map((p) => p.user_id) || [];
      }

      return {
        userId,
        clubId,
        role,
        agentId: clubMember.agent_id || undefined,
        playerIds,
      };
    } catch (err) {
      console.warn('[MsgPerms] getUserClubRole unexpected error:', err);
      return null;
    }
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
    try {
      const userRole = await this.getUserClubRole(userId, clubId);
      if (!userRole) return [];

      const messagableUserIds: string[] = [];

      switch (userRole.role) {
        // UNION/CLUB OWNER/ADMIN → All club members
        case 'union_owner':
        case 'union_admin':
        case 'club_owner':
        case 'club_admin': {
          const { data: allMembers, error: aErr } = await supabase
            .from('club_members')
            .select('user_id')
            .eq('club_id', await resolveClubUUID(clubId))
            .neq('user_id', userId);
          if (aErr)
            reportError(aErr, 'ClubMessagingPermissions.getMessagableUsers_allmembers_error');
          return allMembers?.map((m) => m.user_id) || [];
        }

        // AGENT → Their players + owners/admins + other agents
        case 'agent': {
          const resolvedId = await resolveClubUUID(clubId);
          const [{ data: players, error: pErr }, { data: management, error: mErr }] =
            await Promise.all([
              supabase
                .from('club_members')
                .select('user_id')
                .eq('club_id', resolvedId)
                .eq('agent_id', userId),
              supabase
                .from('club_members')
                .select('user_id')
                .eq('club_id', resolvedId)
                .in('role', ['owner', 'co_owner', 'admin', 'agent'])
                .neq('user_id', userId),
            ]);
          if (pErr)
            reportError(pErr, 'ClubMessagingPermissions.getMessagableUsers_agentplayers_error');
          if (mErr)
            reportError(mErr, 'ClubMessagingPermissions.getMessagableUsers_agentmgmt_error');

          players?.forEach((p) => messagableUserIds.push(p.user_id));
          management?.forEach((m) => messagableUserIds.push(m.user_id));
          break;
        }

        // PLAYER → Their agent + owners/admins
        case 'player': {
          if (userRole.agentId) {
            messagableUserIds.push(userRole.agentId);
          }
          const { data: admins, error: adErr } = await supabase
            .from('club_members')
            .select('user_id')
            .eq('club_id', await resolveClubUUID(clubId))
            .in('role', ['owner', 'co_owner', 'admin']);
          if (adErr)
            reportError(adErr, 'ClubMessagingPermissions.getMessagableUsers_playeradmins_error');
          admins?.forEach((a) => messagableUserIds.push(a.user_id));
          break;
        }
      }

      return [...new Set(messagableUserIds)]; // Remove duplicates
    } catch (err) {
      console.warn('[MsgPerms] getMessagableUsers unexpected error:', err);
      return [];
    }
  }
}

// Export singleton
export const clubMessagingPermissions = new ClubMessagingPermissionsClass();
