/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT VARIANT CATALOGUE — the one list of games a tournament can be
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS ITS OWN MODULE (2026-08-31). The map below used to live inside
 * `lib/tournamentFromTableConfig`, which imports PayoutEngine, the blind
 * structures and the buy-in maths. The lobby's filter spec needs the same list
 * and nothing else from that file, so importing it from there would drag the
 * whole tournament-building graph into a module whose own header insists it is
 * pure data. A catalogue is config; it lives in config.
 *
 * Everything that answers "which games exist as tournaments" now reads THIS
 * file: the create-table form's SNG/MTT gate, CreateTournamentModal's Game
 * dropdown, and the Games chips on the lobby's MTT, Heads Up and Spins tabs.
 * That matters more here than almost anywhere else, because the two ways for
 * those lists to disagree are both SILENT:
 *
 *   • a CHIP whose key nothing can produce empties the tab when it is ticked
 *     (this happened to an FLH chip, and to an "OMAHA High" chip, and both had
 *     to be deleted);
 *   • a PRODUCIBLE VARIANT with no chip is deleted from the board the moment a
 *     player ticks any other chip (this happened to Pineapple cash tables, and
 *     was live for PLO8 Sit & Gos and for PLO8 / Short Deck Spins until this
 *     module landed).
 *
 * One list feeding both makes each of those impossible rather than unlikely.
 */

import { SPIN_GAME_TYPES } from './spinSpec';

/** The engine vocabulary a tournament's `game_type` is allowed to hold. */
export type TournamentGameVariant =
  | 'NLH'
  | 'PLO4'
  | 'PLO5'
  | 'PLO6'
  | 'PLO8'
  | 'SHORT_DECK'
  | 'FLH'
  | 'FLO8';

/**
 * The create-table route's `:gameType` -> the tournament engine's vocabulary.
 * Anything not listed cannot be run as a tournament, and hides the SNG/MTT tabs.
 *
 * 2026-08-24: THE KEYS WERE WRONG AND HAD ALWAYS BEEN WRONG. This map was keyed
 * `plo` and `shortdeck`; the create-table screen has only ever emitted `plo4`
 * and `short_deck`. Neither matched, so `canRunAsTournament` answered false for
 * every game except Hold'em and the SNG/MTT tabs were hidden on all of them —
 * while production was already running 3,100 PLO4, 1,548 PLO5, 945 PLO6, 41
 * PLO8 and a Short Deck tournament, created through the recurring service. The
 * platform ran the games; only that screen could not make one. (The identical
 * stale-key bug was in TableConfigPage's GAME_TYPE_LABELS, fixed in #594.)
 *
 * The value is written to `tournaments.game_type`, which TournamentManagerBase
 * lowercases into the table's `game_variant`, so each entry must be a variant
 * the engine genuinely deals — verified against server/src/engine/VariantRules.ts
 * and against the live rows above.
 *
 * ── LIMIT IS IN, AS OF 2026-08-31 ────────────────────────────────────────────
 * Dan: "LIMIT POKER NEEDS TO BE ADDED TO THE GAME VARIATIONS FILTER", pointing
 * at the Heads Up tab — whose Games row could not offer it, because no limit
 * tournament could exist to be filtered.
 *
 * The note that used to sit here said a limit tournament "raises stakes on a
 * bet-size ladder, and every blind structure here is a blind ladder. Offering
 * them would deal limit and escalate it like no-limit." That is wrong about
 * THIS engine, and the code it was describing proves it:
 *
 *   • `fixedLimitBetSize(bigBlind, stage)` derives the whole bet ladder from
 *     the big blind — small bet = BB preflop and flop, big bet = 2x BB on turn
 *     and river (server/src/engine/BettingStructure.ts). There is no second
 *     ladder to author.
 *   • The tournament engine rewrites `tables.small_blind` / `big_blind` on
 *     every level change (TournamentManagerBase: `small_blind: level.smallBlind`),
 *     so the limits escalate with the level automatically and exactly.
 *   • A blind ladder IS a limit ladder in fixed-limit poker: a level posting
 *     50/100 is a 100/200 limit game. That is the live and online convention
 *     BettingStructure's own header documents and `stakesLabel()` already
 *     prints.
 *
 * So a limit tournament escalates correctly with no new structure, and the only
 * thing the old exclusion bought was a LIMIT lobby tab no tournament could ever
 * reach. Fixed-limit Hold'em and Omaha Hi-Lo are standard tournament games.
 *
 * Still absent, deliberately:
 *  • `pineapple` — its discard street has no tournament timing path, and no
 *    PINEAPPLE tournament has ever been played. One legacy `OFC_PINEAPPLE` row
 *    exists and stays filterable; see advancedFilterSpec's MTT row.
 */
export const TOURNAMENT_GAME_VARIANTS: Record<string, TournamentGameVariant> = {
  nlh: 'NLH',
  plo4: 'PLO4',
  plo5: 'PLO5',
  plo6: 'PLO6',
  plo8: 'PLO8',
  short_deck: 'SHORT_DECK',
  flh: 'FLH',
  flo8: 'FLO8',
};

/** Every variant runnable as a tournament, as the lower-case filter-chip keys. */
export const TOURNAMENT_VARIANT_KEYS: readonly string[] = Object.keys(TOURNAMENT_GAME_VARIANTS);

/** Can this game be run as a tournament at all? */
export function canRunAsTournament(gameType: string | undefined): boolean {
  return Boolean(TOURNAMENT_GAME_VARIANTS[(gameType ?? 'nlh').toLowerCase()]);
}

/**
 * Spins are a CATALOGUE, not a variant switch. `SPIN_GAME_TYPES` advertises
 * NLH, PLO4, PLO5 and PLO6; the tier table is tuned around them, and
 * TournamentRecurringService will only ever mint those four.
 *
 * Nothing enforced that on the MANUAL path, so a Short Deck or PLO8 Spin was
 * creatable from the create-table form and from the tournament modal, while the
 * Spins tab of the lobby filter carried no chip for either — ticking any chip
 * deleted such a game from the board with nothing to bring it back. Rather than
 * invent chips for a product the spin catalogue does not sell, the catalogue is
 * enforced where spins are authored.
 */
export function canRunAsSpin(gameType: string | undefined): boolean {
  /* Accepts EITHER vocabulary. The create-table route speaks lower case
     ('short_deck'), CreateTournamentModal speaks the engine's upper case
     ('SHORT_DECK'), and a guard that silently answered false for one of them
     would be worse than no guard: it would delete the Spins option from a
     screen that is allowed to show it. */
  const key = TOURNAMENT_GAME_VARIANTS[(gameType ?? 'nlh').toLowerCase()];
  return Boolean(key && (SPIN_GAME_TYPES as readonly string[]).includes(key));
}

/** The spin catalogue as filter-chip keys, for the Spins tab's Games row. */
export const SPIN_VARIANT_KEYS: readonly string[] = TOURNAMENT_VARIANT_KEYS.filter(canRunAsSpin);
