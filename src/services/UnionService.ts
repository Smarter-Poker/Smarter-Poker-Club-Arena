/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Union Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages unions (club networks), union admins, and consolidated settlements
 * Real Supabase integration — no demo data
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Union {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  avatarUrl?: string;
  isPublic: boolean;
  memberCount: number;
  onlineCount: number;
  clubCount: number;
  totalRake: number;
  level: number;
  playerLevel: number;
  hierarchyLevel: number;
  totalPlayers: number;
  hierarchyUnits: number;
  hierarchyUnitsRoundedUp: number;
  playerThresholdCurrent: number;
  playerThresholdNext: number;
  hierarchyThresholdCurrent: number;
  hierarchyThresholdNext: number;
  settings: UnionSettings;
  createdAt: string;
  updatedAt: string;
}

export interface UnionSettings {
  revenueSharePercent: number; // % taken from member clubs
  sharedPlayerPool: boolean; // Cross-club player visibility
  crossClubTournaments: boolean; // Allow union-wide tournaments
}

export interface UnionAdmin {
  id: string;
  unionId: string;
  userId: string;
  role: 'union_lead' | 'union_admin';
  permissions: {
    manageClubs: boolean;
    manageSettlements: boolean;
  };
  displayName?: string;
  createdAt: string;
}

export interface UnionClub {
  id: string;
  unionId: string;
  clubId: string;
  clubName: string;
  ownerId: string;
  ownerName?: string;
  memberCount: number;
  weeklyRake: number;
  joinedAt: string;
}

export interface UnionSettlement {
  unionId: string;
  periodStart: string;
  periodEnd: string;
  totalClubs: number;
  totalRakeCollected: number;
  totalUnionTax: number;
  totalAgentCommissions: number;
  totalPlayerRakeback: number;
  netUnionRevenue: number;
  clubBreakdowns: ClubSettlementBreakdown[];
}

