/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Clubs Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Primary service layer for club management, discovery, and membership
 */

import { supabase, getAuthUser } from '@/lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import type {
  Club,
  ClubWithDistance,
  ClubMember,
  ClubLocation,
  ClubChallenge,
  MemberRole,
} from '@/types/club.types';

// ═══════════════════════════════════════════════════════════════════════════════
//  CLUB DISCOVERY (PostGIS)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover clubs within a specified radius using PostGIS
 * @param location User's current location
 * @param radiusKm Search radius in kilometers (default 50km)
 * @returns Clubs sorted by proximity with < 50ms latency
 */
export async function discoverNearbyClubs(
  location: ClubLocation,
  radiusKm: number = 50
): Promise<ClubWithDistance[]> {
  const { data, error } = await retryAsync(
    () =>
      supabase.rpc('fn_discover_clubs', {
        user_lat: location.latitude,
        user_lng: location.longitude,
        radius_km: radiusKm,
      }),
    3
  );

  if (error) {
    console.error('[ClubsService] Club discovery failed:', error);
    throw new Error('Failed to discover nearby clubs');
  }

  return data || [];
}

/**
 * Search clubs by name with pattern matching
 */
export async function searchClubs(query: string): Promise<Club[]> {
  const { data, error } = await supabase
    .from('clubs')
    .select(
      'id, club_id, name, slug, description, avatar_url, logo_url, banner_url, color_theme, member_count, online_count, table_count, chip_treasury, is_public, requires_approval, gps_restricted, owner_id, union_id, settings, created_at, updated_at'
    )
    .ilike('name', `%${query}%`)
    .eq('is_public', true)
    .order('member_count', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[ClubsService] Club search failed:', error);
    throw new Error('Failed to search clubs');
  }

  return data || [];
}

/**
 * Get a single club by ID or slug
 */
export async function getClub(identifier: string): Promise<Club | null> {
  // Try by ID first, then by slug
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  const { data, error } = await supabase
    .from('clubs')
    .select(
      'id, club_id, name, slug, description, avatar_url, logo_url, banner_url, color_theme, member_count, online_count, table_count, chip_treasury, is_public, requires_approval, gps_restricted, owner_id, union_id, settings, created_at, updated_at'
    )
    .eq(isUUID ? 'id' : 'slug', identifier)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    console.error('[ClubsService] Get club failed:', error);
    throw new Error('Failed to get club');
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CLUB MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new club with automatic slug generation
 */
export async function createClub(clubData: {
  name: string;
  description?: string;
  color_theme?: string;
  is_public?: boolean;
  requires_approval?: boolean;
  location?: ClubLocation;
  city?: string;
  country?: string;
}): Promise<Club> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  // ═══════════════════════════════════════════════════════════════════════
  // ENFORCE 4-CLUB LIMIT
  // ═══════════════════════════════════════════════════════════════════════
  const { count, error: countError } = await supabase
    .from('club_members')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.user.id)
    .in('status', ['active', 'approved']);

  if (countError) {
    console.error('⚠ Failed to check club membership count:', countError);
  } else if (count && count >= 4) {
    throw new Error('You can only be a member of up to 4 clubs. Leave a club to create a new one.');
  }

  // Generate URL-friendly slug
  const slug = clubData.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const { data, error } = await supabase
    .from('clubs')
    .insert({
      name: clubData.name,
      slug,
      description: clubData.description,
      color_theme: clubData.color_theme || 'royal-blue',
      is_public: clubData.is_public ?? true,
      requires_approval: clubData.requires_approval ?? false,
      owner_id: user.user.id,
    })
    .select()
    .maybeSingle();

  if (error) {
    console.error('[ClubsService] Club creation failed:', error);
    throw new Error('Failed to create club');
  }

  // Auto-join as owner
  await joinClub(data.id, 'owner');

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MEMBERSHIP MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Join a club with role assignment
 */
