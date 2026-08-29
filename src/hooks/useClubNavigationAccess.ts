import { useCallback, useEffect, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import {
  getClubNavigationCapabilities,
  type ClubNavigationCapabilities,
} from '../config/clubArenaNavigation';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useAuthUser } from './useAuthUser';

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
  const { user } = useAuthUser();
  const [clubRole, setClubRole] = useState<string | null>(null);
  const [isPlatformStaff, setIsPlatformStaff] = useState(false);
  const [loading, setLoading] = useState(Boolean(clubId));
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;

    const loadAccess = async () => {
      if (!clubId || !user?.id) {
        if (!cancelled) {
          setClubRole(null);
          setIsPlatformStaff(false);
          setLoading(false);
          setError(null);
        }
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const resolvedId = await resolveClubUUID(clubId);
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
        setClubRole(membershipResult.data?.role || null);
        setIsPlatformStaff(
          !profileResult.error &&
            (profileResult.data?.role === 'admin' || profileResult.data?.role === 'super_admin')
        );
      } catch (loadError) {
        reportError(loadError, 'ClubNavigationAccess.Load_failed');
        if (!cancelled) {
          setClubRole(null);
          setIsPlatformStaff(false);
          setError('Club permissions could not be confirmed.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadAccess();
    const refreshAccess = () => void loadAccess();
    const unsubClub = masterBus.subscribeDebounced('CLUB_UPDATED', refreshAccess, 300);
    const unsubRole = masterBus.subscribeDebounced('MEMBER_ROLE_CHANGED', refreshAccess, 150);

    return () => {
      cancelled = true;
      unsubClub();
      unsubRole();
    };
  }, [clubId, user?.id, revision]);

  const capabilities = error
    ? CLOSED_CAPABILITIES
    : getClubNavigationCapabilities(clubRole, isPlatformStaff);

  return {
    ...capabilities,
    clubRole,
    isPlatformStaff,
    loading,
    error,
    reload,
  };
}
