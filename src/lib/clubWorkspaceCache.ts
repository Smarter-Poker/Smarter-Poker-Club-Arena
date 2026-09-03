/**
 * Last verified club-route authorization.
 *
 * The route guard is a client-side navigation aid; every protected RPC still
 * enforces authorization in Postgres. Keeping a five-minute, user-scoped copy
 * lets a known owner reach the page during a transient PostgREST outage while
 * the server remains the authority for every data read and mutation.
 */

export const CLUB_WORKSPACE_CACHE_KEY = 'club_arena_workspace_access_v1';
export const CLUB_WORKSPACE_CACHE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 50;

export interface CachedClubWorkspace {
  userId: string;
  routeClubId: string;
  clubUUID: string;
  clubRole: string | null;
  membershipStatus: string;
  isPlatformStaff: boolean;
  verifiedAt: number;
}

function readAll(): CachedClubWorkspace[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLUB_WORKSPACE_CACHE_KEY) || '[]');
    return Array.isArray(parsed) ? (parsed as CachedClubWorkspace[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: CachedClubWorkspace[]): void {
  try {
    localStorage.setItem(CLUB_WORKSPACE_CACHE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Storage can be unavailable or full. Live authorization still works.
  }
}

export function readClubWorkspaceCache(
  userId: string,
  routeClubId: string,
  now = Date.now()
): CachedClubWorkspace | null {
  const cached = readAll().find(
    (entry) => entry.userId === userId && entry.routeClubId === routeClubId
  );
  if (!cached || now - cached.verifiedAt > CLUB_WORKSPACE_CACHE_TTL_MS) return null;
  if (!['active', 'approved'].includes(cached.membershipStatus)) return null;
  return cached;
}

export function writeClubWorkspaceCache(entry: CachedClubWorkspace): void {
  const entries = readAll().filter(
    (current) => !(current.userId === entry.userId && current.routeClubId === entry.routeClubId)
  );
  entries.push(entry);
  writeAll(entries);
}

export function removeClubWorkspaceCache(userId: string, routeClubId: string): void {
  writeAll(
    readAll().filter((entry) => !(entry.userId === userId && entry.routeClubId === routeClubId))
  );
}
