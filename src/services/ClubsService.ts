/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Clubs Service
 * ═══════════════════════════════════════════════════════════════════════════════
 * Primary service layer for club management, discovery, and membership
 */

import { supabase, getAuthUser } from '@/lib/supabase';
import { getWarmMemberships, rememberWarmMemberships } from '../lib/membershipWarmState';
export { clearMembershipsWarmCache } from '../lib/membershipWarmState';
import { retryAsync } from '../utils/retryAsync';
import { PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { retryFetch } from '../utils/retryFetch';
import { sanitizeInput } from '../utils/sanitizeInput';
import { escapeIlikePattern } from '../utils/clubSlug';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
import { ClubCardGenerator } from './ClubCardGenerator';
import { cashoutService } from './CashoutService';

// Module-level circuit breaker — resets after 5 min cooldown
const _membershipBreaker = (() => {
  let failures = 0,
    trippedAt = 0;
  return {
    isOpen(): boolean {
      if (failures < 3) return false;
      if (Date.now() - trippedAt > 5 * 60_000) {
        failures = 0;
        trippedAt = 0;
        return false;
      }
      return true;
    },
    trip(): void {
      failures++;
      if (failures >= 3 && trippedAt === 0) trippedAt = Date.now();
    },
  };
})();
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
  // Round 19: prod fn_discover_clubs is search-based, not lat/lng/radius
  // (signatures: (p_search, p_limit) and (p_search, p_limit, p_offset)).
  // The location-based discover doesn't exist in production. Until a real
  // PostGIS-backed location RPC ships, fall back to a search-based discover
  // and let the caller order/filter client-side. location + radiusKm are
  // accepted to keep the public API stable but only used for client-side
  // distance annotation when the clubs table grows lat/lng columns.
  void location; // kept for future PostGIS upgrade
  void radiusKm;
  const { data, error } = await retryAsync(
    () =>
      supabase.rpc('fn_discover_clubs', {
        p_search: '',
        p_limit: 50,
        p_offset: 0,
      }),
    3
  );

  if (error) {
    reportError(error, 'ClubsService.Club_discovery_failed');
    throw new Error('Failed to discover nearby clubs');
  }

  return (data as ClubWithDistance[]) || [];
}

/**
 * Search clubs by name with pattern matching
 */
