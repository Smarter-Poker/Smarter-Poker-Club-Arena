import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  getClubNavigationCapabilities,
  type ClubNavigationCapabilities,
} from '../config/clubArenaNavigation';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { useAuthUser } from '../hooks/useAuthUser';
import {
  readClubWorkspaceCache,
  removeClubWorkspaceCache,
  writeClubWorkspaceCache,
} from '../lib/clubWorkspaceCache';

export type ClubWorkspaceStatus = 'idle' | 'loading' | 'ready' | 'denied' | 'error';

export interface ClubWorkspaceValue extends ClubNavigationCapabilities {
  routeClubId: string | null;
  clubUUID: string | null;
  clubRole: string | null;
  membershipStatus: string | null;
  isMember: boolean;
  isPlatformStaff: boolean;
  status: ClubWorkspaceStatus;
  loading: boolean;
  error: string | null;
  isOffline: boolean;
  isStale: boolean;
  lastSyncedAt: number | null;
  reload: () => void;
}

const CLOSED_CAPABILITIES = getClubNavigationCapabilities(null, false);

const EMPTY_WORKSPACE: ClubWorkspaceValue = {
  routeClubId: null,
  clubUUID: null,
  clubRole: null,
  membershipStatus: null,
  isMember: false,
  isPlatformStaff: false,
  status: 'idle',
  loading: false,
  error: null,
  isOffline: false,
  isStale: false,
  lastSyncedAt: null,
  reload: () => undefined,
  ...CLOSED_CAPABILITIES,
};

const ClubWorkspaceContext = createContext<ClubWorkspaceValue>(EMPTY_WORKSPACE);

// A PostgREST request can remain pending when a pooled connection or the
// browser's fetch stack wedges. retryFetch can retry rejected requests, but it
// cannot retry a promise that never settles. Bound each authorization read so
// a club route reaches either its real member surface or its recoverable error
// state instead of showing PageSkeleton forever.
const CLUB_WORKSPACE_READ_TIMEOUT_MS = 10_000;

async function withClubWorkspaceReadTimeout<T>(
  read: (signal: AbortSignal) => PromiseLike<T>,
  label: string
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLUB_WORKSPACE_READ_TIMEOUT_MS);

  try {
    return await read(controller.signal);
  } catch (readError) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(
        `${label} timed out after ${CLUB_WORKSPACE_READ_TIMEOUT_MS}ms.`
      );
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw readError;
  } finally {
    clearTimeout(timer);
  }
}

