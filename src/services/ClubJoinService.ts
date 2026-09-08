import { getArenaContext } from './ArenaContextService';
import type { ArenaAccessContext } from '../../server/src/domain/ArenaContext';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { ClubEntryTrustService } from './ClubEntryTrustService';
import { isJoinableClubCode } from '../utils/clubCode';

const PENDING_JOIN_KEY = 'club-arena:pending-join:v1';
const CLUB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLUB_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

export interface ClubJoinPreview {
  found: boolean;
  arena_context?: ArenaAccessContext;
  automatic_membership?: boolean;
  id?: string;
  club_id?: number;
  slug?: string;
  name?: string;
  description?: string | null;
  logo_url?: string | null;
  member_count?: number;
  requires_approval?: boolean;
  membership_status?: string | null;
}

export interface ClubJoinResult {
  success: boolean;
  arena_context?: ArenaAccessContext;
  automatic_membership?: boolean;
  code?: string;
  error?: string;
  club?: { id: string; club_id: number; slug?: string; name: string; logo_url?: string | null };
  membership?: Record<string, unknown>;
  status?: string;
  invitation_redeemed?: boolean;
}

/** Identifiers accepted by the authoritative join RPC: code, UUID, or safe slug. */
export function isClubJoinIdentifier(value: string | null | undefined): value is string {
  const normalized = value?.trim() || '';
  return (
    isJoinableClubCode(normalized) || CLUB_UUID_RE.test(normalized) || CLUB_SLUG_RE.test(normalized)
  );
}

interface PendingJoin {
  identifier: string;
  referralCode: string | null;
  requestId: string;
  createdAt: number;
}

export function parseClubJoinInput(
  input: string
): { identifier: string; referralCode: string | null } | null {
  const value = input.trim();
  if (isJoinableClubCode(value)) return { identifier: value, referralCode: null };
  try {
    const url = new URL(value, window.location.origin);
    const inviteMatch = url.pathname.match(/\/invite\/([^/]+)/i);
    if (inviteMatch) {
      const identifier = decodeURIComponent(inviteMatch[1]);
      if (!isClubJoinIdentifier(identifier)) return null;
      return {
        identifier,
        referralCode: url.searchParams.get('ref'),
      };
    }
    const code = url.searchParams.get('c');
    if (code && isJoinableClubCode(code)) {
      return { identifier: code, referralCode: url.searchParams.get('ref') };
    }
  } catch {
    return null;
  }
  return null;
}

export async function previewClubJoin(identifier: string): Promise<ClubJoinPreview> {
  const startedAt = performance.now();
  const { data, error } = await supabase.rpc('fn_preview_club_join', {
    p_identifier: identifier.trim(),
  });
  ClubEntryTrustService.track('join', 'previewed', {
    outcome: error || !data?.found ? 'failed' : 'succeeded',
    durationMs: Math.round(performance.now() - startedAt),
    metadata: error ? { error_code: error.code || 'unknown' } : undefined,
  });
  if (error) throw new Error(error.message || 'Could not look up that club.');
  return (data || { found: false }) as ClubJoinPreview;
}

function savePending(value: PendingJoin | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(PENDING_JOIN_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(PENDING_JOIN_KEY);
  } catch {
    // Storage can be unavailable in private browsing; the RPC remains idempotent
    // for the lifetime of the current call even when recovery cannot persist.
  }
}

export async function joinClubByIdentifier(options: {
  identifier: string;
  referralCode?: string | null;
  requestId?: string;
}): Promise<ClubJoinResult> {
  const startedAt = performance.now();
  const pending: PendingJoin = {
    identifier: options.identifier.trim(),
    referralCode: options.referralCode?.trim() || null,
    requestId: options.requestId || crypto.randomUUID(),
    createdAt: Date.now(),
  };
  const context = await getArenaContext(pending.identifier);
  if (context?.automaticMembership) {
    const preview = await previewClubJoin(context.arena.id);
    if (
      !preview.found ||
      preview.id !== context.arena.id ||
      !preview.name ||
      preview.club_id == null
    ) {
      throw new Error('Could Not Resolve Diamond Arena');
    }
    savePending(null);
    return {
      success: true,
      status: 'automatic',
      automatic_membership: true,
      arena_context: context,
      club: {
        id: preview.id,
        club_id: preview.club_id,
        slug: preview.slug,
        name: preview.name,
        logo_url: preview.logo_url,
      },
    };
  }
  savePending(pending);
  const { data, error } = await supabase.rpc('fn_join_club_atomic', {
    p_identifier: pending.identifier,
    p_request_id: pending.requestId,
    p_referral_code: pending.referralCode,
  });
  if (error) {
    ClubEntryTrustService.track('join', 'completed', {
      outcome: 'failed',
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { error_code: error.code || 'unknown' },
    });
    throw new Error(error.message || 'Could not join the club.');
  }
  const result = data as ClubJoinResult;
  savePending(null);
  ClubEntryTrustService.track('join', 'completed', {
    outcome: result?.success ? 'succeeded' : 'failed',
    durationMs: Math.round(performance.now() - startedAt),
    metadata: { status: result?.status || result?.code || 'unknown' },
  });
  if (!result?.success) return result || { success: false, error: 'Could not join the club.' };
  if (result.club?.id) {
    masterBus.emit('CLUB_JOINED', {
      clubId: result.club.id,
      clubName: result.club.name,
      action: 'member_joined',
    });
  }
  return result;
}

export async function resumePendingClubJoin(): Promise<ClubJoinResult | null> {
  if (typeof window === 'undefined' || !navigator.onLine) return null;
  try {
    const raw = window.localStorage.getItem(PENDING_JOIN_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingJoin;
    if (!pending.requestId || Date.now() - pending.createdAt > 24 * 60 * 60_000) {
      savePending(null);
      return null;
    }
    return joinClubByIdentifier({
      identifier: pending.identifier,
      referralCode: pending.referralCode,
      requestId: pending.requestId,
    });
  } catch {
    return null;
  }
}

export async function cancelClubJoinRequest(clubId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('fn_cancel_club_join_request', { p_club_id: clubId });
  if (error) throw new Error(error.message || 'Could not cancel the request.');
  return data === true;
}

export const ClubJoinService = {
  isValidIdentifier: isClubJoinIdentifier,
  parseInput: parseClubJoinInput,
  preview: previewClubJoin,
  join: joinClubByIdentifier,
  resumePending: resumePendingClubJoin,
  cancelRequest: cancelClubJoinRequest,
};
