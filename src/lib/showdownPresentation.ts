/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHOWDOWN PRESENTATION — pure logic, extracted from TablePage (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * TablePage is a 13k-line component whose hand-lifecycle beats used to be
 * decided inline, mid-handler, where nothing could unit-test them. Everything
 * in this module is a PURE function over wire payloads: no React, no timers,
 * no globals. TablePage calls these and owns only the state and the clocks.
 *
 * The wire shapes come from the engine's pot_win event (see
 * ServerTableEngineHandEvents.buildPotAwardGroups): `pot_awards` is the
 * ordered, UNMERGED per-pot(-half) breakdown — board 1 before board 2, main
 * pot before side pots, high half before low half. Older payloads without it
 * degrade to per-winner pot_index grouping, and older still to one group.
 */

export interface PotAwardWinnerWire {
  user_id: string;
  amount: number;
  hand_name?: string;
  hand_description?: string;
  hole_card_indices?: number[];
}

export interface PotAwardGroupWire {
  pot_index: number;
  /**
   * POKERBROS PARITY 2026-08-26: 1|2 on double-board bomb pots, RUN index
   * 1..3 on run-it-twice hands. Ordering by this axis is what makes RIT pots
   * ship board by board.
   */
  board?: number;
  low?: boolean;
  winners: PotAwardWinnerWire[];
}

export interface FlatWinnerWire {
  user_id: string;
  amount: number;
  hand_name?: string;
  hand_description?: string;
  hole_card_indices?: number[];
  pot_index?: number;
}

/** One sequenced award beat: every winner in it animates together. */
export interface AwardGroup {
  potIndex: number;
  /** 1|2 on double-board bomb pots; RUN index 1..3 on run-it-twice hands. */
  board: number;
  low: boolean;
  winners: Array<{ userId: string; amount: number }>;
  /**
   * Review fix 2026-08-25: true when this group came from the engine's
   * `pot_awards` breakdown, whose amounts are EXACT post-rake per-pot
   * shares. Consumers must render those amounts verbatim — a zero share is
   * a real zero, not missing data — and must not fall back to merged totals
   * or equal-split estimates. False for the legacy pot_index / single-group
   * degradations, where estimating is the best available.
   */
  exact: boolean;
}

/**
 * Build the ordered award beats for a pot_win event.
 *
 * Preference order (spec 16/19):
 *  1. `pot_awards` — the engine's authoritative unmerged groups, already in
 *     award order with exact per-pot shares. This is the only source that
 *     sequences correctly when ONE player wins several pots.
 *  2. Per-winner `pot_index` grouping over the flat winners list (the
 *     2026-08-25 interim wire) — correct when different players win
 *     different pots, merged when one player spans pots.
 *  3. A single group of all winners (pre-2026-08-25 payloads).
 */
export function buildAwardGroups(
  potAwards: PotAwardGroupWire[] | undefined,
  flatWinners: FlatWinnerWire[],
  winnerIds: string[],
  fallbackAmounts: Record<string, number>
): AwardGroup[] {
  if (Array.isArray(potAwards) && potAwards.length > 0) {
    return potAwards
      .map((g) => ({
        potIndex: g.pot_index ?? 0,
        board: typeof g.board === 'number' && g.board >= 1 ? g.board : 1,
        low: g.low === true,
        winners: (g.winners ?? [])
          .filter((w) => w && typeof w.user_id === 'string')
          .map((w) => ({ userId: w.user_id, amount: w.amount ?? 0 })),
        exact: true,
      }))
      .filter((g) => g.winners.length > 0);
  }

  const winners =
    flatWinners.length > 0
      ? flatWinners.map((w) => ({
          userId: w.user_id,
          amount: w.amount ?? fallbackAmounts[w.user_id] ?? 0,
          potIndex: w.pot_index ?? 0,
        }))
      : winnerIds.map((id) => ({ userId: id, amount: fallbackAmounts[id] ?? 0, potIndex: 0 }));
  if (winners.length === 0) return [];

  const byPot = new Map<number, Array<{ userId: string; amount: number }>>();
  for (const w of winners) {
    const g = byPot.get(w.potIndex);
    if (g) g.push({ userId: w.userId, amount: w.amount });
    else byPot.set(w.potIndex, [{ userId: w.userId, amount: w.amount }]);
  }
  return [...byPot.keys()]
    .sort((a, b) => a - b)
    .map((potIndex) => ({
      potIndex,
      board: 1 as const,
      low: false,
      winners: byPot.get(potIndex)!,
      exact: false,
    }));
}