export async function searchClubs(query: string): Promise<Club[]> {
  const { data, error } = await supabase
    .from('clubs')
    .select(
      'id, club_id, name, slug, description, avatar_url, logo_url, banner_url, color_theme, member_count, online_count, table_count, chip_treasury, is_public, requires_approval, gps_restricted, owner_id, union_id, settings, created_at, updated_at, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
    )
    /* `%` and `_` are ilike WILDCARDS. Interpolated raw, a search for "100%"
       matched every club and "a_b" matched "axb". The escaper is already in
       this file and already used a hundred lines down. */
    .ilike('name', `%${escapeIlikePattern(query)}%`)
    .eq('is_public', true)
    .order('member_count', { ascending: false })
    .limit(20);

  if (error) {
    reportError(error, 'ClubsService.Club_search_failed');
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
      'id, club_id, name, slug, description, avatar_url, logo_url, banner_url, color_theme, member_count, online_count, table_count, chip_treasury, is_public, requires_approval, gps_restricted, owner_id, union_id, settings, created_at, updated_at, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
    )
    .eq(isUUID ? 'id' : 'slug', identifier)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    reportError(error, 'ClubsService.Get_club_failed');
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
export interface CreateClubData {
  request_id?: string;
  name: string;
  description?: string;
  color_theme?: string;
  is_public?: boolean;
  requires_approval?: boolean;
  location?: ClubLocation;
  city?: string;
  country?: string;
  logoPreview?: string | null;
  /** Stable published asset URL for a curated placeholder crest. */
  logoUrl?: string | null;
}

export async function createClub(clubData: CreateClubData): Promise<Club> {
  const { data: user } = await getAuthUser();
  if (!user.user) throw new Error('Authentication required');

  // Sanitize inputs
  const safeName = sanitizeInput(clubData.name.trim());
  const safeDescription = clubData.description
    ? sanitizeInput(clubData.description.trim())
    : undefined;

  // Name validation (matches CreateClubPage rules)
  if (!safeName || safeName.length < 3) {
    throw new Error('Club name must be at least 3 characters.');
  }
  if (safeName.length > 30) {
    throw new Error('Club name must be 30 characters or less.');
  }

  const isPublic = clubData.is_public ?? true;
  // Persisted by the modal with its draft so a retry after a lost response
  // resolves the original transaction instead of creating a second club.
  const requestId = clubData.request_id || crypto.randomUUID();

  // ── Step 1: Upload raw logo to storage ──────────────────────────────
  let logoUrl: string | null = clubData.logoUrl || null;
  let uploadedLogoPath: string | null = null;
  if (clubData.logoPreview) {
    try {
      const logoResponse = await fetch(clubData.logoPreview);
      if (!logoResponse.ok) throw new Error('The selected logo could not be read.');
      const logoBlob = await logoResponse.blob();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(logoBlob.type)) {
        throw new Error('Club logos must be PNG, JPG, or WEBP images.');
      }
      if (logoBlob.size > 2 * 1024 * 1024) {
        throw new Error('The optimized club logo must be 2MB or smaller.');
      }
      const logoExt =
        logoBlob.type === 'image/png' ? 'png' : logoBlob.type === 'image/webp' ? 'webp' : 'jpg';
      const logoFileName = `club-logos/${user.user.id}/${requestId}.${logoExt}`;

      const { data: logoUploadData, error: logoUploadError } = await supabase.storage
        .from('club-assets')
        .upload(logoFileName, logoBlob, {
          contentType: logoBlob.type || 'image/png',
          // Replaying the same request must be safe before its RPC runs too.
          upsert: true,
        });
      if (logoUploadError || !logoUploadData) {
        if (logoUploadError) reportError(logoUploadError, 'ClubsService.createClub.LogoUpload');
        throw new Error('Custom Logo Could Not Be Uploaded. Please Try Again.');
      }
      uploadedLogoPath = logoFileName;
      const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(logoFileName);
      logoUrl = urlData?.publicUrl || null;
    } catch (e) {
      reportError(e, 'ClubsService.createClub.LogoUpload');
      throw new Error(
        e instanceof Error && e.message === 'Custom Logo Could Not Be Uploaded. Please Try Again.'
          ? e.message
          : 'The Selected Logo Could Not Be Prepared. Please Choose Another Image.'
      );
    }
  }

  // The RPC serializes this user's creates and commits the club, owner row,
  // and idempotency key as one transaction.
  const { data: rpcData, error: createError } = await supabase.rpc('fn_create_club_atomic', {
    p_request_id: requestId,
    p_name: safeName,
    p_description: safeDescription ?? null,
    p_color_theme: clubData.color_theme || 'royal-blue',
    p_is_public: isPublic,
    p_requires_approval: clubData.requires_approval ?? false,
    p_logo_url: logoUrl,
  });
  if (createError || !rpcData) {
    reportError(createError, 'ClubsService.Club_creation_failed');
    const definitiveRejection = new Set(['22023', '23505', '23514', '28000', 'P0001']).has(
      createError?.code || ''
    );
    // An empty/transport code is an ambiguous outcome: the transaction may
    // have committed before its response was lost, so preserve its logo for
    // the idempotent retry instead of deleting a live club's asset.
    if (uploadedLogoPath && definitiveRejection) {
      const { error: cleanupError } = await supabase.storage
        .from('club-assets')
        .remove([uploadedLogoPath]);
      if (cleanupError) reportError(cleanupError, 'ClubsService.createClub.OrphanLogoCleanup');
    }
    const message = createError?.message || 'Failed to create club';
    if (/already exists|duplicate|unique/i.test(message)) {
      throw new Error('A club with this name already exists. Please choose a different name.');
    }
    if (/only be a member of up to 4 clubs|four-club allowance/i.test(message)) {
      throw new Error('Your Four-Club Allowance Is Full. Leave A Club Before Creating Another.');
    }
    if (/temporarily unavailable/i.test(message)) {
      throw new Error('Club Creation Is Temporarily Unavailable. Please Try Again Soon.');
    }
    throw new Error('Club Could Not Be Created. Your Details Are Still Here. Please Try Again.');
  }
  const data = rpcData as Club & { card_image_url?: string };

  // ── Step 3: Generate baked card with REAL club_id ────────────────────
  if (logoUrl || clubData.logoPreview) {
    try {
      const { dataUrl, format } = await ClubCardGenerator.generateCard({
        logoUrl: logoUrl || (clubData.logoPreview as string),
        clubId: data.club_id,
        clubName: safeName.toUpperCase(),
      });

      const cardBlob = await fetch(dataUrl).then((r) => r.blob());
      const ext = format === 'webp' ? 'webp' : 'png';
      const contentType = format === 'webp' ? 'image/webp' : 'image/png';
      const cardFileName = `club-cards/${data.club_id}-card-v2.${ext}`;

      const { data: cardUploadData, error: cardUploadError } = await supabase.storage
        .from('club-assets')
        .upload(cardFileName, cardBlob, { contentType, upsert: true });

      if (!cardUploadError && cardUploadData) {
        const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(cardFileName);
        if (urlData?.publicUrl) {
          await supabase
            .from('clubs')
            .update({ card_image_url: urlData.publicUrl })
            .eq('id', data.id);
          data.card_image_url = urlData.publicUrl;
        }
      }
    } catch (cardErr) {
      reportError(cardErr, 'ClubsService.createClub.CardGeneration');
    }
  }

  // Creation already committed the owner membership. Notify every live view.
  try {
    const { masterBus } = await import('../core/MasterBus');
    masterBus.emit('CLUB_JOINED', {
      clubId: data.id,
      clubName: data.name,
      action: 'member_joined',
    });
  } catch (eventError) {
    reportError(eventError, 'ClubsService.createClub.BusEmit');
  }

  return data;
}

