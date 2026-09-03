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

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { reportError } from '../utils/errorReporter';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import RakeSnapshotPanel from '../components/club/RakeSnapshotPanel';
import styles from './UnionDataPage.module.css';

export default function UnionDataPage() {
  const { unionId } = useParams<{ unionId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();

  const [unionName, setUnionName] = useState<string | null>(null);
  const [clubCount, setClubCount] = useState<number | null>(null);

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
    })();

    void (async () => {
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
    })();

    return () => {
      cancelled = true;
    };
  }, [unionId]);

  if (!unionId) {
    return (
      <main className={styles.page}>
        <p className={styles.empty}>No Union Selected.</p>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <CasinoSurfaceHeader
        eyebrow="Union Network / Data"
        title="Union Data"
        description="What Every Club Beneath This Union Produced In Rake, For The Day, The Week, The Month Or The Year."
        artPath="assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp"
        status="UNION PRODUCTION // LIVE"
        metrics={[
          { label: 'Union', value: unionName ?? 'Union' },
          { label: 'Clubs', value: clubCount ?? 0 },
        ]}
        actions={
          <>
            <button
              type="button"
              className={styles.headerBtn}
              onClick={() => navigate(`/unions/${unionId}`)}
            >
              Union
            </button>
            <button
              type="button"
              className={styles.headerBtn}
              onClick={() => navigate(`/unions/${unionId}/statements`)}
            >
              Statements
            </button>
          </>
        }
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
