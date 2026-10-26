/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BOUNTIES - the mystery bounty ladder, on its own tab
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-25, verbatim: "CREATE ANOTHER TAB, FOR 'BOUNTIES' FOR ALL MYSTERY
 * BOUNTY TOURNAMENTS NEXT TO REWARDS, INSTEAD OF PLACING IT AT THE BOTTOM OF
 * REWARDS, WHERE ALL THE BOUNTY PRIZES AND AWARDS ARE LOCATED."
 *
 * This is the panel that used to sit at the bottom of Rewards, unchanged:
 * `MysteryBountyPanel`, fed by the page's single `useMysteryBounty` fetch
 * (`mysteryBounty` on the tab contract), so the top chest the Detail tab
 * advertises, the pool totals Rewards keeps, and the ladder here read the same
 * calls and cannot disagree. The tab only exists for a mystery bounty event
 * (`tabsFor` in ./types), and renders nothing for any other.
 */
import React, { useMemo } from 'react';
import MysteryBountyPanel from '../MysteryBountyPanel';
import { tournamentRowUnitCents, type TournamentTabProps } from './types';
import './RewardsTab.css';

export default function BountiesTab({
  tournament,
  currentUserId,
  mysteryBounty,
}: TournamentTabProps) {
  const t = (tournament || {}) as unknown as {
    is_mystery_bounty?: boolean | null;
    status?: string | null;
  };
  const tournamentId = tournament?.id;
  const unitCents = useMemo(() => tournamentRowUnitCents(tournament), [tournament]);

  if (!t.is_mystery_bounty || !mysteryBounty || !tournamentId) return null;

  return (
    <div className="rw">
      <MysteryBountyPanel
        tournamentId={tournamentId}
        isMysteryBounty
        data={mysteryBounty}
        currentUserId={currentUserId ?? null}
        isCompleted={String(t.status || '').toUpperCase() === 'COMPLETED'}
        unitCents={unitCents}
      />
    </div>
  );
}
