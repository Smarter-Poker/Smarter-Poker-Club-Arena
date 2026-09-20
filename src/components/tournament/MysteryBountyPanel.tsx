/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY LOBBY PANEL — sections 31 to 36, 41, 47, 67, 68, 73
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three sections, in Dan's order, inside the tournament lobby that already
 * exists rather than on a page of their own:
 *
 *   A. PRIZES        the full ladder, original / remaining / awarded per tier
 *   B. AWARDED       what has been won, by whom, off whose knockout, and when
 *   C. LEADERBOARD   who is winning the bounty half of the event
 *
 * Above them the advertised TOP bounty (section 10) and the activation status
 * (section 73), and below the leaderboard a per-player payout view (section 41).
 *
 * THE RULES THAT SHAPED THIS
 *
 *   Section 33: an exhausted MAJOR bounty is NOT hidden. A 5,000 chest that has
 *   been won still reads "5,000 / 0 Remaining / Won By <name>" for the rest of
 *   the event, because "what was in this tournament" is the question a player is
 *   asking and a disappeared row answers it wrongly. Lower tiers collapse behind
 *   a control, they are not dropped: section 34 says the history stays reachable.
 *
 *   Section 36 / 69: the leaderboard comes from fn_mystery_bounty_leaderboard.
 *   Never from the animation history, never from a running client tally. A
 *   spectator who joined ten minutes ago sees the same numbers as a player who
 *   has been here since level one.
 *
 *   Section 38: nothing here touches a chip stack. These are wallet payouts and
 *   the panel is read-only.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import type { UseMysteryBountyResult } from '../../hooks/useMysteryBounty';
import {
  formatCents,
  topBountyCents,
  remainingCents,
  awardedCents,
  chestCounts,
  largestAward,
  activationStatusLine,
  playerTotalsFromAwards,
  type MysteryBountyAward,
} from '../../services/MysteryBountyService';
import {
  isHeadlineTier,
  mysteryBountyTierColor,
  mysteryBountyTierLabel,
} from '../../config/mysteryBountyTiers';
import { moneyAdjectiveAtUnit } from '../../utils/format';
import styles from './MysteryBountyPanel.module.css';

export interface MysteryBountyPanelProps {
  tournamentId: string;
  /** False for any event that is not a mystery bounty. The panel renders null. */
  isMysteryBounty: boolean;
  /**
   * The live view, from `useMysteryBounty`.
   *
   * Passed IN rather than fetched here so the page that hosts this panel can
   * also advertise the top bounty on its own summary tab (section 10) off the
   * same three RPC calls. A second hook instance inside the panel would double
   * every fetch and let the two surfaces disagree for a few hundred ms after a
   * reveal.
   */
  data: UseMysteryBountyResult;
  /** Highlights the viewer's own leaderboard row. */
  currentUserId?: string | null;
  /** Enables the "final position" half of the player payout view (section 41). */
  isCompleted?: boolean;
  /**
   * THE GRID THIS EVENT PAYS ON (2026-09-20). Every figure in this panel is
   * cents off `fn_mystery_bounty_*`, and a Diamond chest holds whole Diamonds,
   * so the panel cannot print any of them until it is told the unit. Required
   * and undefaulted for the reason
   * `a-tournament-prize-knows-its-unit.law.test.ts` records: a defaulted unit
   * is "I could not tell" folded into a confident cent.
   *
   * The host reads it once from the tournament's arena embed with
   * `tournamentRowUnitCents`; it is not derived here, because this panel is
   * handed a view of the bounty RPCs and never sees a club row.
   */
  unitCents: number;
}

/** How many low tiers to show before the collapse control takes over. */
const COLLAPSED_TIER_LIMIT = 4;
/** How many awards to list before "Show All". */
const COLLAPSED_AWARD_LIMIT = 8;

function shortWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "Ann And Bob" for a split, "Ann" for a solo knockout. */
function winnerNames(award: MysteryBountyAward): string {
  const names = award.recipients.map((r) => r.username).filter(Boolean);
  if (names.length === 0) return 'Player';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} And ${names[names.length - 1]}`;
}

interface PlayerPayout {
  position: number | null;
  prize: number;
  status: string | null;
}

export default function MysteryBountyPanel({
  tournamentId,
  isMysteryBounty,
  data,
  currentUserId,
  isCompleted,
  unitCents,
}: MysteryBountyPanelProps) {
  const { inventory, awards, leaderboard, isLoading, pendingReveals } = data;

  const [showAllTiers, setShowAllTiers] = useState(false);
  const [showAllAwards, setShowAllAwards] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [playerPayout, setPlayerPayout] = useState<PlayerPayout | null>(null);

  /**
   * Who won each tier, for the section 33 "Won By" line.
   *
   * Built from the AWARD rows (the server's record) rather than from anything
   * the page has watched happen, so it is identical after a reload.
   */
  const wonByTier = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of awards) {
      const key = `${a.tier}:${a.amountCents}`;
      const list = map.get(key) ?? [];
      list.push(winnerNames(a));
      map.set(key, list);
    }
    return map;
  }, [awards]);

  const perPlayer = useMemo(() => playerTotalsFromAwards(awards), [awards]);
  const biggest = useMemo(() => largestAward(awards), [awards]);

  // ── Section 41: the selected player's regular prize and final position. ──
  useEffect(() => {
    let alive = true;
    if (!selectedUserId || !tournamentId) {
      setPlayerPayout(null);
      return;
    }
    (async () => {
      try {
        const { data } = await supabase
          .from('tournament_players')
          .select('position, prize, status')
          .eq('tournament_id', tournamentId)
          .eq('user_id', selectedUserId)
          .maybeSingle();
        if (!alive) return;
        setPlayerPayout(
          data
            ? {
                position: (data as { position: number | null }).position ?? null,
                prize: Number((data as { prize: number | null }).prize) || 0,
                status: (data as { status: string | null }).status ?? null,
              }
            : { position: null, prize: 0, status: null }
        );
      } catch (err) {
        reportError(err, 'MysteryBountyPanel.loadPlayerPayout');
        if (alive) setPlayerPayout({ position: null, prize: 0, status: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedUserId, tournamentId]);

  if (!isMysteryBounty) return null;

  const tiers = inventory?.tiers ?? [];
  const top = topBountyCents(inventory);
  const counts = chestCounts(inventory);
  const stage = inventory?.stage ?? 'pending';

  /**
   * Section 33 in one expression. A headline tier ALWAYS renders. Everything
   * else renders while it still has chests, and otherwise only once the player
   * has asked to see the whole ladder.
   */
  const alwaysVisible = tiers.filter((t) => isHeadlineTier(t.tier) || t.remaining > 0);
  const collapsible = tiers.filter((t) => !isHeadlineTier(t.tier) && t.remaining === 0);
  const visibleTiers = showAllTiers
    ? tiers
    : [
        ...alwaysVisible,
        ...collapsible.slice(0, Math.max(0, COLLAPSED_TIER_LIMIT - alwaysVisible.length)),
      ];
  const hiddenTierCount = tiers.length - visibleTiers.length;

  const visibleAwards = showAllAwards ? awards : awards.slice(0, COLLAPSED_AWARD_LIMIT);

  const statusClass =
    stage === 'active'
      ? styles.statusActive
      : stage === 'complete'
        ? styles.statusComplete
        : styles.statusPending;

  const selectedTotals = selectedUserId ? perPlayer.get(selectedUserId) : undefined;
  const selectedBoardRow = selectedUserId
    ? leaderboard.find((r) => r.userId === selectedUserId)
    : undefined;
  /* Leaderboard first: it is the server's own aggregate. The award-derived
     totals are the fallback and the only source for "largest". */
  const selectedBounties = selectedBoardRow?.bountiesWon ?? selectedTotals?.bountiesWon ?? 0;
  const selectedEarnings = selectedBoardRow?.earningsCents ?? selectedTotals?.earningsCents ?? 0;

  return (
    <div className={styles.panel}>
      {/* ── Section 10: the advertised top bounty, derived from real chests ── */}
      {top > 0 && (
        <div className={styles.headline}>
          <span className={styles.headlineLabel}>Top Mystery Bounty</span>
          <span className={styles.headlineValue}>{formatCents(top, unitCents)}</span>
          <span className={styles.headlineSub}>
            {counts.original.toLocaleString('en-US')} Mystery Bounties Drawn From A{' '}
            {formatCents(inventory?.poolCents ?? 0, unitCents)} {moneyAdjectiveAtUnit(unitCents)}{' '}
            Pool
          </span>
        </div>
      )}

      {/* ── Section 73: before it opens, say why ── */}
      <div className={`${styles.status} ${statusClass}`}>
        {stage === 'active' && <span className={styles.livePulse} aria-hidden="true" />}
        <span>{activationStatusLine(inventory)}</span>
      </div>

      {/* Section 68: the largest bounty won so far, and who took it. Listed
          separately from the ladder because "the biggest one anybody has hit"
          is the number the rail actually follows, and it is one of the things
          that must move on a reveal without a refresh. Derived from the award
          rows, so a reload rebuilds it exactly. */}
      {biggest && (
        <div className={`${styles.status} ${styles.statusComplete}`}>
          <span>
            Largest Mystery Bounty Won: {formatCents(biggest.amountCents, unitCents)} By{' '}
            {winnerNames(biggest.award)}
          </span>
        </div>
      )}

      {inventory && (
        <div className={styles.poolGrid}>
          <div className={styles.poolCell}>
            <span className={styles.poolCellLabel}>Bounty Pool</span>
            <span className={styles.poolCellValue}>
              {formatCents(inventory.poolCents, unitCents)}
            </span>
          </div>
          <div className={styles.poolCell}>
            <span className={styles.poolCellLabel}>Awarded</span>
            <span className={styles.poolCellValue}>
              {formatCents(awardedCents(inventory), unitCents)}
            </span>
          </div>
          <div className={styles.poolCell}>
            <span className={styles.poolCellLabel}>Still In Play</span>
            <span className={styles.poolCellValue}>
              {formatCents(remainingCents(inventory), unitCents)}
            </span>
          </div>
          <div className={styles.poolCell}>
            <span className={styles.poolCellLabel}>Chests Left</span>
            <span className={styles.poolCellValue}>
              {counts.remaining.toLocaleString('en-US')} Of{' '}
              {counts.original.toLocaleString('en-US')}
            </span>
          </div>
        </div>
      )}

      {/* ══ A. PRIZES (sections 31, 32, 33, 47) ══ */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle}>Mystery Bounty Prizes</h4>
          {pendingReveals > 0 && <span className={styles.sectionNote}>Updating</span>}
        </div>
        <div className={styles.rows}>
          {tiers.length === 0 ? (
            <div className={styles.empty}>
              {isLoading
                ? 'Loading The Mystery Bounty Ladder'
                : stage === 'pending'
                  ? 'The Ladder Is Drawn When The Mystery Phase Opens'
                  : 'No Mystery Bounties Were Drawn For This Event'}
            </div>
          ) : (
            visibleTiers.map((t) => {
              const exhausted = t.remaining === 0;
              const winners = wonByTier.get(`${t.tier}:${t.amountCents}`) ?? [];
              return (
                <div
                  key={`${t.tier}:${t.amountCents}`}
                  className={`${styles.tierRow} ${exhausted ? styles.tierRowExhausted : ''}`}
                >
                  <span
                    className={styles.tierSwatch}
                    style={{ background: mysteryBountyTierColor(t.tier) }}
                    aria-hidden="true"
                  />
                  <span className={styles.tierMain}>
                    <span
                      className={`${styles.tierAmount} ${exhausted ? styles.tierAmountExhausted : ''}`}
                    >
                      {formatCents(t.amountCents, unitCents)} x{t.original.toLocaleString('en-US')}
                    </span>
                    <span className={styles.tierName}>{mysteryBountyTierLabel(t.tier)}</span>
                    {winners.length > 0 && (
                      <span className={styles.tierWonBy}>Won By {winners.join(', ')}</span>
                    )}
                  </span>
                  <span className={styles.tierCounts}>
                    <span
                      className={`${styles.tierRemaining} ${exhausted ? styles.tierRemainingZero : ''}`}
                    >
                      {t.remaining.toLocaleString('en-US')} Remaining
                    </span>
                    <span className={styles.tierOriginal}>
                      {t.awarded.toLocaleString('en-US')} Awarded Of{' '}
                      {t.original.toLocaleString('en-US')}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </div>
        {(hiddenTierCount > 0 || showAllTiers) && tiers.length > 0 && (
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={() => setShowAllTiers((v) => !v)}
          >
            {showAllTiers
              ? 'Show Fewer Tiers'
              : `Show All ${tiers.length.toLocaleString('en-US')} Tiers`}
          </button>
        )}
      </section>

      {/* ══ B. AWARDED (sections 34, 35) ══ */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle}>Mystery Bounties Awarded</h4>
          <span className={styles.sectionNote}>
            {awards.length.toLocaleString('en-US')} Revealed
          </span>
        </div>
        <div className={styles.rows}>
          {awards.length === 0 ? (
            <div className={styles.empty}>
              {stage === 'pending'
                ? 'No Mystery Bounties Have Been Opened Yet'
                : 'The First Chest Has Not Been Opened Yet'}
            </div>
          ) : (
            visibleAwards.map((a) => (
              <div
                key={a.awardId}
                className={`${styles.awardRow} ${isHeadlineTier(a.tier) ? styles.awardHeadline : ''}`}
              >
                <span>
                  <span className={styles.awardWinners}>{winnerNames(a)}</span>
                  <span
                    className={styles.awardTier}
                    style={{ color: mysteryBountyTierColor(a.tier) }}
                  >
                    {mysteryBountyTierLabel(a.tier)}
                  </span>
                  <span className={styles.awardMeta}>
                    Knocked Out {a.eliminated.username}
                    {a.handId ? ` / Hand ${a.handId}` : ''}
                  </span>
                </span>
                <span>
                  <span className={styles.awardAmount}>
                    {formatCents(a.amountCents, unitCents)}
                  </span>
                  <span className={styles.awardWhen}>{shortWhen(a.revealedAt)}</span>
                </span>
              </div>
            ))
          )}
        </div>
        {awards.length > COLLAPSED_AWARD_LIMIT && (
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={() => setShowAllAwards((v) => !v)}
          >
            {showAllAwards
              ? 'Show Recent Only'
              : `Show All ${awards.length.toLocaleString('en-US')} Awards`}
          </button>
        )}
      </section>

      {/* ══ C. LEADERBOARD (section 36) ══ */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h4 className={styles.sectionTitle}>Mystery Bounty Leaderboard</h4>
          <span className={styles.sectionNote}>By Bounty Earnings</span>
        </div>
        <div className={styles.rows}>
          {leaderboard.length === 0 ? (
            <div className={styles.empty}>Nobody Has Won A Mystery Bounty Yet</div>
          ) : (
            leaderboard.map((row, i) => (
              <button
                type="button"
                key={row.userId}
                className={`${styles.lbRow} ${row.userId === currentUserId ? styles.lbRowMe : ''}`}
                onClick={() =>
                  setSelectedUserId((prev) => (prev === row.userId ? null : row.userId))
                }
              >
                <span className={styles.lbRank}>{i + 1}</span>
                <span className={styles.lbName}>
                  {row.username}
                  <span className={styles.lbCount}>
                    {row.bountiesWon.toLocaleString('en-US')} Bount
                    {row.bountiesWon === 1 ? 'y' : 'ies'} Won
                  </span>
                </span>
                <span className={styles.lbEarnings}>
                  {formatCents(row.earningsCents, unitCents)}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      {/* ══ Section 41: one player's payout, public ══ */}
      {selectedUserId && (
        <div className={styles.playerCard}>
          <div className={styles.playerHead}>
            <span className={styles.playerName}>
              {selectedBoardRow?.username ?? selectedTotals?.username ?? 'Player'}
            </span>
            <button
              type="button"
              className={styles.playerClose}
              onClick={() => setSelectedUserId(null)}
              aria-label="Close Player Payout"
            >
              X
            </button>
          </div>
          <div className={styles.playerGrid}>
            <div className={styles.playerStat}>
              <span className={styles.playerStatLabel}>Bounties Won</span>
              <span className={styles.playerStatValue}>
                {selectedBounties.toLocaleString('en-US')}
              </span>
            </div>
            <div className={styles.playerStat}>
              <span className={styles.playerStatLabel}>Bounty Earnings</span>
              <span className={styles.playerStatValue}>
                {formatCents(selectedEarnings, unitCents)}
              </span>
            </div>
            <div className={styles.playerStat}>
              <span className={styles.playerStatLabel}>Largest Bounty</span>
              <span className={styles.playerStatValue}>
                {formatCents(selectedTotals?.largestCents ?? 0, unitCents)}
              </span>
            </div>
            {isCompleted && (
              <>
                <div className={styles.playerStat}>
                  <span className={styles.playerStatLabel}>Final Position</span>
                  <span className={styles.playerStatValue}>
                    {playerPayout?.position ? `#${playerPayout.position}` : 'Not Finished'}
                  </span>
                </div>
                <div className={styles.playerStat}>
                  <span className={styles.playerStatLabel}>Tournament Prize</span>
                  <span className={styles.playerStatValue}>
                    {(playerPayout?.prize ?? 0).toLocaleString('en-US')}
                  </span>
                </div>
              </>
            )}
            <div className={`${styles.playerStat} ${styles.playerTotal}`}>
              <span className={styles.playerStatLabel}>Total Payout</span>
              <span className={`${styles.playerStatValue} ${styles.playerTotalValue}`}>
                {formatCents(
                  Math.round((playerPayout?.prize ?? 0) * 100) + selectedEarnings,
                  unitCents
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { MysteryBountyPanel };
