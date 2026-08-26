import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { readLocalSession } from '../../lib/authUtils';
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
        const localSession = readLocalSession();
        if (!localSession?.userId) {
          if (mounted) navigate(`/invite/${clubId}`);
          return;
        }

        const { data: memStat } = await supabase
          .from('club_members')
          .select('status')
          .eq('club_id', clubId)
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
