/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Club Service (ADMIN / LOW-LEVEL)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * @deprecated For frontend-facing club operations, use ClubsService instead.
 * ClubsService provides auth-gated, security-hardened equivalents of:
 *   - searchClubs   → ClubsService.search()
 *   - getClub       → ClubsService.get()
 *   - createClub    → ClubsService.create()  (with 4-club limit)
 *   - updateClub    → ClubsService.update()  (with owner verification)
 *   - deleteClub    → ClubsService.delete()  (with owner verification)
 *   - getMyClubs    → ClubsService.getUserMemberships()
 *
 * This service is retained ONLY for admin-level operations that bypass
 * auth checks: addMember, updateMemberRole, updateChipBalance, etc.
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { BBJService } from './BBJService';
import type { Club, ClubMember, ClubSettings, MemberRole } from '../types/database.types';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class ClubServiceClass {
  // ─────────────────────────────────────────────────────────────────────────────
  // CLUB CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all clubs the current user is a member of
   */
  async getMyClubs(userId: string): Promise<Club[]> {
    const { data, error } = await supabase
      .from('club_members')
      .select('club_id, clubs(*)')
      .eq('user_id', userId)
      .in('status', ['active', 'approved']);

    if (error) throw error;
    return (data || []).map((m) => m.clubs as unknown as Club);
  }

  /**
   * Get a single club by ID
   */
  async getClub(clubId: string): Promise<Club | null> {
    const { column, value } = resolveClubIdFilter(clubId);
    const { data, error } = await supabase
      .from('clubs')
      .select(
        'id, club_id, name, description, owner_id, avatar_url, banner_url, is_public, requires_approval, gps_restricted, member_count, online_count, settings, union_id, created_at, updated_at'
      )
      .eq(column, value)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  /**
   * Get club by 6-digit public ID
   */
  async getClubByPublicId(publicId: number): Promise<Club | null> {
    const { data, error } = await supabase
      .from('clubs')
      .select(
        'id, club_id, name, description, owner_id, avatar_url, banner_url, is_public, requires_approval, gps_restricted, member_count, online_count, settings, union_id, created_at, updated_at'
      )
      .eq('club_id', publicId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  /**
   * Search public clubs
   */
  async searchClubs(query: string): Promise<Club[]> {
    const { data, error } = await supabase
      .from('clubs')
      .select(
        'id, club_id, name, description, owner_id, avatar_url, banner_url, is_public, requires_approval, gps_restricted, member_count, online_count, settings, union_id, created_at, updated_at'
      )
      .eq('is_public', true)
      .ilike('name', `%${query}%`)
      .limit(20);

    if (error) throw error;
    return data || [];
  }

  /**
   * Create a new club
   */
  async createClub(
    ownerId: string,
    name: string,
    description: string,
    settings: Partial<ClubSettings> = {}
  ): Promise<Club> {
    // Generate unique 6-digit club ID with collision check
    let clubId: number;
    let attempts = 0;
    do {
      clubId = Math.floor(100000 + Math.random() * 900000);
      const { count } = await supabase
        .from('clubs')
        .select('id', { count: 'exact', head: true })
        .eq('club_id', clubId);
      if (!count || count === 0) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      throw new Error('Failed to generate unique club ID after 10 attempts');
    }

    const { data, error } = await supabase
      .from('clubs')
      .insert({
        club_id: clubId,
        name,
        description,
        owner_id: ownerId,
        settings: {
          default_rake_percent: 5,
          rake_cap: 15,
          time_bank_seconds: 30,
          allow_straddle: true,
          allow_run_it_twice: true,
          min_buy_in_bb: 40,
          max_buy_in_bb: 200,
          ...settings,
        },
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Club creation returned no data');
    await this.addMember(data.id, ownerId, 'owner');

    // Initialize BBJ pool for the new club
    const { error: poolError } = await supabase.from('bbj_pools').insert({
      club_id: data.id,
      union_id: null,
      main_balance: 0,
      backup_balance: 0,
      promo_balance: 0,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    if (poolError) {
      console.error('Failed to initialize BBJ pool for club:', poolError);
      // Log but don't fail the club creation — pool can be created later
    }

    return data;
  }

  /**
   * Update club settings
   */
  async updateClub(clubId: string, updates: Partial<Club>): Promise<Club> {
    const { data, error } = await supabase
      .from('clubs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', clubId)
      .select()
      .maybeSingle();

    if (error) throw error;
    masterBus.emit('CLUB_UPDATED', { clubId });
    return data;
  }

  /**
   * Delete a club
   */
  async deleteClub(clubId: string): Promise<boolean> {
    const { error } = await supabase.from('clubs').delete().eq('id', clubId);

    return !error;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MEMBERSHIP OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all members of a club
   */
  async getMembers(clubId: string): Promise<ClubMember[]> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data, error } = await supabase
      .from('club_members')
      .select('*')
      .eq('club_id', resolvedId)
      .order('role', { ascending: true })
      .limit(5000);

    if (error) throw error;
    if (!data || data.length === 0) return [];

    // Batch-fetch profiles separately (no FK hint needed)
    const userIds = data.map((m: any) => m.user_id);
    const profileMap: Record<string, { display_name?: string; avatar_url?: string }> = {};
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url')
        .in('id', userIds);
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p;
      }
    } catch {
      /* non-critical */
    }

    return data.map((m: any) => ({
      ...m,
      nickname: profileMap[m.user_id]?.display_name || m.nickname,
    }));
  }

  /**
   * Add a member to a club
   */
  async addMember(
    clubId: string,
    userId: string,
    role: MemberRole = 'member'
  ): Promise<ClubMember> {
    const { data, error } = await supabase
      .from('club_members')
      .insert({
        club_id: clubId,
        user_id: userId,
        role,
        status: role === 'owner' ? 'active' : 'pending',
        chip_balance: 0,
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    masterBus.emit('CLUB_UPDATED', { clubId });
    return data;
  }

  /**
   * Update member role
   */
  async updateMemberRole(clubId: string, userId: string, role: MemberRole): Promise<boolean> {
    const resolvedId = await resolveClubUUID(clubId);
    const { error } = await supabase
      .from('club_members')
      .update({ role })
      .eq('club_id', resolvedId)
      .eq('user_id', userId);

    if (!error) {
      masterBus.emit('CLUB_UPDATED', { clubId: resolvedId });
    }
    return !error;
  }

  /**
   * Update member chip balance — uses proper wallet system
   * Positive amount = credit, negative amount = debit
   */
  async updateChipBalance(clubId: string, userId: string, amount: number): Promise<boolean> {
    if (amount > 0) {
      // Credit via atomic wallet RPC + log
      const { error } = await retryAsync(
        () =>
          supabase.rpc('atomic_credit_wallet_and_log', {
            p_user_id: userId,
            p_amount: Math.trunc(amount * 100) / 100,
            p_category: 'transfer',
            p_description: 'Club balance adjustment (credit)',
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: null,
          }),
        3
      );
      if (error) return false;

      masterBus.emit('BALANCE_UPDATED', {
        source: 'club_adjustment_credit',
        userId,
      });
    } else if (amount < 0) {
      const absAmt = Math.trunc(Math.abs(amount) * 100) / 100;
      const { data: result, error } = await retryAsync(
        () =>
          supabase.rpc('atomic_deduct_wallet_and_log', {
            p_user_id: userId,
            p_amount: absAmt,
            p_category: 'transfer',
            p_description: 'Club balance adjustment (debit)',
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: null,
          }),
        3
      );
      if (error || result === false) return false;

      masterBus.emit('BALANCE_UPDATED', {
        source: 'club_adjustment_debit',
        userId,
      });
    }

    return true;
  }

  /**
   * Request to join a club
   */
  async requestJoin(clubId: string, userId: string): Promise<ClubMember> {
    const club = await this.getClub(clubId);
    if (!club) throw new Error('Club not found');

    return this.addMember(clubId, userId, 'member');
  }

  /**
   * Approve or reject a membership request
   */
  async handleMembershipRequest(clubId: string, userId: string, approved: boolean): Promise<void> {
    const resolvedId = await resolveClubUUID(clubId);
    if (approved) {
      const { error: approveErr } = await supabase
        .from('club_members')
        .update({ status: 'active' })
        .eq('club_id', resolvedId)
        .eq('user_id', userId);
      if (approveErr) throw new Error('Failed to approve membership: ' + approveErr.message);
    } else {
      const { error: rejectErr } = await supabase
        .from('club_members')
        .delete()
        .eq('club_id', resolvedId)
        .eq('user_id', userId);
      if (rejectErr) throw new Error('Failed to reject membership: ' + rejectErr.message);
    }
    masterBus.emit('CLUB_UPDATED', { clubId: resolvedId });
  }

  /**
   * Remove a member from club
   */
  async removeMember(clubId: string, userId: string): Promise<boolean> {
    const resolvedId = await resolveClubUUID(clubId);
    const { error } = await supabase
      .from('club_members')
      .delete()
      .eq('club_id', resolvedId)
      .eq('user_id', userId);

    if (!error) {
      masterBus.emit('CLUB_UPDATED', { clubId: resolvedId });
    }
    return !error;
  }

  /**
   * Get online member count for a club
   */
  async getOnlineCount(clubId: string): Promise<number> {
    // Try to get actual online count from members who were active in last 15 minutes
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const resolvedId = await resolveClubUUID(clubId);

    const { count: onlineCount, error: onlineError } = await supabase
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .eq('club_id', resolvedId)
      .in('status', ['active', 'approved'])
      .gte('last_active_at', fifteenMinAgo);

    if (!onlineError && onlineCount !== null) {
      return onlineCount;
    }

    // Fallback: estimate from total members if last_active_at not available
    const { count, error } = await supabase
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .eq('club_id', resolvedId)
      .in('status', ['active', 'approved']);

    if (error) throw error;
    return Math.floor((count || 0) * 0.15); // Conservative estimate
  }

  /**
   * Get member count by club
   */
  async getMemberCount(clubId: string): Promise<number> {
    const resolvedId = await resolveClubUUID(clubId);
    const { count, error } = await supabase
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .eq('club_id', resolvedId)
      .in('status', ['active', 'approved']);

    if (error) throw error;
    return count || 0;
  }
}

export const clubService = new ClubServiceClass();
export const ClubService = clubService;
export default clubService;
