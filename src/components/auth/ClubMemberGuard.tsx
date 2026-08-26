import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase, getAuthUser } from '../../lib/supabase';
import { readLocalSession } from '../../lib/authUtils';

import { resolveClubUUID } from '../../utils/clubIdResolver';
import PageSkeleton from '../common/PageSkeleton';

export default function ClubMemberGuard({ children }: { children: ReactNode }) {
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const navigate = useNavigate();
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!clubId) {
      setHasAccess(true);
      return;
    }

    const checkAccess = async () => {
      try {
        let localSession = readLocalSession();
        if (!localSession?.userId) {
          const authUser = await getAuthUser();
          if (authUser?.data?.user?.id) {
            localSession = { userId: authUser.data.user.id } as any;
          }
        }

        if (!localSession?.userId) {
          if (mounted) navigate(`/invite/${clubId}`);
          return;
        }

        const resolvedId = await resolveClubUUID(clubId);

        const { data: memStat } = await supabase
          .from('club_members')
          .select('status')
          .eq('club_id', resolvedId)
          .eq('user_id', localSession.userId)
          .maybeSingle();

        if (!mounted) return;

        if (!memStat || !['active', 'approved'].includes(memStat.status)) {
          navigate(`/invite/${clubId}`);
        } else {
          setHasAccess(true);
        }
      } catch (err) {
        if (mounted) navigate(`/invite/${clubId}`);
      }
    };

    checkAccess();
    return () => {
      mounted = false;
    };
  }, [clubId, navigate]);

  if (hasAccess === null) {
    return <PageSkeleton variant="default" />;
  }

  return <>{children}</>;
}
// Trigger CI to bypass GitHub Actions queue desync
