/**
 * ♠ CLUB ARENA — Agent Service
 * PokerBros-style agent/chip distribution system
 */

import { supabase, isDemoMode } from '../lib/supabase';
import type { Agent, AgentPlayer, ChipTransaction } from '../types/database.types';

// Demo agents
const DEMO_AGENTS: Agent[] = [
    {
        id: 'agent-1',
        club_id: '1',
        user_id: 'user-2',
        member_id: 'mem-user-2',
        name: 'AceMaster',
        chip_balance: 100000,
        commission_rate: 10,
        player_count: 15,
        is_active: true,
        created_at: new Date().toISOString(),
    },
];

class AgentService {
    // ═══════════════════════════════════════════════════════════════════════════════
    // Agent Operations
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Get all agents for a club
     */
    async getAgents(clubId: string): Promise<Agent[]> {
        if (isDemoMode) {
            return DEMO_AGENTS.filter((a) => a.club_id === clubId);
        }

        const { data, error } = await supabase
            .from('agents')
            .select('*')
            .eq('club_id', clubId)
            .eq('is_active', true);

        if (error) throw error;
        return data || [];
    }

    /**
     * Create a new agent
     */
    async createAgent(
        clubId: string,
        userId: string,
        name: string,
        commissionRate: number = 10
    ): Promise<Agent> {
        if (isDemoMode) {
            const newAgent: Agent = {
                id: crypto.randomUUID(),
                club_id: clubId,
                user_id: userId,
                member_id: `mem-${userId}`,
                name,
                chip_balance: 0,
                commission_rate: commissionRate,
                player_count: 0,
                is_active: true,
                created_at: new Date().toISOString(),
            };
            DEMO_AGENTS.push(newAgent);
            return newAgent;
        }

        const { data: member } = await supabase
            .from('club_members')
            .select('id')
            .eq('club_id', clubId)
            .eq('user_id', userId)
            .single();

        if (!member) throw new Error('User is not a member');

        const { data, error } = await supabase
            .from('agents')
            .insert({
                club_id: clubId,
                user_id: userId,
                member_id: member.id,
                name,
                commission_rate: commissionRate,
                chip_balance: 0,
                player_count: 0,
                is_active: true,
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Get players under an agent
     */
    async getAgentPlayers(agentId: string): Promise<AgentPlayer[]> {
        if (isDemoMode) {
            // Mock data...
            return [
                {
                    id: 'ap-1',
                    agent_id: agentId,
                    user_id: 'player-1',
                    nickname: 'CardShark',
                    chip_balance: 5000,
                    rakeback_percent: 15,
                    joined_at: new Date().toISOString(),
                },
                {
                    id: 'ap-2',
                    agent_id: agentId,
                    user_id: 'player-2',
                    nickname: 'PokerPro',
                    chip_balance: 10000,
                    rakeback_percent: 20,
                    joined_at: new Date().toISOString(),
                },
            ];
        }

        // 1. Get the member_id of this agent
        const { data: agent } = await supabase
            .from('agents')
            .select('member_id')
            .eq('id', agentId)
            .single();

        if (!agent) throw new Error('Agent not found');

        // 2. Get players linked to this agent (via member_id)
        const { data: members, error } = await supabase
            .from('club_members')
            .select('*')
            .eq('agent_id', agent.member_id);

        if (error) throw error;

        // Map to AgentPlayer type
        return (members || []).map(m => ({
            id: m.id,
            agent_id: agentId,
            user_id: m.user_id,
            nickname: m.nickname || 'Unknown',
            chip_balance: m.chip_balance,
            rakeback_percent: 0, // Not in schema yet
            joined_at: m.joined_at
        }));
    }

    /**
     * Assign a player to an agent
     */
    async assignPlayer(clubId: string, memberId: string, agentId: string): Promise<void> {
        if (isDemoMode) return;

        // 1. Get member_id of the agent
        const { data: agent } = await supabase
            .from('agents')
            .select('member_id')
            .eq('id', agentId)
            .single();

        if (!agent) throw new Error('Agent not found');

        // 2. Update player's agent_id
        const { error } = await supabase
            .from('club_members')
            .update({ agent_id: agent.member_id })
            .eq('id', memberId)
            .eq('club_id', clubId);

        if (error) throw error;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Chip Transfers (Agent System)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Transfer chips from club owner to agent
     */
    async transferToAgent(
        clubId: string,
        agentId: string,
        amount: number,
        notes?: string
    ): Promise<ChipTransaction> {
        if (isDemoMode) {
            return {
                id: crypto.randomUUID(),
                club_id: clubId,
                from_user_id: null,
                to_user_id: agentId,
                amount,
                type: 'agent_transfer',
                reference_id: null,
                notes: notes || null,
                created_at: new Date().toISOString(),
            };
        }

        // Start transaction
        const { data: agent } = await supabase
            .from('agents')
            .select('chip_balance')
            .eq('id', agentId)
            .single();

        if (!agent) throw new Error('Agent not found');

        // Update agent balance
        await supabase
            .from('agents')
            .update({ chip_balance: agent.chip_balance + amount })
            .eq('id', agentId);

        // Record transaction
        const { data, error } = await supabase
            .from('chip_transactions')
            .insert({
                club_id: clubId,
                from_user_id: null,
                to_user_id: agentId,
                amount,
                type: 'agent_transfer',
                notes,
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Transfer chips from agent to player
     */
    async transferToPlayer(
        clubId: string,
        agentId: string,
        playerId: string,
        amount: number,
        notes?: string
    ): Promise<ChipTransaction> {
        if (isDemoMode) {
            return {
                id: crypto.randomUUID(),
                club_id: clubId,
                from_user_id: agentId,
                to_user_id: playerId,
                amount,
                type: 'deposit',
                reference_id: null,
                notes: notes || null,
                created_at: new Date().toISOString(),
            };
        }

        // Get agent and player balances
        const [{ data: agent }, { data: member }] = await Promise.all([
            supabase.from('agents').select('chip_balance').eq('id', agentId).single(),
            supabase.from('club_members').select('chip_balance').eq('user_id', playerId).eq('club_id', clubId).single(),
        ]);

        if (!agent) throw new Error('Agent not found');
        if (!member) throw new Error('Player not found in club');
        if (agent.chip_balance < amount) throw new Error('Insufficient agent balance');

        // Update balances
        await Promise.all([
            supabase.from('agents').update({ chip_balance: agent.chip_balance - amount }).eq('id', agentId),
            supabase.from('club_members').update({ chip_balance: member.chip_balance + amount }).eq('user_id', playerId).eq('club_id', clubId),
        ]);

        // Record transaction
        const { data, error } = await supabase
            .from('chip_transactions')
            .insert({
                club_id: clubId,
                from_user_id: agentId,
                to_user_id: playerId,
                amount,
                type: 'deposit',
                notes,
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Player cashes out chips back to agent
     */
    async cashOutToAgent(
        clubId: string,
        playerId: string,
        agentId: string,
        amount: number
    ): Promise<ChipTransaction> {
        if (isDemoMode) {
            return {
                id: crypto.randomUUID(),
                club_id: clubId,
                from_user_id: playerId,
                to_user_id: agentId,
                amount,
                type: 'withdrawal',
                reference_id: null,
                notes: 'Cash out to agent',
                created_at: new Date().toISOString(),
            };
        }

        // Get balances
        const [{ data: member }, { data: agent }] = await Promise.all([
            supabase.from('club_members').select('chip_balance').eq('user_id', playerId).eq('club_id', clubId).single(),
            supabase.from('agents').select('chip_balance').eq('id', agentId).single(),
        ]);

        if (!member) throw new Error('Player not found in club');
        if (!agent) throw new Error('Agent not found');
        if (member.chip_balance < amount) throw new Error('Insufficient player balance');

        // Update balances
        await Promise.all([
            supabase.from('club_members').update({ chip_balance: member.chip_balance - amount }).eq('user_id', playerId).eq('club_id', clubId),
            supabase.from('agents').update({ chip_balance: agent.chip_balance + amount }).eq('id', agentId),
        ]);

        // Record transaction
        const { data, error } = await supabase
            .from('chip_transactions')
            .insert({
                club_id: clubId,
                from_user_id: playerId,
                to_user_id: agentId,
                amount,
                type: 'withdrawal',
                notes: 'Cash out to agent',
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Get transaction history
     */
    async getTransactionHistory(
        clubId: string,
        userId?: string,
        limit: number = 50
    ): Promise<ChipTransaction[]> {
        if (isDemoMode) {
            return [];
        }

        let query = supabase
            .from('chip_transactions')
            .select('*')
            .eq('club_id', clubId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (userId) {
            query = query.or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    }
}

export const agentService = new AgentService();