export async function joinClub(clubId: string, role: MemberRole = 'member'): Promise<ClubMember> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  // ═══════════════════════════════════════════════════════════════════════
  // ENFORCE 4-CLUB LIMIT (skip for owner role - already checked in createClub)
  // ═══════════════════════════════════════════════════════════════════════
  if (role !== 'owner') {
    const { count, error: countError } = await supabase
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.user.id)
      .in('status', ['active', 'approved']);

    if (countError) {
      console.error('⚠ Failed to check club membership count:', countError);
    } else if (count && count >= 4) {
      throw new Error('You can only be a member of up to 4 clubs. Leave a club to join a new one.');
    }
  }

  const resolvedId = await resolveClubUUID(clubId);
  const { data, error } = await supabase
    .from('club_members')
    .insert({
      club_id: resolvedId,
      user_id: user.user.id,
      role,
      status: 'active',
      tier: 'bronze',

      diamonds: 0,
      reputation_xp: 0,
      trust_score: 50, // Starting trust score
      rank_level: 0,
      sessions_played: 0,
      orange_ball_status: 'cold',
    })
    .select()
    .maybeSingle();

  if (error) {
    console.error('[ClubsService] Join club failed:', error);
    throw new Error('Failed to join club');
  }

  // NOTE: clubs.member_count is auto-synced by the trg_sync_club_member_count
  // trigger on INSERT to club_members. No manual increment needed.

  // Emit CLUB_JOINED for cross-page reactivity (lobby, carousel, detail pages)
  try {
    const { masterBus } = await import('../core/MasterBus');
    masterBus.emit('CLUB_JOINED', { clubId, action: 'member_joined' });
  } catch (e) {
    console.warn('[ClubsService] joinClub: bus emit failed (non-critical):', e);
  }

  return data;
}

/**
 * Leave a club — comprehensive safe-leave flow (ported from Hub leave-club.js).
 *  1. Validate membership exists
 *  2. Block if owner (must transfer ownership first)
 *  3. Cancel any pending cashout requests
 *  4. Return chip_balance to club treasury via atomic RPC
 *  5. If agent, clean up downline
 *  6. Delete membership record
 *  7. Decrement club member count
 *  8. Emit CLUB_UPDATED for real-time sync
 */
export async function leaveClub(clubId: string): Promise<void> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  const resolvedId = await resolveClubUUID(clubId);
  const userId = user.user.id;

  // 1. Get membership record
  const { data: member, error: memErr } = await supabase
    .from('club_members')
    .select('role, chip_balance, credit_used')
    .eq('club_id', resolvedId)
    .eq('user_id', userId)
    .maybeSingle();

  if (memErr || !member) {
    throw new Error('You are not a member of this club');
  }

  // 2. Block owners — must transfer ownership first
  if (member.role === 'owner') {
    throw new Error('Club owners cannot leave. Transfer ownership first.');
  }

  // 2b. Block members with outstanding credit (IOUs)
  const creditUsed = member.credit_used || 0;
  if (creditUsed > 0) {
    throw new Error(
      `Cannot leave with outstanding credit of ${creditUsed.toLocaleString()} chips. Repay credit first.`
    );
  }

  // 3. Cancel any pending cashout requests
  try {
    await supabase
      .from('cashout_requests')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('club_id', resolvedId)
      .eq('player_id', userId)
      .eq('status', 'pending');
  } catch (e: unknown) {
    console.warn('[ClubsService] leaveClub: cashout cancel failed (non-critical):', e);
  }

  // 4. Return chip_balance to club treasury (if any) — BEFORE deleting membership
  // If refund fails, throw error to prevent membership deletion (no chip loss)
  const balance = member.chip_balance || 0;
  if (balance > 0) {
    try {
      await retryAsync(
        () =>
          supabase.rpc('atomic_deduct_wallet_and_log', {
            p_user_id: userId,
            p_amount: balance,
            p_category: 'transfer',
            p_description: 'Chips returned to treasury on club departure',
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: resolvedId,
          }),
        2
      );
    } catch (err: any) {
      // CRITICAL: Fail fast — do NOT delete membership if refund fails
      console.error('[ClubsService] Failed to refund chips on leave:', err.message);
      throw new Error(`Cannot leave club: chip refund failed. ${err.message}`);
    }
  }

  // 5. If agent, clear downline references
  if (['agent', 'super_agent', 'sub_agent'].includes(member.role)) {
    try {
      await supabase
        .from('club_members')
        .update({ parent_agent_id: null })
        .eq('club_id', resolvedId)
        .eq('parent_agent_id', userId);
    } catch (e: unknown) {
      console.warn('[ClubsService] leaveClub: agent hierarchy cleanup failed (non-critical):', e);
    }
  }

  // 6. Delete membership record (only after successful refund)
  const { error } = await supabase
    .from('club_members')
    .delete()
    .eq('club_id', resolvedId)
    .eq('user_id', userId);

  if (error) {
    console.error('[ClubsService] Leave club failed:', error);
    throw new Error('Failed to leave club');
  }

  // NOTE: clubs.member_count is auto-synced by the trg_sync_club_member_count
  // trigger on DELETE from club_members. No manual decrement needed.

  // 8. Real-time sync — emit both CLUB_LEFT and CLUB_UPDATED so all listeners react
  try {
    const { masterBus } = await import('../core/MasterBus');
    masterBus.emit('CLUB_LEFT', { clubId: resolvedId, action: 'member_left' });
    masterBus.emit('CLUB_UPDATED', { clubId: resolvedId, action: 'member_left' });
  } catch (e) {
    console.warn('[ClubsService] leaveClub: bus emit failed (non-critical):', e);
  }
}