function getRouteClubId(pathname: string, search: string): string | null {
  const match = pathname.match(/^\/clubs\/([^/]+)/);
  const raw = match?.[1] || new URLSearchParams(search).get('club');
  if (!raw || raw === 'create') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * One route-aware source of truth for club identity, membership, role, and
 * derived capabilities. Navigation, guards, and operator workspaces consume
 * this same state so the app cannot advertise one permission model while a
 * route enforces another.
 */
export function ClubWorkspaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { user, isHydrating } = useAuthUser();
  const routeClubId = useMemo(
    () => getRouteClubId(location.pathname, location.search),
    [location.pathname, location.search]
  );
  const [clubUUID, setClubUUID] = useState<string | null>(null);
  const [clubRole, setClubRole] = useState<string | null>(null);
  const [membershipStatus, setMembershipStatus] = useState<string | null>(null);
  const [isPlatformStaff, setIsPlatformStaff] = useState(false);
  const [status, setStatus] = useState<ClubWorkspaceStatus>(routeClubId ? 'loading' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [loadedRouteClubId, setLoadedRouteClubId] = useState<string | null>(null);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  const [revision, setRevision] = useState(0);
  const [usingCachedAccess, setUsingCachedAccess] = useState(false);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const onOnline = () => {
      setIsOffline(false);
      reload();
    };
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [reload]);

  useEffect(() => {
    let cancelled = false;

    const clear = (nextStatus: ClubWorkspaceStatus) => {
      setClubUUID(null);
      setClubRole(null);
      setMembershipStatus(null);
      setIsPlatformStaff(false);
      setError(null);
      setUsingCachedAccess(false);
      setStatus(nextStatus);
      setLoadedRouteClubId(routeClubId);
      setLoadedUserId(user?.id || null);
    };

    const load = async (allowCacheFallback = true) => {
      if (!routeClubId) {
        if (!cancelled) clear('idle');
        return;
      }
      if (!user?.id) {
        if (!cancelled && !isHydrating) clear('denied');
        return;
      }

      setStatus('loading');
      setError(null);
      try {
        // This provider is mounted in the global shell. Keep the retry helper
        // out of the first-load bundle and fetch it only for contextual club
        // routes that actually need authorization reads.
        const { retryFetch } = await import('../utils/retryFetch');
        const resolvedId = await retryFetch(
          () =>
            withClubWorkspaceReadTimeout(
              (signal) => resolveClubUUIDStrict(routeClubId, signal),
              'Club identity lookup'
            ),
          { maxRetries: 3, baseDelayMs: 500 }
        );
        // These are authorization reads, but a transient PostgREST/network
        // failure is not an authorization verdict. Retry the existing
        // idempotent reads before the guard renders its recoverable fault
        // state; otherwise a single cold request can hide every club surface
        // from a member whose access is still valid.
        const [membershipResult, profileResult] = await Promise.all([
          retryFetch(() =>
            withClubWorkspaceReadTimeout(
              (signal) =>
                supabase
                  .from('club_members')
                  .select('role,status')
                  .eq('club_id', resolvedId)
                  .eq('user_id', user.id)
                  .abortSignal(signal)
                  .maybeSingle(),
              'Club membership lookup'
            )
          ),
          retryFetch(() =>
            withClubWorkspaceReadTimeout(
              (signal) =>
                supabase
                  .from('profiles')
                  .select('role')
                  .eq('id', user.id)
                  .abortSignal(signal)
                  .maybeSingle(),
              'Platform role lookup'
            )
          ),
        ]);
        if (cancelled) return;
        if (membershipResult.error) throw membershipResult.error;
        if (profileResult.error) {
          reportError(profileResult.error, 'ClubWorkspace.Platform_role_lookup_failed', {
            routeClubId,
          });
        }

        const nextMembershipStatus = membershipResult.data?.status || null;
        const isActive = ['active', 'approved'].includes(nextMembershipStatus || '');
        setClubUUID(resolvedId);
        setClubRole(membershipResult.data?.role || null);
        setMembershipStatus(nextMembershipStatus);
        setIsPlatformStaff(
          !profileResult.error &&
            (profileResult.data?.role === 'admin' || profileResult.data?.role === 'super_admin')
        );
        const verifiedAt = Date.now();
        setLastSyncedAt(verifiedAt);
        setUsingCachedAccess(false);
        setStatus(isActive ? 'ready' : 'denied');
        setLoadedRouteClubId(routeClubId);
        setLoadedUserId(user.id);
        if (isActive) {
          writeClubWorkspaceCache({
            userId: user.id,
            routeClubId,
            clubUUID: resolvedId,
            clubRole: membershipResult.data?.role || null,
            membershipStatus: nextMembershipStatus!,
            isPlatformStaff:
              !profileResult.error &&
              (profileResult.data?.role === 'admin' || profileResult.data?.role === 'super_admin'),
            verifiedAt,
          });
        } else {
          removeClubWorkspaceCache(user.id, routeClubId);
        }
      } catch (loadError) {
        reportError(loadError, 'ClubWorkspace.Load_failed', { routeClubId });
        if (!cancelled) {
          const cached = allowCacheFallback ? readClubWorkspaceCache(user.id, routeClubId) : null;
          if (cached) {
            setClubUUID(cached.clubUUID);
            setClubRole(cached.clubRole);
            setMembershipStatus(cached.membershipStatus);
            setIsPlatformStaff(cached.isPlatformStaff);
            setLastSyncedAt(cached.verifiedAt);
            setUsingCachedAccess(true);
            setError(null);
            setStatus('ready');
            setLoadedRouteClubId(routeClubId);
            setLoadedUserId(user.id);
            return;
          }
          setClubUUID(null);
          setClubRole(null);
          setMembershipStatus(null);
          setIsPlatformStaff(false);
          setUsingCachedAccess(false);
          setError('Club access could not be verified. Your membership has not been changed.');
          setStatus('error');
          setLoadedRouteClubId(routeClubId);
          setLoadedUserId(user.id);
        }
      }
    };

    void load();
    // A role/membership event may represent a revocation, so it must never be
    // hidden by the last verified cache. Manual retry and cold navigation may
    // use the short-lived fallback because protected RPCs still fail closed.
    const refresh = () => void load(false);
    const unsubClub = masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 300);
    const unsubRole = masterBus.subscribeDebounced('MEMBER_ROLE_CHANGED', refresh, 150);
    return () => {
      cancelled = true;
      unsubClub();
      unsubRole();
    };
  }, [isHydrating, revision, routeClubId, user?.id]);

  const routeIsCurrent =
    loadedRouteClubId === routeClubId && (!routeClubId || loadedUserId === (user?.id || null));
  const effectiveStatus: ClubWorkspaceStatus = routeIsCurrent
    ? status
    : routeClubId
      ? 'loading'
      : 'idle';
  const effectiveClubUUID = routeIsCurrent ? clubUUID : null;
  const effectiveClubRole = routeIsCurrent ? clubRole : null;
  const effectiveMembershipStatus = routeIsCurrent ? membershipStatus : null;
  const effectivePlatformStaff = routeIsCurrent ? isPlatformStaff : false;
  const capabilities =
    effectiveStatus === 'ready'
      ? getClubNavigationCapabilities(effectiveClubRole, effectivePlatformStaff)
      : CLOSED_CAPABILITIES;
  const isMember = effectiveStatus === 'ready';
  const isStale =
    isOffline || usingCachedAccess || (!!lastSyncedAt && Date.now() - lastSyncedAt > 5 * 60_000);

  const value = useMemo<ClubWorkspaceValue>(
    () => ({
      routeClubId,
      clubUUID: effectiveClubUUID,
      clubRole: effectiveClubRole,
      membershipStatus: effectiveMembershipStatus,
      isMember,
      isPlatformStaff: effectivePlatformStaff,
      status: effectiveStatus,
      loading: effectiveStatus === 'loading',
      error: routeIsCurrent ? error : null,
      isOffline,
      isStale,
      lastSyncedAt,
      reload,
      ...capabilities,
    }),
    [
      capabilities,
      effectiveClubRole,
      effectiveClubUUID,
      effectiveMembershipStatus,
      effectivePlatformStaff,
      effectiveStatus,
      error,
      isMember,
      isOffline,
      isStale,
      lastSyncedAt,
      reload,
      routeClubId,
      routeIsCurrent,
    ]
  );

  return <ClubWorkspaceContext.Provider value={value}>{children}</ClubWorkspaceContext.Provider>;
}

export function useClubWorkspace(): ClubWorkspaceValue {
  return useContext(ClubWorkspaceContext);
}
