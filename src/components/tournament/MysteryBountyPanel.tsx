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
 *
 * ─── THE CONSOLE (#ClubArenaConsole, 2026-09-08) ─────────────────────────────
 *
 * The panel was a stack of rounded cards with a four-tile pool grid, a colour
 * swatch per tier and coloured tier names. It is Dan's approved spade master
 * now: MYSTERY BOUNTY is engraved in the header well, the stage sits in the
 * well's painted pill slot, and every figure prints as a row on the black glass
 * between the rails - label in the master's lit blue on the left, value in
 * silver on the right, an engraved rule between rows. The swatches are gone
 * (an emblem is part of the render or it is not there), and the tier colours
 * with them: the classifier's palette carries purples and cyans, and Dan's rule
 * is the house colours only. A headline tier reads in gold, an exhausted one in
 * muted ink, and nothing is drawn.
 *
 * MONEY STAYS EXACT HERE. `formatCents` is the panel's only money formatter and
 * tests/components/MysteryBountyPanel.test.tsx pins its output string for
 * string ("5,000 x1", "36 Mystery Bounties Drawn From A 13,000 Chip Pool"): a
 * bounty ladder is a list of prizes a player is being promised, so it is not a
 * browsing figure to abbreviate.
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
  mysteryBountyTierLabel,
} from '../../config/mysteryBountyTiers';
import { moneyAdjectiveAtUnit } from '../../utils/format';
import { SpadeConsole } from '../console/SpadeConsole';
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

  /* The stage, printed into the master's painted pill slot. Green while the
     chests are live, muted before they are drawn, blue once they are all out. */
  const stagePill = stage === 'active' ? 'Live' : stage === 'complete' ? 'Closed' : 'Pending';
  const stagePillInk: 'green' | 'blue' | 'muted' =
    stage === 'active' ? 'green' : stage === 'complete' ? 'blue' : 'muted';

  const selectedTotals = selectedUserId ? perPlayer.get(selectedUserId) : undefined;
  const selectedBoardRow = selectedUserId
    ? leaderboard.find((r) => r.userId === selectedUserId)
    : undefined;
  /* Leaderboard first: it is the server's own aggregate. The award-derived
     totals are the fallback and the only source for "largest". */
  const selectedBounties = selectedBoardRow?.bountiesWon ?? selectedTotals?.bountiesWon ?? 0;
  const selectedEarnings = selectedBoardRow?.earningsCents ?? selectedTotals?.earningsCents ?? 0;

  return (
    <SpadeConsole
      as="div"
      className={styles.panel}
      eyebrow="Mystery Bounty"
      title="Bounties"
      pill={stagePill}
      pillInk={stagePillInk}
      foot="foot"
    >
      {/* ── Section 10: the advertised top bounty, derived from real chests ── */}
      {top > 0 && (
        <div className={styles.headline}>
          <span className={`${styles.headlineLabel} sc-label sc-ink--blue`}>
            Top Mystery Bounty
          </span>
          <span className={`${styles.headlineValue} sc-ink--gold`}>{formatCents(top, unitCents)}</span>
          <span className={styles.headlineSub}>
            {counts.original.toLocaleString('en-US')} Mystery Bounties Drawn From A{' '}
            {formatCents(inventory?.poolCents ?? 0, unitCents)} {moneyAdjectiveAtUnit(unitCents)}{' '}
            Pool
          </span>
        </div>
      )}

      {/* ── Section 73: before it opens, say why ── */}
      <div className={styles.status}>
        {stage === 'active' && <span className={styles.livePulse} aria-hidden="true" />}
        <span>{activationStatusLine(inventory)}</span>
      </div>

      {/* Section 68: the largest bounty won so far, and who took it. Listed
          separately from the ladder because "the biggest one anybody has hit"
          is the number the rail actually follows, and it is one of the things
          that must move on a reveal without a refresh. Derived from the award
          rows, so a reload rebuilds it exactly. */}
      {biggest && (
        <div className={styles.status}>
          <span>
            Largest Mystery Bounty Won: {formatCents(biggest.amountCents, unitCents)} By{' '}
            {winnerNames(biggest.award)}
          </span>
        </div>
      )}

      {inventory && (
        <div className={styles.rows}>
          <div className={styles.figure}>
            <span className="sc-label sc-ink--blue">Bounty Pool</span>
            <span className={`${styles.figureValue} sc-ink--silver`}>
              {formatCents(inventory.poolCents, unitCents)}
            </span>
          </div>
          <div className={styles.figure}>
            <span className="sc-label sc-ink--blue">Awarded</span>
            <span className={`${styles.figureValue} sc-ink--silver`}>
              {formatCents(awardedCents(inventory), unitCents)}
            </span>
          </div>
          <div className={styles.figure}>
            <span className="sc-label sc-ink--blue">Still In Play</span>
            <span className={`${styles.figureValue} sc-ink--silver`}>
              {formatCents(remainingCents(inventory), unitCents)}
            </span>
          </div>
          <div className={styles.figure}>
            <span className="sc-label sc-ink--blue">Chests Left</span>
            <span className={`${styles.figureValue} sc-ink--silver`}>
              {counts.remaining.toLocaleString('en-US')} Of{' '}
              {counts.original.toLocaleString('en-US')}
            </span>
          </div>
        </div>
      )}

      {/* ══ A. PRIZES (sections 31, 32, 33, 47) ══ */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h4 className={`${styles.sectionTitle} sc-ink--silver`}>Mystery Bounty Prizes</h4>
          {pendingReveals > 0 && (
            <span className={`${styles.sectionNote} sc-ink--blue`}>Updating</span>
          )}
        </div>
        <div className={styles.rows}>
          {tiers.length === 0 ? (
            <div className={`${styles.empty} sc-copy sc-copy--center`}>
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
                  <span className={styles.tierMain}>
                    <span
                      className={`${styles.tierAmount} ${
                        exhausted
                          ? 'sc-ink--muted'
                          : isHeadlineTier(t.tier)
                            ? 'sc-ink--gold'
                            : 'sc-ink--silver'
                      }`}
                    >
                      {formatCents(t.amountCents, unitCents)} x{t.original.toLocaleString('en-US')}
                    </span>
                    <span className={`${styles.tierName} sc-label sc-ink--blue`}>
                      {mysteryBountyTierLabel(t.tier)}
                    </span>
                    {winners.length > 0 && (
                      <span className={`${styles.tierWonBy} sc-ink--muted`}>
                        Won By {winners.join(', ')}
                      </span>
                    )}
                  </span>
                  <span className={styles.tierCounts}>
                    <span
                      className={`${styles.tierRemaining} ${
                        exhausted ? 'sc-ink--muted' : 'sc-ink--silver'
                      }`}
                    >
                      {t.remaining.toLocaleString('en-US')} Remaining
                    </span>
                    <span className={`${styles.tierOriginal} sc-ink--muted`}>
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
            className={`${styles.collapseBtn} sc-ink--blue`}
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
          <h4 className={`${styles.sectionTitle} sc-ink--silver`}>Mystery Bounties Awarded</h4>
          <span className={`${styles.sectionNote} sc-ink--blue`}>
            {awards.length.toLocaleString('en-US')} Revealed
          </span>
        </div>
        <div className={styles.rows}>
          {awards.length === 0 ? (
            <div className={`${styles.empty} sc-copy sc-copy--center`}>
              {stage === 'pending'
                ? 'No Mystery Bounties Have Been Opened Yet'
                : 'The First Chest Has Not Been Opened Yet'}
            </div>
          ) : (
            visibleAwards.map((a) => (
              <div key={a.awardId} className={styles.awardRow}>
                <span className={styles.awardMain}>
                  <span className={`${styles.awardWinners} sc-ink--silver`}>{winnerNames(a)}</span>
                  <span
                    className={`${styles.awardTier} sc-label ${
                      isHeadlineTier(a.tier) ? 'sc-ink--gold' : 'sc-ink--blue'
                    }`}
                  >
                    {mysteryBountyTierLabel(a.tier)}
                  </span>
                  <span className={`${styles.awardMeta} sc-ink--muted`}>
                    Knocked Out {a.eliminated.username}
                    {a.handId ? ` / Hand ${a.handId}` : ''}
                  </span>
                </span>
                <span className={styles.awardSide}>
                  <span
                    className={`${styles.awardAmount} ${
                      isHeadlineTier(a.tier) ? 'sc-ink--gold' : 'sc-ink--silver'
                    }`}
                  >
                    {formatCents(a.amountCents, unitCents)}
                  </span>
                  <span className={`${styles.awardWhen} sc-ink--muted`}>
                    {shortWhen(a.revealedAt)}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
        {awards.length > COLLAPSED_AWARD_LIMIT && (
          <button
            type="button"
            className={`${styles.collapseBtn} sc-ink--blue`}
            onClick={() => setShowAllAwards((v) => !v)}
          >
            {showAllAwards
              ? 'Show Recent Only'
              : `Show All ${awards.length.toLocaleString('en-US')} Awards`}
          </button>
        )}
      </section>

      {/* ══ C. LEADERBOARD (section 36) ══
          Every button inside this section is a leaderboard ROW - the test reads
          them by role and indexes them. Do not add a control here. */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h4 className={`${styles.sectionTitle} sc-ink--silver`}>Mystery Bounty Leaderboard</h4>
          <span className={`${styles.sectionNote} sc-ink--blue`}>By Bounty Earnings</span>
        </div>
        <div className={styles.rows}>
          {leaderboard.length === 0 ? (
            <div className={`${styles.empty} sc-copy sc-copy--center`}>
              Nobody Has Won A Mystery Bounty Yet
            </div>
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
                <span className={`${styles.lbRank} sc-ink--blue`}>{i + 1}</span>
                <span className={`${styles.lbName} sc-ink--silver`}>
                  {row.username}
                  <span className={`${styles.lbCount} sc-ink--muted`}>
                    {row.bountiesWon.toLocaleString('en-US')} Bount
                    {row.bountiesWon === 1 ? 'y' : 'ies'} Won
                  </span>
                </span>
                <span className={`${styles.lbEarnings} sc-ink--silver`}>
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
            <span className={`${styles.playerName} sc-ink--white`}>
              {selectedBoardRow?.username ?? selectedTotals?.username ?? 'Player'}
            </span>
            <button
              type="button"
              className={`${styles.playerClose} sc-ink--blue`}
              onClick={() => setSelectedUserId(null)}
              aria-label="Close Player Payout"
            >
              Close
            </button>
          </div>
          <div className={styles.rows}>
            <div className={styles.figure}>
              <span className="sc-label sc-ink--blue">Bounties Won</span>
              <span className={`${styles.figureValue} sc-ink--silver`}>
                {selectedBounties.toLocaleString('en-US')}
              </span>
            </div>
            <div className={styles.figure}>
              <span className="sc-label sc-ink--blue">Bounty Earnings</span>
              <span className={`${styles.figureValue} sc-ink--silver`}>
                {formatCents(selectedEarnings, unitCents)}
              </span>
            </div>
            <div className={styles.figure}>
              <span className="sc-label sc-ink--blue">Largest Bounty</span>
              <span className={`${styles.figureValue} sc-ink--silver`}>
                {formatCents(selectedTotals?.largestCents ?? 0, unitCents)}
              </span>
            </div>
            {isCompleted && (
              <>
                <div className={styles.figure}>
                  <span className="sc-label sc-ink--blue">Final Position</span>
                  <span className={`${styles.figureValue} sc-ink--silver`}>
                    {playerPayout?.position ? `#${playerPayout.position}` : 'Not Finished'}
                  </span>
                </div>
                <div className={styles.figure}>
                  <span className="sc-label sc-ink--blue">Tournament Prize</span>
                  <span className={`${styles.figureValue} sc-ink--silver`}>
                    {(playerPayout?.prize ?? 0).toLocaleString('en-US')}
                  </span>
                </div>
              </>
            )}
            <div className={styles.figure}>
              <span className="sc-label sc-ink--blue">Total Payout</span>
              <span className={`${styles.figureValue} sc-ink--gold`}>
                {formatCents(
                  Math.round((playerPayout?.prize ?? 0) * 100) + selectedEarnings,
                  unitCents
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </SpadeConsole>
  );
}

export { MysteryBountyPanel };
