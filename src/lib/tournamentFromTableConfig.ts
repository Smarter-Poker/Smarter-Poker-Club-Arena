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
import { SPIN_TIERS } from '../config/spinSpec';
// Type-only: erased at compile time, so this module never boots the Supabase
// client that TournamentService constructs at import.
import type { TournamentConfig } from '../services/TournamentService';
import { payoutEngine } from '../services/PayoutEngine';
import { rakeRateFor, splitBuyIn } from '../utils/buyIn';
import { freeBuyConfig } from '../utils/freeBuy';
import { maxSeatsTheDeckAllows } from '../config/tableSeating';
/* Value imports as well as the re-export below: `export … from` does not bind
   the names locally, and buildTournamentConfig uses both. */
import {
  TOURNAMENT_GAME_VARIANTS as VARIANT_MAP,
  canRunAsSpin as gameTypeCanRunAsSpin,
} from '../config/tournamentVariants';

/**
 * THE VARIANT CATALOGUE MOVED (2026-08-31) to `src/config/tournamentVariants`,
 * so the lobby's filter spec can read the same list without importing
 * PayoutEngine and the blind ladders through this file. Re-exported here
 * because `canRunAsTournament` is this module's published API — TableConfigPage
 * and the tests both import it from this path.
 */
export {
  TOURNAMENT_GAME_VARIANTS,
  TOURNAMENT_VARIANT_KEYS,
  SPIN_VARIANT_KEYS,
  canRunAsTournament,
  canRunAsSpin,
  type TournamentGameVariant,
} from '../config/tournamentVariants';

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
  /* THE SPIN CATALOGUE IS ENFORCED HERE, NOT ONLY IN THE FORM (2026-08-31).
     The seat dropdown no longer offers "3 Players (Spins)" outside the
     catalogue, but a restored draft or a saved template can carry
     `isSpins: true` alongside any variant, and this function is what turns
     that into a row. A variant outside the catalogue becomes an ordinary
     three-handed SNG — the same game, sold as what it is — rather than a Spin
     the Spins board has no chip for and the tier table was never tuned for. */
  const isSpins = isSng && config.isSpins && gameTypeCanRunAsSpin(gameType);

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
        (
          {
            slow: 'deepStack',
            standard: 'regular',
            turbo: 'turbo',
            hyper_turbo: 'hyperTurbo',
          } as const
        )[config.blindStructure] ?? 'regular'
      ] as typeof SPIN_BLIND_STRUCTURE);
  const levelMinutes = Math.max(1, config.blindsUpMinutes);
  const blindStructure = preset.map((lvl) =>
    lvl.isBreak ? lvl : { ...lvl, durationMinutes: levelMinutes }
  );

  /* Payouts. The owner's Payout Structure choice is HONOURED (2026-08-22 —
     payout1/2/3 used to fall through to autoSelectPayouts, so all four choices
     were identical). payoutsForChoice normalizes to exactly 100%, which the
     service and the engine both require.

     A SPIN IS NOT "WINNER-TAKE-ALL BY DEFINITION" (2026-08-31). That comment
     stood here and it was false: three of the seven tiers in `SPIN_TIERS` pay
     more than one place, and 25x / 50x / 100x pay 80 / 12 / 8 across all three
     seats. The literal was a workaround for `fn_create_tournament`, which
     refused `paid_places >= max_players` until
     `20260831200000_a_spin_pays_three_places_at_three_seats`.

     What a Spin gets at CREATION is the ladder of the placeholder tier, read
     from the spec rather than typed out — the same value, from the same
     source, that `TournamentRecurringService.createSpin` writes. It is a
     placeholder on purpose and not out of caution: the tier is drawn at START
     (TournamentManagerBase), which rewrites stack, blinds, pool and
     `payout_structure` from the real tier before a card is dealt. Writing the
     true ladder here would leak the draw, because only the 25x-and-up tiers
     pay three places — a lobby showing 80 / 12 / 8 has told the player the
     multiplier is at least 25x before the wheel exists. */
  const payoutStructure = isSpins
    ? SPIN_TIERS[0].payouts.map((pct, i) => ({
        place: i + 1,
        percentage: Math.round(pct * 10000) / 100,
      }))
    : payoutEngine.payoutsForChoice(config.payoutStructure, maxPlayers);

  // WHOLE-DOLLAR BUY-IN (Dan 2026-08-20): "Sit and Go and any tournament
  // buy-ins must never be decimal buy-ins, whole numbers only." The Buy-in
  // slider on the create-table form already steps in whole chips; rounding here
  // is the backstop for a restored draft or a programmatic config. `buyIn` is
  // the TOTAL the player pays and the fee is a cut OUT of it, so the total the
  // player is charged is always a whole number.
  const buyIn = Math.max(0, Math.round(Number(config.buyIn) || 0));
  // The rate depends on the FORMAT (2026-08-27). A 2-seat SNG pays 5% and a
  // Spin pays nothing at all — its rake is engineered into the multiplier
  // distribution and `buy_in_fee` must be 0 or the
  // tournaments_spin_no_extra_rake constraint refuses the row. This path used a
  // flat 10% for all three, so an owner building a duel or a Spin from the
  // table-config form was shown a fee that fn_create_tournament then wrote
  // differently. rakeRateFor is the single source of truth.
  const split = splitBuyIn(
    buyIn,
    rakeRateFor({ variant: isSpins ? 'spin' : isSng ? 'sng' : 'mtt', maxPlayers })
  );

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
    // The house cut, floored to cents, at the rate THIS format pays: 10% on an
    // MTT, 5% on a two-seat duel, nothing on a Spin. It is recomputed
    // identically server-side in fn_create_tournament; this is only what the UI
    // shows, which is exactly why it has to agree with it.
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
    /**
     * FREEROLLS ARE FREE BUY (Dan 2026-09-02). A 0 buy-in MTT built on the
     * table-config form is a freeroll: rebuys and add-ons are ON at 1 chip
     * each whatever the sliders say (the form locks them and says why). Spread
     * LAST so it wins. Empty for a paid event, a Spin or an SNG.
     */
    ...freeBuyConfig({
      buyIn: split.total,
      type: isSpins ? 'spin' : isSng ? 'sng' : 'mtt',
      startingStack: config.startingChips,
      addOnChips: Math.round(config.startingChips * Math.max(1, config.addOnMultiplier)),
      maxRebuys: config.numberOfRebuysReentries,
    }),
    guaranteedPrize:
      isMtt && config.gtdPrizePool ? Math.max(0, Math.round(config.gtdPrizeAmount ?? 0)) : 0,
    gameVariant: VARIANT_MAP[String(gameType ?? 'nlh').toLowerCase()] ?? 'NLH',
    spinType: isSpins ? 'standard' : undefined,
    // Half the buy-in as the head, floored to a whole number so the bounty can
    // never be a decimal and can never exceed the prize half of the split.
    bountyConfig:
      !isSatellite && config.koBounty
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
    maxRebuys:
      isMtt && config.numberOfRebuysReentries > 0
        ? clampInt(config.numberOfRebuysReentries, 0, 100)
        : undefined,
    maxReentries:
      isMtt && config.numberOfRebuysReentries > 0
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
    /* MULTI-DAY IS NOT BUILT, SO IT IS NOT SENT (2026-08-26).
       `is_multi_day` and `total_days` are stored, badged in two places, and
       read by NOTHING that runs a tournament: there is no day end, no Day 2
       resume, no flight merge, and nothing has ever written
       `flight_end_chips_snapshot`. An event with the flag set played down to a
       single winner in one session while the lobby card said Multi-Day.
       `trg_tournaments_refuse_unbuilt_multi_day` now refuses the write at the
       database, for every caller including the engine; this keeps the client
       from composing a payload that would be refused. 0 of 34,072 production
       tournaments ever set it, so nothing is taken away.
       Delete both of these lines in the commit that implements Day 2. */
    isMultiDay: false,
    totalDays: undefined,
  } as TournamentConfig;
}
