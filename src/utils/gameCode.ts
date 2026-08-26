/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  gameCode — the short game label a multi-table tab wears
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "that box should stay there regardless if i have a hand, if
 * i don't have a hand it should say the game type. (NLH, PLO PLO5 PLO6 SPIN,
 * MTT HU ETC)"
 *
 * A tab is ~100px wide, so the label has to be a CODE, not a table name. Table
 * names are unreliable for this anyway: a club owner can type anything into
 * the create-table form, and the multi-table container often has a tab on
 * screen before its TablePage has loaded a name at all ("Table 2").
 *
 * Priority is deliberate, and it is "what is this game" in the order a player
 * would answer it:
 *   1. SPIN  — a spin is a spin first and NLH second; that is how it is sold,
 *              lobbied and played.
 *   2. MTT / SNG — a tournament's format outranks its variant on a tab: the
 *              variant is on the felt, the format is what you are sitting in.
 *   3. HU    — a 2-seat CASH table. Heads-up is the defining fact of the game.
 *   4. variant — NLH / PLO / PLO5 / PLO6 / PLO8 / SHORT / PINE.
 *
 * Every input is optional and any shape (the enum arrives lowercase from
 * `tables.game_variant`, uppercase from `tableState.gameType`), because this
 * runs at first paint when only some of it is known.
 */

/** DB enum / engine variant token -> the acronym players use. */
const VARIANT_CODES: Record<string, string> = {
  nlh: 'NLH',
  nlhe: 'NLH',
  holdem: 'NLH',
  texas_holdem: 'NLH',
  plo: 'PLO',
  plo4: 'PLO',
  omaha: 'PLO',
  plo5: 'PLO5',
  plo6: 'PLO6',
  plo8: 'PLO8',
  short_deck: 'SHORT',
  shortdeck: 'SHORT',
  six_plus: 'SHORT',
  pineapple: 'PINE',
  crazy_pineapple: 'PINE',
};

export interface GameCodeInput {
  /** `tables.game_variant` ('plo5') or `tableState.gameType` ('PLO5'). */
  variant?: string | null;
  /** True for tournament tables (game_type='tournament' OR tournament_id set). */
  isTournament?: boolean | null;
  /** Resolved tournament format when known. */
  tournamentFormat?: 'spin' | 'sng' | 'mtt' | null;
  /** Seats at the table. 2 = heads-up. */
  maxPlayers?: number | null;
}

/**
 * The short code for a table, or '' when there is nothing to go on. Callers
 * treat '' as "no label yet" rather than printing an empty pill.
 */
export function gameCode(input: GameCodeInput): string {
  const { variant, isTournament, tournamentFormat, maxPlayers } = input;

  if (tournamentFormat === 'spin') return 'SPIN';
  if (isTournament) {
    if (tournamentFormat === 'sng') return 'SNG';
    // An unresolved tournament is an MTT until its format says otherwise -
    // MTT is the overwhelming majority and the least surprising guess.
    return 'MTT';
  }
  // Heads-up cash. Checked AFTER tournaments so a 2-seat SNG still reads SNG.
  if (typeof maxPlayers === 'number' && maxPlayers === 2) return 'HU';

  const token = String(variant ?? '')
    .trim()
    .toLowerCase();
  if (!token) return '';
  if (VARIANT_CODES[token]) return VARIANT_CODES[token];
  // An unknown variant is still better shown than hidden: uppercase it and
  // keep it short enough for the pill.
  return token
    .replace(/[^a-z0-9]+/g, '')
    .toUpperCase()
    .slice(0, 6);
}

/**
 * Last-resort code recovered from a table NAME, for the first paint of a tab
 * whose TablePage has not reported yet (a lobby link, a deep link, the
 * server-truth rebuild). Names usually lead with the variant - "NLH 0.05/0.10",
 * "PLO5 Deep 1/2" - so the first token that is a known variant wins.
 *
 * Returns '' when the name carries no recognisable variant, which is correct:
 * the authoritative code arrives from TablePage a moment later.
 */
export function gameCodeFromName(name?: string | null): string {
  if (!name) return '';
  for (const raw of String(name).split(/[^A-Za-z0-9_]+/)) {
    const token = raw.toLowerCase();
    if (!token) continue;
    if (VARIANT_CODES[token]) return VARIANT_CODES[token];
    if (token === 'spin') return 'SPIN';
    if (token === 'mtt') return 'MTT';
    if (token === 'sng') return 'SNG';
  }
  return '';
}
