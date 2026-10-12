/**
 * UNION DATA
 * ============================================================================
 * What the union produced, without walking into one of its clubs first.
 *
 * The rake snapshot has answered the union question since it was built, but
 * only from inside a member club: the panel derived the union from whichever
 * club the operator happened to open. A union lead who owns no club had no
 * door at all, and one who owns two had to pick a club and hope the figure
 * above it was the union's rather than that club's.
 *
 * So this page hands the panel the UNION directly. Every scope below it is
 * still gated in the database - ca_can_oversee_union for the union itself,
 * ca_can_view_club_finances for a club opened from the list - and the panel
 * reports a refusal rather than painting a zero.
 *
 * Deliberately not a second statements page. Statements are the billing
 * record and live at /unions/:unionId/statements; this is production.
 */

import { useEffect, useLayoutEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUnionRouteId } from '../hooks/useUnionRouteId';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useCanOperateUnionNetwork } from '../hooks/useCanCreateUnion';
import { reportError } from '../utils/errorReporter';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import RakeSnapshotPanel from '../components/club/RakeSnapshotPanel';
import { titleCase } from '../utils/titleCase';
import styles from './UnionDataPage.module.css';

export default function UnionDataPage() {
  const { unionId, unionRef } = useUnionRouteId();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const { canOperateUnionNetwork } = useCanOperateUnionNetwork();

  const [unionName, setUnionName] = useState<string | null>(null);
  const [clubCount, setClubCount] = useState<number | null>(null);
  const [unionNameReady, setUnionNameReady] = useState(false);
  const [clubCountReady, setClubCountReady] = useState(false);

  // A route change must retire the prior union's identity before the browser
  // paints the new URL. The two header reads repopulate only this union.
  useLayoutEffect(() => {
    setUnionName(null);
    setClubCount(null);
    setUnionNameReady(false);
    setClubCountReady(false);
  }, [unionId]);

  /**
   * The name and the club count are for the header only. A refusal here is
   * NOT reported as a failure and never blocks the panel: the panel asks the
   * database itself and says what it was told, and a union lead reading a
   * union whose row RLS happens to hide should still get their figures rather
   * than an error about a name.
   */
  useEffect(() => {
    if (!unionId) return;
    let cancelled = false;

    void (async () => {
      try {
        const { data, error } = await supabase
          .from('unions')
          .select('name')
          .eq('id', unionId)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          reportError(error, 'UnionDataPage.union_name');
        } else if (data?.name) {
          setUnionName(String(data.name));
        }
      } catch (error) {
        if (!cancelled) reportError(error, 'UnionDataPage.union_name');
      } finally {
        if (!cancelled) setUnionNameReady(true);
      }
    })();

    void (async () => {
      try {
        const { count, error } = await supabase
          .from('union_clubs')
          .select('club_id', { count: 'exact', head: true })
          .eq('union_id', unionId);
        if (cancelled) return;
        if (error) {
          reportError(error, 'UnionDataPage.club_count');
        } else if (typeof count === 'number') {
          setClubCount(count);
        }
      } catch (error) {
        if (!cancelled) reportError(error, 'UnionDataPage.club_count');
      } finally {
        if (!cancelled) setClubCountReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [unionId]);

  if (!unionId) {
    return (
      <main className={styles.page}>
        <CasinoSurfaceHeader
          crest="flat"
          family="shark"
          eyebrow="Union Network / Data"
          title="Union Data"
          description="Choose A Union To Read Its Verified Production Ledger."
          status="UNION PRODUCTION // CHECKING"
          pill="No Union"
          pillInk="muted"
          plates={{
            primary: {
              label: canOperateUnionNetwork ? 'Return To Unions' : 'Return To Community',
              onClick: () => navigate(canOperateUnionNetwork ? '/unions' : '/community'),
            },
          }}
        />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <CasinoSurfaceHeader
        crest="spade"
        family="riveted"
        eyebrow="Union Network / Data"
        title="Union Data"
        description="What Every Club Beneath This Union Produced In Rake, For The Day, The Week, The Month Or The Year."
        status="UNION PRODUCTION // LIVE"
        metrics={[
          {
            label: 'Union',
            value: unionName ? titleCase(unionName) : unionNameReady ? 'Unavailable' : 'Checking',
          },
          { label: 'Clubs', value: clubCount ?? (clubCountReady ? 'Unavailable' : 'Checking') },
        ]}
        plates={{
          secondary: {
            label: 'Union',
            onClick: () => navigate(`/unions/${unionRef}`),
          },
          primary: {
            label: 'Statements',
            onClick: () => navigate(`/unions/${unionRef}/statements`),
          },
        }}
      />

      {/*
        The union, handed over directly. scopes is union alone: the club scope
        needs a club, and on this page the only honest way to reach one is to
        open it from the list below - which the panel does, and which the
        database re-checks per club.
      */}
      <RakeSnapshotPanel
        clubId={null}
        unionId={unionId}
        userId={user?.id ?? null}
        scopes={['union']}
      />
    </main>
  );
}
