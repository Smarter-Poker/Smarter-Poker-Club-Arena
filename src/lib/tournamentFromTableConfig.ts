/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CREATE-TABLE CONFIG -> TOURNAMENT CONFIG
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Extracted from TableConfigPage on 2026-08-19 so the mapping can be tested
 * without rendering the page. The mapping is where every silently-ignored
 * setting would come back, so it is the part worth pinning.
 */
import {
  manualTournamentBlindPreset,
  newTournamentPlayingLevels,
  SPIN_BLIND_STRUCTURE,
} from '../config/blindStructures';
import { SPIN_TIERS } from '../config/spinSpec';
// Type-only: erased at compile time, so this module never boots the Supabase
// client that TournamentService constructs at import.
import type { TournamentConfig } from '../services/TournamentService';
import { RESTART_MAX_MINUTES } from '../services/TournamentService';
import { payoutEngine } from '../services/PayoutEngine';
import { rakeRateFor, splitBuyIn } from '../utils/buyIn';
import { freeBuyConfig } from '../utils/freeBuy';
// A line of its own: tests/law/FreerollsAreFreeBuy.law.test.ts pins the line above verbatim.
import { isFreeBuyEvent } from '../utils/freeBuy';
import { maxSeatsTheDeckAllows } from '../config/tableSeating';
import { TOURNAMENT_CREATE_ERRORS, startTimeIsPast } from './tournamentCreationRules';
import {
  mttPayoutDepthForChoice,
  MTT_PAYOUT_DEPTH_REQUIRED,
  provisionalMttPayoutStructure,
} from '../../server/src/tournament/mttPayoutDepth';
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

/**
 * THE TWO AXES OF AN MTT (2026-09-20). How a player may come back after
 * busting (the lifecycle) and how the prize money is shaped (the prize style)
 * are separate decisions, and each has its own control on the form. Until now
 * the form had one slider that switched rebuys AND re-entries on together, and
 * one boolean that could only say "knockout bounty or not".
 *
 * Every value maps to a key the service and the database already accept:
 * `isRebuy` / `isReentry` / `maxRebuys` / `maxReentries` for the lifecycle, and
 * `type` plus `bountyConfig.bountyType` for the prize style. The prize styles
 * are exactly the bounty formats TournamentType carries.
 */
export type MttEntryRules = 'freezeout' | 'rebuy' | 'reentry';
export type MttPrizeStyle = 'regular' | 'bounty' | 'progressive_bounty' | 'mystery_bounty';

export const MTT_ENTRY_RULES: readonly { value: MttEntryRules; label: string }[] = [
  { value: 'freezeout', label: 'Freezeout' },
  { value: 'rebuy', label: 'Rebuy' },
  { value: 'reentry', label: 'Re-Entry' },
];

export const MTT_PRIZE_STYLES: readonly { value: MttPrizeStyle; label: string }[] = [
  { value: 'regular', label: 'Regular' },
  { value: 'bounty', label: 'Bounty' },
  { value: 'progressive_bounty', label: 'Progressive Bounty' },
  { value: 'mystery_bounty', label: 'Mystery Bounty' },
];

const BOUNTY_TYPE_FOR_STYLE = {
  bounty: 'fixed',
  progressive_bounty: 'progressive',
  mystery_bounty: 'mystery',
} as const;

const isMttEntryRules = (v: unknown): v is MttEntryRules =>
  MTT_ENTRY_RULES.some((rule) => rule.value === v);
const isMttPrizeStyle = (v: unknown): v is MttPrizeStyle =>
  MTT_PRIZE_STYLES.some((style) => style.value === v);

/**
 * What the Entry Rules control should show for a draft or template saved
 * before the control existed. Those carried only the rebuy count, and the
 * engine treats an event with both flags set as a rebuy event
 * (`is_reentry && !is_rebuy ? 'reentry' : 'rebuy'`), so a count above zero
 * reads as Rebuy and zero as Freezeout.
 */
export function entryRulesForDraft(draft: {
  entryRules?: unknown;
  numberOfRebuysReentries?: unknown;
}): MttEntryRules {
  if (isMttEntryRules(draft.entryRules)) return draft.entryRules;
  return Number(draft.numberOfRebuysReentries) > 0 ? 'rebuy' : 'freezeout';
}

/** The Prize Style a pre-2026-09-20 draft meant: its KO Bounty switch. */
export function prizeStyleForDraft(draft: {
  prizeStyle?: unknown;
  koBounty?: unknown;
}): MttPrizeStyle {
  if (isMttPrizeStyle(draft.prizeStyle)) return draft.prizeStyle;
  return draft.koBounty === true ? 'bounty' : 'regular';
}

/**
 * A REBUY OR RE-ENTRY EVENT NEEDS LATE REGISTRATION TO CLOSE (2026-09-20).
 * Rebuys and re-entries close with late registration, and the engine and
 * process_tournament_rebuy both read a cap of 0 as NO cap at all
 * (`NULLIF(..., 0)`), so a 0 late registration level would leave rebuys open
 * for the whole event: not what Rebuy or Re-Entry promises. The club
 * tournament modal refuses the same pair. A Free Buy runs its own window and
 * is not asked. Returns the message to show, or null when the pair is fine.
 */
