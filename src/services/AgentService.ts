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
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { uuid } from '../utils/uuid';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
import {
  playerDisplayName,
  PLAYER_NAME_COLUMNS,
  type NameableProfile,
} from '../utils/playerDisplayName';

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

/**
 * A send this agent can still take back, as fn_agent_wallet_reversible
 * describes it. `seconds_left` is computed by the database against
 * `reversible_until`, so the countdown an operator sees and the clock that
 * decides whether the claim back is allowed are the same clock.
 */
export interface ReversibleDistribution {
  transaction_id: string;
  to_user_id: string;
  to_name: string;
  amount: number;
  claimed_back: number;
  remaining: number;
  destination: string;
  created_at: string;
  reversible_until: string;
  seconds_left: number;
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
    const profileMap: Record<string, NameableProfile & { avatar_url?: string }> = {};
    if (allUserIds.size > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
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
        ? playerDisplayName(profileMap[parentMap[a.parent_agent_id]])
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
      displayName: playerDisplayName(profileMap[a.user_id]),
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
          .select(`${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
          .eq('id', data.user_id)
          .maybeSingle();
        displayName = playerDisplayName(profile);
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
            .select(PLAYER_NAME_COLUMNS)
            .eq('id', parent.user_id)
            .maybeSingle();
          parentAgentName = playerDisplayName(parentProfile);
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
    /* Every other method in this file resolves first, and this one did not:
       the club id reaching here comes from a route param, which is a slug or a
       six-digit code as often as it is a uuid, so "Create Agent" failed with an
       invalid-uuid error on every club URL that was not already a uuid. */
    const resolvedCreateClubId = await resolveClubUUID(input.clubId);

    const { data: res, error } = await supabase.rpc('fn_create_agent', {
      p_user_id: input.userId,
      p_club_id: resolvedCreateClubId,
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
  /**
   * Redeem an invite/referral code for the CALLING player.
   *
   * The returned `status` and `agentId` come from the RPC's own RETURNING row,
   * so they describe the membership as it exists AFTER redemption. Callers must
   * prefer them over anything they read before this ran: for an approval-gated
   * club this call is what promotes the row from 'pending' to 'active', and a
   * caller that keeps its earlier copy will show an approval wall to a player
   * the database has already let in.
   *
   * `code` is the machine-readable reason on failure (`unknown_inviter`,
   * `inviter_not_in_club`, `self_referral`, `not_a_member`, ...). It is never a
   * thrown error — a bad code is an ordinary outcome, not an exception.
   */
  async linkPlayerByReferral(
    playerId: string,
    referralCode: string | number,
    clubId: string
  ): Promise<{
    success: boolean;
    agentName?: string;
    agentId?: string | null;
    status?: string;
    code?: string;
    error?: string;
  }> {
    const resolvedClubId = await resolveClubUUID(clubId);

    // 1. Fetch the agent's name first just for the UI toast
    let agentName: string | undefined;
    let agentProfileQuery = supabase.from('profiles').select('id, username');
    if (typeof referralCode === 'string' && referralCode.includes('-')) {
      agentProfileQuery = agentProfileQuery.eq('id', referralCode);
    } else {
      agentProfileQuery = agentProfileQuery.eq(
        'player_number',
        typeof referralCode === 'string' ? parseInt(referralCode, 10) : referralCode
      );
    }
    const { data: agentProfile } = await agentProfileQuery.maybeSingle();
    if (agentProfile) {
      agentName = agentProfile.username;
    }

    // 2. Run the secure RPC that links them and admits them
    const { data, error } = await supabase.rpc('fn_redeem_club_invite_code', {
      p_club_id: resolvedClubId,
      p_user_id: playerId,
      p_referral_code: String(referralCode),
    });

    if (error || !data?.success) {
      // Report the RPC's own reason code, not just "it failed". Until
      // 2026-08-26 this branch was hit on EVERY call — the RPC compared a text
      // player_number to an integer and raised 42883 every time — and because
      // the reason never reached the report, a totally broken money-adjacent
      // path looked like a stream of players simply arriving without a code.
      reportError(
        error || new Error(data?.error || 'redeem failed'),
        'AgentService.linkPlayerByReferral',
        {
          playerId,
          referralCode,
          reason: data?.code ?? error?.code ?? 'unknown',
        }
      );
      return { success: false, code: data?.code, error: data?.error ?? error?.message };
    }

    console.debug(`[AgentService] Linked player ${playerId} via referral code ${referralCode}`);
    masterBus.emit('CLUB_UPDATED', { clubId });
    return {
      success: true,
      agentName: data.agent_name ?? agentName,
      agentId: data.agent_id ?? null,
      status: data.status,
    };
  }

  /**
   * Attach a player to an agent's downline, creating the membership if the
   * player is not in the club yet.
   *
   * This is what the "Add Player" button behind an agent row calls. It used to
   * be a direct `club_members` insert carrying `referrer_id: agentId` --
   * `club_members` HAS NO referrer_id column, so PostgREST rejected the whole
   * statement (PGRST204) and the button had never once succeeded. It also never
   * wrote `agent_id`, which is the column the hierarchy is actually built from,
   * and it was handed the `agents` table primary key where a user id belonged.
   *
   * The RPC does the permission check server-side: an agent may claim a player
   * nobody has, club staff may move one, and nobody else may do either. The new
   * membership is created with zero chips by the BEFORE INSERT guard on
   * club_members -- there is no path here that can mint a balance.
   *
   * @param agentUserId the agent's USER id (Agent.userId), not Agent.id.
   */
  async attachPlayerToAgent(
    clubId: string,
    agentUserId: string,
    playerId: string
  ): Promise<{ success: boolean; code?: string; error?: string }> {
    const resolvedClubId = await resolveClubUUID(clubId);

    const { data, error } = await supabase.rpc('fn_agent_attach_player', {
      p_club_id: resolvedClubId,
      p_agent_user_id: agentUserId,
      p_player_id: playerId,
    });

    if (error || !data?.success) {
      reportError(
        error || new Error(data?.error || 'attach failed'),
        'AgentService.attachPlayerToAgent',
        {
          clubId: resolvedClubId,
          agentUserId,
          playerId,
          reason: data?.code ?? error?.code ?? 'unknown',
        }
      );
      return { success: false, code: data?.code, error: data?.error ?? error?.message };
    }

    masterBus.emit('CLUB_UPDATED', { clubId: resolvedClubId });
    return { success: true };
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
      reportError(
        `Agent ${agentUserId} not found in club ${clubId}`,
        'AgentService.assignPlayerToAgent'
      );
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
    const currentUser = await import('../lib/authUtils').then((m) => m.readLocalSession());
    const assignedBy = currentUser?.userId || 'system';
    await supabase
      .from('audit_trail')
      // The columns are actor_id / target_type / target_id / after_state, and
      // actor_role and target_type are NOT NULL with no default. This insert
      // named three columns that do not exist and omitted two that are
      // required, so the agent audit trail has never recorded a single
      // assignment: every write was rejected into the catch below.
      .insert({
        action: 'ASSIGN_PLAYER_TO_AGENT',
        actor_id: assignedBy,
        actor_role: 'club_admin',
        target_type: 'user',
        target_id: playerId,
        club_id: resolvedClubId,
        agent_id: agentRecord.id,
        after_state: {
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
  async getAgentPlayers(agentId: string, clubId?: string): Promise<AgentPlayer[]> {
    const { data: agent } = await supabase
      .from('agents')
      .select('user_id, club_id')
      .eq('id', agentId)
      .maybeSingle();

    if (!agent?.user_id) return [];

    /* SCOPED TO ONE CLUB. This query had no club filter, so it returned the
       agent's players from EVERY club they hold an agents row in. That list is
       what SuperAgentDashboard counts on its stat card and offers in its
       transfer picker - and the transfer it then makes is scoped to the club
       being viewed, so an operator could pick a name that belongs to another
       club entirely. The agent row names its own club; a caller may override
       it, and neither may be omitted. */
    const scopedClubId = clubId ? await resolveClubUUID(clubId) : agent.club_id;
    if (!scopedClubId) return [];

    // club_members.agent_id is a FK to users(id) and stores the agent's USER id
    // (not membership_id) everywhere it is written — filter on that.
    const { data, error } = await supabase
      .from('club_members')
      .select('club_id, user_id, chip_balance, joined_at')
      .eq('agent_id', agent.user_id)
      .eq('club_id', scopedClubId)
      .limit(QUERY_LIMITS.MODERATE);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    // Batch-fetch profiles for all player user_ids
    const userIds = data.map((m) => m.user_id);
    const profileMap: Record<
      string,
      NameableProfile & { avatar_url?: string; is_online?: boolean }
    > = {};
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, is_online`)
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
      displayName: playerDisplayName(profileMap[m.user_id]),
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
  // assignPlayer() was removed on 2026-08-21. It took an `agentMembershipId`
  // and wrote it into club_members.agent_id, which holds the agent's USER id
  // and carries a foreign key to users - so the write could only ever fail the
  // constraint or, worse, land an id that getAgentPlayers() would never match,
  // making an assignment that appeared to succeed and then did not exist.
  //
  // It had no callers. The two correct paths are assignPlayerToAgent() below,
  // and UnionOpsService.assignPlayerToAgent(), which goes through
  // fn_assign_player_to_agent - the RPC that also checks the agent is active in
  // that club, refuses an agent as their own player, and writes an audit row.
  // Prefer the RPC. Verified against production: all 1,160 assigned rows are
  // user-id shaped, so nothing was ever corrupted by this - it simply never
  // worked.

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
   * Send chips from the caller's AGENT WALLET to a player in their downline.
   *
   * TWO BUGS LIVED HERE, and the second one made the first academic.
   *
   *   1. WRONG ACCOUNT. It called ChipFlowService.transfer, a peer-to-peer move
   *      between two users' PLAYER wallets. Dan, 2026-08-25: "Any chips sent or
   *      claimed back transact from the Agent Wallet." This debited the agent's
   *      personal chips and never touched agents.agent_wallet_balance.
   *   2. WRONG ID. SuperAgentDashboard passes `agent.id` - the agents-table row
   *      id - into a parameter that ChipFlowService.transfer reads as a USER
   *      id. No wallet has ever matched it, so the one live caller of this
   *      method could not have moved a chip.
   *
   * It is now fn_agent_wallet_send: the same call the Cashier, the Trade grid,
   * the Wallet Cashier and ChipTransferModal make. The SENDER IS NO LONGER A
   * PARAMETER - the RPC derives it from auth.uid(), which is the only identity
   * a browser can establish and the reason bug 2 was possible at all.
   */
  async transferToPlayer(playerId: string, clubId: string, amount: number): Promise<boolean> {
    if (amount <= 0) throw new Error('Transfer amount must be positive');

    const resolvedId = (await resolveClubUUID(clubId)) || clubId;
    const { data, error } = await supabase.rpc('fn_agent_wallet_send', {
      p_club_id: resolvedId,
      p_to_user_id: playerId,
      p_amount: amount,
      p_destination: 'player_wallet',
      p_reason: 'Agent Transfer To Player',
      // Every send carries a retry key, so a lost response and the obvious
      // retry replay instead of debiting a second time.
      p_op_id: uuid(),
    });
    if (error) throw error;

    const res = (Array.isArray(data) ? data[0] : data) as {
      success?: boolean;
      error?: string;
    } | null;
    if (!res?.success) throw new Error(res?.error || 'The Cashier Refused That Transfer');

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

  // ─────────────────────────────────────────────────────────────────────────────
  // TREASURY DISTRIBUTION — REMOVED (phase 3 of 7, 2026-08-31)
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // distributeFromTreasury is deleted. It was the ONLY client of the World Hub
  // route POST /api/club-arena/distribute-chips, and NOTHING CALLED IT - no
  // page, no component, no other service. The route's agent branch called
  // transfer_chips_agent_to_player, which debits club_members.chip_balance, so
  // the whole chain moved the wrong account and, in a year, never once ran:
  // zero chip_distribution audit rows and zero agent_to_player_transfer
  // chip_transactions on production.
  //
  // The route is removed in Smarter-Poker-World-Hub#1120.
  //
  // The club bank is spent through fn_club_bank_send, which the Cashier, the
  // Wallet Cashier and ChipTransferModal already use: it enforces its own
  // authorization, takes a uuid op_id, writes one ledger row and opens a ten
  // minute clawback window.

  // ─────────────────────────────────────────────────────────────────────────────
  // CLAWBACK — Reverse a chip distribution within 10-minute window
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  UNDOING A DISTRIBUTION, THROUGH THE ONLY PATH THAT CAN
   * ═════════════════════════════════════════════════════════════════════════
   *
   * WHAT WAS HERE (removed 2026-09-03, phase 3)
   *
   * `clawbackDistribution` and `getRecentDistributions`: a second, parallel
   * implementation of agent undo that could not work, for three independent
   * reasons, any one of which was fatal.
   *
   *   1. THE LIST WAS ALWAYS EMPTY. It filtered `transaction_type` in
   *      ('agent_to_player', 'promo_agent_to_player', 'send'). Those three
   *      types have ZERO rows in chip_transactions, estate-wide. The only
   *      agent distribution type is `agent_wallet_send`.
   *   2. THE CLAIM STEP COULD NOT WRITE. It began by UPDATEing
   *      chip_transactions to stake the row. That table carries SELECT
   *      policies only, so the update matched zero rows and the method
   *      returned "Transaction already clawed back or claim failed" - naming
   *      a cause that was never true.
   *   3. THE RPC WAS UNREACHABLE. `fn_clawback_chips_atomic` is SECURITY
   *      INVOKER and `authenticated` holds no EXECUTE on it. Even reached, it
   *      updates agents and wallets, neither of which grants a browser a
   *      write, so its own arithmetic would have landed on nothing.
   *
   * WHAT REPLACES IT. Nothing new. The platform already does this correctly
   * and has since the agent wallet shipped: `fn_agent_wallet_reversible` lists
   * what the signed-in agent may still undo, and `fn_agent_wallet_claim_back`
   * undoes it. Both are SECURITY DEFINER, both are granted to `authenticated`,
   * both are what WalletCashierModal has been calling all along. The window is
   * `reversible_until` on the row and the clock that decides is the database's,
   * not the browser's - which also removes the ten-minute constant this file
   * used to keep in parallel with it.
   */
  async reversibleDistributions(clubId: string): Promise<ReversibleDistribution[]> {
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_agent_wallet_reversible', {
      p_club_id: resolvedClubId,
    });
    if (error) throw error;
    return (data || []) as ReversibleDistribution[];
  }

