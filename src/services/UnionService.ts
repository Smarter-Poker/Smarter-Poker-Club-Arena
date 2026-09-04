/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Union Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages unions (club networks), union admins, and consolidated settlements
 * Real Supabase integration — no demo data
 */

import { supabase } from '../lib/supabase';
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
        'id, slug, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
      )
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    return this.enrichWithRealtimeCounts((data || []).map(this.mapUnion));
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
    return this.enrichWithRealtimeCounts(unions);
  }

  /**
   * Dan 2026-09-03: "harden this for all clubs and unions globally."
   *
   * Every union the app hands out passes through here, so every surface shows
   * the same two numbers the union card on the home carousel shows:
   *
   *   memberCount / totalPlayers  = fn_batch_union_realtime_member_counts
   *                                 (sum of each member club's members)
   *   onlineCount                 = fn_batch_union_realtime_active_counts
   *                                 (sum of each member club's seated players)
   *
   * Both RPCs return a row per requested union, zero included, so a brand-new
   * union with no clubs reads 0 rather than keeping a stale column. The old
   * enrichment used fn_batch_club_member_counts (no row for an empty club)
   * and then took Math.max against unions.total_players, so a union could
   * never show a decrease; and `unions.online_count`, which mapUnion used to
   * read, is not a column that exists. It was always 0.
   */
  private async enrichWithRealtimeCounts(unions: Union[]): Promise<Union[]> {
    if (unions.length === 0) return unions;
    const unionIds = unions.map((u) => u.id);
    try {
      const [membersResult, activeResult, ucResult] = await Promise.all([
        supabase.rpc('fn_batch_union_realtime_member_counts', { p_union_ids: unionIds }),
        supabase.rpc('fn_batch_union_realtime_active_counts', { p_union_ids: unionIds }),
        supabase.from('union_clubs').select('union_id').in('union_id', unionIds),
      ]);

      const memberMap = new Map<string, number>();
      for (const row of (membersResult.data as any[]) || []) {
        memberMap.set(row.union_id, Number(row.member_count) || 0);
      }
      const activeMap = new Map<string, number>();
      for (const row of (activeResult.data as any[]) || []) {
        activeMap.set(row.union_id, Number(row.active_count) || 0);
      }
      const clubCountMap = new Map<string, number>();
      for (const row of (ucResult.data as any[]) || []) {
        clubCountMap.set(row.union_id, (clubCountMap.get(row.union_id) || 0) + 1);
      }

      for (const union of unions) {
        if (!membersResult.error && memberMap.has(union.id)) {
          const live = memberMap.get(union.id)!;
          union.memberCount = live;
          union.totalPlayers = live;
        }
        if (!activeResult.error && activeMap.has(union.id)) {
          union.onlineCount = activeMap.get(union.id)!;
        }
        if (!ucResult.error) {
          union.clubCount = clubCountMap.get(union.id) || 0;
        }
      }
    } catch (e) {
      console.warn('[UnionService] Realtime union count enrichment failed:', e);
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

    const [union] = await this.enrichWithRealtimeCounts([this.mapUnion(data)]);
    return union;
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
      // Member counts: the realtime RPC returns a row per requested club, zero
      // included, so an empty or brand-new club reads 0 rather than "missing".
      try {
        const { data: counts } = await supabase.rpc('fn_batch_club_realtime_member_counts', {
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
    // REAL FINANCIALS 2026-07-21 (was a client-side estimate): numbers now
    // come from the union's actual money ledger.
    //   - union_wallet_transactions tx_type='settlement_hold' credits = the
    //     REAL union tax collected per club in the window (written by the
    //     settle-period close, conserved against club treasuries).
    //   - tx_type='rake' credits = engine-held union rake (tournament fees).
    //   - Per-club rake is derived from its hold and the union_rake_hold rate
    //     the hold was taken at (union settings; default 10%).
    // union_wallet_transactions is readable by union admins under RLS.
    const union = await this.getUnion(unionId);
    if (!union) throw new Error('Union not found');

    const clubs = await this.getUnionClubs(unionId);

    const start = periodStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const end = periodEnd || new Date().toISOString();

    const { data: ledger } = await supabase
      .from('union_wallet_transactions')
      .select('tx_type, direction, amount, club_id, created_at')
      .eq('union_id', unionId)
      .gte('created_at', start)
      .lte('created_at', end)
      .limit(2000);

    const rows = ledger || [];
    const holdsByClub = new Map<string, number>();
    let totalHolds = 0;
    let engineRake = 0;
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (r.tx_type === 'settlement_hold' && r.direction === 'credit') {
        totalHolds += amt;
        if (r.club_id) {
          holdsByClub.set(r.club_id, (holdsByClub.get(r.club_id) || 0) + amt);
        }
      } else if (r.tx_type === 'rake' && r.direction === 'credit') {
        engineRake += amt;
      }
    }

    // The rate the holds were taken at (fraction of club rake).
    const rawSettings = union.settings as unknown as Record<string, unknown>;
    const holdRate = Number(rawSettings?.union_rake_hold) || 0.1;

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const clubBreakdowns = clubs.map((c) => {
      const hold = round2(holdsByClub.get(c.clubId) || 0);
      if (hold > 0) {
        // Settled this period: derive the club's rake from its collected hold.
        const rake = holdRate > 0 ? round2(hold / holdRate) : hold;
        return {
          clubId: c.clubId,
          clubName: c.clubName,
          rakeCollected: rake,
          unionTaxPaid: hold,
          netToClub: round2(rake - hold),
          wireDirection: 'COLLECT_FROM_UNION' as const, // settled — renders as paid
        };
      }
      // Not yet settled this period: current weekly rake with the projected hold.
      const projectedHold = round2(c.weeklyRake * holdRate);
      return {
        clubId: c.clubId,
        clubName: c.clubName,
        rakeCollected: c.weeklyRake,
        unionTaxPaid: projectedHold,
        netToClub: round2(c.weeklyRake - projectedHold),
        wireDirection: 'PAY_TO_UNION' as const, // pending settlement
      };
    });

    const totalRakeCollected = round2(clubBreakdowns.reduce((s, c) => s + c.rakeCollected, 0));

    return {
      unionId,
      periodStart: start,
      periodEnd: end,
      totalClubs: clubs.length,
      totalRakeCollected,
      totalUnionTax: round2(totalHolds),
      // Agent commissions and player rakeback settle INSIDE each club
      // (agent_commissions / rake_records are club-scoped, and RLS gives an
      // agent their own rows and a union overseer only the clubs they oversee)
      // - they are not union revenue and are reported as 0 here rather than
      // fabricated.
      //
      // 2026-09-01: this named commission_records, a table dropped in phase 7
      // that never held a row. The reasoning was right; the table was not.
      totalAgentCommissions: 0,
      totalPlayerRakeback: 0,
      netUnionRevenue: round2(totalHolds + engineRake),
      clubBreakdowns,
    };
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

    /* Both totals come from the same SECURITY DEFINER union RPCs the home
       carousel card uses (a direct count here would be RLS-filtered to "members
       I may personally enumerate" - measured 593 against a true 1,172). Members
       are summed across clubs without de-duplication; active players are the
       sum of each club's seated players. `onlinePlayers` used to be a flat
       twenty percent of the member total - an invented number. */
    const [membersResult, activeResult] = await Promise.all([
      supabase.rpc('fn_batch_union_realtime_member_counts', { p_union_ids: [unionId] }),
      supabase.rpc('fn_batch_union_realtime_active_counts', { p_union_ids: [unionId] }),
    ]);
    const totalPlayers = Number((membersResult.data as any[])?.[0]?.member_count) || 0;
    const onlinePlayers = Number((activeResult.data as any[])?.[0]?.active_count) || 0;

    return {
      totalPlayers,
      totalClubs: clubs.length,
      weeklyRake: clubs.reduce((sum, c) => sum + c.weeklyRake, 0),
      onlinePlayers,
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
      // Trigger-maintained by fn_apply_union_ladder; overwritten with the live
      // RPC value in enrichWithRealtimeCounts before any caller sees it.
      memberCount: u.member_count || 0,
      // There is no unions.online_count column. Live value is filled in by
      // enrichWithRealtimeCounts from fn_batch_union_realtime_active_counts.
      onlineCount: 0,
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
