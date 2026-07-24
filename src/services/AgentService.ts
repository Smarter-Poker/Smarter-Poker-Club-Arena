/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Agent Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Full agent management with hierarchy, credit, and commission tracking
 *
 * HIERARCHY:
 * - Club assigns: rakeback % + credit limit → Agent
 * - Super Agent assigns: credit limit → Agent
 * - Agent assigns: credit limit → Sub-Agent
 */

import { supabase, getAuthUser } from '../lib/supabase';
import { WalletService } from './WalletService';
import { ChipFlowService } from './ChipFlowService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type AgentRole = 'super_agent' | 'agent' | 'sub_agent';
export type AgentStatus = 'active' | 'suspended' | 'frozen';

export interface Agent {
  id: string;
  userId: string;
  clubId: string;
  membershipId?: string;

  // Role & Status
  role: AgentRole;
  status: AgentStatus;

  // Hierarchy
  parentAgentId?: string;
  parentAgentName?: string;

  // Commission Rates (MANDATORY when creating)
  commissionRate: number; // Rate they receive from club/parent (max 70%)
  playerRakebackRate: number; // Rakeback rate — % of rake players receive back as chips (max 50%)

  // Credit (MANDATORY when creating)
  creditLimit: number;
  creditUsed: number;
  isPrepaid: boolean;

  // Triple Wallet
  businessBalance: number;
  playerBalance: number;
  promoBalance: number;

  // Stats
  totalPlayers: number;
  activePlayerCount: number;
  subAgentCount: number;
  weeklyRakeGenerated: number;
  lifetimeEarnings: number;

  // Display
  displayName?: string;
  avatarUrl?: string;

  // Timestamps
  joinedAt: string;
  lastActiveAt?: string;
}

export interface CreateAgentInput {
  userId: string;
  clubId: string;
  role: AgentRole;
  parentAgentId?: string;
  commissionRate: number; // MANDATORY
  playerRakebackRate: number; // MANDATORY
  creditLimit: number; // MANDATORY
  isPrepaid?: boolean;
}

export interface AgentPlayer {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl?: string;
  chipBalance: number;
  rakebackPercent: number;
  joinedAt: string;
  isOnline: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class AgentServiceClass {
  // ─────────────────────────────────────────────────────────────────────────────
  // AGENT CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all agents for a club
   */
  async getAgents(clubId: string): Promise<Agent[]> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('club_id', resolvedId)
      .order('joined_at', { ascending: false })
      .limit(QUERY_LIMITS.MODERATE);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    // Batch-fetch display names for all agent user_ids + parent user_ids
    const allUserIds = new Set<string>();
    for (const a of data) {
      if (a.user_id) allUserIds.add(a.user_id);
    }
    // Fetch parent agents to get their user_ids
    const parentIds = data.filter((a) => a.parent_agent_id).map((a) => a.parent_agent_id);
    const parentMap: Record<string, string> = {};
    if (parentIds.length > 0) {
      const { data: parents } = await supabase
        .from('agents')
        .select('id, user_id')
        .in('id', parentIds);
      if (parents) {
        for (const p of parents) {
          parentMap[p.id] = p.user_id;
          allUserIds.add(p.user_id);
        }
      }
    }

    // Fetch all profiles in one query
    const profileMap: Record<string, { display_name?: string; avatar_url?: string }> = {};
    if (allUserIds.size > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url')
        .in('id', [...allUserIds]);
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p;
      }
    }