export interface ClubSettlementBreakdown {
  clubId: string;
  clubName: string;
  rakeCollected: number;
  unionTaxPaid: number;
  netToClub: number;
  wireDirection: 'PAY_TO_UNION' | 'COLLECT_FROM_UNION';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class UnionServiceClass {
  // ─────────────────────────────────────────────────────────────────────────────
  // UNION CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all unions
   */
  async getUnions(): Promise<Union[]> {
    const { data, error } = await supabase
      .from('unions')
      .select(
        'id, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
      )
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return (data || []).map(this.mapUnion);
  }

  /**
   * Get unions where user is owner or admin
   */
  async getMyUnions(userId: string): Promise<Union[]> {
    // Run all 3 discovery paths in parallel (no data dependency between them)
    const [ownedResult, adminResult, memberResult] = await Promise.allSettled([
      // Path 1: unions where user is owner
      supabase
        .from('unions')
        .select(
          'id, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
        )
        .eq('owner_id', userId),
      // Path 2: unions where user is admin
      supabase.from('union_admins').select('union_id').eq('user_id', userId),
      // Path 3: unions via club membership → union_clubs
      (async () => {
        const { data: memberClubs } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', userId);
        if (!memberClubs || memberClubs.length === 0) return { data: [] as { union_id: string }[] };
        const clubIds = memberClubs.map((m) => m.club_id);
        return supabase.from('union_clubs').select('union_id').in('club_id', clubIds);
      })(),
    ]);

    // Extract owned unions
    const owned =
      ownedResult.status === 'fulfilled' && !ownedResult.value.error
        ? ownedResult.value.data || []
        : [];
    if (ownedResult.status === 'fulfilled' && ownedResult.value.error) {
      throw ownedResult.value.error;
    }

    // Extract admin union IDs
    const adminOf =
      adminResult.status === 'fulfilled' && !adminResult.value.error
        ? adminResult.value.data || []
        : [];

    // Extract club-membership union IDs
    let memberUnionIds: string[] = [];
    if (memberResult.status === 'fulfilled') {
      const ucRows = memberResult.value.data;
      if (ucRows && ucRows.length > 0) {
        memberUnionIds = [...new Set(ucRows.map((r: any) => r.union_id))];
      }
    } else {
      console.warn(
        '[UnionService] Failed to resolve unions via club membership:',
        memberResult.reason
      );
    }

    // Combine and dedupe
    const unionMap = new Map<string, any>();
    (owned || []).forEach((u) => unionMap.set(u.id, u));

    // Collect all union IDs we need to fetch (from admin + club membership paths)
    const missingUnionIds = [...(adminOf || []).map((a) => a.union_id), ...memberUnionIds];
    const uniqueMissingIds = [...new Set(missingUnionIds)];

    // Fetch full union data for any unions not already in the map (single batch query)
    const idsToFetch = uniqueMissingIds.filter((id) => !unionMap.has(id));
    if (idsToFetch.length > 0) {
      const { data: batchUnions } = await supabase
        .from('unions')
        .select(
          'id, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
        )
        .in('id', idsToFetch);
      if (batchUnions) {
        batchUnions.forEach((u) => unionMap.set(u.id, u));
      }
    }

    const unions = Array.from(unionMap.values()).map(this.mapUnion);

    // ── Enrich with LIVE clubCount + memberCount (unions.member_count / club_count can be stale) ──
    if (unions.length > 0) {
      try {
        const unionIds = unions.map((u) => u.id);
        // Single batch: get all union_clubs rows for these unions
        const { data: ucRows } = await supabase
          .from('union_clubs')
          .select('union_id, club_id')
          .in('union_id', unionIds);

        if (ucRows && ucRows.length > 0) {
          // Live club counts per union
          const clubCountMap = new Map<string, number>();
          const allClubIds: string[] = [];
          const clubToUnionMap = new Map<string, string>();
          for (const row of ucRows) {
            clubCountMap.set(row.union_id, (clubCountMap.get(row.union_id) || 0) + 1);
            allClubIds.push(row.club_id);
            clubToUnionMap.set(row.club_id, row.union_id);
          }

          // Live member counts: use SECURITY DEFINER RPC (bypasses RLS for accurate cross-club totals)
          if (allClubIds.length > 0) {
            const { data: counts } = await supabase.rpc('fn_batch_club_member_counts', {
              p_club_ids: allClubIds,
            });

            const memberCountMap = new Map<string, number>();
            for (const row of counts || []) {
              const uid = clubToUnionMap.get(row.club_id);
              if (uid) {
                memberCountMap.set(uid, (memberCountMap.get(uid) || 0) + Number(row.member_count));
              }
            }

            for (const union of unions) {
              if (clubCountMap.has(union.id)) union.clubCount = clubCountMap.get(union.id)!;
              if (memberCountMap.has(union.id)) {
                // Use the higher of live count vs authoritative totalPlayers (prevents regression)
                const liveCount = memberCountMap.get(union.id)!;
                union.memberCount = Math.max(liveCount, union.totalPlayers || 0);
              }
            }
          } else {
            // No clubs in any union — zero out counts
            for (const union of unions) {
              if (clubCountMap.has(union.id)) union.clubCount = clubCountMap.get(union.id)!;
            }
          }
        }
      } catch (e) {
        console.warn('[UnionService] Live union count enrichment failed (using stale counts):', e);
      }
    }

    return unions;
  }

  /**
   * Get union by ID
   */
  async getUnion(unionId: string): Promise<Union | null> {
    const { data, error } = await supabase
      .from('unions')
      .select(
        'id, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
      )
      .eq('id', unionId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    return this.mapUnion(data);
  }

  /**
   * Create a new union
   */
  async createUnion(
    name: string,
    description: string,
    ownerId: string,
    settings?: Partial<UnionSettings>
  ): Promise<Union> {
    const { data, error } = await supabase
      .from('unions')
      .insert({
        name,
        description,
        owner_id: ownerId,
        is_public: true,
        settings: {
          revenue_share_percent: 10,
          shared_player_pool: true,
          cross_club_tournaments: true,
          ...settings,
        },
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Union creation returned no data');

    // Add owner as union_lead
    await this.addAdmin(data.id, ownerId, 'union_lead');

    return this.mapUnion(data);
  }

  /**
   * Update union
   */
  async updateUnion(unionId: string, updates: Partial<Union>): Promise<Union | null> {
    const { data, error } = await supabase
      .from('unions')
      .update({
        name: updates.name,
        description: updates.description,
        avatar_url: updates.avatarUrl,
        is_public: updates.isPublic,
        settings: updates.settings,
        updated_at: new Date().toISOString(),
      })
      .eq('id', unionId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    masterBus.emit('UNION_UPDATED', { unionId });

    return this.mapUnion(data);
  }

  /**
   * Delete union
   */
  async deleteUnion(unionId: string): Promise<boolean> {
    const { error } = await supabase.from('unions').delete().eq('id', unionId);

    if (!error) {
      masterBus.emit('UNION_UPDATED', { unionId });
    }

    return !error;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UNION ADMINS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get union admins
   */
  async getAdmins(unionId: string): Promise<UnionAdmin[]> {
    const { data, error } = await supabase
      .from('union_admins')
      .select('id, union_id, user_id, role, permissions, created_at')
      .eq('union_id', unionId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Fetch display names separately from profiles
    const admins = await Promise.all(
      (data || []).map(async (a) => {
        let displayName: string | undefined;
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('username, full_name')
            .eq('id', a.user_id)
            .maybeSingle();
          displayName = profile?.full_name || profile?.username;
        } catch (err) {
          reportError(err, 'UnionService.getUnionProfile');
        }

        return {
          id: a.id,
          unionId: a.union_id,
          userId: a.user_id,
          role: a.role as 'union_lead' | 'union_admin',
          permissions: a.permissions || { manageClubs: true, manageSettlements: true },
          displayName,
          createdAt: a.created_at,
        };
      })
    );

    return admins;
  }

  /**
   * Add admin to union
   */
  async addAdmin(
    unionId: string,
    userId: string,
    role: 'union_lead' | 'union_admin' = 'union_admin'
  ): Promise<boolean> {
    const { error } = await supabase.from('union_admins').insert({
      union_id: unionId,
      user_id: userId,
      role,
      permissions: { manage_clubs: true, manage_settlements: true },
    });

    if (!error) {
      masterBus.emit('UNION_UPDATED', { unionId });
    }

    return !error;
  }

  /**
   * Remove admin from union
   */
  async removeAdmin(unionId: string, userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('union_admins')
      .delete()
      .eq('union_id', unionId)
      .eq('user_id', userId);

    if (!error) {
      masterBus.emit('UNION_UPDATED', { unionId });
    }

    return !error;
  }

  /**
   * Check if user is union admin
   */
  async isUnionAdmin(unionId: string, userId: string): Promise<boolean> {
    // Check if owner
    const { data: union } = await supabase
      .from('unions')
      .select('owner_id')
      .eq('id', unionId)
      .maybeSingle();

    if (union?.owner_id === userId) return true;

    // Check if admin
    const { count } = await supabase
      .from('union_admins')
      .select('*', { count: 'exact', head: true })
      .eq('union_id', unionId)
      .eq('user_id', userId);

    return (count || 0) > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UNION CLUBS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get clubs in a union
   */
  async getUnionClubs(unionId: string): Promise<UnionClub[]> {
    const { data, error } = await supabase
      .from('union_clubs')
      .select(
        `
                *,
                clubs (
                    id,
                    name,
                    owner_id
                )
            `
      )
      .eq('union_id', unionId)
      .order('joined_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) throw error;

    // Enrich clubs with member counts (skip rake_transactions if empty/slow)
    const enrichedClubs = await Promise.all(
      (data || []).map(async (uc) => {
        let memberCount = 0;
        let weeklyRake = 0;

        try {
          const { count } = await supabase
            .from('club_members')
            .select('*', { count: 'exact', head: true })
            .eq('club_id', uc.club_id)
            .in('status', ['active', 'approved']);
          memberCount = count || 0;
        } catch (err) {
          reportError(err, 'UnionService.memberCountQuery');
        }

        try {
          const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data: rakeData } = await supabase
            .from('rake_transactions')
            .select('amount')
            .eq('club_id', uc.club_id)
            .gte('created_at', oneWeekAgo)
            .limit(QUERY_LIMITS.BULK);
          weeklyRake = (rakeData || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
        } catch (err) {
          reportError(err, 'UnionService.rakeQuery');
        }

        // Get owner display name from profiles table directly
        let ownerName: string | undefined;
        try {
          const ownerId = (uc.clubs as any)?.owner_id;
          if (ownerId) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('username, full_name')
              .eq('id', ownerId)
              .maybeSingle();
            ownerName = profile?.full_name || profile?.username;
          }
        } catch (err) {
          reportError(err, 'UnionService.ownerProfileLookup');
        }

        return {
          id: uc.id,
          unionId: uc.union_id,
          clubId: uc.club_id,
          clubName: (uc.clubs as any)?.name || 'Unknown',
          ownerId: (uc.clubs as any)?.owner_id,
          ownerName,
          memberCount,
          weeklyRake,
          joinedAt: uc.joined_at,
        };
      })
    );

    return enrichedClubs;
  }

  /**
   * Add club to union
   */
  async addClub(unionId: string, clubId: string): Promise<boolean> {
    // Resolve club UUID once for consistent usage across all queries
    const resolvedClubId = await resolveClubUUID(clubId);

    const { error } = await supabase.from('union_clubs').insert({
      union_id: unionId,
      club_id: resolvedClubId,
    });

    if (error) return false;

    // Update union club_count from actual union_clubs count (race-safe)
    const { count: clubCount } = await supabase
      .from('union_clubs')
      .select('*', { count: 'exact', head: true })
      .eq('union_id', unionId);

    if (clubCount !== null) {
      const { error: countErr } = await supabase
        .from('unions')
        .update({ club_count: clubCount })
        .eq('id', unionId);
      if (countErr) reportError(countErr, 'UnionService.addClub.updateCount');
    }

    // Update club's union_id
    const { error: linkErr } = await supabase
      .from('clubs')
      .update({ union_id: unionId })
      .eq('id', resolvedClubId);
    if (linkErr) reportError(linkErr, 'UnionService.addClub.linkClub');

    masterBus.emit('UNION_UPDATED', { unionId });
    masterBus.emit('CLUB_UPDATED', { clubId: resolvedClubId });

    return true;
  }

  /**
   * Remove club from union
   */
  async removeClub(unionId: string, clubId: string): Promise<boolean> {
    // Resolve club UUID once for consistent usage across all queries
    const resolvedClubId = await resolveClubUUID(clubId);

    const { error } = await supabase
      .from('union_clubs')
      .delete()
      .eq('union_id', unionId)
      .eq('club_id', resolvedClubId);

    if (error) return false;

    // Update union club_count from actual union_clubs count (race-safe)
    const { count: clubCount } = await supabase
      .from('union_clubs')
      .select('*', { count: 'exact', head: true })
      .eq('union_id', unionId);

    if (clubCount !== null) {
      const { error: countErr } = await supabase
        .from('unions')
        .update({ club_count: clubCount })
        .eq('id', unionId);
      if (countErr) reportError(countErr, 'UnionService.removeClub.updateCount');
    }

    // Update club's union_id to null
    const { error: unlinkErr } = await supabase
      .from('clubs')
      .update({ union_id: null })
      .eq('id', resolvedClubId);
    if (unlinkErr) reportError(unlinkErr, 'UnionService.removeClub.unlinkClub');

    masterBus.emit('UNION_UPDATED', { unionId });
    masterBus.emit('CLUB_UPDATED', { clubId: resolvedClubId });

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SETTLEMENTS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get consolidated settlement report
   */
  async getSettlementReport(
    unionId: string,
    periodStart?: string,
    periodEnd?: string
  ): Promise<UnionSettlement> {
    // Get union details
    const union = await this.getUnion(unionId);
    if (!union) throw new Error('Union not found');

    // Get clubs
    const clubs = await this.getUnionClubs(unionId);

    // Calculate totals (would come from settlement_periods in production)
    const totalRake = clubs.reduce((sum, c) => sum + c.weeklyRake, 0);
    const revenueShareRate = union.settings?.revenueSharePercent || 10;
    const totalUnionTax = totalRake * (revenueShareRate / 100);

    return {
      unionId,
      periodStart: periodStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      periodEnd: periodEnd || new Date().toISOString(),
      totalClubs: clubs.length,
      totalRakeCollected: totalRake,
      totalUnionTax,
      totalAgentCommissions: totalRake * 0.2, // Estimated
      totalPlayerRakeback: totalRake * 0.1, // Estimated
      netUnionRevenue: totalUnionTax,
      clubBreakdowns: clubs.map((c) => ({
        clubId: c.clubId,
        clubName: c.clubName,
        rakeCollected: c.weeklyRake,
        unionTaxPaid: c.weeklyRake * (revenueShareRate / 100),
        netToClub: c.weeklyRake * (1 - revenueShareRate / 100),
        wireDirection: 'PAY_TO_UNION' as const,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UNION SETTINGS (for UnionSettingsPanel)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get union settings for settings panel
   */
  async getUnionSettings(unionId: string): Promise<any> {
    const union = await this.getUnion(unionId);
    if (!union) throw new Error('Union not found');

    return {
      id: union.id,
      name: union.name,
      revenueSplit: union.settings?.revenueSharePercent || 10,
      settlementFrequency: 'weekly',
      autoSettlement: true,
      minimumSettlement: 1000,
      rakeCap: null,
      allowMemberWithdrawal: true,
      requireApprovalForJoin: true,
    };
  }

  /**
   * Update union settings from settings panel
   */
  async updateUnionSettings(unionId: string, settings: any): Promise<boolean> {
    const { error } = await supabase
      .from('unions')
      .update({
        settings: {
          revenue_share_percent: settings.revenueSplit,
          shared_player_pool: true,
          cross_club_tournaments: true,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', unionId);

    if (!error) {
      masterBus.emit('UNION_UPDATED', { unionId });
    }

    return !error;
  }

  /**
   * Update individual club revenue splits
   */
  async updateClubSplits(unionId: string, splits: Record<string, number>): Promise<boolean> {
    // Update each club's commission rate in union_clubs
    let anyFailed = false;
    for (const [clubId, splitPercent] of Object.entries(splits)) {
      const { error: splitErr } = await supabase
        .from('union_clubs')
        .update({ club_commission_rate: splitPercent / 100 })
        .eq('union_id', unionId)
        .eq('club_id', await resolveClubUUID(clubId));
      if (splitErr) {
        reportError(splitErr, 'UnionService.updateSplits', { clubId });
        anyFailed = true;
      }
    }

    masterBus.emit('UNION_UPDATED', { unionId });

    return !anyFailed;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STATS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get union stats
   */
  async getStats(unionId: string): Promise<{
    totalPlayers: number;
    totalClubs: number;
    weeklyRake: number;
    onlinePlayers: number;
  }> {
    const clubs = await this.getUnionClubs(unionId);

    // Get member counts for all clubs
    const clubIds = clubs.map((c) => c.clubId);

    const { count: totalPlayers } = await supabase
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .in('club_id', clubIds)
      .in('status', ['active', 'approved']);

    return {
      totalPlayers: totalPlayers || 0,
      totalClubs: clubs.length,
      weeklyRake: clubs.reduce((sum, c) => sum + c.weeklyRake, 0),
      onlinePlayers: Math.floor((totalPlayers || 0) * 0.2), // Estimate 20% online
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  private mapUnion(u: any): Union {
    return {
      id: u.id,
      name: u.name,
      description: u.description,
      ownerId: u.owner_id,
      avatarUrl: u.avatar_url,
      isPublic: u.is_public ?? true,
      memberCount: Math.max(u.member_count || 0, u.total_players || 0),
      onlineCount: u.online_count || 0,
      clubCount: u.club_count || 0,
      totalRake: Number(u.total_rake) || 0,
      level: u.level || 1,
      playerLevel: u.player_level || 1,
      hierarchyLevel: u.hierarchy_level || 1,
      totalPlayers: u.total_players || 0,
      hierarchyUnits: Number(u.hierarchy_units) || 0,
      hierarchyUnitsRoundedUp: u.hierarchy_units_rounded_up || 0,
      playerThresholdCurrent: u.player_threshold_current || 0,
      playerThresholdNext: u.player_threshold_next || 0,
      hierarchyThresholdCurrent: u.hierarchy_threshold_current || 0,
      hierarchyThresholdNext: u.hierarchy_threshold_next || 0,
      settings: {
        revenueSharePercent: u.settings?.revenue_share_percent || 10,
        sharedPlayerPool: u.settings?.shared_player_pool ?? true,
        crossClubTournaments: u.settings?.cross_club_tournaments ?? true,
      },
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    };
  }
}

export const unionService = new UnionServiceClass();
export const UnionService = unionService;
export default unionService;
