import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { isUUID, resolveClubUUID } from '../../utils/clubIdResolver';
import { LoadingState, PermissionState } from '../common/EmptyState';
import type { ClubDataScope } from '../../hooks/useClubDataScope';

/** The footer's session cache is navigation only. Data routes ask again. */
export default function ClubDataGuard({
  children,
  wholeClub = false,
}: {
  children: ReactNode;
  wholeClub?: boolean;
}) {
  const { clubId } = useParams<{ clubId: string }>();
  const { user, isHydrating } = useAuthUser();
  const navigate = useNavigate();
  const key = JSON.stringify([user?.id, clubId, wholeClub]);
  const [verdict, setVerdict] = useState<{ key: string; scope: ClubDataScope } | null>(null);

  useEffect(() => {
    let dead = false;
    if (!user?.id || !clubId || isHydrating) return;
    void (async () => {
      let scope: ClubDataScope = null;
      try {
        const id = isUUID(clubId) ? clubId : await resolveClubUUID(clubId);
        if (isUUID(id)) {
          const { data, error } = await supabase.rpc('fn_ca_club_data_scope', { p_club_id: id });
          if (!error && (data === 'club' || data === 'downline')) scope = data;
        }
      } catch {
        /* An unknown permission never opens private reports. */
      }
      if (!dead) setVerdict({ key, scope });
    })();
    return () => {
      dead = true;
    };
  }, [key, user?.id, clubId, isHydrating]);

  if (isHydrating || !verdict || verdict.key !== key) {
    return <LoadingState message="Checking Your Data Access" />;
  }
  if (!verdict.scope) {
    return (
      <PermissionState
        description="Only Owners, CO-Owners, Admins And Agents Can Open Data. Agents Can See Only Themselves And Their Downline."
        onBack={() => navigate(-1)}
      />
    );
  }
  if (wholeClub && verdict.scope === 'downline') {
    return <Navigate to={`/clubs/${clubId}/data`} replace />;
  }
  // Account changes retire the entire report tree, including all private state.
  return <Fragment key={key}>{children}</Fragment>;
}