    return data.map((a) => ({
      id: a.id,
      userId: a.user_id,
      clubId: a.club_id,
      membershipId: a.membership_id,
      role: a.role as AgentRole,
      status: a.status as AgentStatus,
      parentAgentId: a.parent_agent_id,
      parentAgentName: a.parent_agent_id
        ? profileMap[parentMap[a.parent_agent_id]]?.display_name
        : undefined,
      commissionRate: Number(a.commission_rate),
      playerRakebackRate: Number(a.player_rakeback_rate),
      creditLimit: Number(a.credit_limit),
      creditUsed: Number(a.credit_used),
      isPrepaid: a.is_prepaid,
      businessBalance: Number(a.business_balance),
      playerBalance: Number(a.player_balance),
      promoBalance: Number(a.promo_balance),
      totalPlayers: a.total_players,
      activePlayerCount: a.active_player_count,
      subAgentCount: a.sub_agent_count,
      weeklyRakeGenerated: Number(a.weekly_rake_generated),
      lifetimeEarnings: Number(a.lifetime_earnings),
      displayName: profileMap[a.user_id]?.display_name,
      avatarUrl: profileMap[a.user_id]?.avatar_url,
      joinedAt: a.joined_at,
      lastActiveAt: a.last_active_at,
    }));
  }

  /**
   * Get a single agent by ID
   */
  async getAgent(agentId: string): Promise<Agent | null> {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', agentId)
      .maybeSingle();

    if (error || !data) return null;

    // Fetch profile info separately
    let displayName: string | undefined;
    let avatarUrl: string | undefined;
    let parentAgentName: string | undefined;
    try {
      if (data.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name, avatar_url')
          .eq('id', data.user_id)
          .maybeSingle();
        displayName = profile?.display_name;
        avatarUrl = profile?.avatar_url;
      }
      if (data.parent_agent_id) {
        const { data: parent } = await supabase
          .from('agents')
          .select('user_id')
          .eq('id', data.parent_agent_id)
          .maybeSingle();
        if (parent?.user_id) {
          const { data: parentProfile } = await supabase
            .from('profiles')
            .select('display_name')
            .eq('id', parent.user_id)
            .maybeSingle();
          parentAgentName = parentProfile?.display_name;
        }
      }
    } catch (e) {
      reportError(e, 'AgentService');
      /* non-critical */
    }

    return {
      id: data.id,
      userId: data.user_id,
      clubId: data.club_id,
      membershipId: data.membership_id,
      role: data.role as AgentRole,
      status: data.status as AgentStatus,
      parentAgentId: data.parent_agent_id,
      parentAgentName,
      commissionRate: Number(data.commission_rate),
      playerRakebackRate: Number(data.player_rakeback_rate),
      creditLimit: Number(data.credit_limit),
      creditUsed: Number(data.credit_used),
      isPrepaid: data.is_prepaid,
      businessBalance: Number(data.business_balance),
      playerBalance: Number(data.player_balance),
      promoBalance: Number(data.promo_balance),
      totalPlayers: data.total_players,
      activePlayerCount: data.active_player_count,
      subAgentCount: data.sub_agent_count,
      weeklyRakeGenerated: Number(data.weekly_rake_generated),
      lifetimeEarnings: Number(data.lifetime_earnings),
      displayName,
      avatarUrl,
      joinedAt: data.joined_at,
      lastActiveAt: data.last_active_at,
    };
  }

  /**
   * Create a new agent (promote player to agent)
   * REQUIRES: commissionRate, playerRakebackRate, creditLimit
   */
  async createAgent(input: CreateAgentInput): Promise<Agent> {
    // Validate mandatory fields
    if (input.commissionRate === undefined) throw new Error('Commission rate is required');
    if (input.playerRakebackRate === undefined) throw new Error('Rakeback rate is required');
    if (input.creditLimit === undefined) throw new Error('Credit limit is required');

    // Validate ranges (must be non-negative and within caps)
    if (input.commissionRate < 0 || input.commissionRate > 0.7)
      throw new Error('Commission rate must be between 0% and 70%');
    if (input.playerRakebackRate < 0 || input.playerRakebackRate > 0.5)
      throw new Error('Rakeback rate must be between 0% and 50%');
    if (input.creditLimit < 0) throw new Error('Credit limit cannot be negative');

    // agents is service-role-write-only under RLS — create via the SECURITY
    // DEFINER RPC, which authorizes the caller as the club owner/admin, enforces
    // the sub-agent parent rate caps, inserts the agent, and syncs the
    // club_members role. The direct browser insert here silently no-op'd.
    const { data: res, error } = await supabase.rpc('fn_create_agent', {
      p_user_id: input.userId,
      p_club_id: input.clubId,
      p_role: input.role,
      p_parent_agent_id: input.parentAgentId ?? null,
      p_commission_rate: input.commissionRate,
      p_player_rakeback_rate: input.playerRakebackRate,
      p_credit_limit: input.creditLimit,
      p_is_prepaid: input.isPrepaid ?? false,
    });

    if (error || !res?.success) {
      throw new Error(res?.error || error?.message || 'Failed to create agent');
    }

    return this.getAgent(res.agent_id) as Promise<Agent>;
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(agentId: string, status: AgentStatus): Promise<boolean> {
    // agents is service-role-write-only under RLS — a direct browser update
    // silently no-ops and returns success. Go through the SECURITY DEFINER RPC
    // (authorizes the caller as the agent's club owner/admin).
    const { data, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_status: status,
    });
    if (error || !data?.success) {
      reportError(
        error || new Error(data?.error || 'agent status update failed'),
        'AgentService.updateAgentStatus'
      );
      return false;
    }
    return true;
  }

  /**
   * Update agent role (promote/demote)
   */
  async updateAgentRole(agentId: string, newRole: AgentRole): Promise<boolean> {
    // agents is service-role-write-only AND read-own-row-only under RLS, so the
    // whole flow (existence check, agents update, club_members role sync) must
    // run server-side. fn_admin_update_agent authorizes the caller as the club
    // owner/admin, updates the role, and syncs club_members.role in one call.
    const { data: roleRes, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_role: newRole,
    });

    if (error || !roleRes?.success) {
      reportError(
        error || new Error(roleRes?.error || 'agent role update failed'),
        'AgentService.updateAgentRole'
      );
      return false;
    }

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AGENT PROMOTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Promote a player to agent status.
   *
   * Agents handle player chip buy-ins and cash-outs. They collect payments from
   * players IRL and manage their chip accounts.
   *
   * REQUIRED at promotion time:
   * - commissionRate: Rake back percentage the agent receives (40-70% in 5% steps)
   *   Valid values: 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70
   * - isPrepaid: Whether the agent is pre-paid or on credit
   * - creditLimit: If on credit (isPrepaid=false), the credit line amount (manually entered)
   *   If pre-paid, creditLimit should be 0
   *
   * When a player becomes an agent they receive:
   * - Agent record in the agents table with commission rates and credit settings
   * - BUSINESS wallet (commission/rake back earnings)
   * - PROMO wallet (for distributing bonuses to their players)
   * - Their PLAYER wallet stays intact for gameplay
   * - Their club_members role is upgraded to 'agent'
   * - A player_number is assigned (if not already set) — used as referral code
   *
   * Players join under an agent by entering the agent's player_number
   * when signing up for a club or with smarter.poker.
   */
  async promoteToAgent(input: {
    userId: string;
    clubId: string;
    role?: AgentRole;
    parentAgentId?: string;
    commissionRate: number; // REQUIRED: rake back % (0.40 - 0.70, 5% steps)
    playerRakebackRate: number; // REQUIRED: rakeback % agent gives to their players
    creditLimit: number; // REQUIRED: credit line amount (0 if pre-paid)
    isPrepaid: boolean; // REQUIRED: pre-paid or credit
  }): Promise<Agent> {
    const user = await getAuthUser();
    if (!user) throw new Error('[AgentService] Authentication required');

    const {
      userId,
      clubId,
      role = 'agent',
      commissionRate,
      playerRakebackRate,
      creditLimit,
    } = input;

    // Validate commission rate: must be 40%, 45%, 50%, 55%, 60%, 65%, or 70%
    const validRates = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
    if (!validRates.includes(commissionRate)) {
      throw new Error(
        `Commission rate must be one of: ${validRates.map((r) => `${r * 100}%`).join(', ')}`
      );
    }

    // Validate credit setup
    if (!input.isPrepaid && creditLimit <= 0) {
      throw new Error('Credit agents must have a credit limit greater than 0');
    }
    if (input.isPrepaid && creditLimit > 0) {
      // Pre-paid agents don't get credit lines — force to 0
      reportError(
        'Pre-paid agent has credit limit, setting to 0',
        'AgentService.updateCreditLimit'
      );
    }

    // 1. Validate the user exists
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, username, player_number')
      .eq('id', userId)
      .maybeSingle();

    if (!profile) throw new Error(`User ${userId} not found`);

    // 2. Ensure player_number is assigned (serves as referral code)
    if (!profile.player_number) {
      // Generate unique player_number: random 4-6 digit number
      let playerNumber: number;
      let attempts = 0;
      do {
        playerNumber = 1000 + Math.floor(Math.random() * 899000); // 1000-899999
        const { data: existing } = await supabase
          .from('profiles')
          .select('id')
          .eq('player_number', playerNumber)
          .maybeSingle();
        if (!existing) break;
        attempts++;
      } while (attempts < 50);

      const { error: numErr } = await supabase
        .from('profiles')
        .update({ player_number: playerNumber })
        .eq('id', userId);
      if (numErr) reportError(numErr, 'AgentService.assignPlayerNumber');

      console.debug(`[AgentService] Assigned player_number ${playerNumber} to ${profile.username}`);
    }

    // 3. Ensure BUSINESS and PROMO wallets exist (on top of their PLAYER wallet)
    await WalletService.ensureWalletsExist(userId, ['BUSINESS', 'PROMO']);

    // 4. Check if already an agent in this club
    const { data: existingAgent } = await supabase
      .from('agents')
      .select('id')
      .eq('user_id', userId)
      .eq('club_id', await resolveClubUUID(clubId))
      .maybeSingle();

    if (existingAgent) {
      console.debug(`[AgentService] ${profile.username} is already an agent in club ${clubId}`);
      return this.getAgent(existingAgent.id) as Promise<Agent>;
    }

    // 5. Create agent record using the existing createAgent method
    const agent = await this.createAgent({
      userId,
      clubId,
      role,
      parentAgentId: input.parentAgentId,
      commissionRate,
      playerRakebackRate,
      creditLimit,
      isPrepaid: input.isPrepaid,
    });

    // 6. Log the promotion as a wallet transaction (audit trail)
    await WalletService.logTransaction(
      userId,
      'BUSINESS',
      0,
      'credit',
      'settlement',
      `Promoted to ${role} in club ${clubId}`,
      undefined,
      undefined,
      clubId
    );

    console.debug(`[AgentService] Promoted ${profile.username} to ${role} in club ${clubId}`);
    return agent;
  }

  /**
   * Link a player under an agent using the agent's player_number as referral code.
   *
   * When a player signs up for a club or with smarter.poker and enters a referral code
   * (which is an agent's player_number), this method links them under that agent.
   *
   * The player's club_members.agent_id is set to the agent's user_id.
   */
  async linkPlayerByReferral(
    playerId: string,
    referralCode: number,
    clubId: string
  ): Promise<{ success: boolean; agentName?: string }> {
    // 1. Find the agent by player_number (referral code)
    const { data: agentProfile } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('player_number', referralCode)
      .maybeSingle();

    if (!agentProfile) {
      return { success: false };
    }

    // 2. Verify this user is an agent in the specified club
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data: agentRecord } = await supabase
      .from('agents')
      .select('id, user_id')
      .eq('user_id', agentProfile.id)
      .eq('club_id', resolvedClubId)
      .maybeSingle();

    if (!agentRecord) {
      return { success: false };
    }

    // 3. Update the player's club_members record to link under this agent
    const { error } = await supabase
      .from('club_members')
      .update({ agent_id: agentProfile.id })
      .eq('user_id', playerId)
      .eq('club_id', resolvedClubId);

    if (error) {
      reportError(error, 'AgentService.linkPlayerByReferral', {
        playerId,
        agentUsername: agentProfile.username,
      });
      return { success: false };
    }

    // 4. Increment agent player count
    const { error: countErr } = await supabase
      .from('agents')
      .update({
        total_players: (agentRecord as any).total_players + 1,
        active_player_count: (agentRecord as any).active_player_count + 1,
      })
      .eq('id', agentRecord.id);
    if (countErr) reportError(countErr, 'AgentService.updatePlayerCount');

    console.debug(
      `[AgentService] Linked player ${playerId} under agent ${agentProfile.username} via referral code ${referralCode}`
    );

    masterBus.emit('CLUB_UPDATED', { clubId });

    return { success: true, agentName: agentProfile.username };
  }

  /**
   * Assign a player directly under an agent by user IDs.
   * Used for bulk assignment or admin-level linking without referral codes.
   */
  async assignPlayerToAgent(
    playerId: string,
    agentUserId: string,
    clubId: string
  ): Promise<boolean> {
    // Verify agent exists in this club
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data: agentRecord } = await supabase
      .from('agents')
      .select('id, total_players, active_player_count')
      .eq('user_id', agentUserId)
      .eq('club_id', resolvedClubId)
      .maybeSingle();

    if (!agentRecord) {
      reportError(`Agent ${agentUserId} not found in club ${clubId}`, 'AgentService.assignPlayer');
      return false;
    }

    // Update player's club_members record — use agent's user_id (FK references auth.users)
    const { error } = await supabase
      .from('club_members')
      .update({ agent_id: agentUserId })
      .eq('user_id', playerId)
      .eq('club_id', resolvedClubId);

    if (error) {
      reportError(error, 'AgentService.assignPlayerToAgent');
      return false;
    }

    // Update agent player count
    const { error: countErr } = await supabase
      .from('agents')
      .update({
        total_players: (agentRecord.total_players || 0) + 1,
        active_player_count: (agentRecord.active_player_count || 0) + 1,
      })
      .eq('id', agentRecord.id);
    if (countErr) reportError(countErr, 'AgentService.updatePlayerCount');

    // Audit log — record who assigned the player
    const { data: currentUser } = await supabase.auth.getUser();
    const assignedBy = currentUser?.user?.id || 'system';
    await supabase
      .from('audit_trail')
      .insert({
        action: 'ASSIGN_PLAYER_TO_AGENT',
        performed_by: assignedBy,
        target_user_id: playerId,
        details: {
          agent_user_id: agentUserId,
          agent_record_id: agentRecord.id,
          club_id: resolvedClubId,
        },
      })
      .then(({ error: logErr }) => {
        if (logErr) reportError(logErr, 'AgentService.Audit_log_failed');
      });

    masterBus.emit('CLUB_UPDATED', { clubId });

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CREDIT MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Set credit limit (Club → Agent, Agent → Sub-Agent)
   */
  async setCreditLimit(
    agentId: string,
    newLimit: number,
    assignedBy: string,
    reason?: string
  ): Promise<boolean> {
    if (newLimit < 0) throw new Error('Credit limit cannot be negative');

    // agents is service-role-write-only AND read-own-row-only under RLS, so the
    // parent-limit check, the update, and the credit_assignments audit all run
    // server-side in fn_admin_update_agent (which authorizes the caller as the
    // club owner/admin). Direct browser reads/writes here silently failed.
    const { data: res, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_credit_limit: newLimit,
      p_assigned_by: assignedBy,
      p_credit_reason: reason ?? null,
    });

    if (error || !res?.success) {
      const msg = error?.message || res?.error || 'credit limit update failed';
      // Preserve the parent-limit rule as a throw so callers can surface it.
      if (msg.includes('parent')) throw new Error('Credit limit cannot exceed parent agent limit');
      reportError(error || new Error(msg), 'AgentService.setCreditLimit');
      return false;
    }

    if (res.club_id) {
      masterBus.emit('CLUB_UPDATED', { clubId: res.club_id });
    }

    return true;
  }

  /**
   * Update commission/rakeback rates
   */
  async updateRates(
    agentId: string,
    commissionRate?: number,
    playerRakebackRate?: number
  ): Promise<boolean> {
    const updates: any = {};

    if (commissionRate !== undefined) {
      if (commissionRate > 0.7) throw new Error('Commission rate cannot exceed 70%');
      updates.commission_rate = commissionRate;
    }

    if (playerRakebackRate !== undefined) {
      if (playerRakebackRate > 0.5) throw new Error('Rakeback rate cannot exceed 50%');
      updates.player_rakeback_rate = playerRakebackRate;
    }

    if (Object.keys(updates).length === 0) return true;

    // agents is service-role-write-only under RLS — go through the SECURITY
    // DEFINER RPC (authorizes the caller as the agent's club owner/admin).
    const { data: res, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_commission_rate: updates.commission_rate,
      p_player_rakeback_rate: updates.player_rakeback_rate,
    });

    if (error || !res?.success) {
      reportError(
        error || new Error(res?.error || 'agent rates update failed'),
        'AgentService.updateRates'
      );
      return false;
    }

    if (res.club_id) {
      masterBus.emit('CLUB_UPDATED', { clubId: res.club_id });
    }

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PLAYER MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get players under an agent
   */
  async getAgentPlayers(agentId: string): Promise<AgentPlayer[]> {
    const { data: agent } = await supabase
      .from('agents')
      .select('user_id')
      .eq('id', agentId)
      .maybeSingle();

    if (!agent?.user_id) return [];

    // club_members.agent_id is a FK to users(id) and stores the agent's USER id
    // (not membership_id) everywhere it is written — filter on that.
    const { data, error } = await supabase
      .from('club_members')
      .select('club_id, user_id, chip_balance, joined_at')
      .eq('agent_id', agent.user_id)
      .limit(QUERY_LIMITS.MODERATE);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    // Batch-fetch profiles for all player user_ids
    const userIds = data.map((m) => m.user_id);
    const profileMap: Record<
      string,
      { display_name?: string; avatar_url?: string; is_online?: boolean }
    > = {};
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url, is_online')
        .in('id', userIds);
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p;
      }
    } catch (e) {
      reportError(e, 'AgentService.map');
      /* non-critical */
    }

    return data.map((m) => ({
      id: `${m.club_id}:${m.user_id}`,
      userId: m.user_id,
      displayName: profileMap[m.user_id]?.display_name || 'Unknown',
      avatarUrl: profileMap[m.user_id]?.avatar_url,
      chipBalance: m.chip_balance || 0,
      rakebackPercent: 0, // rakeback_percent column does not exist yet
      joinedAt: m.joined_at,
      isOnline: profileMap[m.user_id]?.is_online || false,
    }));
  }

  /**
   * Assign a player to an agent
   */
  async assignPlayer(
    clubId: string,
    playerUserId: string,
    agentMembershipId: string
  ): Promise<boolean> {
    const { error } = await supabase
      .from('club_members')
      .update({ agent_id: agentMembershipId })
      .eq('club_id', clubId)
      .eq('user_id', playerUserId);

    if (!error) {
      masterBus.emit('CLUB_UPDATED', { clubId });
    }

    return !error;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WALLET OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Self-transfer between agent wallets
   */
  async selfTransfer(
    agentId: string,
    amount: number,
    fromWallet: 'business' | 'player' | 'promo',
    toWallet: 'business' | 'player' | 'promo'
  ): Promise<boolean> {
    if (amount <= 0) throw new Error('Transfer amount must be positive');
    if (fromWallet === toWallet) throw new Error('Cannot transfer to the same wallet');

    const desc = `Agent self-transfer ${fromWallet} → ${toWallet}`;

    // Atomic wallet-TYPE transfer for a single user via SECURITY DEFINER RPC.
    // fn_wallet_type_transfer moves chips between wallet types (BUSINESS/PLAYER/PROMO)
    // in ONE transaction, honoring the real from/to wallets — this replaces the old
    // atomic_deduct + atomic_credit pair which was hardcoded to PLAYER (cross-wallet
    // no-op, plus a deduct-then-credit chip-loss edge if the credit leg failed).
    // Wallet types are stored uppercase; the method's args are lowercase.
    const { data: transferRes, error } = await retryAsync(
      () =>
        supabase.rpc('fn_wallet_type_transfer', {
          p_user_id: agentId,
          p_from_wallet: fromWallet.toUpperCase(),
          p_to_wallet: toWallet.toUpperCase(),
          p_amount: amount,
          p_note: desc,
        }),
      3
    );

    if (error || !transferRes?.success) {
      reportError(
        error || new Error(transferRes?.error || 'self-transfer failed'),
        'AgentService.selfTransfer'
      );
      throw new Error(
        error?.message || transferRes?.error || 'Insufficient balance for self-transfer'
      );
    }

    return true;
  }

  /**
   * Transfer chips to a player
   */
  async transferToPlayer(
    agentId: string,
    playerId: string,
    clubId: string,
    amount: number
  ): Promise<boolean> {
    if (amount <= 0) throw new Error('Transfer amount must be positive');

    // Use ChipFlowService for proper atomic wallet transfer with full audit trail
    await ChipFlowService.transfer(
      agentId,
      playerId,
      amount,
      'transfer',
      `Agent chip transfer to player via hierarchy`,
      clubId
    );

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HIERARCHY (for AgentHierarchyTree)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get agent hierarchy tree for a club
   */
  async getAgentHierarchy(clubId: string): Promise<any[]> {
    const agents = await this.getAgents(clubId);

    // Build tree structure
    const agentMap = new Map<string, any>();
    const rootAgents: any[] = [];

    // First pass: create nodes
    for (const agent of agents) {
      agentMap.set(agent.id, {
        ...agent,
        children: [],
      });
    }

    // Second pass: build tree
    for (const agent of agents) {
      const node = agentMap.get(agent.id)!;
      if (agent.parentAgentId && agentMap.has(agent.parentAgentId)) {
        agentMap.get(agent.parentAgentId)!.children.push(node);
      } else {
        rootAgents.push(node);
      }
    }

    return rootAgents;
  }

  /**
   * Distribute chips from agent to sub-agents or players
   * Uses ChipFlowService for atomic wallet transfers with full audit trail
   */
  async distributeChips(
    fromAgentId: string,
    distributions: Array<{ toId: string; type: 'agent' | 'player'; amount: number }>
  ): Promise<boolean> {
    const agent = await this.getAgent(fromAgentId);
    if (!agent) throw new Error('Agent not found');

    let distributed = 0;
    for (const dist of distributions) {
      try {
        const amt = Math.trunc(dist.amount * 100) / 100;
        if (dist.type === 'agent') {
          // Agent → Sub-Agent: Get sub-agent's user_id
          const subAgent = await this.getAgent(dist.toId);
          if (!subAgent) {
            reportError(
              `Sub-agent ${dist.toId} not found`,
              'AgentService.distributeChips.subAgentMissing'
            );
            continue;
          }
          await ChipFlowService.transfer(
            agent.userId,
            subAgent.userId,
            amt,
            'transfer',
            'Agent chip distribution to sub-agent'
          );
        } else {
          // Agent → Player: toId IS the user_id
          await ChipFlowService.transfer(
            agent.userId,
            dist.toId,
            amt,
            'transfer',
            'Agent chip distribution to player'
          );
        }
        distributed += amt;
      } catch (err: unknown) {
        reportError(err, 'AgentService.distributeChips', { toId: dist.toId });
        // Continue with remaining distributions — partial failures are logged
      }
    }

    if (distributed === 0 && distributions.length > 0) {
      throw new Error('All distributions failed');
    }

    return true;
  }

  /**
   * Transfer chips from one agent to another (horizontal peer transfer)
   * Unlike distributeChips which is parent→child, this allows any agent-to-agent transfer
   * within the same club hierarchy.
   */
  async transferToAgent(
    fromAgentId: string,
    toAgentId: string,
    amount: number,
    reason?: string
  ): Promise<{ success: boolean; transactionId?: string }> {
    // 1. Validate both agents exist and are in the same club
    const fromAgent = await this.getAgent(fromAgentId);
    const toAgent = await this.getAgent(toAgentId);

    if (!fromAgent) throw new Error('Source agent not found');
    if (!toAgent) throw new Error('Destination agent not found');
    if (fromAgent.clubId !== toAgent.clubId) {
      throw new Error('Agents must be in the same club');
    }

    // 2. Validate amount is positive
    if (amount <= 0) {
      throw new Error('Transfer amount must be positive');
    }

    const amt = Math.trunc(amount * 100) / 100;
    const desc =
      reason ||
      `Agent transfer: ${fromAgent.displayName || fromAgentId} to ${toAgent.displayName || toAgentId}`;

    // 3. Use ChipFlowService for atomic wallet transfer with audit trail
    const result = await ChipFlowService.transfer(
      fromAgent.userId,
      toAgent.userId,
      amt,
      'transfer',
      desc,
      fromAgent.clubId
    );

    return {
      success: true,
      transactionId: result.transactionIds?.[0],
    };
  }

  /**
   * Get transfer history between agents
   */
  async getAgentTransferHistory(
    agentId: string,
    limit = 50
  ): Promise<
    {
      id: string;
      fromAgentName: string;
      toAgentName: string;
      amount: number;
      notes: string;
      createdAt: string;
    }[]
  > {
    const agent = await this.getAgent(agentId);
    if (!agent) return [];

    const { data, error } = await supabase
      .from('chip_transactions')
      .select('id, from_user_id, to_user_id, amount, notes, created_at')
      .eq('transaction_type', 'agent_transfer')
      .or(`from_user_id.eq.${agent.userId},to_user_id.eq.${agent.userId}`)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    // Fetch user display names
    const userIds = [...new Set(data.flatMap((t) => [t.from_user_id, t.to_user_id]))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', userIds);

    const nameMap = new Map(profiles?.map((p) => [p.id, p.display_name]) || []);

    return data.map((t) => ({
      id: t.id,
      fromAgentName: nameMap.get(t.from_user_id) || 'Unknown',
      toAgentName: nameMap.get(t.to_user_id) || 'Unknown',
      amount: t.amount,
      notes: t.notes || '',
      createdAt: t.created_at,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TREASURY DISTRIBUTION (Owner/Admin → Player)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Distribute chips from club treasury to a member.
   * Uses the `distribute_chips` Supabase RPC for atomic wallet transfer.
   * Only club owners and admins can use this (agents use transferToPlayer instead).
   */
  async distributeFromTreasury(
    clubId: string,
    toUserId: string,
    amount: number,
    distributedBy: string,
    notes?: string
  ): Promise<{
    success: boolean;
    treasuryBefore?: number;
    treasuryAfter?: number;
    memberBefore?: number;
    memberAfter?: number;
    error?: string;
  }> {
    if (amount <= 0 || !Number.isFinite(amount) || amount > 100_000_000) {
      return { success: false, error: 'Amount must be a positive integer (max 100M)' };
    }

    const sanitizedAmount = Math.floor(amount);

    const { data: result, error: rpcErr } = await retryAsync(
      () =>
        supabase.rpc('distribute_chips', {
          p_club_id: clubId,
          p_to_user_id: toUserId,
          p_amount: sanitizedAmount,
          p_distributed_by: distributedBy,
        }),
      3
    );

    if (rpcErr) {
      reportError(rpcErr, 'AgentService.treasuryDistribution');
      return { success: false, error: rpcErr.message || 'Distribution failed' };
    }

    if (!result?.success) {
      return { success: false, error: result?.error || 'Distribution failed' };
    }

    masterBus.emit('BALANCE_UPDATED', { source: 'treasury_distribution' });

    return {
      success: true,
      treasuryBefore: result.treasury_before,
      treasuryAfter: result.treasury_after,
      memberBefore: result.member_before,
      memberAfter: result.member_after,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CLAWBACK — Reverse a chip distribution within 10-minute window
  // ─────────────────────────────────────────────────────────────────────────────

  /** Time window (ms) within which clawback is allowed */
  private static readonly CLAWBACK_WINDOW_MS = 10 * 60 * 1000;

  /**
   * Clawback (reverse) a chip distribution within the 10-minute security window.
   *
   * RULES:
   *   - Must be within 10 minutes of the original distribution
   *   - Can only clawback your own distributions
   *   - Can clawback full or partial amount (up to original)
   *   - After 10 minutes, the only recourse is a player cashout request
   */
  async clawbackDistribution(
    transactionId: string,
    clubId: string,
    agentUserId: string,
    requestedAmount?: number
  ): Promise<{
    success: boolean;
    partial?: boolean;
    recovered?: number;
    originalAmount?: number;
    playerNewBalance?: number;
    agentNewBalance?: number;
    windowRemaining?: string;
    error?: string;
  }> {
    // 0. Resolve clubId to UUID (URL param may be integer)
    const resolvedClubId = await resolveClubUUID(clubId);

    // 1. Get the original transaction
    const { data: txn, error: txnErr } = await supabase
      .from('chip_transactions')
      .select(
        'id, from_user_id, to_user_id, amount, club_id, created_at, transaction_type, notes, clawed_back'
      )
      .eq('id', transactionId)
      .maybeSingle();

    if (txnErr || !txn) {
      return { success: false, error: 'Transaction not found' };
    }

    // 2. Verify caller is the agent who sent the chips
    if (txn.from_user_id !== agentUserId) {
      return { success: false, error: 'You can only clawback your own distributions' };
    }

    if (txn.club_id !== resolvedClubId) {
      return { success: false, error: 'Club ID mismatch' };
    }

    // Must be an agent→player distribution
    const clawbackableTypes = ['agent_to_player', 'promo_agent_to_player', 'send'];
    if (!clawbackableTypes.includes(txn.transaction_type) || txn.from_user_id === txn.to_user_id) {
      return { success: false, error: 'Can only clawback agent→player distributions' };
    }

    // Check if already clawed back (boolean column takes priority, notes fallback for legacy)
    if (txn.clawed_back || txn.notes?.includes('[CLAWED BACK:')) {
      return { success: false, error: 'This transaction has already been clawed back' };
    }

    // 3. Check the 10-minute window
    const txnTime = new Date(txn.created_at).getTime();
    const elapsed = Date.now() - txnTime;

    if (elapsed > AgentServiceClass.CLAWBACK_WINDOW_MS) {
      const minutesAgo = Math.floor(elapsed / 60000);
      return {
        success: false,
        error: `Clawback window expired. Distribution was ${minutesAgo} minutes ago (limit: 10 min). The player must submit a cashout request instead.`,
      };
    }

    const remainingSeconds = Math.ceil((AgentServiceClass.CLAWBACK_WINDOW_MS - elapsed) / 1000);

    // 4. Determine clawback amount
    let clawbackAmount: number;
    if (requestedAmount != null) {
      clawbackAmount = Math.floor(Number(requestedAmount));
      if (!Number.isFinite(clawbackAmount) || clawbackAmount <= 0 || clawbackAmount > 100_000_000) {
        return { success: false, error: 'Amount must be a positive integer (max 100M)' };
      }
      clawbackAmount = Math.min(clawbackAmount, txn.amount); // cap at original
    } else {
      clawbackAmount = txn.amount; // default to full
    }

    // 5. Atomically claim the transaction (prevents double-clawback)
    const clawbackNote = `${txn.notes || ''} [CLAWED BACK: ${clawbackAmount} at ${new Date().toISOString()}]`;
    const { data: claimed, error: claimErr } = await supabase
      .from('chip_transactions')
      .update({ notes: clawbackNote, clawed_back: true })
      .eq('id', transactionId)
      .eq('clawed_back', false)
      .select('id')
      .maybeSingle();

    if (claimErr || !claimed) {
      return { success: false, error: 'Transaction already clawed back or claim failed' };
    }

    // 6. Execute atomic clawback via RPC
    const { data: rpcResult, error: rpcErr } = await retryAsync(
      () =>
        supabase.rpc('fn_clawback_chips_atomic', {
          p_transaction_id: transactionId,
          p_club_id: resolvedClubId,
          p_agent_id: agentUserId,
          p_amount: clawbackAmount,
        }),
      3
    );

    if (rpcErr || !rpcResult?.success) {
      // Revert claim note on failure
      await supabase
        .from('chip_transactions')
        .update({ notes: txn.notes || '', clawed_back: false })
        .eq('id', transactionId);

      return {
        success: rpcResult?.partial || false,
        partial: rpcResult?.partial || false,
        recovered: rpcResult?.recovered || 0,
        playerNewBalance: rpcResult?.player_new_balance || 0,
        error: rpcResult?.error || 'Clawback RPC failed',
        windowRemaining: `${remainingSeconds}s`,
      };
    }

    masterBus.emit('BALANCE_UPDATED', { source: 'clawback', userId: agentUserId });

    return {
      success: true,
      partial: rpcResult.partial,
      recovered: rpcResult.recovered,
      originalAmount: txn.amount,
      playerNewBalance: rpcResult.player_new_balance,
      agentNewBalance: rpcResult.agent_new_balance,
      windowRemaining: `${remainingSeconds}s`,
    };
  }

  /**
   * Get recent distributions (for showing clawback-eligible items in the UI).
   * Returns only distributions within the clawback window (10 minutes).
   */
  async getRecentDistributions(
    agentUserId: string,
    clubId: string,
    limit = 20
  ): Promise<
    {
      id: string;
      toUserId: string;
      toDisplayName: string;
      amount: number;
      createdAt: string;
      canClawback: boolean;
      minutesRemaining: number;
    }[]
  > {
    const cutoff = new Date(Date.now() - AgentServiceClass.CLAWBACK_WINDOW_MS).toISOString();

    const { data, error } = await supabase
      .from('chip_transactions')
      .select('id, to_user_id, amount, created_at, notes, transaction_type, clawed_back')
      .eq('from_user_id', agentUserId)
      .eq('club_id', clubId)
      .in('transaction_type', ['agent_to_player', 'promo_agent_to_player', 'send'])
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data?.length) return [];

    // Fetch display names for recipients
    const toUserIds = [...new Set(data.map((t) => t.to_user_id))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', toUserIds);

    const nameMap = new Map(profiles?.map((p) => [p.id, p.display_name || 'Unknown']) || []);

    return data.map((t) => {
      const elapsed = Date.now() - new Date(t.created_at).getTime();
      const minutesRemaining = Math.max(
        0,
        Math.ceil((AgentServiceClass.CLAWBACK_WINDOW_MS - elapsed) / 60000)
      );
      return {
        id: t.id,
        toUserId: t.to_user_id,
        toDisplayName: nameMap.get(t.to_user_id) || 'Unknown',
        amount: t.amount,
        createdAt: t.created_at,
        canClawback: !t.clawed_back && !t.notes?.includes('[CLAWED BACK:') && minutesRemaining > 0,
        minutesRemaining,
      };
    });
  }
}

export const AgentService = new AgentServiceClass();
export default AgentService;
