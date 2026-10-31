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

/** Legacy Lightning frames carried the controller's flat per-pot awards. */
export interface FlatPotAwardWire {
  userId: string;
  amount: number;
  potIndex: number;
  board?: number;
  low?: boolean;
  hand?: { name?: string };
  handDescription?: string;
}

/** Read old Lightning frames at the same boundary as grouped physical frames. */
export function normalizePotAwardWire(
  awards: PotAwardGroupWire[] | FlatPotAwardWire[] | undefined
): PotAwardGroupWire[] | undefined {
  if (!Array.isArray(awards) || !awards.length || !awards.every((a) => a && 'userId' in a))
    return awards as PotAwardGroupWire[] | undefined;
  const groups = new Map<string, PotAwardGroupWire>();
  for (const award of awards as FlatPotAwardWire[]) {
    const board = typeof award.board === 'number' && award.board >= 1 ? award.board : 1;
    const potIndex = award.potIndex ?? 0;
    const low = award.low === true;
    const key = `${board}:${potIndex}:${low}`;
    let group = groups.get(key);
    if (!group) {
      group = { board, pot_index: potIndex, low, winners: [] };
      groups.set(key, group);
    }
    group.winners.push({
      user_id: award.userId,
      amount: award.amount,
      hand_name: award.hand?.name,
      hand_description: low ? award.hand?.name : award.handDescription,
    });
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.board ?? 1) - (b.board ?? 1) || a.pot_index - b.pot_index || Number(a.low) - Number(b.low)
  );
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
  potAwards: PotAwardGroupWire[] | FlatPotAwardWire[] | undefined,
  flatWinners: FlatWinnerWire[],
  winnerIds: string[],
  fallbackAmounts: Record<string, number>
): AwardGroup[] {
  potAwards = normalizePotAwardWire(potAwards);
  if (Array.isArray(potAwards) && potAwards.length > 0) {
    // The serving Lightning engine used the flat controller shape here.
    // Preserve its exact per-pot shares instead of falling through to an
    // equal split of the gross pot when every missing winners[] reads empty.
    return (potAwards as PotAwardGroupWire[])
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

/**
 * ── THE ALL-IN SHOWDOWN, AND WHO WON IT (Dan 2026-10-24) ──
 *
 * Dan, verbatim: "WHEN PLAYERS ARE ALL IN, ON THE RIVER, KEEP THE CARDS
 * SHOWN FOR 2 MORE SECONDS, AND PROPERLY DISPLAY AND ANNOUCE THE WINNING
 * HANDS BETTER..."
 *
 * `isAllInShowdown` is the client's half of the engine's question
 * (server/src/engine/presentation/handEventFrames.ts isAllInShowdown): two or
 * more hands reached showdown and at least one of them belongs to a player
 * whose seat is all-in. Both sides pass the answer to handCompletionHoldMs,
 * so the felt and the engine hold for the same ALL_IN_SHOWDOWN_EXTRA_MS.
 */
export function isAllInShowdown(
  shownUserIds: readonly string[],
  players: ReadonlyArray<{ id: string; status?: string } | null | undefined>
): boolean {
  if (shownUserIds.length < 2) return false;
  const shown = new Set(shownUserIds);
  return players.some((p) => !!p && shown.has(p.id) && p.status === 'all_in');
}

/**
 * The line that says WHO won, printed on the board's winning-hand band above
 * the hand's name. The hand name alone ("Full House") never said whose it
 * was; at a full ring the player had to find the lit seat to learn it.
 * Empty when nobody is known. No em dashes, first letter of every word
 * capitalized at render (formatPopupText), and no currency sign.
 */
export function showdownWinnerLine(names: readonly string[]): string {
  const clean = names.map((n) => (n ?? '').trim()).filter((n) => n.length > 0);
  if (clean.length === 0) return '';
  if (clean.length === 1) return `${clean[0]} Wins`;
  if (clean.length === 2) return `${clean[0]} And ${clean[1]} Split The Pot`;
  return `${clean.length} Players Split The Pot`;
}

/**
 * Every tabled hand's name at showdown, keyed by player. The engine's
 * `showdown` event already carries `hand_name` for each hand it turned face
 * up (blank for a mucked hand, whose identity stays private), but only the
 * WINNER's seat ever printed one, so a beaten hand sat face up with nothing
 * to say what it was. Mucked and nameless rows are left out.
 */
export function showdownHandNamesFrom(
  results: ReadonlyArray<{ user_id?: string; hand_name?: string; mucked?: boolean }> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of results ?? []) {
    if (!r || typeof r.user_id !== 'string' || r.mucked === true) continue;
    const name = typeof r.hand_name === 'string' ? r.hand_name.trim() : '';
    if (name) out[r.user_id] = name;
  }
  return out;
}
