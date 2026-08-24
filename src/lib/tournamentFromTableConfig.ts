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
import { maxSeatsTheDeckAllows } from '../config/tableSeating';


/**
 * The route's :gameType -> the tournament engine's variant vocabulary.
 * Anything not listed cannot be run as a tournament, and hides the SNG/MTT tabs.
 *
 * 2026-08-24: THE KEYS WERE WRONG AND HAD ALWAYS BEEN WRONG. This map was keyed
 * `plo` and `shortdeck`; the create-table screen has only ever emitted `plo4`
 * and `short_deck`. Neither matched, so `canRunAsTournament` answered false for
 * every game except Hold'em and the SNG/MTT tabs were hidden on all of them —
 * while production was already running 3,100 PLO4, 1,548 PLO5, 945 PLO6, 41
 * PLO8 and a Short Deck tournament, created through the recurring service. The
 * platform ran the games; only this screen could not make one. (The identical
 * stale-key bug was in TableConfigPage's GAME_TYPE_LABELS, fixed in #594.)
 *
 * The value is written to `tournaments.game_type`, which
 * TournamentManagerBase lowercases into the table's `game_variant`, so each
 * entry must be a variant the engine genuinely deals — verified against
 * server/src/engine/VariantRules.ts and against the live rows above.
 *
 * Still absent, deliberately:
 *  • `pineapple` — its discard street has no tournament timing path, and no
 *    PINEAPPLE tournament has ever existed.
 *  • `flh` / `flo8` — a limit tournament raises stakes on a bet-size ladder,
 *    and every blind structure here is a no-limit/pot-limit blind ladder.
 *    Offering them would deal limit and escalate it like no-limit.
 */
const TOURNAMENT_GAME_VARIANTS: Record<
  string,
  'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8' | 'SHORT_DECK'