/**
 * Get user's club memberships — enriched with LIVE member counts.
 * Accepts an optional pre-resolved user to avoid redundant getAuthUser() calls.
 * This avoids redundant auth lookups when the caller already has the user.
 */
export async function getUserMemberships(
  preResolvedUser?: { id: string } | null
): Promise<(ClubMember & { club: Club })[]> {
  let userId: string;
  if (preResolvedUser?.id) {
    userId = preResolvedUser.id;
  } else {
    const { data: user } = await getAuthUser();
    if (!user.user) return [];
    userId = user.user.id;
  }

  const { data, error } = await supabase
    .from('club_members')
    .select(
      `
      club_id, user_id, role, status, tier, chip_balance, credit_used, diamonds, reputation_xp, trust_score, rank_level, sessions_played, orange_ball_status, joined_at, parent_agent_id, hands_played, chips_won, chips_lost, total_rake_paid,
      club:clubs(id, club_id, name, slug, description, avatar_url, logo_url, banner_url, color_theme, member_count, table_count, chip_treasury, is_public, requires_approval, owner_id, union_id, settings, created_at, updated_at)
    `
    )
    .eq('user_id', userId);

  if (error) {
    console.error('[ClubsService] Get memberships failed:', error);
    throw new Error('Failed to get memberships');
  }

  const memberships = (data || []) as unknown as (ClubMember & { club: Club })[];

  // Enrich with LIVE member counts via grouped-count RPC
  // The clubs.member_count column is a denormalized counter that can go stale
  if (memberships.length > 0) {
    const clubIds = memberships.map((m) => (m.club as any)?.id).filter(Boolean) as string[];

    if (clubIds.length > 0) {
      try {
        // RPC returns {club_id, member_count} grouped — 1 row per club instead of N rows
        const { data: counts } = await supabase.rpc('fn_batch_club_member_counts', {
          p_club_ids: clubIds,
        });
        const countMap = new Map<string, number>();
        for (const row of counts || []) {
          countMap.set(row.club_id, Number(row.member_count));
        }

        // Override stale member_count with live count
        for (const m of memberships) {
          const club = m.club as any;
          if (club?.id && countMap.has(club.id)) {
            club.member_count = countMap.get(club.id);
          }
        }
      } catch (e) {
        console.warn('[ClubsService] Live member count enrichment failed (using stale counts):', e);
      }
    }
  }

  return memberships;
}

/**
 * Get club members with profiles
 */