export async function checkClubNameAvailability(name: string): Promise<boolean> {
  const safeName = sanitizeInput(name.trim());
  if (safeName.length < 3 || safeName.length > 30) return false;
  const { data, error } = await supabase.rpc('fn_club_name_available', { p_name: safeName });
  if (error) throw new Error('Could not check club name availability.');
  return data === true;
}

export async function getClubCreationEligibility(): Promise<{
  canCreate: boolean;
  membershipCount: number;
  maxClubs: number | null;
  remaining: number | null;
}> {
  const { data, error } = await supabase.rpc('fn_get_club_creation_eligibility');
  if (error || !data || typeof data !== 'object') {
    throw new Error('Could not verify your club allowance. Please try again.');
  }
  const result = data as Record<string, unknown>;
  return {
    canCreate: result.can_create === true,
    membershipCount: Number(result.membership_count) || 0,
    maxClubs: result.limit === null ? null : Number(result.limit),
    remaining: result.remaining === null ? null : Number(result.remaining),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MEMBERSHIP MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Every localStorage spelling an invite code may be sitting under for one club.
 *
 * Callers park the code before they know the club's UUID — InvitePage has a
 * slug, ClubsPage has the six-digit club_id — so the code can be under either
 * spelling. Read both, and clear both: leaving the other one behind is how a
 * code outlives its redemption and re-fires on the next club the user joins.
 */
export function inviteCodeKeys(...clubIds: (string | undefined | null)[]): string[] {
  return Array.from(
    new Set(clubIds.filter((id): id is string => !!id).map((id) => `referral_${id}`))
  );
}

/** Park an invite code until the user is a member and it can be redeemed. */
export function rememberInviteCode(clubId: string, code: string): void {
  if (typeof window === 'undefined' || !code) return;
  try {
    window.localStorage.setItem(`referral_${clubId}`, code);
  } catch (e) {
    reportError(e, 'ClubsService.rememberInviteCode');
  }
}

/**
 * Redeem whatever invite code is parked for this club, and return the
 * membership AS IT STANDS AFTERWARDS.
 *
 * The return value is the whole point. Redemption is what attaches the upline
 * agent and what admits an invited player into an approval-gated club, so a
 * caller that keeps the row it read before this ran is holding a row the
 * database has already replaced.
 *
 * Safe to call more than once and safe to call with nothing parked — both are
 * a no-op that hands back the membership untouched.
 */
export async function redeemStoredInviteCode(
  membership: ClubMember,
  resolvedId: string,
  rawClubId: string,
  userId: string
): Promise<ClubMember> {
  if (typeof window === 'undefined') return membership;

  const keys = inviteCodeKeys(resolvedId, rawClubId);
  let storedCode: string | null = null;
  for (const key of keys) {
    if (!storedCode) storedCode = window.localStorage.getItem(key);
  }
  if (!storedCode) return membership;

  const forget = () => keys.forEach((key) => window.localStorage.removeItem(key));

  try {
    const { AgentService } = await import('./AgentService');
    const res = await AgentService.linkPlayerByReferral(userId, storedCode, resolvedId);

    if (res.success) {
      forget();
      // fn_redeem_club_invite_code returns the row it wrote. Prefer it over the
      // pre-redemption copy in every field it reports on.
      return {
        ...membership,
        status: res.status ?? membership.status,
        agent_id: res.agentId ?? membership.agent_id,
      };
    }

    // 'not_a_member' means the membership row is not visible to the RPC yet —
    // replica lag, or a join that has not landed. Keep the code so the next
    // arrival can still spend it; this is the one failure worth retrying.
    if (res.code === 'not_a_member') return membership;

    // Still pending means redemption did not admit them, so this is a request
    // an owner can still reject. A platform referral credit is unrecoverable
    // once spent, so it must not fire here — leave the code parked until the
    // membership settles. (Guarded since the 2026-08-20 audit; the check moved
    // here when redemption started deciding the returned status.)
    if (membership.status === 'pending') return membership;

    forget();

    // The code matched no club invite. It may still be a platform-wide referral
    // code, which is a different system — try it once, best-effort.
    const { referralService } = await import('./ReferralService');
    referralService
      .redeemCode(userId, storedCode)
      .catch((e) => reportError(e, 'ClubsService.joinClub_referral_redeem'));
  } catch (e) {
    // A thrown error is a transport failure, not a verdict on the code — keep
    // it parked so the next attempt can redeem it.
    reportError(e, 'ClubsService.joinClub_referral');
  }

  return membership;
}

/**
 * Join a club with role assignment
 */
export async function joinClub(
  clubId: string,
  role: MemberRole = 'member',
  knownClubName?: string
): Promise<ClubMember> {
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
      reportError(countError, 'ClubsService._Failed_to_check_club_membership_count');
    } else if (count && count >= 4) {
      throw new Error('You can only be a member of up to 4 clubs. Leave a club to join a new one.');
    }
  }

  const resolvedId = await resolveClubUUID(clubId);

  // Join via the SECURITY DEFINER RPC fn_join_club. The RPC resolves the caller
  // from auth.uid() and decides the effective role/status itself:
  //   • caller owns the club  → role='owner',  status='active'
  //   • otherwise             → role='member', status = requires_approval
  //                             ? 'pending' : 'active'
  // It also re-enforces the 4-club limit and is idempotent (an existing
  // membership row is returned unchanged). Because it is SECURITY DEFINER it
  // bypasses the club_members RLS INSERT policy that (correctly) forbids
  // privileged self-inserts. The `role` argument is retained for API
  // compatibility but is no longer authoritative — the RPC owns that decision.
  const { data, error } = await supabase.rpc('fn_join_club', {
    p_club_id: resolvedId,
  });

  if (error || !data) {
    reportError(error, 'ClubsService.Join_club_failed');
    throw new Error(error?.message || 'Failed to join club');
  }

  if (data && typeof data === 'object' && 'error' in data) {
    reportError(new Error(data.error), 'ClubsService.Join_club_failed_RPC');
    throw new Error(data.error);
  }

  // ── Redeem the invite code that brought this user here ───────────────────
  // fn_redeem_club_invite_code does two things: it attaches the upline agent,
  // and — for an approval-gated club — it promotes the 'pending' row that
  // fn_join_club just wrote into a real membership. So `membership` below is
  // deliberately reassigned from what redemption leaves behind.
  //
  // It used to be `const`, and that was the bug the user saw. Every live club
  // has requires_approval = true, so fn_join_club always returns 'pending'; the
  // redemption then flipped the database row to 'active' and joinClub returned
  // the stale pre-redemption object anyway. Both callers branch on
  // `membership.status === 'pending'` to decide between "welcome, come in" and
  // an approval wall, so an invited player was parked on "pending owner
  // approval" forever while the database already had them fully active. One
  // stale variable, and invite links did not work for anyone.
  let membership = data as ClubMember;
  membership = await redeemStoredInviteCode(membership, resolvedId, clubId, user.user.id);

  // Emit CLUB_JOINED for cross-page reactivity (lobby, carousel, detail pages).
  // Harmless for pending joins — listeners simply re-fetch memberships.
  try {
    const { masterBus } = await import('../core/MasterBus');
    /* THE RESOLVED UUID, LIKE EVERY OTHER EMIT.
       This one sent the raw caller argument while leaveClub sends the resolved
       id, and two consumers compare the value by identity: MasterBus registers
       its realtime channel under `club:${clubId}` on JOIN and unsubscribes
       `club:${clubId}` on LEAVE - join by club code then leave, and the key
       never matches, so LEAVE_CLUB is never sent to the engine and the
       listeners leak for the session. ClubHomePage compares it against the
       club it is showing, so a CLUB_UPDATED carrying the other spelling never
       refreshed the lobby. One spelling, everywhere. */
    // We need the club name for the push notification to display something friendly instead of a UUID
    let cName = knownClubName || '';
    if (!cName) {
      try {
        const { data: cData } = await supabase
          .from('clubs')
          .select('name')
          .eq('id', resolvedId)
          .maybeSingle();
        if (cData?.name) cName = cData.name;
      } catch (e) {
        /* ignore */
      }
    }
    masterBus.emit('CLUB_JOINED', { clubId: resolvedId, clubName: cName, action: 'member_joined' });
  } catch (e) {
    console.warn('[ClubsService] joinClub: bus emit failed (non-critical):', e);
  }

  return membership;
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

  /* 3. Cancel any pending cashout requests.
   *
   * This used to be a direct `.update({ status: 'cancelled' })` on
   * cashout_requests. On 2026-08-25 the migration
   * `20260825_role_scoped_cashier_agent_wallet_and_cashout_escrow` dropped the
   * `cashout_update` policy that had made that write possible, because it also
   * let a player set status to 'approved' on their own request. Every write now
   * goes through a SECURITY DEFINER function. This caller was not updated with
   * it, so the statement survived as a NO-OP: RLS with no UPDATE policy does not
   * raise, it matches zero rows, and PostgREST answers 200. The try/catch could
   * never fire, and `leaveClub` reported success either way.
   *
   * What that cost, when a leaver had a pending cashout: the request stayed
   * 'pending', the chip_escrow row stayed unreleased, so the escrowed chips were
   * never added back to chip_balance and therefore were NOT included in the
   * treasury return at step 4 either. Then step 6 deleted the membership. The
   * chips existed only as an orphan escrow row belonging to a non-member.
   *
   * fn_cashout_release is the one path that actually returns them: it credits
   * club_members.chip_balance, marks the escrow released and writes the ledger
   * row, in one transaction. It must run BEFORE step 4 so the returned chips are
   * part of the balance that goes back to the treasury.
   *
   * A failure here is NOT non-critical and is no longer swallowed. If the chips
   * cannot be brought back out of escrow, leaving would strand them, so we stop
   * and say so rather than completing a departure that loses money. */
  const { data: pendingCashouts, error: pendingErr } = await supabase
    .from('cashout_requests')
    .select('id')
    .eq('club_id', resolvedId)
    .eq('player_id', userId)
    .eq('status', 'pending');

  if (pendingErr) {
    reportError(pendingErr, 'ClubsService.leaveClub.pendingCashouts', { clubId: resolvedId });
    throw new Error(
      'Could not check whether you have a cash out waiting, so leaving was stopped. Try again.'
    );
  }

  for (const row of pendingCashouts ?? []) {
    // Throws on refusal. cancelCashout reads the RPC's {success,error} envelope,
    // so a refusal arrives as an Error and not as a silent success.
    await cashoutService.cancelCashout(row.id, userId);
  }

  // 4. If agent, clear downline references (before removing membership)
  if (['agent', 'super_agent', 'sub_agent'].includes(member.role)) {
    try {
      await supabase
        .from('club_members')
        .update({ agent_id: null })
        .eq('club_id', resolvedId)
        .eq('agent_id', userId);
    } catch (e: unknown) {
      console.warn('[ClubsService] leaveClub: agent hierarchy cleanup failed (non-critical):', e);
    }
  }

  // 5. Atomically move the member's club chips into the club treasury
  //    (clubs.chip_treasury — the balance shown as the club "bank") and remove
  //    the membership in a single SECURITY DEFINER transaction. Club money tables
  //    are service-role-write-only under RLS, and the two steps must not be able
  //    to strand chips. This replaces the old flow that DEBITED the player's main
  //    wallet (wrong account and direction) and then deleted the membership
  //    regardless of whether the debit RPC returned false.
  const { data: leaveResult, error: leaveErr } = await retryAsync(
    () =>
      supabase.rpc('fn_member_leave_to_treasury', {
        p_club_id: resolvedId,
        p_user_id: userId,
      }),
    2
  );

  if (leaveErr) {
    reportError(leaveErr, 'ClubsService.Leave_club_failed');
    throw new Error('Failed to leave club - please try again');
  }
  if (!leaveResult?.success) {
    const reason = leaveResult?.error || 'unknown error';
    reportError(new Error(reason), 'ClubsService.Leave_club_rejected');
    throw new Error(`Cannot leave club: ${reason}`);
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
/**
 * In-flight de-duplication for the lobby's first query.
 *
 * PERF 2026-08-23. This is the first thing the app asks for after boot, and
 * nothing could ask for it until React had mounted, resolved the route and
 * loaded HomePage's chunk - several hundred milliseconds on mobile during
 * which the network sat idle. warmUserMemberships() below starts it at
 * module-eval time instead, and this memo makes HomePage's later call reuse
 * that same request rather than issuing a second one.
 *
 * A SHORT TTL, deliberately: this is a warm-start window, not a cache. Five
 * seconds is long enough to cover boot -> first render on a slow phone and
 * short enough that nobody can observe a stale membership list; the page also
 * has realtime subscriptions and its own SWR cache behind it.
 *
 * Keyed by user so a sign-out and sign-in cannot serve the previous account's
 * clubs, and cleared on rejection so a failure is never memoised.
 */
/**
 * Start the lobby's first query before anything renders. Fire-and-forget:
 * failures are swallowed here and surfaced normally to whoever asks next.
 */
export function warmUserMemberships(): void {
  try {
    void getUserMemberships().catch(() => {});
  } catch {
    /* never let a warm-up break boot */
  }
}

export async function getUserMemberships(
  preResolvedUser?: { id: string } | null
): Promise<(ClubMember & { club: Club })[]> {
  // Key on the RESOLVED user id, never on the argument. The warm start at boot
  // has no user to hand, while HomePage passes the one it already resolved -
  // keying on the argument gave them different keys, so they never shared and
  // the warm start was pure extra load. A test pins this.
  let warmKey = preResolvedUser?.id;
  if (!warmKey) {
    const { data: authed } = await getAuthUser();
    warmKey = authed?.user?.id;
    if (!warmKey) return [];
  }

  const warm = getWarmMemberships<(ClubMember & { club: Club })[]>(warmKey);
  if (warm) return warm;
  const promise = _getUserMembershipsUncached({ id: warmKey });
  return rememberWarmMemberships(warmKey, promise);
}

async function _getUserMembershipsUncached(
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

  const { data, error } = await retryFetch(
    () =>
      supabase
        .from('club_members')
        .select(
          `
      club_id, user_id, role, status, tier, chip_balance, credit_used, diamonds, trust_score, rank_level, sessions_played, orange_ball_status, joined_at, agent_id, hands_played, chips_won, chips_lost, total_rake_paid,
      club:clubs(id, club_id, name, slug, description, avatar_url, logo_url, card_image_url, banner_url, color_theme, member_count, table_count, chip_treasury, is_public, is_union, requires_approval, owner_id, union_id, settings, created_at, updated_at, level, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next)
    `
        )
        .eq('user_id', userId)
        // Only real memberships. A join request for an approval-required club
        // creates a status='pending' row (fn_join_club); without this filter the
        // requester saw a full club card on the lobby carousel and could open a
        // club they had NOT been admitted to. This also matches the status set
        // every 4-club-limit check counts, so "clubs shown" and "clubs counted"
        // can never disagree.
        .in('status', ['active', 'approved'])
        .then((result) => result),
    { maxRetries: 4, baseDelayMs: 500 }
  );

  if (error) {
    if (!_membershipBreaker.isOpen()) {
      _membershipBreaker.trip();
      reportError(error, 'ClubsService.Get_memberships_failed');
    }
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
      'club_id, user_id, role, status, tier, chip_balance, credit_used, diamonds, trust_score, rank_level, sessions_played, orange_ball_status, joined_at, agent_id, hands_played, chips_won, chips_lost, total_rake_paid'
    )
    .eq('club_id', resolvedId)
    // was .order('reputation_xp'), a column that is 0 on all 1,499 rows in
    // production - so this list came back in whatever order Postgres felt
    // like, and could differ between two loads of the same page
    .order('chip_balance', { ascending: false })
    .order('joined_at', { ascending: true })
    .limit(QUERY_LIMITS.MODERATE);

  if (error) {
    reportError(error, 'ClubsService.Get_club_members_failed');
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
        .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
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
    .order('ends_at', { ascending: true })
    /* club_challenges grows without bound per club, and this ran on every
       lobby load with no cap - the only query in this file without one. */
    .limit(QUERY_LIMITS.LIST);

  if (error) {
    reportError(error, 'ClubsService.Get_challenges_failed');
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
      'club_id, user_id, role, status, tier, chip_balance, credit_used, diamonds, trust_score, rank_level, sessions_played, orange_ball_status, joined_at, agent_id, hands_played, chips_won, chips_lost, total_rake_paid'
    )
    .eq('club_id', resolvedId)
    // same as above: reputation_xp was always 0, so "top 50" was 50 arbitrary
    // members rather than the top of anything
    .order('chip_balance', { ascending: false })
    .order('joined_at', { ascending: true })
    .limit(50);

  if (error) {
    reportError(error, 'ClubsService.Get_leaderboard_failed');
    throw new Error('Failed to get leaderboard');
  }

  // Batch-fetch profiles (no FK between club_members → profiles)
  const members = data || [];
  if (members.length > 0) {
    const userIds = members.map((m: any) => m.user_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
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
    reportError(memberErr, 'ClubsService.Failed_to_remove_members_before_club_del');
    throw new Error('Failed to remove club members');
  }

  // Delete the club
  const { error } = await supabase.from('clubs').delete().eq('id', resolvedId);

  if (error) {
    reportError(error, 'ClubsService.Delete_club_failed');
    throw new Error('Failed to delete club');
  }

  // Emit bus events so all open lobby/carousel tabs refresh immediately
  try {
    const { masterBus } = await import('../core/MasterBus');
    masterBus.emit('CLUB_LEFT', { clubId: resolvedId, action: 'club_deleted' });
    masterBus.emit('CLUB_UPDATED', { clubId: resolvedId, action: 'club_deleted' });
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
    reportError(
      new Error(
        `[ClubsService] Unauthorized updateClub attempt by ${user.user.id} on club ${clubId}`
      ),
      'ClubsService.Unauthorized_updateClub_attempt_by_useru'
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
    'gps_restricted',
    'color_theme',
    'avatar_url',
    'logo',
    'logo_url',
    'banner_url',
    'settings',
    // Game settings — critical for ClubDetailPage settings tab
    'default_rake_percent',
    'rake_cap',
    'min_buyin_bb',
    'max_buyin_bb',
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
    reportError(error, 'ClubsService.Update_club_failed');
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
    reportError(error, 'ClubsService.Logo_upload_failed');
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
    reportError(updateErr, 'ClubsService.Logo_uploaded_but_failed_to_save_URL_to_');
    throw new Error('Logo uploaded but failed to save - please try again');
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
    reportError(error, 'ClubsService.Banner_upload_failed');
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
    reportError(updateErr, 'ClubsService.Banner_uploaded_but_failed_to_save_URL_t');
    throw new Error('Banner uploaded but failed to save - please try again');
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
    reportError(error, 'ClubsService._Failed_to_check_club_membership_count');
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

  // BUGFIX 2026-07-24: a direct `club_members` count is subject to RLS. For a
  // club the viewer is NOT a member of, RLS exposes only the viewer's own row (or
  // none), so the old "Tier 1 direct count, return if > 0" logic returned 1 (or 0)
  // and NEVER reached the accurate SECURITY DEFINER RPC — this is why the featured
  // Shark Club card showed "1 member" for a 578-member club. We now take the MAX
  // across every source so an RLS-filtered undercount can never win, and the
  // authoritative RLS-bypassing RPC / denormalized column always dominate.
  const candidates: number[] = [];

  // ── Source A: SECURITY DEFINER RPC (bypasses RLS — authoritative) ──
  try {
    const { data, error } = await supabase.rpc('fn_get_club_member_count', {
      p_club_id: resolvedId,
    });
    if (!error && typeof data === 'number' && Number.isFinite(data)) {
      candidates.push(data);
    }
  } catch (e) {
    // RPC not deployed — rely on the other sources
  }

  // ── Source B: Denormalized clubs.member_count (trigger-maintained) ──
  try {
    const { data: club } = await supabase
      .from('clubs')
      .select('member_count')
      .eq('id', resolvedId)
      .maybeSingle();
    if (club?.member_count && Number.isFinite(club.member_count)) {
      candidates.push(club.member_count);
    }
  } catch (e) {
    /* fall through */
  }

  /* Source C (a direct count) REMOVED 2026-08-26.
   *
   * Its own comment said "only correct when RLS permits full visibility", and
   * that is the whole argument against keeping it. RLS can only REMOVE rows, so
   * this count is always <= the true count. Source A is now genuinely SECURITY
   * DEFINER (it was declared as such in a comment but was not, until
   * 20260825460000) and returns the true count. Since the function below returns
   * Math.max(...candidates), source C could never once have been selected - it
   * was a 204 ms scan whose result was arithmetically guaranteed to lose.
   *
   * Measured, as the club owner who can see all 588 rows:
   *   direct count ................. 204.61 ms
   *   fn_get_club_member_count ......  0.55 ms
   */

  if (candidates.length === 0) {
    reportError(new Error('getLiveMemberCount: no source returned a count'), 'ClubsService');
    return 0;
  }
  return Math.max(...candidates);
}

// Export service object for cleaner imports
export const ClubsService = {
  discoverNearby: discoverNearbyClubs,
  search: searchClubs,
  get: getClub,
  create: createClub,
  checkNameAvailability: checkClubNameAvailability,
  getCreationEligibility: getClubCreationEligibility,
  update: updateClub,
  join: joinClub,
  rememberInviteCode,
  redeemStoredInviteCode,
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