> = {
  nlh: 'NLH',
  plo4: 'PLO4',
  plo5: 'PLO5',
  plo6: 'PLO6',
  plo8: 'PLO8',
  short_deck: 'SHORT_DECK',
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

  // ── PokerBros parity (2026-08-22). Optional so restored drafts and older
  // callers keep working; every one maps to an fn_create_tournament key. ──
  isPrivate?: boolean;
  isVipOnly?: boolean;
  shortDescription?: string;
  banChat?: boolean;
  allInOrFold?: boolean;
  labelAsNew?: boolean;
  hideClubName?: boolean;
  featuredTournament?: boolean;
  tableSize?: number;
  actionTimeSeconds?: number;
  acceleratedMtt?: boolean;
  bigBlindAnte?: boolean;
  authorizedToRegister?: boolean;
  synchronizedBreaks?: boolean;
  customRebuyReentryCost?: boolean;
  rebuyReentryCost?: number;
  customAddOn?: boolean;
  customAddOnCost?: number;
  addOnBreakLengthMinutes?: number;
  gtdPrizePool?: boolean;
  gtdPrizeAmount?: number;
  finalTableDeal?: boolean;
  earlyBirdRegistration?: boolean;
  earlyBirdChips?: number;
  bubbleProtection?: boolean;
  multiDayMtt?: boolean;
  totalDays?: number;
  restartTournamentEvery?: boolean;
  restartEveryMinutes?: number;
  nextStepSatellite?: boolean;
  satelliteTargetId?: string;
  satelliteSeats?: number;
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
  // 2026-08-22: hyper_turbo maps to the REAL hyperTurbo ramp now (2-minute
  // levels, steeper jumps) instead of silently aliasing to turbo.
  const preset = isSpins
    ? SPIN_BLIND_STRUCTURE
    : (BLIND_STRUCTURES[
      ({
        slow: 'deepStack',
        standard: 'regular',
        turbo: 'turbo',
        hyper_turbo: 'hyperTurbo',
      } as const)[config.blindStructure] ?? 'regular'
    ] as typeof SPIN_BLIND_STRUCTURE);
  const levelMinutes = Math.max(1, config.blindsUpMinutes);
  const blindStructure = preset.map((lvl) =>
    lvl.isBreak ? lvl : { ...lvl, durationMinutes: levelMinutes }
  );

  // Payouts. A spin is winner-take-all by definition; otherwise the owner's
  // Payout Structure choice is HONOURED (2026-08-22 — payout1/2/3 used to
  // fall through to autoSelectPayouts, so all four choices were identical).
  // payoutsForChoice normalizes to exactly 100%, which the service and the
  // engine both require, and pays fewer places than the field.
  const payoutStructure = isSpins
    ? [{ place: 1, percentage: 100 }]
    : payoutEngine.payoutsForChoice(config.payoutStructure, maxPlayers);

  // WHOLE-DOLLAR BUY-IN (Dan 2026-08-20): "Sit and Go and any tournament
  // buy-ins must never be decimal buy-ins, whole numbers only." The Buy-in
  // slider on the create-table form already steps in whole chips; rounding here
  // is the backstop for a restored draft or a programmatic config. `buyIn` is
  // the TOTAL the player pays and the 10% fee is a cut OUT of it, so both
  // halves of the split are whole numbers too.
  const buyIn = Math.max(0, Math.round(Number(config.buyIn) || 0));
  const split = splitBuyIn(buyIn);

  const isMtt = config.gameMode === 'mtt';
  const clampInt = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

  // Next Step (Satellite): only real with a target — a satellite without a
  // target would silently pay cash, defeating the point.
  const isSatellite = isMtt && Boolean(config.nextStepSatellite && config.satelliteTargetId);

  // Rebuy / add-on money. Custom toggles switch the derived cost for a typed
  // whole number; the whole-number rule is enforced by rounding here and
  // refused (not rounded) server-side, matching the rest of the money path.
  const rebuyCost =
    config.customRebuyReentryCost && (config.rebuyReentryCost ?? 0) > 0
      ? Math.round(config.rebuyReentryCost!)
      : split.total;
  const addOnCost =
    config.customAddOn && (config.customAddOnCost ?? 0) > 0
      ? Math.round(config.customAddOnCost!)
      : split.total;

  return {
    name: config.name.trim() || 'Tournament',
    type: isSpins
      ? 'spin'
      : isSng
        ? 'sng'
        : isSatellite
          ? 'satellite'
          : config.koBounty
            ? 'bounty'
            : 'mtt',
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
    isRebuy: isMtt && config.numberOfRebuysReentries > 0,
    isReentry: isMtt && config.numberOfRebuysReentries > 0,
    rebuyCost,
    rebuyChips: config.startingChips,
    addOnAvailable: isMtt && config.addOnMultiplier > 0,
    addOnCost,
    addOnChips: Math.round(config.startingChips * Math.max(1, config.addOnMultiplier)),
    addOnLevels: 1,
    guaranteedPrize:
      isMtt && config.gtdPrizePool ? Math.max(0, Math.round(config.gtdPrizeAmount ?? 0)) : 0,
    gameVariant: TOURNAMENT_GAME_VARIANTS[gameType ?? 'nlh'] ?? 'NLH',
    spinType: isSpins ? 'standard' : undefined,
    // Half the buy-in as the head, floored to a whole number so the bounty can
    // never be a decimal and can never exceed the prize half of the split.
    bountyConfig: !isSatellite && config.koBounty
    ? { baseBounty: Math.min(split.prize, Math.floor(split.total * 0.5)) }
    : undefined,
    satelliteTarget: isSatellite
      ? {
          tournamentId: config.satelliteTargetId!,
          seatsAwarded: Math.max(1, Math.round(config.satelliteSeats ?? 1)),
        }
      : undefined,

    // ── PokerBros parity (2026-08-22). Shared fields on SNG and MTT alike;
    // MTT-only fields gated so an SNG never sends keys its tab cannot set. ──
    isPrivate: config.isPrivate ?? false,
    isVipOnly: config.isVipOnly ?? false,
    shortDescription: config.shortDescription?.trim() || undefined,
    banChat: config.banChat ?? false,
    allInOrFold: config.allInOrFold ?? false,
    labelAsNew: config.labelAsNew ?? false,
    hideClubName: config.hideClubName ?? false,
    isFeatured: config.featuredTournament ?? false,
    actionTimeSeconds: clampInt(config.actionTimeSeconds ?? 15, 5, 60),
    // For an SNG the field IS the table (or a fixed multiple of 9), so the
    // table can never seat more than the field itself.
    // 2026-08-24: clamped by what the DECK can physically deal, and by NOTHING
    // ELSE. tableSeating's cash cap is deliberately NOT used here: its header
    // is explicit that "TOURNAMENTS ARE NOT BOUND BY THIS", because the cash
    // cap is kept tight so Run It Twice has three boards to come out of, and a
    // tournament cannot run it twice at all. Applying it would shrink 9-handed
    // MTT tables and turn 3-max Spin & Gos into 8-max — a structural change,
    // not a seat cap. (I tried it that way first; the seat-law parity guard and
    // that header are what caught it.)
    //
    // Physics still applies. PLO6 deals six cards a seat, so a ten-handed PLO6
    // table wants 60 hole cards plus a board out of one 52-card deck, and
    // PokerEngine.deal() THROWS rather than dealing short — the tournament
    // would start and then sit there. This forbids only the undealable:
    // Hold'em stays 10, PLO4 and PLO8 stay 10, and only PLO5 (9) and PLO6 (7)
    // are actually reduced.
    tableSize: Math.min(
      isSng
        ? Math.min(clampInt(config.tableSize ?? 9, 2, 10), maxPlayers)
        : clampInt(config.tableSize ?? 9, 2, 10),
      maxSeatsTheDeckAllows(gameType)
    ),

    bigBlindAnte: config.bigBlindAnte ?? false,
    authorizedToRegister: config.authorizedToRegister ?? false,
    synchronizedBreaks: config.synchronizedBreaks ?? true,
    acceleratedMtt: isMtt ? (config.acceleratedMtt ?? false) : false,
    maxRebuys: isMtt && config.numberOfRebuysReentries > 0
      ? clampInt(config.numberOfRebuysReentries, 0, 100)
      : undefined,
    maxReentries: isMtt && config.numberOfRebuysReentries > 0
      ? clampInt(config.numberOfRebuysReentries, 0, 100)
      : undefined,
    addonBreakMinutes:
      isMtt && config.addOnMultiplier > 0
        ? clampInt(config.addOnBreakLengthMinutes ?? 1, 1, 10)
        : undefined,
    earlyBirdEnabled: isMtt ? (config.earlyBirdRegistration ?? false) : false,
    earlyBirdChips:
      isMtt && config.earlyBirdRegistration
        ? Math.max(0, Math.round(config.earlyBirdChips ?? 0))
        : undefined,
    bubbleProtection: isMtt ? (config.bubbleProtection ?? false) : false,
    finalTableDealEnabled: isMtt ? (config.finalTableDeal ?? false) : false,
    restartEveryMinutes:
      isMtt && config.restartTournamentEvery
        ? clampInt(config.restartEveryMinutes ?? 60, 5, 1440)
        : undefined,
    isMultiDay: isMtt ? (config.multiDayMtt ?? false) : false,
    totalDays: isMtt && config.multiDayMtt ? clampInt(config.totalDays ?? 2, 2, 7) : undefined,
  } as TournamentConfig;
}