export async function getClubMembers(clubId: string): Promise<ClubMember[]> {
  const resolvedId = await resolveClubUUID(clubId);
  const { data, error } = await supabase
    .from('club_members')
    .select(
      'club_id, user_id, role, status, tier, chip_balance, credit_used, diamonds, reputation_xp, trust_score, rank_level, sessions_played, orange_ball_status, joined_at, parent_agent_id, hands_played, chips_won, chips_lost, total_rake_paid'
    )
    .eq('club_id', resolvedId)
    .order('reputation_xp', { ascending: false })
    .limit(QUERY_LIMITS.MODERATE);

  if (error) {
    console.error('[ClubsService] Get club members failed:', error);
    throw new Error('Failed to get club members');
  }

  // Batch-fetch profiles (no FK between club_members → profiles)
  const members = data || [];
  if (members.length > 0) {
    const userIds = members.map((m: any) => m.user_id);
    const profileMap: Record<string, any> = {};
    const chunkSize = 150;
    for (let i = 0; i < userIds.length; i += chunkSize) {
      const chunk = userIds.slice(i, i + chunkSize);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .in('id', chunk);
      if (profiles) {
        for (const p of profiles) profileMap[p.id] = p;
      }
    }
    for (const m of members) {
      (m as any).profile = profileMap[(m as any).user_id] || null;
    }
  }

  return members;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHALLENGES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get active challenges for a club
 */
export async function getClubChallenges(clubId: string): Promise<ClubChallenge[]> {
  const resolvedId = await resolveClubUUID(clubId);
  const { data, error } = await supabase
    .from('club_challenges')
    .select(
      'id, club_id, title, description, type, target_value, current_value, reward_type, reward_amount, reward_chips, starts_at, ends_at, status, is_active, created_at'
    )
    .eq('club_id', resolvedId)
    .eq('status', 'active')
    .order('ends_at', { ascending: true });

  if (error) {
    console.error('[ClubsService] Get challenges failed:', error);
    throw new Error('Failed to get challenges');
  }

  return data || [];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STATS & LEADERBOARDS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get club leaderboard
 */
export async function getClubLeaderboard(
  clubId: string,
  period: 'daily' | 'weekly' | 'monthly' | 'all_time' = 'weekly'
): Promise<ClubMember[]> {
  const resolvedId = await resolveClubUUID(clubId);
  const { data, error } = await supabase
    .from('club_members')
    .select(
      'club_id, user_id, role, status, tier, chip_balance, credit_used, diamonds, reputation_xp, trust_score, rank_level, sessions_played, orange_ball_status, joined_at, parent_agent_id, hands_played, chips_won, chips_lost, total_rake_paid'
    )
    .eq('club_id', resolvedId)
    .order('reputation_xp', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[ClubsService] Get leaderboard failed:', error);
    throw new Error('Failed to get leaderboard');
  }

  // Batch-fetch profiles (no FK between club_members → profiles)
  const members = data || [];
  if (members.length > 0) {
    const userIds = members.map((m: any) => m.user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, avatar_url')
      .in('id', userIds);
    const profileMap: Record<string, any> = {};
    if (profiles) {
      for (const p of profiles) profileMap[p.id] = p;
    }
    for (const m of members) {
      (m as any).profile = profileMap[(m as any).user_id] || null;
    }
  }

  return members;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLUB DELETION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Delete a club (owner only)
 * Removes all members first, then deletes the club
 */
export async function deleteClub(clubId: string): Promise<void> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  // Resolve to UUID first — clubId from URL may be integer (e.g., "25450")
  const resolvedId = await resolveClubUUID(clubId);

  // Verify ownership
  const { data: club, error: clubError } = await supabase
    .from('clubs')
    .select('owner_id')
    .eq('id', resolvedId)
    .maybeSingle();

  if (clubError || !club) {
    throw new Error('Club not found');
  }

  if (club.owner_id !== user.user.id) {
    throw new Error('Only the owner can delete this club');
  }

  // Delete all members first (cascade should handle this, but explicit is safer)
  const { error: memberErr } = await supabase
    .from('club_members')
    .delete()
    .eq('club_id', resolvedId);
  if (memberErr) {
    console.error('[ClubsService] Failed to remove members before club delete:', memberErr);
    throw new Error('Failed to remove club members');
  }

  // Delete the club
  const { error } = await supabase.from('clubs').delete().eq('id', resolvedId);

  if (error) {
    console.error('[ClubsService] Delete club failed:', error);
    throw new Error('Failed to delete club');
  }

  // Emit bus events so all open lobby/carousel tabs refresh immediately
  try {
    const { masterBus } = await import('../core/MasterBus');
    masterBus.emit('CLUB_LEFT', { clubId, action: 'club_deleted' });
    masterBus.emit('CLUB_UPDATED', { clubId, action: 'club_deleted' });
  } catch (e) {
    console.warn('[ClubsService] deleteClub: bus emit failed (non-critical):', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ✏️ CLUB UPDATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update club settings
 */
export async function updateClub(clubId: string, updates: Record<string, any>): Promise<Club> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  // Resolve to UUID first — clubId from URL may be integer (e.g., "25450")
  const resolvedId = await resolveClubUUID(clubId);

  // SECURITY: Verify caller is club owner before allowing any updates.
  // RLS provides a backend safety net, but defense-in-depth is essential
  // since updateClub accepts arbitrary field updates.
  const { data: club, error: clubErr } = await supabase
    .from('clubs')
    .select('owner_id')
    .eq('id', resolvedId)
    .maybeSingle();

  if (clubErr || !club) {
    throw new Error('Club not found');
  }

  if (club.owner_id !== user.user.id) {
    console.error(
      `[ClubsService] Unauthorized updateClub attempt by ${user.user.id} on club ${clubId}`
    );
    throw new Error('Only the club owner can update club settings');
  }

  // Whitelist allowed update fields to prevent arbitrary column injection
  const ALLOWED_FIELDS = [
    'name',
    'description',
    'slug',
    'is_public',
    'requires_approval',
    'color_theme',
    'avatar_url',
    'banner_url',
    'settings',
    // Game settings — critical for ClubDetailPage settings tab
    'default_rake_percent',
    'rake_cap',
    'min_buyin_bb',
    'max_buyin_bb',
    'time_bank_seconds',
    'allow_straddle',
    'allow_run_it_twice',
    'allow_rabbit_hunt',
  ];
  const sanitizedUpdates: Record<string, any> = {};
  for (const key of Object.keys(updates)) {
    if (ALLOWED_FIELDS.includes(key)) {
      sanitizedUpdates[key] = updates[key];
    }
  }

  if (Object.keys(sanitizedUpdates).length === 0) {
    throw new Error('No valid fields to update');
  }

  const { data, error } = await supabase
    .from('clubs')
    .update(sanitizedUpdates)
    .eq('id', resolvedId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[ClubsService] Update club failed:', error);
    throw new Error('Failed to update club');
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🖼️ LOGO UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upload club logo to Supabase Storage
 * @param clubId Club ID to update
 * @param file File to upload (from input or drag-drop)
 * @returns URL of the uploaded logo
 */
export async function uploadClubLogo(clubId: string, file: File): Promise<string> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Invalid file type. Please upload JPEG, PNG, GIF, or WebP');
  }

  // Validate file size (max 2MB)
  const maxSize = 2 * 1024 * 1024;
  if (file.size > maxSize) {
    throw new Error('File too large. Maximum size is 2MB');
  }

  // Generate unique filename
  const fileExt = file.name.split('.').pop();
  const fileName = `${clubId}/logo-${Date.now()}.${fileExt}`;

  // Upload to Supabase Storage
  const { data, error } = await supabase.storage.from('club-assets').upload(fileName, file, {
    cacheControl: '3600',
    upsert: true,
  });

  if (error) {
    console.error('[ClubsService] Logo upload failed:', error);
    throw new Error('Failed to upload logo');
  }

  // Get public URL
  const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(data.path);

  const logoUrl = urlData.publicUrl;

  // Update club record with new logo URL
  const resolvedId = await resolveClubUUID(clubId);
  const { error: updateErr } = await supabase
    .from('clubs')
    .update({ avatar_url: logoUrl })
    .eq('id', resolvedId);
  if (updateErr) {
    console.error('[ClubsService] Logo uploaded but failed to save URL to club record:', updateErr);
    throw new Error('Logo uploaded but failed to save — please try again');
  }

  return logoUrl;
}

/**
 * Upload club banner/cover image
 */
export async function uploadClubBanner(clubId: string, file: File): Promise<string> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Invalid file type. Please upload JPEG, PNG, or WebP');
  }

  // Validate file size (max 5MB for banners)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    throw new Error('File too large. Maximum size is 5MB');
  }

  // Generate unique filename
  const fileExt = file.name.split('.').pop();
  const fileName = `${clubId}/banner-${Date.now()}.${fileExt}`;

  // Upload to Supabase Storage
  const { data, error } = await supabase.storage.from('club-assets').upload(fileName, file, {
    cacheControl: '3600',
    upsert: true,
  });

  if (error) {
    console.error('[ClubsService] Banner upload failed:', error);
    throw new Error('Failed to upload banner');
  }

  // Get public URL
  const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(data.path);

  const bannerUrl = urlData.publicUrl;

  // Update club record with new banner URL
  const resolvedId = await resolveClubUUID(clubId);
  const { error: updateErr } = await supabase
    .from('clubs')
    .update({ banner_url: bannerUrl })
    .eq('id', resolvedId);
  if (updateErr) {
    console.error(
      '[ClubsService] Banner uploaded but failed to save URL to club record:',
      updateErr
    );
    throw new Error('Banner uploaded but failed to save — please try again');
  }

  return bannerUrl;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔢 CLUB LIMIT CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if user can join/create more clubs (max 4 clubs per user)
 * @returns Object with canJoin boolean and current club count
 */
export async function canJoinMoreClubs(): Promise<{
  canJoin: boolean;
  currentCount: number;
  maxClubs: number;
}> {
  const MAX_CLUBS = 4;

  const { data: user } = await getAuthUser();
  if (!user.user) return { canJoin: false, currentCount: 0, maxClubs: MAX_CLUBS };

  const { count, error } = await supabase
    .from('club_members')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.user.id)
    .in('status', ['active', 'approved']);

  if (error) {
    console.error('⚠ Failed to check club membership count:', error);
    return { canJoin: true, currentCount: 0, maxClubs: MAX_CLUBS }; // Allow on error
  }

  const currentCount = count || 0;
  return {
    canJoin: currentCount < MAX_CLUBS,
    currentCount,
    maxClubs: MAX_CLUBS,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔢 LIVE MEMBER COUNT — 3-tier fallback (direct count → RPC → stale column)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the LIVE member count for a club.
 *
 * Strategy (3-tier fallback):
 *   1. Direct COUNT(*) from club_members via PostgREST — works when RLS allows
 *      (user is a club member, or service role key is used).
 *   2. SECURITY DEFINER RPC fn_get_club_member_count — bypasses RLS for
 *      non-members (requires migration to be deployed).
 *   3. Denormalized clubs.member_count column — last resort (may be stale,
 *      but auto-synced by trg_sync_club_member_count trigger once deployed).
 */
export async function getLiveMemberCount(clubId: string): Promise<number> {
  const resolvedId = await resolveClubUUID(clubId);

  // ── Tier 1: Direct count from club_members (works if RLS permits) ──
  try {
    const { count, error } = await supabase
      .from('club_members')
      .select('*', { count: 'exact', head: true })
      .eq('club_id', resolvedId)
      .in('status', ['active', 'approved']);

    if (!error && typeof count === 'number' && count > 0) {
      return count;
    }
    // count === 0 might mean RLS filtered everything — fall through to Tier 2
  } catch (e) {
    console.warn('[ClubsService] getLiveMemberCount direct count failed:', e);
  }

  // ── Tier 2: SECURITY DEFINER RPC (bypasses RLS) ──
  try {
    const { data, error } = await supabase.rpc('fn_get_club_member_count', {
      p_club_id: resolvedId,
    });

    if (!error && typeof data === 'number') {
      return data;
    }
    // RPC not deployed yet — fall through to Tier 3
  } catch (e) {
    // Silently fall through
  }

  // ── Tier 3: Denormalized clubs.member_count (may be stale) ──
  try {
    const { data: club } = await supabase
      .from('clubs')
      .select('member_count')
      .eq('id', resolvedId)
      .maybeSingle();
    return club?.member_count || 0;
  } catch {
    return 0;
  }
}

// Export service object for cleaner imports
export const ClubsService = {
  discoverNearby: discoverNearbyClubs,
  search: searchClubs,
  get: getClub,
  create: createClub,
  update: updateClub,
  join: joinClub,
  leave: leaveClub,
  delete: deleteClub,
  getUserMemberships,
  getMembers: getClubMembers,
  getChallenges: getClubChallenges,
  getLeaderboard: getClubLeaderboard,
  uploadLogo: uploadClubLogo,
  uploadBanner: uploadClubBanner,
  updateClub,
  canJoinMoreClubs,
  getLiveMemberCount,
};
