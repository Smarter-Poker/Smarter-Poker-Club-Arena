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

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { ChipFlowService } from './ChipFlowService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';

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
      .select(
        `
                *,
                parent:parent_agent_id (
                    id,
                    user_id,
                    profiles!agents_profiles_fkey (
                        display_name
                    )
                ),
                profiles!agents_profiles_fkey (
                    display_name,
                    avatar_url
                )
            `
      )
      .eq('club_id', resolvedId)
      .order('joined_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    return (data || []).map((a) => ({
      id: a.id,
      userId: a.user_id,
      clubId: a.club_id,
      membershipId: a.membership_id,
      role: a.role as AgentRole,
      status: a.status as AgentStatus,
      parentAgentId: a.parent_agent_id,
      parentAgentName: (a.parent as any)?.profiles?.display_name,
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
      displayName: (a.profiles as any)?.display_name,
      avatarUrl: (a.profiles as any)?.avatar_url,
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
      .select(
        `
                *,
                parent:parent_agent_id (
                    id,
                    profiles!agents_profiles_fkey (
                        display_name
                    )
                ),
                profiles!agents_profiles_fkey (
                    display_name,
                    avatar_url
                )
            `
      )
      .eq('id', agentId)
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: data.id,
      userId: data.user_id,
      clubId: data.club_id,
      membershipId: data.membership_id,
      role: data.role as AgentRole,
      status: data.status as AgentStatus,
      parentAgentId: data.parent_agent_id,
      parentAgentName: (data.parent as any)?.profiles?.display_name,
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
      displayName: (data.profiles as any)?.display_name,
      avatarUrl: (data.profiles as any)?.avatar_url,
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

    // Validate caps
    if (input.commissionRate > 0.7) throw new Error('Commission rate cannot exceed 70%');
    if (input.playerRakebackRate > 0.5) throw new Error('Rakeback rate cannot exceed 50%');

    // Get or create membership
    const { data: membership } = await supabase
      .from('club_members')
      .select('id')
      .eq('club_id', input.clubId)
      .eq('user_id', input.userId)
      .maybeSingle();

    // If sub-agent, verify parent exists and has capacity + rate limits
    if (input.parentAgentId) {
      const parent = await this.getAgent(input.parentAgentId);
      if (!parent) throw new Error('Parent agent not found');
      if (parent.role === 'sub_agent') throw new Error('Sub-agents cannot have sub-agents');
      if (input.commissionRate > parent.commissionRate) {
        throw new Error(
          `Commission rate (${input.commissionRate}) cannot exceed parent rate (${parent.commissionRate})`
        );
      }
      if (input.playerRakebackRate > parent.playerRakebackRate) {
        throw new Error(`Rakeback rate cannot exceed parent rate (${parent.playerRakebackRate})`);
      }
    }

    const { data, error } = await supabase
      .from('agents')
      .insert({
        user_id: input.userId,
        club_id: input.clubId,
        membership_id: membership?.id,
        role: input.role,
        parent_agent_id: input.parentAgentId,
        commission_rate: input.commissionRate,
        player_rakeback_rate: input.playerRakebackRate,
        credit_limit: input.creditLimit,
        is_prepaid: input.isPrepaid || false,
      })
      .select()
      .maybeSingle();

    if (error) throw error;

    // Update membership role
    if (membership?.id) {
      const { error: roleErr } = await supabase
        .from('club_members')
        .update({ role: input.role })
        .eq('id', membership.id);
      if (roleErr) console.error('[AgentService] Failed to update membership role:', roleErr);
    }

    return this.getAgent(data.id) as Promise<Agent>;
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(agentId: string, status: AgentStatus): Promise<boolean> {
    const { error } = await supabase.from('agents').update({ status }).eq('id', agentId);

    return !error;
  }

  /**
   * Update agent role (promote/demote)
   */
  async updateAgentRole(agentId: string, newRole: AgentRole): Promise<boolean> {
    // Get current agent info
    const { data: agent } = await supabase
      .from('agents')
      .select('role, membership_id')
      .eq('id', agentId)
      .maybeSingle();

    if (!agent) return false;

    // Update agent role
    const { error } = await supabase.from('agents').update({ role: newRole }).eq('id', agentId);

    if (error) return false;

    // Also update membership role if exists
    if (agent.membership_id) {
      const { error: roleErr } = await supabase
        .from('club_members')
        .update({ role: newRole })
        .eq('id', agent.membership_id);
      if (roleErr) console.error('[AgentService] Failed to sync membership role:', roleErr);
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
      console.error(`[AgentService] Pre-paid agent should not have credit limit, setting to 0`);
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
      if (numErr) console.error('[AgentService] Failed to assign player_number:', numErr);

      console.debug(`[AgentService] Assigned player_number ${playerNumber} to ${profile.username}`);
    }

    // 3. Ensure BUSINESS and PROMO wallets exist (on top of their PLAYER wallet)
    for (const walletType of ['BUSINESS', 'PROMO'] as const) {
      const { data: existing } = await supabase
        .from('wallets')
        .select('user_id')
        .eq('user_id', userId)
        .eq('wallet_type', walletType)
        .maybeSingle();

      if (!existing) {
        const { error: walletErr } = await supabase.from('wallets').insert({
          user_id: userId,
          wallet_type: walletType,
          balance: 0,
          locked_balance: 0,
        });
        if (walletErr)
          console.error(`[AgentService] Failed to create ${walletType} wallet:`, walletErr);
        else console.debug(`[AgentService] Created ${walletType} wallet for ${profile.username}`);
      }
    }

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
      console.error(
        `[AgentService] Failed to link player ${playerId} to agent ${agentProfile.username}:`,
        error
      );
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
    if (countErr) console.error('[AgentService] Failed to update agent player count:', countErr);

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
      console.error(`[AgentService] Agent ${agentUserId} not found in club ${clubId}`);
      return false;
    }

    // Update player's club_members record
    const { error } = await supabase
      .from('club_members')
      .update({ agent_id: agentUserId })
      .eq('user_id', playerId)
      .eq('club_id', resolvedClubId);

    if (error) {
      console.error(`[AgentService] Failed to assign player:`, error);
      return false;
    }

    // Update agent player count
    const { error: countErr } = await supabase
      .from('agents')
      .update({
        total_players: agentRecord.total_players + 1,
        active_player_count: agentRecord.active_player_count + 1,
      })
      .eq('id', agentRecord.id);
    if (countErr) console.error('[AgentService] Failed to update agent player count:', countErr);

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

    // Get current limit and parent info for logging + validation
    const { data: agent } = await supabase
      .from('agents')
      .select('credit_limit, parent_agent_id, club_id')
      .eq('id', agentId)
      .maybeSingle();

    if (!agent) throw new Error('Agent not found');

    // If sub-agent, verify limit doesn't exceed parent's
    if (agent.parent_agent_id) {
      const { data: parent } = await supabase
        .from('agents')
        .select('credit_limit')
        .eq('id', agent.parent_agent_id)
        .maybeSingle();
      if (parent && newLimit > Number(parent.credit_limit)) {
        throw new Error('Credit limit cannot exceed parent agent limit');
      }
    }

    const oldLimit = Number(agent.credit_limit);

    // Update limit
    const { error } = await supabase
      .from('agents')
      .update({ credit_limit: newLimit })
      .eq('id', agentId);

    if (error) return false;

    // Log the assignment
    const { error: auditErr } = await supabase.from('credit_assignments').insert({
      agent_id: agentId,
      assigned_by: assignedBy,
      old_limit: oldLimit,
      new_limit: newLimit,
      reason,
    });
    if (auditErr) console.error('[AgentService] Failed to log credit assignment:', auditErr);

    // Notify UI of club config changes
    if (agent.club_id) {
      masterBus.emit('CLUB_UPDATED', { clubId: agent.club_id });
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

    const { data: agent, error } = await supabase
      .from('agents')
      .update(updates)
      .eq('id', agentId)
      .select('club_id')
      .maybeSingle();

    if (!error && agent) {
      masterBus.emit('CLUB_UPDATED', { clubId: agent.club_id });
    }

    return !error;
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
      .select('membership_id')
      .eq('id', agentId)
      .maybeSingle();

    if (!agent) return [];

    const { data, error } = await supabase
      .from('club_members')
      .select(
        `
                id,
                user_id,
                chip_balance,
                rakeback_percent,
                joined_at,
                profiles!club_members_profiles_fkey (
                    display_name,
                    avatar_url,
                    is_online
                )
            `
      )
      .eq('agent_id', agent.membership_id)
      .limit(500);

    if (error) throw error;

    return (data || []).map((m) => ({
      id: m.id,
      userId: m.user_id,
      displayName: (m.profiles as any)?.display_name || 'Unknown',
      avatarUrl: (m.profiles as any)?.avatar_url,
      chipBalance: m.chip_balance || 0,
      rakebackPercent: m.rakeback_percent || 0,
      joinedAt: m.joined_at,
      isOnline: (m.profiles as any)?.is_online || false,
    }));
  }

  /**
   * Assign a player to an agent
   */
  async assignPlayer(memberId: string, agentMembershipId: string): Promise<boolean> {
    const { data: member } = await supabase
      .from('club_members')
      .select('club_id')
      .eq('id', memberId)
      .maybeSingle();
    const { error } = await supabase
      .from('club_members')
      .update({ agent_id: agentMembershipId })
      .eq('id', memberId);

    if (!error && member) {
      masterBus.emit('CLUB_UPDATED', { clubId: member.club_id });
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

    // Use RPC for atomic wallet-to-wallet transfer to prevent race conditions
    const { error } = await retryAsync(
      () =>
        supabase.rpc('wallet_internal_transfer', {
          p_agent_id: agentId,
          p_amount: amount,
          p_from_wallet: fromWallet,
          p_to_wallet: toWallet,
        }),
      3
    );

    if (error) {
      console.error('[AgentService] selfTransfer failed:', error);
      throw new Error(error.message || 'Self-transfer failed');
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
            console.error(`[AgentService] Sub-agent ${dist.toId} not found, skipping`);
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
        console.error(`[AgentService] Distribution to ${dist.toId} failed:`, err);
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
      console.error('[AgentService] Treasury distribution RPC error:', rpcErr);
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
      .select('id, from_user_id, to_user_id, amount, club_id, created_at, transaction_type, notes')
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

    // Check if already clawed back
    if (txn.notes?.includes('[CLAWED BACK:')) {
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
      .update({ notes: clawbackNote })
      .eq('id', transactionId)
      .or('notes.is.null,notes.not.like.*[CLAWED BACK:*')
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
        .update({ notes: txn.notes || '' })
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
      .select('id, to_user_id, amount, created_at, notes, transaction_type')
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
        canClawback: !t.notes?.includes('[CLAWED BACK:') && minutesRemaining > 0,
        minutesRemaining,
      };
    });
  }
}

export const AgentService = new AgentServiceClass();
export default AgentService;