/** What the board label above the felt should say for this settlement. */
export interface BoardLabel {
  handName: string;
  handDescription: string;
  /**
   * Spec 33: on a hi-lo split, the low half gets its own line — the
   * qualifying low's self-describing name ("Low: 8-6-4-3-2") prefixed for
   * the table. Empty when no low was awarded.
   */
  lowWinnerLabel: string;
}

/**
 * Derive the board label from the award groups, falling back to the flat
 * winners' first entry (the pre-groups behaviour) when groups are absent.
 * The HIGH half of the main pot names the hand; a LOW half anywhere adds
 * the low line.
 */
export function boardLabelFromAwards(
  potAwards: PotAwardGroupWire[] | undefined,
  fallbackName: string,
  fallbackDescription: string
): BoardLabel {
  if (!Array.isArray(potAwards) || potAwards.length === 0) {
    return { handName: fallbackName, handDescription: fallbackDescription, lowWinnerLabel: '' };
  }
  const hi = potAwards.find((g) => g.low !== true && (g.winners?.length ?? 0) > 0);
  const lo = potAwards.find((g) => g.low === true && (g.winners?.length ?? 0) > 0);
  const hiWinner = hi?.winners?.[0];
  const loName = lo?.winners?.[0]?.hand_name ?? '';
  return {
    handName: hiWinner?.hand_name || fallbackName,
    handDescription: hiWinner?.hand_description || fallbackDescription,
    // The engine's low name is already self-describing ("Low: 8-6-4-3-2").
    lowWinnerLabel: loName,
  };
}

/**
 * Spec 21: the display hold on a winner's stack — the share not yet visually
 * delivered. Returns 0 when the player is not a pending winner or the hold
 * has been released.
 */
/**
 * ── PER-BOARD RELEASE (2026-09-05, run-it-twice parity) ──
 *
 * `released` used to be the whole story: one boolean, flipped once, after the
 * LAST award group's fan landed. On a single-board hand that is right — one
 * ship, one release. On a run-it-twice or run-it-three-times hand it is the
 * reported bug. The engine credits ONE merged total, the seat holds ALL of it
 * through boards 1..N-1, and the stack then jumps by the entire amount in a
 * single step at the end.
 *
 * The reference client (PokerBros, frame-verified 2026-09-05) pays each board
 * as it lands: a player taking two of three boards is seen going 0 → 2.73 →
 * 5.46, each step landing with that board's own chip fan. Ours went
 * 0 → 0 → 5.46.
 *
 * `releasedByPlayer` carries the amount already visually delivered to each
 * player, accumulated one award group at a time as each fan arrives, so the
 * seat rises in the same beats the chips do.
 *
 * The subtraction is done in integer cents. These are two independently
 * rounded money paths meeting; a float subtraction leaves 0.00499… behind and
 * renders as a stack permanently a cent short of the truth.
 *
 * `released === true` still short-circuits to zero: it is the backstop
 * (HAND_COMPLETE, HAND_STARTED) and must always be able to end the hold
 * outright, whatever the per-player ledger says.
 */
export function pendingStackHold(
  engineWinners: Array<{ userId: string; amount: number }> | undefined,
  playerId: string,
  released: boolean,
  releasedByPlayer?: Readonly<Record<string, number>>
): number {
  if (released || !engineWinners) return 0;
  const w = engineWinners.find((x) => x.userId === playerId);
  if (!w || !(w.amount > 0)) return 0;
  const shipped = releasedByPlayer?.[playerId] ?? 0;
  if (!(shipped > 0)) return w.amount;
  const remainingCents = Math.round(w.amount * 100) - Math.round(shipped * 100);
  return remainingCents > 0 ? remainingCents / 100 : 0;
}
