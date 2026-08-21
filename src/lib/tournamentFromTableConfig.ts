/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CREATE-TABLE CONFIG -> TOURNAMENT CONFIG
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TableConfigPage on 2026-08-19 so the mapping can be tested
 * without rendering the page. The mapping is where every silently-ignored
 * setting would come back, so it is the part worth pinning.
 */
import { BLIND_STRUCTURES, SPIN_BLIND_STRUCTURE } from '../config/blindStructures';
// Type-only: erased at compile time, so this module never boots the Supabase
// client that TournamentService constructs at import.
import type { TournamentConfig } from '../services/TournamentService';
import { payoutEngine } from '../services/PayoutEngine';
import { splitBuyIn } from '../utils/buyIn';

/**
 * The route's :gameType -> the tournament engine's variant vocabulary.
 * Anything not listed cannot be run as a tournament: HandController defaults an
 * unknown variant to 2 cards and a full deck, so 'flh' or 'mixed' would quietly
 * deal plain Hold'em. Those game types hide the SNG/MTT tabs instead.
 */
const TOURNAMENT_GAME_VARIANTS: Record<string, 'NLH' | 'PLO4' | 'SHORT_DECK'> = {
  nlh: 'NLH',
  plo: 'PLO4',
  shortdeck: 'SHORT_DECK',
};


/** The subset of the create-table form a tournament actually uses. */
export interface TournamentFormInput {
  name: string;
  gameMode: 'regular' | 'sng' | 'mtt';
  buyIn: number;
  startingChips: number;
  blindStructure: string;
  blindsUpMinutes: number;
  payoutStructure: string;
  sngPlayerCount: number;
  isSpins: boolean;
  minPlayers: number;
  maxPlayersRange: number;
  lateRegistrationLevel: number;
  numberOfRebuysReentries: number;
  addOnMultiplier: number;
  koBounty: boolean;
  startTime: string;
}

export function canRunAsTournament(gameType: string | undefined): boolean {
  return Boolean(TOURNAMENT_GAME_VARIANTS[gameType ?? 'nlh']);
}

  /**
   * SNG / MTT tabs -> a real tournament.
   *
   * 2026-08-19. Until now these tabs inserted a row into `tables` exactly like
   * the Regular tab and produced an ordinary CASH GAME with the configured
   * blinds. Every tournament control on them — buy-in, blind structure,
   * payouts, starting chips, late registration, rebuys, add-ons, bounties —
   * wrote a `tables` column that nothing in server/src reads. Real tournaments
   * live in the `tournaments` table and are run by TournamentManager.
   *
   * Only fields the tournament engine actually consumes are mapped here.
   * Controls it cannot honour are hidden on these tabs rather than left on
   * screen doing nothing.
   */
export function buildTournamentConfig(
  config: TournamentFormInput,
  gameType: string | undefined
): TournamentConfig {
  const isSng = config.gameMode === 'sng';
  const isSpins = isSng && config.isSpins;

  // Field size. For an SNG the engine starts the tournament only when it is
  // FULL (GameServer: isSngOrSpin ? maxReached : ...), so min must equal max
  // or it would sit in REGISTERING until the stale-SNG sweeper cancels it.
  // Clamped, not trusted: fn_create_tournament rejects a non-positive field
  // with max_players_must_be_positive, and 0 is not "unlimited" — registration
  // is refused once current_players >= max_players, so 0 locks everyone out.
  const rawMax = isSng ? config.sngPlayerCount : config.maxPlayersRange;
  const maxPlayers = Math.max(2, Math.floor(Number(rawMax) || 0) || 2);
  const minPlayers = isSng
    ? maxPlayers
    : Math.min(maxPlayers, Math.max(2, Math.floor(Number(config.minPlayers) || 0) || 2));

  // Blind ramp from the shared presets, with the owner's level length applied
  // to the playing levels. Break rows keep their own duration, and the blinds
  // themselves are untouched — the service validates that they never decrease.
  const preset = isSpins
    ? SPIN_BLIND_STRUCTURE
    : (BLIND_STRUCTURES[
      ({ slow: 'deepStack', standard: 'regular', turbo: 'turbo', hyper_turbo: 'turbo' } as const)[
      config.blindStructure
      ] ?? 'regular'
    ] as typeof SPIN_BLIND_STRUCTURE);
  const levelMinutes = Math.max(1, config.blindsUpMinutes);
  const blindStructure = preset.map((lvl) =>
    lvl.isBreak ? lvl : { ...lvl, durationMinutes: levelMinutes }
  );

  // Payouts. A spin is winner-take-all by definition; otherwise scale the
  // shape to the field. normalizePayouts guarantees exactly 100%, which the
  // service and the engine both require.
  const payoutStructure = isSpins
    ? [{ place: 1, percentage: 100 }]
    : config.payoutStructure === 'winner_take_all'
    ? [{ place: 1, percentage: 100 }]
    : payoutEngine.normalizePayouts(payoutEngine.autoSelectPayouts(maxPlayers));

  // WHOLE-DOLLAR BUY-IN (Dan 2026-08-20): "Sit and Go and any tournament
  // buy-ins must never be decimal buy-ins, whole numbers only." The Buy-in
  // slider on the create-table form already steps in whole chips; rounding here
  // is the backstop for a restored draft or a programmatic config. `buyIn` is
  // the TOTAL the player pays and the 10% fee is a cut OUT of it, so both
  // halves of the split are whole numbers too.
  const buyIn = Math.max(0, Math.round(Number(config.buyIn) || 0));
  const split = splitBuyIn(buyIn);

  return {
    name: config.name.trim() || 'Tournament',
    type: isSpins ? 'spin' : isSng ? 'sng' : config.koBounty ? 'bounty' : 'mtt',
    buyIn: split.total,
    // The house takes 10% of the buy-in on every tournament, rounded to a whole
    // number. It is recomputed identically server-side in fn_create_tournament;
    // this is only what the UI shows.
    rake: split.fee,
    startingStack: config.startingChips,
    maxPlayers,
    minPlayers,
    blindStructure,
    payoutStructure,
    lateRegistrationLevels: config.gameMode === 'mtt' ? config.lateRegistrationLevel : 0,
    // The MTT start time IS honoured: the discovery loop starts an MTT once
    // start_time has passed and the minimum field is present. An SNG ignores
    // it for starting (it starts when full) but still needs a value, and a
    // time in the past would trip the 30-minute auto-cancel immediately — so
    // anything not in the future falls back to the service default.
    startTime:
    config.gameMode === 'mtt' && config.startTime
      ? (() => {
        const when = new Date(config.startTime);
        return Number.isFinite(when.getTime()) && when.getTime() > Date.now()
        ? when
        : undefined;
      })()
      : undefined,
    isRebuy: config.numberOfRebuysReentries > 0,
    isReentry: config.numberOfRebuysReentries > 0,
    rebuyCost: split.total,
    rebuyChips: config.startingChips,
    addOnAvailable: config.addOnMultiplier > 0,
    addOnCost: split.total,
    addOnChips: Math.round(config.startingChips * Math.max(1, config.addOnMultiplier)),
    addOnLevels: 1,
    guaranteedPrize: 0,
    gameVariant: TOURNAMENT_GAME_VARIANTS[gameType ?? 'nlh'] ?? 'NLH',
    spinType: isSpins ? 'standard' : undefined,
    // Half the buy-in as the head, floored to a whole number so the bounty can
    // never be a decimal and can never exceed the prize half of the split.
    bountyConfig: config.koBounty
    ? { baseBounty: Math.min(split.prize, Math.floor(split.total * 0.5)) }
    : undefined,
  } as TournamentConfig;
}