  /**
   * Undo part or all of a send this agent made, inside its own window.
   *
   * `opId` is required by the function and is the retry key: the same key
   * replays the same claim back rather than taking the chips twice, which is
   * what makes a failed network call safe to repeat.
   */
  async claimBackDistribution(
    clubId: string,
    transactionId: string,
    amount: number,
    reason?: string,
    opId?: string
  ): Promise<{ success: boolean; error?: string; claimedBack?: number; replayed?: boolean }> {
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_agent_wallet_claim_back', {
      p_club_id: resolvedClubId,
      p_transaction_id: transactionId,
      p_amount: amount,
      p_reason: reason ?? null,
      p_op_id: opId ?? crypto.randomUUID(),
    });
    if (error) return { success: false, error: error.message };
    const res = (data || {}) as {
      success?: boolean;
      error?: string;
      amount?: number;
      replayed?: boolean;
    };
    if (!res.success) return { success: false, error: res.error || 'That Claim Back Was Refused.' };

    masterBus.emit('BALANCE_UPDATED', {
      source: 'agent_wallet_claim_back',
      clubId: resolvedClubId,
    });
    return { success: true, claimedBack: res.amount ?? amount, replayed: res.replayed };
  }
}

export const AgentService = new AgentServiceClass();
export default AgentService;
