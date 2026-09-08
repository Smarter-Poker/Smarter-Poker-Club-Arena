import { useCallback, useEffect, useState } from 'react';
import { useClubWorkspace } from '../contexts/ClubWorkspaceContext';
import {
  getClubNavigationCapabilities,
  type ClubNavigationCapabilities,
} from '../config/clubArenaNavigation';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { useAuthUser } from './useAuthUser';
import { isPlatformStaffRole } from '../utils/platformRoles';

export interface ClubNavigationAccess extends ClubNavigationCapabilities {
  clubRole: string | null;
  isPlatformStaff: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const CLOSED_CAPABILITIES = getClubNavigationCapabilities(null, false);

/**
 * One live, fail-closed access read for the hamburger, fixed club rail, and
 * Club Operations workspace. Route guards and Postgres remain authoritative;
 * this hook makes every navigation surface advertise the same tools.
 */
export function useClubNavigationAccess(clubId: string | null | undefined): ClubNavigationAccess {
  const workspace = useClubWorkspace();
  const { user } = useAuthUser();
  const matchesWorkspace = Boolean(
    clubId && (clubId === workspace.routeClubId || clubId === workspace.clubUUID)
  );
  const [fallbackRole, setFallbackRole] = useState<string | null>(null);
  const [fallbackPlatformStaff, setFallbackPlatformStaff] = useState(false);
  const [fallbackLoading, setFallbackLoading] = useState(Boolean(clubId && !matchesWorkspace));
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reloadFallback = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!clubId || matchesWorkspace || !user?.id) {
      setFallbackLoading(false);
      setFallbackError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setFallbackLoading(true);
      setFallbackError(null);
      try {
        const resolvedId = await resolveClubUUIDStrict(clubId);
        const [membershipResult, profileResult] = await Promise.all([
          supabase
            .from('club_members')
            .select('role')
            .eq('club_id', resolvedId)
            .eq('user_id', user.id)
            .maybeSingle(),
          supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
        ]);
        if (cancelled) return;
        if (membershipResult.error) throw membershipResult.error;
        if (profileResult.error) {
          reportError(profileResult.error, 'ClubNavigationAccess.Platform_role_lookup_failed');
        }
        setFallbackRole(membershipResult.data?.role || null);
        setFallbackPlatformStaff(
          !profileResult.error && isPlatformStaffRole(profileResult.data?.role)
        );
      } catch (loadError) {
        reportError(loadError, 'ClubNavigationAccess.Fallback_load_failed');
        if (!cancelled) {
          setFallbackRole(null);
          setFallbackPlatformStaff(false);
          setFallbackError('Club permissions could not be confirmed.');
        }
      } finally {
        if (!cancelled) setFallbackLoading(false);
      }
    };
    void load();
    const refresh = () => void load();
    const unsubClub = masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 300);
    const unsubRole = masterBus.subscribeDebounced('MEMBER_ROLE_CHANGED', refresh, 150);
    return () => {
      cancelled = true;
      unsubClub();
      unsubRole();
    };
  }, [clubId, matchesWorkspace, revision, user?.id]);

  if (!clubId) {
    return {
      ...CLOSED_CAPABILITIES,
      clubRole: null,
      isPlatformStaff: false,
      loading: false,
      error: null,
      reload: workspace.reload,
    };
  }

  const capabilities = matchesWorkspace
    ? getClubNavigationCapabilities(workspace.clubRole, workspace.isPlatformStaff)
    : fallbackError
      ? CLOSED_CAPABILITIES
      : getClubNavigationCapabilities(fallbackRole, fallbackPlatformStaff);

  return {
    ...capabilities,
    clubRole: matchesWorkspace ? workspace.clubRole : fallbackRole,
    isPlatformStaff: matchesWorkspace ? workspace.isPlatformStaff : fallbackPlatformStaff,
    loading: matchesWorkspace ? workspace.loading : fallbackLoading,
    error: matchesWorkspace ? workspace.error : fallbackError,
    reload: matchesWorkspace ? workspace.reload : reloadFallback,
  };
}
