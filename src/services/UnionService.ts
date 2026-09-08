/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Union Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages unions (club networks), union admins, and consolidated settlements
 * Real Supabase integration — no demo data
 */

import { supabase } from '../lib/supabase';
import type { UnionSettlement } from '../utils/unionStatementReport';
export type { UnionSettlement, ClubSettlementBreakdown } from '../utils/unionStatementReport';
import { masterBus } from '../core/MasterBus';
import { unionApi } from './UnionApiService';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface Union {
  id: string;
  /** Route identity: /unions/<slug> (unions.slug, filled by trigger). */
  slug: string;
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
        'id, slug, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
      )
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return (data || []).map(this.mapUnion);
  }

  /**
   * Fetch only unions this user owns.
   *
   * The Home Cashier wallet directory is a hot path and needs ownership from
   * the authoritative `unions` row. `getMyUnions()` intentionally discovers
   * admin/member affiliations and enriches network counts as well; using that
   * broader workflow here would add unrelated round trips and could advertise
   * an admin-visible union as an owner treasury.
   */
  async getOwnedUnions(userId: string): Promise<Union[]> {
    const { data, error } = await supabase
      .from('unions')
      .select('id, slug, name, owner_id, avatar_url, member_count, created_at, updated_at')
      .eq('owner_id', userId);

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
          'id, slug, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
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
          'id, slug, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
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
        'id, slug, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
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
    // UNION AUDIT FIX 2026-07-21: unions is service-role-write-only under RLS,
    // so the old direct insert silently failed for browser users. Create via
    // the World Hub manage-union API (which also seeds the union wallet, the
    // shared BBJ pool, and the creator's union_lead admin row).
    const result = await unionApi.createUnion(name, description, {
      revenue_share_percent: 10,
      shared_player_pool: true,
      cross_club_tournaments: true,
      ...settings,
    });
    const created = result.union as Record<string, unknown> | undefined;
    if (!created) throw new Error('Union creation returned no data');
    void ownerId; // creator identity comes from the API bearer token
    return this.mapUnion(created);
  }

  /**
   * Update union
   */
  async updateUnion(unionId: string, updates: Partial<Union>): Promise<Union | null> {
    // UNION AUDIT FIX 2026-07-21: direct updates silently failed under RLS
    // (service-role only). Route through manage-union update_settings, and
    // normalize settings to the canonical snake_case keys — the Detail page
    // used to send camelCase, which mapUnion could never read back (saved
    // settings were silently lost).
    const rawSettings = updates.settings as unknown as Record<string, unknown> | undefined;
    const settings: Record<string, unknown> | undefined = rawSettings
      ? {
          ...rawSettings,
          ...(rawSettings.revenueSharePercent !== undefined
            ? { revenue_share_percent: rawSettings.revenueSharePercent }
            : {}),
          ...(rawSettings.sharedPlayerPool !== undefined
            ? { shared_player_pool: rawSettings.sharedPlayerPool }
            : {}),
          ...(rawSettings.crossClubTournaments !== undefined
            ? { cross_club_tournaments: rawSettings.crossClubTournaments }
            : {}),
        }
      : undefined;
    if (settings) {
      delete settings.revenueSharePercent;
      delete settings.sharedPlayerPool;
      delete settings.crossClubTournaments;
    }

    const result = await unionApi.updateSettings(unionId, {
      name: updates.name,
      description: updates.description,
      settings,
    });
    const data = result.union as Record<string, unknown> | undefined;

    masterBus.emit('UNION_UPDATED', { unionId });

    return data ? this.mapUnion(data) : this.getUnion(unionId);
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

    const rows = data || [];

    // Batch-fetch display names in ONE query instead of N per-admin lookups.
    const nameMap = new Map<string, string | undefined>();
    const adminUserIds = [...new Set(rows.map((a) => a.user_id).filter(Boolean))];
    if (adminUserIds.length > 0) {
      try {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, full_name')
          .in('id', adminUserIds);
        for (const p of profiles || []) {
          nameMap.set(p.id, p.full_name || p.username || undefined);
        }
      } catch (err) {
        reportError(err, 'UnionService.getUnionProfile');
      }
    }

    const admins = rows.map((a) => ({
      id: a.id,
      unionId: a.union_id,
      userId: a.user_id,
      role: a.role as 'union_lead' | 'union_admin',
      permissions: a.permissions || { manageClubs: true, manageSettlements: true },
      displayName: nameMap.get(a.user_id),
      createdAt: a.created_at,
    }));

    return admins;
  }

  /**
   * Add admin to union
   */
  async addAdmin(
    unionId: string,
    userId: string,
    _role: 'union_lead' | 'union_admin' = 'union_admin'
  ): Promise<boolean> {
    // UNION AUDIT FIX 2026-07-21: union_admins is service-role-write-only under
    // RLS — the direct insert silently failed for browser users. Route through
    // manage-union (union_lead auth enforced server-side; role is always
    // union_admin — leads are created only at union creation).
    try {
      await unionApi.addAdmin(unionId, userId);
      masterBus.emit('UNION_UPDATED', { unionId });
      return true;
    } catch (err) {
      reportError(err, 'UnionService.addAdmin');
      return false;
    }
  }

  /**
   * Remove admin from union
   */
  async removeAdmin(unionId: string, userId: string): Promise<boolean> {
    // UNION AUDIT FIX 2026-07-21: routed through manage-union (see addAdmin).
    try {
      await unionApi.removeAdmin(unionId, userId);
      masterBus.emit('UNION_UPDATED', { unionId });
      return true;
    } catch (err) {
      reportError(err, 'UnionService.removeAdmin');
      return false;
    }
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

    const rows = data || [];
    const clubIds = [...new Set(rows.map((uc) => uc.club_id).filter(Boolean))];
    const ownerIds = [
      ...new Set(rows.map((uc) => (uc.clubs as any)?.owner_id).filter(Boolean)),
    ] as string[];

    // ── Batch all enrichment into 3 queries total (was 3 PER club) ──────────
    const memberCounts = new Map<string, number>();
    const weeklyRakes = new Map<string, number>();
    const ownerNames = new Map<string, string | undefined>();

    if (clubIds.length > 0) {
      // Member counts — one grouped RPC (status filter matches the old per-club query).
      try {
        const { data: counts } = await supabase.rpc('fn_batch_club_member_counts', {
          p_club_ids: clubIds,
        });
        for (const row of counts || []) memberCounts.set(row.club_id, Number(row.member_count));
      } catch (err) {
        reportError(err, 'UnionService.memberCountQuery');
      }

      // Weekly rake — ONE query across all union clubs, grouped client-side.
      // Live ledger is rake_records (rake_history is dead — last row 2026-05-01).
      try {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        // 2026-08-19: this filtered ONLY on member club ids, but union games are
        // now owned BY the union — rake_records.club_id is the union's own id,
        // which is not in clubIds. So the union dashboard reported 0 weekly rake
        // while the union was actively raking (600 rake-wallet credits in 15
        // minutes at the time this was found). Include the union itself.
        const { data: rakeData } = await supabase
          .from('rake_records')
          .select('club_id, rake_amount')
          .in('club_id', [...clubIds, unionId])
          .gte('created_at', oneWeekAgo)
          .limit(QUERY_LIMITS.BULK);
        for (const r of rakeData || []) {
          weeklyRakes.set(
            r.club_id,
            (weeklyRakes.get(r.club_id) || 0) + Number(r.rake_amount || 0)
          );
        }
      } catch (err) {
        reportError(err, 'UnionService.rakeQuery');
      }
    }

    // Owner display names — one batched profiles lookup.
    if (ownerIds.length > 0) {
      try {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, full_name')
          .in('id', ownerIds);
        for (const p of profiles || []) {
          ownerNames.set(p.id, p.full_name || p.username || undefined);
        }
      } catch (err) {
        reportError(err, 'UnionService.ownerProfileLookup');
      }
    }

    return rows.map((uc) => ({
      id: uc.id,
      unionId: uc.union_id,
      clubId: uc.club_id,
      clubName: (uc.clubs as any)?.name || 'Unknown',
      ownerId: (uc.clubs as any)?.owner_id,
      ownerName: ownerNames.get((uc.clubs as any)?.owner_id),
      memberCount: memberCounts.get(uc.club_id) || 0,
      weeklyRake: weeklyRakes.get(uc.club_id) || 0,
      joinedAt: uc.joined_at,
    }));
  }

  /**
   * Add club to union
   */
  async addClub(unionId: string, clubId: string): Promise<boolean> {
    // UNION AUDIT FIX 2026-07-21: this used to force-join the club into
    // union_clubs directly — which both silently failed under RLS AND was the
    // wrong workflow (the UI says "Application sent"; the union owner is
    // supposed to approve). It now SUBMITS AN APPLICATION via the World Hub
    // union-application route; the union lead approves it from the dashboard
    // Applications tab, which performs the actual join server-side.
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      await unionApi.apply(unionId, resolvedClubId);
      masterBus.emit('UNION_UPDATED', { unionId });
      return true;
    } catch (err) {
      reportError(err, 'UnionService.addClub.apply');
      return false;
    }
  }

  /**
   * Remove club from union
   */
  async removeClub(unionId: string, clubId: string): Promise<boolean> {
    // UNION AUDIT FIX 2026-07-21: routed through manage-union remove_club
    // (service-role; also unlinks clubs.union_id and keeps counts in sync
    // server-side). The direct deletes silently failed under RLS.
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      await unionApi.removeClub(unionId, resolvedClubId);
      masterBus.emit('UNION_UPDATED', { unionId });
      masterBus.emit('CLUB_UPDATED', { clubId: resolvedClubId });
      return true;
    } catch (err) {
      reportError(err, 'UnionService.removeClub');
      return false;
    }
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
    // The statement board owns issuer identity and returns the complete period.
    // Missing invoices stay missing; current rates and rolling rake are not a
    // historical source. Payment state is independent of transfer direction.
    if (!!periodStart !== !!periodEnd) throw new Error('Both statement period dates are required');
    const start = periodStart ? new Date(periodStart) : null;
    const end = periodEnd ? new Date(periodEnd) : null;
    if (
      start &&
      end &&
      (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end)
    ) {
      throw new Error('Invalid statement period');
    }
    const { data, error } = await supabase.rpc('ca_union_statement_board', {
      p_union_id: unionId,
      p_period_end: end ? end.toISOString().slice(0, 10) : null,
      p_history: 1,
    });
    if (error) throw error;
    const { mapUnionStatementReport } = await import('../utils/unionStatementReport');
    const report = mapUnionStatementReport(unionId, data);
    if (start && report.periodStart && report.periodStart !== start.toISOString().slice(0, 10)) {
      throw new Error('Requested dates do not match the issued statement period');
    }
    return report;
  }

  async getSettlementReportForPeriod(unionId: string, periodId: string): Promise<UnionSettlement> {
    const { data, error } = await supabase
      .from('settlement_periods')
      .select('start_at, end_at')
      .eq('id', periodId)
      .eq('union_id', unionId)
      .maybeSingle();
    if (error) throw error;
    if (!data?.start_at || !data?.end_at) throw new Error('Union settlement period is unavailable');
    return this.getSettlementReport(unionId, data.start_at, data.end_at);
  }

  // IMPROVE 2026-07-21: getUnionSettings/updateUnionSettings removed — they
  // served only the deleted UnionSettingsPanel (never mounted), returned
  // hardcoded values, and updateUnionSettings both bypassed the API (RLS
  // no-op for browsers) and would have WIPED other settings keys by
  // overwriting the whole settings object. updateUnion is the live path.

  /**
   * Update individual club revenue splits
   */
  async updateClubSplits(unionId: string, splits: Record<string, number>): Promise<boolean> {
    // UNION AUDIT FIX 2026-07-21: routed through manage-union
    // update_club_commission (union_clubs is service-role-write-only under
    // RLS; the route also keeps clubs.club_commission_rate in sync).
    let anyFailed = false;
    for (const [clubId, splitPercent] of Object.entries(splits)) {
      try {
        const resolved = await resolveClubUUID(clubId);
        await unionApi.updateClubCommission(unionId, resolved, splitPercent / 100);
      } catch (err) {
        reportError(err, 'UnionService.updateSplits', { clubId });
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

    /* Summed from the SECURITY DEFINER batch RPC, not counted off the table.
       A direct count here is RLS-filtered, and the filter does not drop a CLUB
       from the sum - it drops ROWS - so the union total silently became "members
       of this union that I may personally enumerate". Measured for a real admin
       of one of the two clubs: 593 against a true 1,172. Identical defect to the
       one fixed in ClubHomePage (#875); this was the second copy.

       Summed without de-duplication, matching unions.member_count: the RPC
       returns one row per club and a player in two clubs is two memberships. */
    const { data: perClubCounts } = await supabase.rpc('fn_batch_club_member_counts', {
      p_club_ids: clubIds,
    });
    const totalPlayers = Array.isArray(perClubCounts)
      ? perClubCounts.reduce(
          (sum: number, row: { member_count: number | string }) =>
            sum + Number(row.member_count ?? 0),
          0
        )
      : 0;

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
    if (u.slug) {
      // Lazy: UnionService is in the entry chunk, the resolver is not.
      const { id, slug } = u;
      void import('../utils/unionIdResolver').then((m) => m.rememberUnionSlug(slug, id));
    }
    return {
      id: u.id,
      slug: u.slug || u.id,
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
        // UNION AUDIT FIX 2026-07-21: tolerate legacy camelCase keys written by
        // the old (broken) Detail-page save path, preferring canonical snake_case.
        revenueSharePercent:
          u.settings?.revenue_share_percent ?? u.settings?.revenueSharePercent ?? 10,
        sharedPlayerPool: u.settings?.shared_player_pool ?? u.settings?.sharedPlayerPool ?? true,
        crossClubTournaments:
          u.settings?.cross_club_tournaments ?? u.settings?.crossClubTournaments ?? true,
      },
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    };
  }
}

export const unionService = new UnionServiceClass();
export const UnionService = unionService;
export default unionService;
