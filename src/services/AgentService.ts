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
import { readPresence } from '../lib/ownProfile';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
import {
  playerDisplayName,
  PLAYER_NAME_COLUMNS,
  type NameableProfile,
} from '../utils/playerDisplayName';
import { UUID_TOKEN } from '../utils/agentManagementPayload';

const AGENT_ADMIN_AUTHZ_REFUSAL = /not authorized to manage this club's agents/i;

type AgentAdminMutationError = Error & { code?: string };

/**
 * The agent-admin RPCs predate the platform-wide convention of raising 42501:
 * their authoritative owner/admin refusal is returned inside a successful
 * JSON response. Normalize only that exact contract (plus a real 42501) so a
 * caller can retire protected rows immediately without mistaking validation
 * failures for an authority change.
 */
function agentAdminAuthzError(error: unknown, responseMessage?: unknown): unknown | null {
  const transport = error as { code?: string; message?: string } | null;
  if (transport?.code === '42501') return error;

  const message =
    typeof responseMessage === 'string'
      ? responseMessage
      : typeof transport?.message === 'string'
        ? transport.message
        : '';
  if (!AGENT_ADMIN_AUTHZ_REFUSAL.test(message)) return null;

  const refusal = new Error(message) as AgentAdminMutationError;
  refusal.code = '42501';
  return refusal;
}

type JsonRecord = Record<string, unknown>;

function malformedAgentPayload(detail: string): never {
  throw new Error(`The Agent Record Is Malformed (${detail}).`);
}

function recordValue(value: unknown, detail: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return malformedAgentPayload(detail);
  }
  return value as JsonRecord;
}

function uuidValue(value: unknown, detail: string): string {
  if (typeof value !== 'string' || !UUID_TOKEN.test(value)) {
    return malformedAgentPayload(detail);
  }
  return value.toLowerCase();
}

function optionalUuid(value: unknown, detail: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return uuidValue(value, detail);
}

