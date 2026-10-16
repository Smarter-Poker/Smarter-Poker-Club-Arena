/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB INVITE SERVICE - Share & Invite links that credit the sender
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-15: "THE SHARE AND INVITE LINK NEEDS TO BE HARD CODED TO THE
 * PERSON WHO SPECIFICALLY SENDS IT ... THE PERSON WHO REFERRED THE USER GETS
 * CREDITED FOR THE SIGN UP, AND ... ADDED UNDER THEM IN THEIR DOWNLINES."
 *
 * Each member gets one short code per club (public.club_invite_links), shared
 * as https://smarter.poker/i/<CODE>. The World Hub page at /i/ draws the link
 * preview, sets the attribution cookie and sends a new player to signup first;
 * signup, the auth callback and the phone step carry the code; the join page
 * here claims it (first link wins) and fn_redeem_club_invite_code places the
 * player in the sender's downline.
 *
 * Storage keys are shared with the World Hub on purpose (same origin):
 *   sp-club-invite  {code, firstSeen}   the invite this browser is carrying
 *   sp-device-id    random id           the self-referral device check
 *
 * Migration: supabase/migrations/20261015181214_club_invite_links_and_attribution.sql
 */
import { supabase } from '../lib/supabase';
import { publicOrigin } from '../lib/appBase';
import { toWebPath } from '../lib/signIn';

export const CLUB_INVITE_STORAGE_KEY = 'sp-club-invite';
export const DEVICE_ID_STORAGE_KEY = 'sp-device-id';
export const CLUB_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_RE = /^[A-HJ-NP-Z2-9]{7}$/;

export interface InviteLink {
  code: string;
  shortUrl: string;
  joinPath: string;
}

export interface InviteStats {
  opened: number;
  signedUp: number;
  verified: number;
  joined: number;
}

export interface ClubInviteStatRow {
  inviterId: string;
  alias: string;
  playerNumber: string | null;
  opened: number;
  signedUp: number;
  verified: number;
  joined: number;
  blocked: number;
}

export interface PendingClubInvite {
  clubId: string;
  clubNumber: number | null;
  clubName: string;
  logoUrl: string | null;
  inviterAlias: string;
  joinPath: string;
  /** The same path inside the Club Arena router (no /hub/club-arena prefix). */
  inAppPath: string;
}

export interface ClaimResult {
  success: boolean;
  status?: string;
  code?: string;
  error?: string;
  joinPath?: string | null;
}

export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  return CODE_RE.test(v) ? v : null;
}

/** The text that travels with the link in the OS share sheet, signed with the alias. */
export function inviteShareText(inviterAlias: string, clubName: string, clubNumber: unknown): string {
  const id = clubNumber == null || clubNumber === '' ? '' : `\nClub ID: ${String(clubNumber)}`;
  return `${inviterAlias} Invited You To Join ${clubName} On Smarter.Poker!${id}`;
}

export function shortInviteUrl(code: string): string {
  return `${publicOrigin()}/i/${code}`;
}

/** '/hub/club-arena/invite/x?ref=1&i=ABC' -> '/invite/x?ref=1&i=ABC'; anything else -> null. */
export function toInAppJoinPath(joinPath: unknown): string | null {
  if (typeof joinPath !== 'string') return null;
  const prefix = '/hub/club-arena/';
  if (!joinPath.startsWith(prefix) || joinPath.includes('\\') || joinPath.startsWith('//')) return null;
  return '/' + joinPath.slice(prefix.length);
}