export const MTT_ENTRY_WINDOW_REQUIRED =
  'Late Registration Must Be At Least 1 Level When Rebuys Or Re-Entries Are On';

export function mttEntryWindowProblem(config: {
  gameMode: TournamentFormInput['gameMode'];
  buyIn: number;
  entryRules?: unknown;
  lateRegistrationLevel: number;
}): string | null {
  if (config.gameMode !== 'mtt') return null;
  if (config.entryRules !== 'rebuy' && config.entryRules !== 'reentry') return null;
  const buyIn = Math.max(0, Math.round(Number(config.buyIn) || 0));
  if (isFreeBuyEvent({ buyIn, type: 'mtt' })) return null;
  return Number(config.lateRegistrationLevel) >= 1 ? null : MTT_ENTRY_WINDOW_REQUIRED;
}

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
  /** Legacy saved-draft field. MTT entry counts are unlimited; ignored. */
  maxPlayersRange?: number;
  lateRegistrationLevel: number;
  numberOfRebuysReentries: number;
  addOnMultiplier: number;
  koBounty: boolean;
  /**
   * The lifecycle axis. Absent on a draft saved before 2026-09-20, which keeps
   * its exact old mapping (a rebuy count above zero set both flags).
   */
  entryRules?: MttEntryRules;
  /** The prize axis. Absent on an older draft, which falls back to `koBounty`. */
  prizeStyle?: MttPrizeStyle;
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
  if (isSng && config.payoutStructure === 'payout20') {
    throw new Error('Choose A Sit And Go Payout Structure');
  }
  // The initial ladder alone does not persist the final-field percentage.
  // Carry the selected engine-supported depth through the actual RPC payload.
  const payoutPercent =
    config.gameMode === 'mtt' ? mttPayoutDepthForChoice(config.payoutStructure) : undefined;
  if (payoutPercent === null) throw new Error(MTT_PAYOUT_DEPTH_REQUIRED);
  /* THE SPIN CATALOGUE IS ENFORCED HERE, NOT ONLY IN THE FORM (2026-08-31).
     The seat dropdown no longer offers "3 Players (Spins)" outside the
     catalogue, but a restored draft or a saved template can carry
     `isSpins: true` alongside any variant, and this function is what turns
     that into a row. A variant outside the catalogue becomes an ordinary
     three-handed SNG — the same game, sold as what it is — rather than a Spin
     the Spins board has no chip for and the tier table was never tuned for. */
  const isSpins = isSng && config.isSpins && gameTypeCanRunAsSpin(gameType);

  // SNGs start when their fixed seats fill. MTTs and satellites have no entry
  // ceiling, including drafts saved when maxPlayersRange was still offered.
  const sngSeats = Math.max(2, Math.floor(Number(config.sngPlayerCount) || 0) || 2);
  const maxPlayers = isSng ? sngSeats : null;
  const minPlayers = isSng
    ? sngSeats
    : Math.max(3, Math.floor(Number(config.minPlayers) || 0) || 3);

  // Blind ramp from the shared presets, with the owner's level length applied
  // to a new MTT playing-only draft. Legacy preset data is retained for stored
  // schedules; the service validates that playable blinds never decrease.
  // 2026-08-22: hyper_turbo maps to the REAL hyperTurbo ramp now (2-minute
  // levels, steeper jumps) instead of silently aliasing to turbo.
  const preset = isSpins
    ? SPIN_BLIND_STRUCTURE
    : manualTournamentBlindPreset(config.blindStructure);
  const levelMinutes = Math.max(1, config.blindsUpMinutes);
  const blindStructure = (isSng ? preset : newTournamentPlayingLevels(preset)).map((lvl) =>
    lvl.isBreak ? lvl : { ...lvl, durationMinutes: levelMinutes }
  );

  /* SNGs have a known field; MTT capacity is not a field projection. Keep a
     bounded provisional MTT structure and persist payoutPercent separately.
     The database generates its final ladder from the actual funded entrants.

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
    : config.gameMode === 'mtt'
      ? provisionalMttPayoutStructure()
      : payoutEngine.payoutsForChoice(config.payoutStructure, sngSeats);

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

  // Next Step (Satellite): only real with a target. A satellite without a
  // target would pay cash, defeating the point, and this used to build a plain
  // MTT instead without saying so. The toggle on with no target is refused
  // with the same sentence every other surface uses (20260924033701).
  if (isMtt && config.nextStepSatellite && !config.satelliteTargetId) {
    throw new Error(TOURNAMENT_CREATE_ERRORS.satellite_target_required);
  }
  const isSatellite = isMtt && Boolean(config.nextStepSatellite && config.satelliteTargetId);

  // A start time in the past is REFUSED, not replaced. This used to drop it
  // and let the server start the event a minute from now, so an owner who
  // picked yesterday (or had last week's saved time restored) created an
  // event at a time they never chose. An SNG ignores the start time.
  let startTime: Date | undefined;
  if (config.gameMode === 'mtt' && config.startTime) {
    const when = new Date(config.startTime);
    if (Number.isFinite(when.getTime())) {
      if (startTimeIsPast(when)) throw new Error(TOURNAMENT_CREATE_ERRORS.start_time_in_past);
      startTime = when;
    }
  }

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

  // FREEROLLS ARE FREE BUY. Asked once up front, because the lifecycle, the
  // add-on break and the prize style below all depend on it. The rule's own
  // keys are still spread LAST in the object below, where they have to win.
  const isFreeBuy =
    freeBuyConfig({
      buyIn: split.total,
      type: isSpins ? 'spin' : isSng ? 'sng' : 'mtt',
      startingStack: config.startingChips,
    }).freeBuy === true;

  /* THE LIFECYCLE AXIS. An explicit Entry Rules choice sets exactly one flag.
     A draft with no choice keeps the mapping it was saved under, so restoring
     an old template never produces a different event than it did before. */
  const explicitRules = isMttEntryRules(config.entryRules) ? config.entryRules : null;
  const legacyRebuys = config.numberOfRebuysReentries > 0;
  const isRebuy = isMtt && (explicitRules ? explicitRules === 'rebuy' : legacyRebuys);
  const isReentry = isMtt && (explicitRules ? explicitRules === 'reentry' : legacyRebuys);
  // A chosen Rebuy or Re-Entry event allows at least one; the form's slider
  // starts at 1 for the same reason.
  const entryCap = clampInt(config.numberOfRebuysReentries, explicitRules ? 1 : 0, 100);
  const freeBuyCap = legacyRebuys ? clampInt(config.numberOfRebuysReentries, 0, 100) : undefined;

  /* THE PRIZE AXIS, read independently of the lifecycle. Only an MTT has one:
     an SNG or a Spin has no bounty control. A satellite pays seats, so it
     cannot also pay bounties (buildRpcConfig refuses the pair), and a freeroll
     has no buy-in for a bounty to be cut from (the database refuses a bounty
     event with no bounty amount), so both read as Regular. */
  const prizeStyle: MttPrizeStyle =
    isMtt && !isSatellite && !isFreeBuy ? prizeStyleForDraft(config) : 'regular';

  return {
    name: config.name.trim() || 'Tournament',
    type: isSpins
      ? 'spin'
      : isSng
        ? 'sng'
        : isSatellite
          ? 'satellite'
          : prizeStyle === 'regular'
            ? 'mtt'
            : prizeStyle,
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
    ...(payoutPercent !== undefined ? { payoutPercent } : {}),
    lateRegistrationLevels: config.gameMode === 'mtt' ? config.lateRegistrationLevel : 0,
    // The MTT start time IS honoured: the discovery loop starts an MTT once
    // start_time has passed and the minimum field is present. An SNG ignores
    // it (it starts when full). A past time was refused above.
    startTime,
    isRebuy,
    isReentry,
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
      prizeStyle !== 'regular'
        ? {
            bountyType: BOUNTY_TYPE_FOR_STYLE[prizeStyle],
            baseBounty: Math.min(split.prize, Math.floor(split.total * 0.5)),
          }
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
    /* MTT CHAT IS BANNED BY DEFAULT (owner requirement, 2026-09-20). Every
       MTT-family event built here (regular, bounty, satellite) is created with
       chat off whatever the draft carried; the form shows the rule locked On.
       An SNG or a Spin keeps its own switch. */
    banChat: isMtt ? true : (config.banChat ?? false),
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
        ? Math.min(clampInt(config.tableSize ?? 9, 2, 10), sngSeats)
        : clampInt(config.tableSize ?? 9, 2, 10),
      maxSeatsTheDeckAllows(gameType)
    ),

    bigBlindAnte: config.bigBlindAnte ?? false,
    authorizedToRegister: config.authorizedToRegister ?? false,
    synchronizedBreaks: config.synchronizedBreaks ?? true,
    acceleratedMtt: isMtt ? (config.acceleratedMtt ?? false) : false,
    // A Free Buy switches both flags on by rule, so its cap is the slider's
    // count exactly as before, whatever Entry Rules held when the buy-in hit 0.
    maxRebuys: isFreeBuy ? freeBuyCap : isRebuy ? entryCap : undefined,
    maxReentries: isFreeBuy ? freeBuyCap : isReentry ? entryCap : undefined,
    /* THE ADD-ON BREAK LENGTH IS ONLY REAL ON A FREE BUY (2026-09-20). The
       engine opens a paid event's add-on window for exactly 60 seconds
       (TournamentManagerBase: `requestedStartMs + 60_000`); only a Free Buy's
       from-the-start window adds `addon_break_minutes` to its length. So a
       paid MTT sends 1, exactly as the club modal does, and the slider that
       promised up to ten minutes is gone from the paid form. */
    addonBreakMinutes: isMtt
      ? isFreeBuy
        ? clampInt(config.addOnBreakLengthMinutes ?? 1, 1, 10)
        : config.addOnMultiplier > 0
          ? 1
          : undefined
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
        ? clampInt(config.restartEveryMinutes ?? 60, 5, RESTART_MAX_MINUTES)
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