function numericValue(
  value: unknown,
  detail: string,
  options: { min?: number; max?: number; integer?: boolean; scale?: number } = {}
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?(?:\d+)(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return malformedAgentPayload(detail);
  if (options.min !== undefined && parsed < options.min) return malformedAgentPayload(detail);
  if (options.max !== undefined && parsed > options.max) return malformedAgentPayload(detail);
  if (options.integer && !Number.isInteger(parsed)) return malformedAgentPayload(detail);
  if (options.scale !== undefined) {
    const factor = 10 ** options.scale;
    if (Math.abs(parsed * factor - Math.round(parsed * factor)) > 1e-6) {
      return malformedAgentPayload(detail);
    }
  }
  return parsed;
}

function timestampValue(value: unknown, detail: string, optional = false): string | undefined {
  if ((value === null || value === undefined) && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    return malformedAgentPayload(detail);
  }
  return value;
}

function textValue(value: unknown, detail: string, optional = false): string | undefined {
  if ((value === null || value === undefined) && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    return malformedAgentPayload(detail);
  }
  return value.trim();
}

function booleanValue(value: unknown, detail: string): boolean {
  if (typeof value !== 'boolean') return malformedAgentPayload(detail);
  return value;
}

function mutationEnvelope(
  value: unknown,
  operation: string
): { receipt: JsonRecord; success: boolean; error?: string } {
  const receipt = recordValue(value, `${operation}.receipt`);
  if (typeof receipt.success !== 'boolean') {
    return malformedAgentPayload(`${operation}.success`);
  }
  if (!receipt.success) {
    return {
      receipt,
      success: false,
      error: textValue(receipt.error, `${operation}.error`),
    };
  }
  return { receipt, success: true };
}

function confirmedAgentMutationReceipt(
  receipt: JsonRecord,
  expectedAgentId: string,
  expectedClubId: string | undefined,
  operation: string
): string {
  const agentId = uuidValue(receipt.agent_id, `${operation}.agent_id`);
  const clubId = uuidValue(receipt.club_id, `${operation}.club_id`);
  if (agentId !== expectedAgentId.toLowerCase()) {
    return malformedAgentPayload(`${operation}.agent_id`);
  }
  if (expectedClubId && clubId !== expectedClubId.toLowerCase()) {
    return malformedAgentPayload(`${operation}.club_id`);
  }
  return clubId;
}

function parseProfile(
  value: unknown,
  expectedUserIds: ReadonlySet<string>,
  detail: string
): NameableProfile & { id: string; avatar_url?: string } {
  const row = recordValue(value, detail);
  const id = uuidValue(row.id, `${detail}.id`);
  if (!expectedUserIds.has(id)) return malformedAgentPayload(`${detail}.id`);
  for (const field of ['username', 'display_name', 'alias', 'display_name_preference'] as const) {
    if (row[field] !== null && row[field] !== undefined && typeof row[field] !== 'string') {
      return malformedAgentPayload(`${detail}.${field}`);
    }
  }
  if (
    row.use_real_name !== null &&
    row.use_real_name !== undefined &&
    typeof row.use_real_name !== 'boolean'
  ) {
    return malformedAgentPayload(`${detail}.use_real_name`);
  }
  if (
    row.avatar_url !== null &&
    row.avatar_url !== undefined &&
    typeof row.avatar_url !== 'string'
  ) {
    return malformedAgentPayload(`${detail}.avatar_url`);
  }
  return {
    id,
    username: row.username as string | null | undefined,
    display_name: row.display_name as string | null | undefined,
    alias: row.alias as string | null | undefined,
    display_name_preference: row.display_name_preference as string | null | undefined,
    use_real_name: row.use_real_name as boolean | null | undefined,
    avatar_url: (row.avatar_url as string | null | undefined) || undefined,
  };
}

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

function parseAgentRow(value: unknown, expectedClubId?: string, expectedAgentId?: string): Agent {
  const row = recordValue(value, 'agent');
  const id = uuidValue(row.id, 'agent.id');
  const userId = uuidValue(row.user_id, 'agent.user_id');
  const clubId = uuidValue(row.club_id, 'agent.club_id');
  if (expectedAgentId && id !== expectedAgentId.toLowerCase()) {
    return malformedAgentPayload('agent.id');
  }
  if (expectedClubId && clubId !== expectedClubId.toLowerCase()) {
    return malformedAgentPayload('agent.club_id');
  }

  if (row.role !== 'super_agent' && row.role !== 'agent' && row.role !== 'sub_agent') {
    return malformedAgentPayload('agent.role');
  }
  if (row.status !== 'active' && row.status !== 'suspended' && row.status !== 'frozen') {
    return malformedAgentPayload('agent.status');
  }

  const parentAgentId = optionalUuid(row.parent_agent_id, 'agent.parent_agent_id');
  if (parentAgentId === id) return malformedAgentPayload('agent.parent_agent_id');
  const commissionRate = numericValue(row.commission_rate, 'agent.commission_rate', {
    min: 0,
    max: 0.7,
    scale: 4,
  });
  const playerRakebackRate = numericValue(row.player_rakeback_rate, 'agent.player_rakeback_rate', {
    min: 0,
    max: 0.5,
    scale: 4,
  });
  const creditLimit = numericValue(row.credit_limit, 'agent.credit_limit', {
    min: 0,
    scale: 2,
  });
  const creditUsed = numericValue(row.credit_used, 'agent.credit_used', {
    min: 0,
    scale: 2,
  });
  const isPrepaid = booleanValue(row.is_prepaid, 'agent.is_prepaid');
  if (!isPrepaid && creditUsed > creditLimit) return malformedAgentPayload('agent.credit_used');
  const totalPlayers = numericValue(row.total_players, 'agent.total_players', {
    min: 0,
    integer: true,
  });
  const activePlayerCount = numericValue(row.active_player_count, 'agent.active_player_count', {
    min: 0,
    integer: true,
  });
  if (activePlayerCount > totalPlayers) return malformedAgentPayload('agent.active_player_count');

  return {
    id,
    userId,
    clubId,
    membershipId: optionalUuid(row.membership_id, 'agent.membership_id'),
    role: row.role,
    status: row.status,
    parentAgentId,
    commissionRate,
    playerRakebackRate,
    creditLimit,
    creditUsed,
    isPrepaid,
    businessBalance: numericValue(row.business_balance, 'agent.business_balance', {
      min: 0,
      scale: 2,
    }),
    playerBalance: numericValue(row.player_balance, 'agent.player_balance', {
      min: 0,
      scale: 2,
    }),
    promoBalance: numericValue(row.promo_balance, 'agent.promo_balance', {
      min: 0,
      scale: 2,
    }),
    totalPlayers,
    activePlayerCount,
    subAgentCount: numericValue(row.sub_agent_count, 'agent.sub_agent_count', {
      min: 0,
      integer: true,
    }),
    weeklyRakeGenerated: numericValue(row.weekly_rake_generated, 'agent.weekly_rake_generated', {
      min: 0,
      scale: 2,
    }),
    lifetimeEarnings: numericValue(row.lifetime_earnings, 'agent.lifetime_earnings', {
      min: 0,
      scale: 2,
    }),
    joinedAt: timestampValue(row.joined_at, 'agent.joined_at')!,
    lastActiveAt: timestampValue(row.last_active_at, 'agent.last_active_at', true),
  };
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
    const resolvedId = uuidValue(await resolveClubUUID(clubId), 'scope.club_id');
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('club_id', resolvedId)
      .order('joined_at', { ascending: false })
      // Read one sentinel row beyond the display/export bound. Returning an
      // exact 500 without this row would make every headline a silent lower
      // bound when a club has more agents than the maintained client cap.
      .limit(QUERY_LIMITS.MODERATE + 1);

    if (error) throw error;
    if (!Array.isArray(data) || data.length > QUERY_LIMITS.MODERATE) {
      return malformedAgentPayload('agents');
    }
    if (data.length === 0) return [];
    const agents = data.map((row) => parseAgentRow(row, resolvedId));
    const agentIds = new Set<string>();
    const agentUserIds = new Set<string>();
    for (const agent of agents) {
      if (agentIds.has(agent.id)) return malformedAgentPayload('agents.id');
      if (agentUserIds.has(agent.userId)) return malformedAgentPayload('agents.user_id');
      agentIds.add(agent.id);
      agentUserIds.add(agent.userId);
    }

    // Batch-fetch display names for all agent user_ids + parent user_ids
    const allUserIds = new Set(agents.map((agent) => agent.userId));
    // Fetch parent agents to get their user_ids
    const parentIds = [...new Set(agents.flatMap((agent) => agent.parentAgentId || []))];
    const parentMap: Record<string, string> = {};
    if (parentIds.length > 0) {
      const { data: parents, error: parentsError } = await supabase
        .from('agents')
        .select('id, user_id, club_id')
        .in('id', parentIds);
      if (parentsError) throw parentsError;
      if (!Array.isArray(parents) || parents.length !== parentIds.length) {
        return malformedAgentPayload('parents');
      }
      const expectedParents = new Set(parentIds);
      for (const [index, value] of parents.entries()) {
        const parent = recordValue(value, `parents[${index}]`);
        const parentId = uuidValue(parent.id, `parents[${index}].id`);
        const parentUserId = uuidValue(parent.user_id, `parents[${index}].user_id`);
        const parentClubId = uuidValue(parent.club_id, `parents[${index}].club_id`);
        if (
          !expectedParents.has(parentId) ||
          parentClubId !== resolvedId ||
          parentMap[parentId] !== undefined
        ) {
          return malformedAgentPayload(`parents[${index}]`);
        }
        parentMap[parentId] = parentUserId;
        allUserIds.add(parentUserId);
      }
    }

    // Fetch all profiles in one query
    const profileMap: Record<string, NameableProfile & { avatar_url?: string }> = {};
    if (allUserIds.size > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
        .in('id', [...allUserIds]);
      if (profilesError) throw profilesError;
      if (!Array.isArray(profiles) || profiles.length > allUserIds.size) {
        return malformedAgentPayload('profiles');
      }
      for (const [index, value] of profiles.entries()) {
        const profile = parseProfile(value, allUserIds, `profiles[${index}]`);
        if (profileMap[profile.id]) return malformedAgentPayload(`profiles[${index}].id`);
        profileMap[profile.id] = profile;
      }
    }

    return agents.map((agent) => ({
      ...agent,
      parentAgentName: agent.parentAgentId
        ? playerDisplayName(profileMap[parentMap[agent.parentAgentId]])
        : undefined,
      displayName: playerDisplayName(profileMap[agent.userId]),
      avatarUrl: profileMap[agent.userId]?.avatar_url,
    }));
  }

  /**
   * Get a single agent by ID
   */
  async getAgent(agentId: string, expectedClubId?: string): Promise<Agent | null> {
    const verifiedAgentId = uuidValue(agentId, 'agent_id');
    const verifiedClubId = expectedClubId
      ? uuidValue(await resolveClubUUID(expectedClubId), 'scope.club_id')
      : undefined;
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', verifiedAgentId)
      .maybeSingle();

    if (error) throw error;
    if (data === null) return null;
    const agent = parseAgentRow(data, verifiedClubId, verifiedAgentId);

    // Fetch profile info separately
    let displayName: string | undefined;
    let avatarUrl: string | undefined;
    let parentAgentName: string | undefined;
    try {
      const expectedProfile = new Set([agent.userId]);
      {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
          .eq('id', agent.userId)
          .maybeSingle();
        if (profileError) throw profileError;
        if (profile !== null) {
          const verifiedProfile = parseProfile(profile, expectedProfile, 'profile');
          displayName = playerDisplayName(verifiedProfile);
          avatarUrl = verifiedProfile.avatar_url;
        }
      }
      if (agent.parentAgentId) {
        const { data: parent, error: parentError } = await supabase
          .from('agents')
          .select('id, user_id, club_id')
          .eq('id', agent.parentAgentId)
          .maybeSingle();
        if (parentError) throw parentError;
        if (parent !== null) {
          const parentRow = recordValue(parent, 'parent');
          if (
            uuidValue(parentRow.id, 'parent.id') !== agent.parentAgentId ||
            uuidValue(parentRow.club_id, 'parent.club_id') !== agent.clubId
          ) {
            return malformedAgentPayload('parent');
          }
          const parentUserId = uuidValue(parentRow.user_id, 'parent.user_id');
          const { data: parentProfile, error: parentProfileError } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}`)
            .eq('id', parentUserId)
            .maybeSingle();
          if (parentProfileError) throw parentProfileError;
          if (parentProfile !== null) {
            parentAgentName = playerDisplayName(
              parseProfile(parentProfile, new Set([parentUserId]), 'parent_profile')
            );
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('The Agent Record Is Malformed')) throw e;
      reportError(e, 'AgentService');
      /* non-critical */
    }

    return {
      ...agent,
      parentAgentName,
      displayName,
      avatarUrl,
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
    const commissionRate = numericValue(input.commissionRate, 'create.commission_rate', {
      scale: 4,
    });
    const playerRakebackRate = numericValue(
      input.playerRakebackRate,
      'create.player_rakeback_rate',
      { scale: 4 }
    );
    const creditLimit = numericValue(input.creditLimit, 'create.credit_limit', {
      scale: 2,
    });
    if (commissionRate < 0 || commissionRate > 0.7)
      throw new Error('Commission rate must be between 0% and 70%');
    if (playerRakebackRate < 0 || playerRakebackRate > 0.5)
      throw new Error('Rakeback rate must be between 0% and 50%');
    if (creditLimit < 0) throw new Error('Credit limit cannot be negative');
    const userId = uuidValue(input.userId, 'create.user_id');
    if (input.role !== 'super_agent' && input.role !== 'agent' && input.role !== 'sub_agent') {
      return malformedAgentPayload('create.role');
    }
    const parentAgentId = input.parentAgentId
      ? uuidValue(input.parentAgentId, 'create.parent_agent_id')
      : undefined;
    if (input.isPrepaid !== undefined && typeof input.isPrepaid !== 'boolean') {
      return malformedAgentPayload('create.is_prepaid');
    }

    // agents is service-role-write-only under RLS — create via the SECURITY
    // DEFINER RPC, which authorizes the caller as the club owner/admin, enforces
    // the sub-agent parent rate caps, inserts the agent, and syncs the
    // club_members role. The direct browser insert here silently no-op'd.
    /* Every other method in this file resolves first, and this one did not:
       the club id reaching here comes from a route param, which is a slug or a
       six-digit code as often as it is a uuid, so "Create Agent" failed with an
       invalid-uuid error on every club URL that was not already a uuid. */
    const resolvedCreateClubId = uuidValue(await resolveClubUUID(input.clubId), 'create.club_id');

    const { data: res, error } = await supabase.rpc('fn_create_agent', {
      p_user_id: userId,
      p_club_id: resolvedCreateClubId,
      p_role: input.role,
      p_parent_agent_id: parentAgentId ?? null,
      p_commission_rate: commissionRate,
      p_player_rakeback_rate: playerRakebackRate,
      p_credit_limit: creditLimit,
      p_is_prepaid: input.isPrepaid ?? false,
    });

    if (error) {
      const authzError = agentAdminAuthzError(error);
      if (authzError) throw authzError;
      throw error;
    }
    const outcome = mutationEnvelope(res, 'create');
    if (!outcome.success) {
      const authzError = agentAdminAuthzError(null, outcome.error);
      if (authzError) throw authzError;
      throw new Error(outcome.error || 'Failed to create agent');
    }
    const createdAgentId = uuidValue(outcome.receipt.agent_id, 'create.agent_id');

    const created = await this.getAgent(createdAgentId, resolvedCreateClubId);
    if (
      !created ||
      created.id !== createdAgentId ||
      created.userId !== userId ||
      created.clubId !== resolvedCreateClubId ||
      created.role !== input.role
    ) {
      return malformedAgentPayload('create.readback');
    }
    return created;
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(
    agentId: string,
    status: AgentStatus,
    expectedClubId?: string
  ): Promise<boolean> {
    const verifiedAgentId = uuidValue(agentId, 'status.agent_id');
    if (status !== 'active' && status !== 'suspended' && status !== 'frozen') {
      return malformedAgentPayload('status.value');
    }
    const verifiedClubId = expectedClubId
      ? uuidValue(await resolveClubUUID(expectedClubId), 'status.club_id')
      : undefined;
    // agents is service-role-write-only under RLS — a direct browser update
    // silently no-ops and returns success. Go through the SECURITY DEFINER RPC
    // (authorizes the caller as the agent's club owner/admin).
    const { data, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: verifiedAgentId,
      p_status: status,
    });
    if (error) {
      const authzError = agentAdminAuthzError(error);
      if (authzError) {
        reportError(authzError, 'AgentService.updateAgentStatus');
        throw authzError;
      }
      reportError(error, 'AgentService.updateAgentStatus');
      return false;
    }
    const outcome = mutationEnvelope(data, 'status');
    if (!outcome.success) {
      const authzError = agentAdminAuthzError(null, outcome.error);
      if (authzError) {
        reportError(authzError, 'AgentService.updateAgentStatus');
        throw authzError;
      }
      reportError(
        new Error(outcome.error || 'agent status update failed'),
        'AgentService.updateAgentStatus'
      );
      return false;
    }
    confirmedAgentMutationReceipt(outcome.receipt, verifiedAgentId, verifiedClubId, 'status');
    return true;
  }

  /**
   * Update agent role (promote/demote)
   */
  async updateAgentRole(
    agentId: string,
    newRole: AgentRole,
    expectedClubId?: string
  ): Promise<boolean> {
    const verifiedAgentId = uuidValue(agentId, 'role.agent_id');
    if (newRole !== 'super_agent' && newRole !== 'agent' && newRole !== 'sub_agent') {
      return malformedAgentPayload('role.value');
    }
    const verifiedClubId = expectedClubId
      ? uuidValue(await resolveClubUUID(expectedClubId), 'role.club_id')
      : undefined;
    // agents is service-role-write-only AND read-own-row-only under RLS, so the
    // whole flow (existence check, agents update, club_members role sync) must
    // run server-side. fn_admin_update_agent authorizes the caller as the club
    // owner/admin, updates the role, and syncs club_members.role in one call.
    const { data: roleRes, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: verifiedAgentId,
      p_role: newRole,
    });

    if (error) {
      const authzError = agentAdminAuthzError(error);
      if (authzError) {
        reportError(authzError, 'AgentService.updateAgentRole');
        throw authzError;
      }
      reportError(error, 'AgentService.updateAgentRole');
      return false;
    }
    const outcome = mutationEnvelope(roleRes, 'role');
    if (!outcome.success) {
      const authzError = agentAdminAuthzError(null, outcome.error);
      if (authzError) {
        reportError(authzError, 'AgentService.updateAgentRole');
        throw authzError;
      }
      reportError(
        new Error(outcome.error || 'agent role update failed'),
        'AgentService.updateAgentRole'
      );
      return false;
    }
    confirmedAgentMutationReceipt(outcome.receipt, verifiedAgentId, verifiedClubId, 'role');

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AGENT PROMOTION
  // ─────────────────────────────────────────────────────────────────────────────

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
    reason?: string,
    expectedClubId?: string
  ): Promise<boolean> {
    const verifiedLimit = numericValue(newLimit, 'credit.limit', { scale: 2 });
    if (verifiedLimit < 0) throw new Error('Credit limit cannot be negative');
    const verifiedAgentId = uuidValue(agentId, 'credit.agent_id');
    const verifiedAssignedBy = uuidValue(assignedBy, 'credit.assigned_by');
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1_000)) {
      return malformedAgentPayload('credit.reason');
    }
    const verifiedClubId = expectedClubId
      ? uuidValue(await resolveClubUUID(expectedClubId), 'credit.club_id')
      : undefined;

    // agents is service-role-write-only AND read-own-row-only under RLS, so the
    // parent-limit check, the update, and the credit_assignments audit all run
    // server-side in fn_admin_update_agent (which authorizes the caller as the
    // club owner/admin). Direct browser reads/writes here silently failed.
    const { data: res, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: verifiedAgentId,
      p_credit_limit: verifiedLimit,
      p_assigned_by: verifiedAssignedBy,
      p_credit_reason: reason ?? null,
    });

    if (error) {
      // Preserve Postgres error identity for authority revocation. Collapsing
      // 42501 into `false` leaves callers unable to remove protected rows and
      // controls after a same-user role change.
      reportError(error, 'AgentService.setCreditLimit');
      throw error;
    }

    const outcome = mutationEnvelope(res, 'credit');
    if (!outcome.success) {
      const msg = outcome.error || 'credit limit update failed';
      const authzError = agentAdminAuthzError(null, msg);
      if (authzError) {
        reportError(authzError, 'AgentService.setCreditLimit');
        throw authzError;
      }
      // Preserve the parent-limit rule as a throw so callers can surface it.
      if (msg.includes('parent')) throw new Error('Credit limit cannot exceed parent agent limit');
      reportError(new Error(msg), 'AgentService.setCreditLimit');
      return false;
    }

    const receiptClubId = confirmedAgentMutationReceipt(
      outcome.receipt,
      verifiedAgentId,
      verifiedClubId,
      'credit'
    );
    const receiptLimit = numericValue(outcome.receipt.credit_limit, 'credit.credit_limit', {
      min: 0,
      scale: 2,
    });
    if (Math.abs(receiptLimit - verifiedLimit) > 1e-9) {
      return malformedAgentPayload('credit.credit_limit');
    }
    if (typeof outcome.receipt.is_prepaid !== 'boolean') {
      return malformedAgentPayload('credit.is_prepaid');
    }
    masterBus.emit('CLUB_UPDATED', { clubId: receiptClubId });

    return true;
  }

  /**
   * Update commission/rakeback rates
   */
  async updateRates(
    agentId: string,
    commissionRate?: number,
    playerRakebackRate?: number,
    expectedClubId?: string
  ): Promise<boolean> {
    const updates: { commission_rate?: number; player_rakeback_rate?: number } = {};

    if (commissionRate !== undefined) {
      const verified = numericValue(commissionRate, 'rates.commission_rate', { scale: 4 });
      if (verified < 0) throw new Error('Commission rate cannot be negative');
      if (verified > 0.7) throw new Error('Commission rate cannot exceed 70%');
      updates.commission_rate = verified;
    }

    if (playerRakebackRate !== undefined) {
      const verified = numericValue(playerRakebackRate, 'rates.player_rakeback_rate', {
        scale: 4,
      });
      if (verified < 0) throw new Error('Rakeback rate cannot be negative');
      if (verified > 0.5) throw new Error('Rakeback rate cannot exceed 50%');
      updates.player_rakeback_rate = verified;
    }

    if (Object.keys(updates).length === 0) return true;
    const verifiedAgentId = uuidValue(agentId, 'rates.agent_id');
    const verifiedClubId = expectedClubId
      ? uuidValue(await resolveClubUUID(expectedClubId), 'rates.club_id')
      : undefined;

    // agents is service-role-write-only under RLS — go through the SECURITY
    // DEFINER RPC (authorizes the caller as the agent's club owner/admin).
    const { data: res, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: verifiedAgentId,
      p_commission_rate: updates.commission_rate,
      p_player_rakeback_rate: updates.player_rakeback_rate,
    });

    if (error) {
      const authzError = agentAdminAuthzError(error);
      if (authzError) throw authzError;
      reportError(error, 'AgentService.updateRates');
      return false;
    }
    const outcome = mutationEnvelope(res, 'rates');
    if (!outcome.success) {
      const authzError = agentAdminAuthzError(null, outcome.error);
      if (authzError) throw authzError;
      reportError(
        new Error(outcome.error || 'agent rates update failed'),
        'AgentService.updateRates'
      );
      return false;
    }
    const receiptClubId = confirmedAgentMutationReceipt(
      outcome.receipt,
      verifiedAgentId,
      verifiedClubId,
      'rates'
    );
    masterBus.emit('CLUB_UPDATED', { clubId: receiptClubId });

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
    const profileMap: Record<string, NameableProfile & { avatar_url?: string }> = {};
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
        .in('id', userIds);
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p;
      }
    } catch (e) {
      reportError(e, 'AgentService.map');
      /* non-critical */
    }
    /* Online-now is the presence door's answer (the flag AND a heartbeat
       under five minutes old), never the raw is_online flag, which stays true
       long after somebody leaves. Unreadable presence is offline. */
    let presence = new Map<string, boolean>();
    try {
      presence = await readPresence(userIds);
    } catch (e) {
      reportError(e, 'AgentService.presence');
    }

    return data.map((m) => ({
      id: `${m.club_id}:${m.user_id}`,
      userId: m.user_id,
      displayName: playerDisplayName(profileMap[m.user_id]),
      avatarUrl: profileMap[m.user_id]?.avatar_url,
      chipBalance: m.chip_balance || 0,
      rakebackPercent: 0, // rakeback_percent column does not exist yet
      joinedAt: m.joined_at,
      isOnline: presence.get(m.user_id) === true,
    }));
  }

  // Assigning a player to an agent lives in UnionOpsService.assignPlayerToAgent(),
  // which goes through fn_assign_player_to_agent: it checks the agent is
  // active in that club, refuses an agent as their own player, and writes an
  // audit row. Two earlier copies here were removed: assignPlayer() on
  // 2026-08-21 (wrote a membership id into a user-id column), and
  // assignPlayerToAgent() / promoteToAgent() / selfTransfer() on 2026-09-04 -
  // all three had zero callers, and the first UPDATEd `agents`, a table with
  // no UPDATE policy for authenticated, then returned true regardless.

  // ─────────────────────────────────────────────────────────────────────────────
  // WALLET OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

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
    const { assertChipAmount, runAgentWalletOperation, confirmedAgentWalletReceipt } =
      await import('./AgentWalletIntent');
    assertChipAmount(amount);
    const { data: auth, error: authError } = await getAuthUser();
    if (authError || !auth.user) throw new Error('Sign In Before Transferring Chips');
    const resolvedId = (await resolveClubUUID(clubId)) || clubId;
    return runAgentWalletOperation(
      {
        userId: auth.user.id,
        clubId: resolvedId,
        targetId: playerId,
        kind: 'agent_send',
        amount,
      },
      async (operation) => {
        const { data, error } = await supabase.rpc('fn_agent_wallet_send', {
          p_club_id: resolvedId,
          p_to_user_id: playerId,
          p_amount: amount,
          p_destination: 'player_wallet',
          p_reason: 'Agent Transfer To Player',
          p_op_id: operation.operationId,
        });
        if (error) throw error;
        if (!confirmedAgentWalletReceipt(data, amount, 'agent_send')) {
          throw new Error(data?.error || 'The Cashier Did Not Confirm That Transfer');
        }
        masterBus.emit('BALANCE_UPDATED', { source: 'agent_transfer_sent', userId: auth.user.id });
        masterBus.emit('BALANCE_UPDATED', { source: 'agent_transfer_received', userId: playerId });
      }
    );
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
    const resolvedClubId = uuidValue(await resolveClubUUID(clubId), 'reversible.club_id');
    const { data, error } = await supabase.rpc('fn_agent_wallet_reversible', {
      p_club_id: resolvedClubId,
    });
    if (error) throw error;
    if (!Array.isArray(data) || data.length > 50) {
      return malformedAgentPayload('reversible.rows');
    }
    const seen = new Set<string>();
    return data.map((value, index) => {
      const row = recordValue(value, `reversible.rows[${index}]`);
      const transactionId = uuidValue(
        row.transaction_id,
        `reversible.rows[${index}].transaction_id`
      );
      if (seen.has(transactionId)) {
        return malformedAgentPayload(`reversible.rows[${index}].transaction_id`);
      }
      seen.add(transactionId);
      const amount = numericValue(row.amount, `reversible.rows[${index}].amount`, {
        min: 0.01,
        max: 1_000_000_000,
        scale: 2,
      });
      const claimedBack = numericValue(row.claimed_back, `reversible.rows[${index}].claimed_back`, {
        min: 0,
        max: amount,
        scale: 2,
      });
      const remaining = numericValue(row.remaining, `reversible.rows[${index}].remaining`, {
        min: 0.01,
        max: amount,
        scale: 2,
      });
      if (Math.round((amount - claimedBack) * 100) !== Math.round(remaining * 100)) {
        return malformedAgentPayload(`reversible.rows[${index}].remaining`);
      }
      if (row.destination !== 'player_wallet' && row.destination !== 'agent_wallet') {
        return malformedAgentPayload(`reversible.rows[${index}].destination`);
      }
      const createdAt = timestampValue(row.created_at, `reversible.rows[${index}].created_at`)!;
      const reversibleUntil = timestampValue(
        row.reversible_until,
        `reversible.rows[${index}].reversible_until`
      )!;
      if (Date.parse(reversibleUntil) <= Date.parse(createdAt)) {
        return malformedAgentPayload(`reversible.rows[${index}].reversible_until`);
      }
      return {
        transaction_id: transactionId,
        to_user_id: uuidValue(row.to_user_id, `reversible.rows[${index}].to_user_id`),
        to_name: textValue(row.to_name, `reversible.rows[${index}].to_name`)!,
        amount,
        claimed_back: claimedBack,
        remaining,
        destination: row.destination,
        created_at: createdAt,
        reversible_until: reversibleUntil,
        seconds_left: numericValue(row.seconds_left, `reversible.rows[${index}].seconds_left`, {
          min: 1,
          integer: true,
        }),
      };
    });
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
    const resolvedClubId = uuidValue(await resolveClubUUID(clubId), 'claim.club_id');
    const verifiedTransactionId = uuidValue(transactionId, 'claim.transaction_id');
    const verifiedAmount = numericValue(amount, 'claim.amount', {
      min: 0.01,
      max: 1_000_000_000,
      scale: 2,
    });
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1_000)) {
      return malformedAgentPayload('claim.reason');
    }
    const operationId = opId ? uuidValue(opId, 'claim.op_id') : crypto.randomUUID();
    const { data, error } = await supabase.rpc('fn_agent_wallet_claim_back', {
      p_club_id: resolvedClubId,
      p_transaction_id: verifiedTransactionId,
      p_amount: verifiedAmount,
      p_reason: reason ?? null,
      p_op_id: operationId,
    });
    if (error) {
      if ((error as { code?: string }).code === '42501') throw error;
      return {
        success: false,
        error:
          typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : 'That Claim Back Was Refused.',
      };
    }
    const outcome = mutationEnvelope(data, 'claim');
    if (!outcome.success) {
      return { success: false, error: outcome.error || 'That Claim Back Was Refused.' };
    }
    uuidValue(outcome.receipt.transaction_id, 'claim.receipt.transaction_id');
    const claimedBack = numericValue(outcome.receipt.amount, 'claim.receipt.amount', {
      min: 0.01,
      max: 1_000_000_000,
      scale: 2,
    });
    if (Math.round(claimedBack * 100) !== Math.round(verifiedAmount * 100)) {
      return malformedAgentPayload('claim.receipt.amount');
    }
    if (typeof outcome.receipt.replayed !== 'boolean') {
      return malformedAgentPayload('claim.receipt.replayed');
    }

    masterBus.emit('BALANCE_UPDATED', {
      source: 'agent_wallet_claim_back',
      clubId: resolvedClubId,
    });
    return { success: true, claimedBack, replayed: outcome.receipt.replayed };
  }
}

export const AgentService = new AgentServiceClass();
export default AgentService;