export function getDeviceId(): string | null {
  try {
    let id = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export function readPendingInviteCode(now = Date.now()): { code: string; firstSeen: number } | null {
  try {
    const raw = window.localStorage.getItem(CLUB_INVITE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code?: unknown; firstSeen?: unknown };
    const code = normalizeInviteCode(parsed.code);
    const firstSeen = Number(parsed.firstSeen);
    if (!code || !Number.isFinite(firstSeen) || now - firstSeen >= CLUB_INVITE_TTL_MS) return null;
    return { code, firstSeen };
  } catch {
    return null;
  }
}

/** First link wins: a live stored invite is never replaced. */
export function rememberInviteCode(code: string, firstSeen = Date.now()): void {
  const normalized = normalizeInviteCode(code);
  if (!normalized || readPendingInviteCode()) return;
  try {
    window.localStorage.setItem(
      CLUB_INVITE_STORAGE_KEY,
      JSON.stringify({ code: normalized, firstSeen })
    );
  } catch {
    /* private browsing: the database claim below is what counts */
  }
}

export function clearPendingInviteCode(): void {
  try {
    window.localStorage.removeItem(CLUB_INVITE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  try {
    document.cookie = 'sp_club_invite=; Max-Age=0; Path=/; SameSite=Lax';
  } catch {
    /* ignore */
  }
}

/**
 * SHARE & INVITE (2026-10-15): the in-app AuthPage's sign-up writes the same
 * invite fields the World Hub signup does (pages/auth/signup.js), so a player
 * who signs up inside the app is credited to the sender exactly as on the
 * web, even when the confirmation email is opened on another device. The code
 * comes from the way back (the /i/<CODE> path or the join page's ?i=) or the
 * invite this device is carrying; club_join_path is the join page itself, as
 * a web path.
 */
export function inviteSignupMetadata(afterSignIn: string): Record<string, string> {
  const [path, query = ''] = afterSignIn.split('#')[0].split('?');
  const shortLink = /^\/i\/([^/?#]+)\/?$/.exec(path);
  const isInvitePath = !!shortLink || path.startsWith('/invite/');
  const fromRedirect = isInvitePath
    ? normalizeInviteCode(new URLSearchParams(query).get('i')) ||
      (shortLink ? normalizeInviteCode(shortLink[1]) : null)
    : null;
  const pending = readPendingInviteCode();
  const code = fromRedirect || pending?.code || null;
  const out: Record<string, string> = {};
  if (code) {
    const firstSeen = pending && pending.code === code ? pending.firstSeen : Date.now();
    out.club_invite_code = code;
    out.club_invite_first_seen = new Date(firstSeen).toISOString();
  }
  if (isInvitePath) out.club_join_path = toWebPath(afterSignIn);
  return out;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The caller's own link for this club (created on first use). */
export async function getMyInviteLink(clubId: string): Promise<InviteLink> {
  const { data, error } = await supabase.rpc('fn_club_invite_link', {
    p_club_id: clubId,
    p_device_id: getDeviceId(),
  });
  if (error) throw new Error(error.message || 'Could Not Create Your Invite Link');
  const r = (data || {}) as { success?: boolean; code?: string; join_path?: string; error?: string };
  if (!r.success || !r.code) throw new Error(r.error || 'Could Not Create Your Invite Link');
  return { code: r.code, shortUrl: shortInviteUrl(r.code), joinPath: r.join_path || '' };
}

export async function getMyInviteStats(clubId: string): Promise<InviteStats> {
  const { data, error } = await supabase.rpc('fn_club_invite_my_stats', { p_club_id: clubId });
  if (error) throw new Error(error.message || 'Could Not Load Your Invite Stats');
  const r = (data || {}) as Record<string, unknown>;
  return {
    opened: num(r.opened),
    signedUp: num(r.signed_up),
    verified: num(r.verified),
    joined: num(r.joined),
  };
}

/** Owners, co-owners and admins see the club; an agent sees their downline. */
export async function getClubInviteStats(
  clubId: string
): Promise<{ allowed: boolean; scope: 'club' | 'downline' | null; rows: ClubInviteStatRow[] }> {
  const { data, error } = await supabase.rpc('fn_club_invite_club_stats', { p_club_id: clubId });
  if (error) throw new Error(error.message || 'Could Not Load Invite Stats');
  const r = (data || {}) as { allowed?: boolean; scope?: string; rows?: Record<string, unknown>[] };
  return {
    allowed: r.allowed === true,
    scope: r.scope === 'club' || r.scope === 'downline' ? r.scope : null,
    rows: (r.rows || []).map((row) => ({
      inviterId: String(row.inviter_id || ''),
      alias: String(row.alias || 'Unknown Player'),
      playerNumber: row.player_number == null ? null : String(row.player_number),
      opened: num(row.opened),
      signedUp: num(row.signed_up),
      verified: num(row.verified),
      joined: num(row.joined),
      blocked: num(row.blocked),
    })),
  };
}

/**
 * Attach the signed-in account to an invite code. First link wins on the
 * server, so calling this with a stale or second code is harmless.
 */
export async function claimInvite(code: string, firstSeen?: number): Promise<ClaimResult> {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return { success: false, code: 'invalid_code' };
  const { data, error } = await supabase.rpc('fn_club_invite_claim', {
    p_code: normalized,
    p_device_id: getDeviceId(),
    p_first_clicked_at: new Date(firstSeen || Date.now()).toISOString(),
  });
  if (error) throw new Error(error.message || 'Could Not Apply That Invite');
  const r = (data || {}) as { success?: boolean; status?: string; code?: string; error?: string; join_path?: string };
  return {
    success: r.success === true,
    status: r.status,
    code: r.code,
    error: r.error,
    joinPath: r.join_path || null,
  };
}

/** The club this player was invited to and has not joined yet, if any. */
export async function getPendingClubInvite(): Promise<PendingClubInvite | null> {
  const { data, error } = await supabase.rpc('fn_club_invite_pending');
  if (error) throw new Error(error.message || 'Could Not Load Your Invite');
  const r = (data || {}) as {
    pending?: boolean;
    club?: { id?: string; club_id?: number; name?: string; logo_url?: string | null };
    inviter_alias?: string;
    join_path?: string;
  };
  const inAppPath = toInAppJoinPath(r.join_path);
  if (!r.pending || !r.club?.id || !inAppPath) return null;
  return {
    clubId: r.club.id,
    clubNumber: r.club.club_id ?? null,
    clubName: r.club.name || 'Your Club',
    logoUrl: r.club.logo_url || null,
    inviterAlias: r.inviter_alias || 'A Club Member',
    joinPath: r.join_path as string,
    inAppPath,
  };
}

/** Signed-in lookup used by the in-app /i/:code route (deep links). */
export async function resolveInviteCode(code: string): Promise<{ inAppPath: string } | null> {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return null;
  const { data, error } = await supabase.rpc('fn_club_invite_resolve', {
    p_code: normalized,
    p_count_click: true,
  });
  if (error) throw new Error(error.message || 'Could Not Open That Invite');
  const r = (data || {}) as { found?: boolean; join_path?: string };
  const inAppPath = toInAppJoinPath(r.join_path);
  return r.found && inAppPath ? { inAppPath } : null;
}

export const ClubInviteService = {
  getMyLink: getMyInviteLink,
  getMyStats: getMyInviteStats,
  getClubStats: getClubInviteStats,
  claim: claimInvite,
  getPending: getPendingClubInvite,
  resolve: resolveInviteCode,
};
