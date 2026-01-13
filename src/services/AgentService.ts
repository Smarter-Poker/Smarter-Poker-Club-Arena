/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Agent Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Full agent management with hierarchy, credit, and commission tracking
 * 
 * HIERARCHY:
 * - Club assigns: rakeback % + credit limit → Agent
 * - Super Agent assigns: credit limit → Agent
 * - Agent assigns: credit limit → Sub-Agent
 */

import { supabase } from '../lib/supabase';

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
    commissionRate: number;      // Rate they receive from club/parent (max 70%)
    playerRakebackRate: number;  // Rate they give to players (max 50%)

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
    commissionRate: number;      // MANDATORY
    playerRakebackRate: number;  // MANDATORY
    creditLimit: number;         // MANDATORY
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
        const { data, error } = await supabase
            .from('agents')
            .select(`
                *,
                parent:parent_agent_id (
                    id,
                    user_id,
                    profiles:user_id (
                        display_name
                    )
                ),
                profiles:user_id (
                    display_name,
                    avatar_url
                )
            `)
            .eq('club_id', clubId)
            .order('joined_at', { ascending: false });

        if (error) throw error;

        return (data || []).map(a => ({
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
            .select(`
                *,
                parent:parent_agent_id (
                    id,
                    profiles:user_id (
                        display_name
                    )
                ),
                profiles:user_id (
                    display_name,
                    avatar_url
                )
            `)
            .eq('id', agentId)
            .single();

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
        if (input.commissionRate > 0.70) throw new Error('Commission rate cannot exceed 70%');
        if (input.playerRakebackRate > 0.50) throw new Error('Rakeback rate cannot exceed 50%');

        // Get or create membership
        const { data: membership } = await supabase
            .from('club_members')
            .select('id')
            .eq('club_id', input.clubId)
            .eq('user_id', input.userId)
            .single();

        // If sub-agent, verify parent exists and has capacity
        if (input.parentAgentId) {
            const parent = await this.getAgent(input.parentAgentId);
            if (!parent) throw new Error('Parent agent not found');
            if (parent.role === 'sub_agent') throw new Error('Sub-agents cannot have sub-agents');
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
            .single();

        if (error) throw error;

        // Update membership role
        if (membership?.id) {
            await supabase
                .from('club_members')
                .update({ role: input.role })
                .eq('id', membership.id);
        }

        return this.getAgent(data.id) as Promise<Agent>;
    }

    /**
     * Update agent status
     */
    async updateAgentStatus(agentId: string, status: AgentStatus): Promise<boolean> {
        const { error } = await supabase
            .from('agents')
            .update({ status })
            .eq('id', agentId);

        return !error;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CREDIT MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Set credit limit (Club → Agent, Agent → Sub-Agent)
     */
    async setCreditLimit(agentId: string, newLimit: number, assignedBy: string, reason?: string): Promise<boolean> {
        // Get current limit for logging
        const { data: agent } = await supabase
            .from('agents')
            .select('credit_limit')
            .eq('id', agentId)
            .single();

        if (!agent) throw new Error('Agent not found');

        const oldLimit = Number(agent.credit_limit);

        // Update limit
        const { error } = await supabase
            .from('agents')
            .update({ credit_limit: newLimit })
            .eq('id', agentId);

        if (error) return false;

        // Log the assignment
        await supabase.from('credit_assignments').insert({
            agent_id: agentId,
            assigned_by: assignedBy,
            old_limit: oldLimit,
            new_limit: newLimit,
            reason,
        });

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
            if (commissionRate > 0.70) throw new Error('Commission rate cannot exceed 70%');
            updates.commission_rate = commissionRate;
        }

        if (playerRakebackRate !== undefined) {
            if (playerRakebackRate > 0.50) throw new Error('Rakeback rate cannot exceed 50%');
            updates.player_rakeback_rate = playerRakebackRate;
        }

        if (Object.keys(updates).length === 0) return true;

        const { error } = await supabase
            .from('agents')
            .update(updates)
            .eq('id', agentId);

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
            .single();

        if (!agent) return [];

        const { data, error } = await supabase
            .from('club_members')
            .select(`
                id,
                user_id,
                chip_balance,
                rakeback_percent,
                joined_at,
                profiles:user_id (
                    display_name,
                    avatar_url,
                    is_online
                )
            `)
            .eq('agent_id', agent.membership_id);

        if (error) throw error;

        return (data || []).map(m => ({
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
        const { error } = await supabase
            .from('club_members')
            .update({ agent_id: agentMembershipId })
            .eq('id', memberId);

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
        const walletMap = {
            business: 'business_balance',
            player: 'player_balance',
            promo: 'promo_balance',
        };

        const fromCol = walletMap[fromWallet];
        const toCol = walletMap[toWallet];

        const { data: agent } = await supabase
            .from('agents')
            .select('business_balance, player_balance, promo_balance')
            .eq('id', agentId)
            .single();

        if (!agent) throw new Error('Agent not found');

        const currentFrom = Number((agent as any)[fromCol]);
        const currentTo = Number((agent as any)[toCol]);

        if (currentFrom < amount) throw new Error('Insufficient balance');

        const { error } = await supabase
            .from('agents')
            .update({
                [fromCol]: currentFrom - amount,
                [toCol]: currentTo + amount,
            })
            .eq('id', agentId);

        return !error;
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
        // Get agent's business balance
        const { data: agent } = await supabase
            .from('agents')
            .select('business_balance')
            .eq('id', agentId)
            .single();

        if (!agent) throw new Error('Agent not found');
        if (Number(agent.business_balance) < amount) throw new Error('Insufficient balance');

        // Get player's chip balance
        const { data: member } = await supabase
            .from('club_members')
            .select('chip_balance')
            .eq('user_id', playerId)
            .eq('club_id', clubId)
            .single();

        if (!member) throw new Error('Player not found');

        // Execute transfer
        const [agentResult, memberResult] = await Promise.all([
            supabase.from('agents').update({
                business_balance: Number(agent.business_balance) - amount
            }).eq('id', agentId),
            supabase.from('club_members').update({
                chip_balance: (member.chip_balance || 0) + amount
            }).eq('user_id', playerId).eq('club_id', clubId),
        ]);

        return !agentResult.error && !memberResult.error;
    }
}

export const AgentService = new AgentServiceClass();
export default AgentService;
