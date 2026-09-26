import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  RESTART_MAX_MINUTES,
  RESTART_WEEKLY_MINUTES,
  tournamentService,
  BLIND_STRUCTURES,
  SPIN_BLIND_STRUCTURE,
  PAYOUT_STRUCTURES,
  SPIN_MULTIPLIERS,
} from '../../services/TournamentService';
import {
  SPIN_TIERS,
  SPIN_SEATS,
  expectedMultiplier,
  impliedHouseEdge,
} from '../../config/spinSpec';
import { maxSeatsTheDeckAllows } from '../../config/tableSeating';
import { titleCase } from '../../utils/titleCase';
import { capPaidPlaces, fieldCapFor, minPlayersFor } from '../../lib/tournamentFieldRules';
import {
  TOURNAMENT_CREATE_ERRORS,
  payoutTotalIsValid,
  rebuyWindowIsOpen,
  startTimeIsPast,
} from '../../lib/tournamentCreationRules';
import styles from './CreateTournamentModal.module.css';
import { useToast } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { digitsOnly, isWholeBuyIn, money, rakeRateFor, splitBuyIn } from '../../utils/buyIn';
import { freeBuyConfig, FREE_BUY_HELPER } from '../../utils/freeBuy';
import { tournamentScheduleService } from '../../services/TournamentScheduleService';
import WeeklyScheduleEditor, {
  DEFAULT_WEEKLY_SCHEDULE,
  validateWeeklySchedule,
  type WeeklyScheduleValue,
} from '../tournament/WeeklyScheduleEditor';
import {
  WEEKDAY_NAMES,
  scheduleWriteTimeZone,
  localClockTime,
  scheduleZoneLabel,
} from '../../utils/scheduleTimeZone';
import { BlindStructureBuilder } from '../tournament/BlindStructureBuilder';
import { Toggle } from '../table-config/controls';
import {
  manualTournamentBlindPreset,
  newTournamentPlayingLevels,
  type BlindLevel,
} from '../../config/blindStructures';
import { canRunAsSpin, type TournamentGameVariant } from '../../config/tournamentVariants';
import { SpadeConsole } from '../console/SpadeConsole';
import {
  MTT_PAYOUT_DEPTH_CHOICES,
  provisionalMttPayoutStructure,
} from '../../../server/src/tournament/mttPayoutDepth';
import {
  MTT_CREATION_PROFILES,
  type MttCreationProfileId,
} from '../../../server/src/tournament/mttCreationProfiles';
import { manualMttCreationProfile, selectedManualMttProfile } from '../../lib/mttCreationProfile';
import { joinLocalStart, upcomingDateOptions } from '../../lib/quarterHourStartSelect';
import {
  describeStoredMttStructure,
  mttClockDescription,
} from '../../../server/src/tournament/mttStructureDescription';

interface Props {
  clubId: string;
  unionId?: string; // If provided, this is a XMTT (union-level tournament)
  /** Open the modal pre-set to a format (e.g. 'spin' from a Spins surface). */
  initialFormat?: TournamentFormat;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Every game a tournament can be created as, in board order.
 *
 * 2026-08-31. This list used to be five hard-coded <option> elements and it had
 * drifted from what the platform actually runs in two directions at once:
 *
 *   • PLO6 was MISSING while 6,028 PLO6 tournaments were live — every one of
 *     them made by the recurring service or the create-table form, which this
 *     modal could not match.
 *   • PLO8 and SHORT_DECK were offered for the SPIN format, which the spin
 *     catalogue (SPIN_GAME_TYPES) does not sell and the Spins board has no
 *     filter chip for — a Spin created that way vanished from the lobby the
 *     moment a player ticked any Games chip.
 *
 * Both are now impossible: the values come from the same map that decides what
 * `canRunAsTournament` allows, and the spin catalogue filters the list when the
 * format is a Spin.
 *
 * FLH and FLO8 are here because limit tournaments became creatable on the same
 * day (Dan: "LIMIT POKER NEEDS TO BE ADDED TO THE GAME VARIATIONS FILTER") —
 * see the header of tournamentFromTableConfig for why the old exclusion was
 * wrong about this engine.
 */
type MttEntryRules = 'freezeout' | 'rebuy' | 'reentry' | 'free_buy';
type MttPrizeStyle = 'regular' | 'bounty' | 'progressive_bounty' | 'mystery_bounty';
/** The one recurrence control at the foot of the form. */
type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';
const EVERY_DAY_OF_WEEK = [0, 1, 2, 3, 4, 5, 6];
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1);
/* PAID PLACES ARE 10 TO 15 PERCENT OF THE FINAL FIELD (owner requirement,
   2026-09-20). The depths come from the database's own contract, capped at 15:
   the contract still accepts 20 for events that already carry it, but this
   creator only ever makes a new event, so it no longer offers it. */
const CREATOR_PAID_FIELD_PERCENTS = MTT_PAYOUT_DEPTH_CHOICES.map((choice) => choice.percent).filter(
  (percent): percent is 10 | 15 => percent <= 15
);

const VARIANT_OPTIONS: { value: TournamentGameVariant; label: string }[] = [
  { value: 'NLH', label: "No-Limit Hold'em" },
  { value: 'PLO4', label: 'Pot-Limit Omaha (4-Card)' },
  { value: 'PLO5', label: 'Pot-Limit Omaha (5-Card)' },
  { value: 'PLO6', label: 'Pot-Limit Omaha (6-Card)' },
  { value: 'PLO8', label: 'PLO Hi-Lo (8 Or Better)' },
  { value: 'SHORT_DECK', label: "Short Deck Hold'em" },
  { value: 'FLH', label: "Fixed-Limit Hold'em" },
  { value: 'FLO8', label: 'Fixed-Limit Omaha Hi-Lo' },
];

type TournamentFormat =
  | 'mtt_freezeout'
  | 'mtt_free_buy'
  | 'mtt_rebuy'
  | 'mtt_reentry'
  | 'sng'
  | 'bounty'
  | 'progressive_bounty'
  | 'mystery_bounty'
  | 'spin'
  | 'satellite'
  | 'xmtt';

export default function CreateTournamentModal({
  clubId,
  unionId,
  initialFormat,
  onClose,
  onSuccess,
}: Props) {
  const toast = useToast();
  /* A `visibleSections` state and six uncleaned setTimeouts used to sit here,
     driving a stagger nothing read - the value was never referenced anywhere
     in this file. Closing the modal inside 540ms still fired them, setting
     state on an unmounted component. */

  // Apply the caller's preferred starting format ONCE, through the same
  // handler a manual selection uses so its per-format defaults apply too.
  useEffect(() => {
    if (initialFormat) handleFormatChange(initialFormat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Core Config ──
  const [name, setName] = useState('');
  const [format, setFormat] = useState<TournamentFormat>(initialFormat || 'mtt_freezeout');
  const [mttEntryRules, setMttEntryRules] = useState<MttEntryRules>('freezeout');
  const [gameVariant, setGameVariant] = useState<TournamentGameVariant>('NLH');
  /* Spins sell four games; every other format sells all eight. See
     VARIANT_OPTIONS above for why this is a filter and not a second list. */
  const variantOptions = useMemo(
    () =>
      format === 'spin' ? VARIANT_OPTIONS.filter((v) => canRunAsSpin(v.value)) : VARIANT_OPTIONS,
    [format]
  );
  // WHOLE-DOLLAR BUY-INS (Dan 2026-08-20): `buyIn` is the TOTAL the player
  // pays, always a positive whole number. The 10% house fee is a cut OUT of
  // that total, never a surcharge on top of it, so the advertised price is the
  // number typed here and nothing downstream ever holds a decimal. Every money
  // field in this form is digits-only for the same reason.
  const [buyIn, setBuyIn] = useState('10');
  const [startingChips, setStartingChips] = useState('1500');
  const [maxPlayers, setMaxPlayers] = useState('6');
  // See CREATOR_PAID_FIELD_PERCENTS. There is no edit or clone path through
  // this modal (its props carry no existing event), so no stored 20 can arrive.
  const [payoutPercent, setPayoutPercent] = useState<10 | 15>(10);
  const isSngOrSpin = format === 'sng' || format === 'spin';
  const fieldCap = isSngOrSpin ? fieldCapFor(maxPlayers) : null;
  const [blindSpeed, setBlindSpeed] = useState<'turbo' | 'regular' | 'deepStack' | 'custom'>(
    'turbo'
  );
  // An explicit selection applies the shared new-draft profile. Mounting the
  // modal keeps the existing custom draft, and fixed-seat formats keep theirs.
  const [mttPreset, setMttPreset] = useState<MttCreationProfileId | 'custom' | null>(null);
  /* Seeded from the builder's existing template on first opening. Keep that
     editor mounted after use so switching presets never discards custom work. */
  const [customBlinds, setCustomBlinds] = useState<BlindLevel[]>([]);
  const [guaranteedPrize, setGuaranteedPrize] = useState('0');

  // ── Satellite target (the tournament winners earn a seat into) ──
  const [satelliteTargetId, setSatelliteTargetId] = useState('');
  const [satelliteSeats, setSatelliteSeats] = useState('1');
  const [satelliteTargets, setSatelliteTargets] = useState<{ id: string; name: string }[]>([]);
  /* A failed target read is not "no upcoming tournaments": say which it was. */
  const [satelliteTargetsFailed, setSatelliteTargetsFailed] = useState(false);

  // ── Auto Satellite Generation (for Main Events) ──
  const [generateSatellites, setGenerateSatellites] = useState(false);
  const [genSatCount, setGenSatCount] = useState('1');
  const [genSatBuyIn, setGenSatBuyIn] = useState('');
  const [genSatSeats, setGenSatSeats] = useState('1');

  // ── Start Time ──
  const [startTimeMode, setStartTimeMode] = useState<'now' | 'scheduled' | 'schedule_only'>('now');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  /* LOCAL CALENDAR DAYS, VALUE AND LABEL ALIKE (2026-09-23). The value used
     to be toISOString() of local noon, which is the UTC date: at UTC+12:45 to
     UTC+14 (New Zealand daylight time from 27 September) local noon is the
     previous UTC day, so every option's value was the day BEFORE its label and
     the event was created a day early. The shared builder reads the local
     fields for both, and the start below is read back as the same local time. */
  const scheduledDateOptions = useMemo(() => upcomingDateOptions(new Date(), null), []);
  const scheduledTimeOptions = useMemo(
    () =>
      Array.from({ length: 96 }, (_, index) => {
        const hour = Math.floor(index / 4);
        const minute = (index % 4) * 15;
        const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        return {
          value,
          label: new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          }),
        };
      }),
    []
  );

  // ── Late Registration (level-based, per tournament) ──
  // Late reg and rebuy/re-entry ALWAYS share the same cutoff level
  const [lateRegLevels, setLateRegLevels] = useState('8');

  // ── Rebuy / Re-Entry / Add-On ──
  // Note: isRebuy/isReentry are managed via format selection, but kept for backward compat
  const isRebuy = mttEntryRules === 'rebuy';
  const isReentry = mttEntryRules === 'reentry';
  const [rebuyCost, setRebuyCost] = useState('');
  /** Flips synchronously, so a second submit cannot slip past an await. */
  const submittingRef = useRef(false);
  /** False once unmounted: onSuccess() closes this modal from inside submit. */
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [rebuyChips, setRebuyChips] = useState('');
  // rebuyLevels is derived from lateRegLevels (always the same cutoff)
  // Auto-enable add-on for rebuy/reentry formats
  const [addOnAvailable, setAddOnAvailable] = useState(isRebuy || isReentry);
  const [addOnCost, setAddOnCost] = useState('');
  const [addOnChips, setAddOnChips] = useState('');

  // ── Bounty Config ──
  const [bountyAmount, setBountyAmount] = useState('5');

  // ── Mystery Bounty Config ──
  // Mystery bounty options (Dan section 72). Defaults are the spec's own:
  // the classic ladder, chests opening at the money, and half the bounty pool
  // held back for them.
  const [mysteryProfile, setMysteryProfile] = useState<'balanced' | 'classic' | 'jackpot'>(
    'classic'
  );
  const [mysteryActivation, setMysteryActivation] = useState<
    'at_the_money' | 'percent_field' | 'player_count'
  >('at_the_money');
  const [mysteryActivationValue, setMysteryActivationValue] = useState('20');
  const [mysteryPoolPercent, setMysteryPoolPercent] = useState('50');

  // ── Spin Config ──
  const [spinType, setSpinType] = useState<'standard' | 'hyper'>('standard');

  // ── Advanced options (PokerBros parity, 2026-08-22). Collapsed by default
  // so the modal stays usable; every field maps to an fn_create_tournament
  // p_config key. ──
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [shortDescription, setShortDescription] = useState('');
  const [isVipOnly, setIsVipOnly] = useState(false);
  // MTT chat is closed by default. An owner can review the locked rule in
  // Advanced Options, but cannot accidentally publish an event with chat on.
  const [banChat] = useState(true);
  const [allInOrFold, setAllInOrFold] = useState(false);
  const [labelAsNew, setLabelAsNew] = useState(false);
  const [hideClubName, setHideClubName] = useState(false);
  const [isFeatured, setIsFeatured] = useState(false);
  const [acceleratedMtt, setAcceleratedMtt] = useState(false);
  const [bigBlindAnte, setBigBlindAnte] = useState(false);
  const [authorizedToRegister, setAuthorizedToRegister] = useState(false);
  const [synchronizedBreaks, setSynchronizedBreaks] = useState(true);
  const [actionTimeSeconds, setActionTimeSeconds] = useState('15');
  const [tableSize, setTableSize] = useState('9');
  const [earlyBirdEnabled, setEarlyBirdEnabled] = useState(false);
  const [earlyBirdChips, setEarlyBirdChips] = useState('0');
  const [bubbleProtection, setBubbleProtection] = useState(false);
  const [finalTableDeal, setFinalTableDeal] = useState(false);
  /** Empty string = no auto-restart; otherwise minutes, 5 to a week (10080). */
  const [restartEvery, setRestartEvery] = useState('');
  const [maxRebuysStr, setMaxRebuysStr] = useState('');

  // ── Weekly recurring schedule (tournament_schedules) ──
  /**
   * REPEATS WEEKLY (Dan 2026-09-03): "ALL MTT'S SHOULD BE ON A RECURRING
   * WEEKLY CYCLE ... ADDED TO THE 'CREATE EVENT' FUNCTIONALITY ... AS A CHECK
   * BOX OPTION." One checkbox, no editor: the event repeats on the weekday and
   * UTC time of its own start, through the same tournament_schedules row the
   * Recurring Tournament section below writes. The row is published a week
   * ahead (spawnAheadMinutes), so next week's copy is on the board as soon as
   * this one exists, and it is spawner-owned: the first instance is created
   * by the spawner rather than by hand, so this week's occurrence is never
   * made twice.
   */
  /* ONE RECURRENCE CONTROL (owner requirement, 2026-09-20): Does Not Repeat /
     Daily / Weekly / Monthly. It replaces two competing checkboxes ("Repeats
     Weekly" and "Recurring Tournament") that hid the cadence choice. The three
     values the submit path has always read are now DERIVED from it, so the
     tournament_schedules payload is unchanged:
       - Weekly + "Use This Event's Day And Time" is the old Repeats Weekly.
       - Every other repeating choice is the old Recurring Tournament editor. */
  const [recurrence, setRecurrence] = useState<Recurrence>('none');
  const [weeklyMatchesStart, setWeeklyMatchesStart] = useState(true);
  const [schedule, setSchedule] = useState<WeeklyScheduleValue>({ ...DEFAULT_WEEKLY_SCHEDULE });
  /** The owner's IANA zone: a recurring event keeps it (null = UTC). */
  const scheduleTimeZone = useMemo(() => scheduleWriteTimeZone(), []);
  const [scheduleDayOfMonth, setScheduleDayOfMonth] = useState(() =>
    scheduleTimeZone ? new Date().getDate() : new Date().getUTCDate()
  );
  // Heads Up and Spins have no recurrence control, so none is ever sent for
  // them, whatever was chosen before the category changed.
  const repeatsWeekly = !isSngOrSpin && recurrence === 'weekly' && weeklyMatchesStart;
  const scheduleEnabled = !isSngOrSpin && recurrence !== 'none' && !repeatsWeekly;
  const scheduleCadence: 'daily' | 'weekly' | 'monthly' =
    recurrence === 'none' ? 'weekly' : recurrence;

  const [isSubmitting, setIsSubmitting] = useState(false);

  /** The weekday and time this event starts, read from the start-time
   *  fields (or "about now" for an event that starts now), on the owner's own
   *  clock when the device names its zone (saved with the row, so 8:00 PM
   *  stays 8:00 PM local across daylight saving), else in UTC as before. */
  const weeklySlotFromStart = useCallback((): { daysOfWeek: number[]; startTimesUtc: string[] } => {
    const when =
      startTimeMode === 'scheduled' && scheduledDate && scheduledTime
        ? new Date(joinLocalStart(scheduledDate, scheduledTime))
        : new Date(Date.now() + 10 * 60 * 1000);
    const at = Number.isFinite(when.getTime()) ? when : new Date(Date.now() + 10 * 60 * 1000);
    if (scheduleTimeZone) return { daysOfWeek: [at.getDay()], startTimesUtc: [localClockTime(at)] };
    return { daysOfWeek: [at.getUTCDay()], startTimesUtc: [at.toISOString().slice(11, 16)] };
  }, [startTimeMode, scheduledDate, scheduledTime, scheduleTimeZone]);

  /* INTERVAL MODE BELONGS TO WEEKLY ONLY. The spawner's interval loop
     (ScheduledTournamentService.processIntervalSchedule) never reads the
     cadence, so "Repeat Every N Minutes" saved under Monthly or Daily respawned
     all month. Leaving Weekly therefore normalises the schedule to set times on
     every day, and the editor is told not to offer the interval at all. */
  const applyRecurrence = (next: Recurrence, matchesStart: boolean = weeklyMatchesStart) => {
    const nextRepeatsWeekly = next === 'weekly' && matchesStart;
    const nextScheduleEnabled = next !== 'none' && !nextRepeatsWeekly;
    setRecurrence(next);
    setWeeklyMatchesStart(matchesStart);
    if (nextRepeatsWeekly) {
      setSchedule((current) => ({ ...current, mode: 'times', ...weeklySlotFromStart() }));
    } else if (next === 'daily' || next === 'monthly') {
      setSchedule((current) => ({ ...current, mode: 'times', daysOfWeek: EVERY_DAY_OF_WEEK }));
    }
    if (nextScheduleEnabled) {
      if (!scheduleEnabled) setStartTimeMode('schedule_only');
    } else if (startTimeMode === 'schedule_only') {
      setStartTimeMode('now');
    }
  };

  // ── The buy-in, split ──
  // total = what the player pays (the typed whole number)
  // fee   = the house cut for THIS format, floored to cents
  // prize = total - fee, what reaches the prize pool.
  //
  // THE RATE IS NOT ALWAYS 10% (fixed 2026-08-27). A heads-up game pays 5% and
  // a Spin pays nothing at all (its rake lives in the multiplier distribution),
  // but this modal quoted a flat 10% for all three. fn_create_tournament is
  // authoritative and recomputes the split correctly, so no money moved wrong —
  // the owner was simply SHOWN a different price from the one that was written.
  // A 20-chip duel was quoted "18 + 2" and stored 19 + 1.
  //
  // The rate is asked for rather than restated: the ternary that used to live
  // here was a SIXTH copy of the rule, keyed on the format LABEL, so a duel
  // created under any other label still quoted 10%. Fixed formats use seats.
  const quotedRakeRate = useMemo(
    () =>
      rakeRateFor({
        variant: format,
        maxPlayers: fieldCap,
      }),
    [format, fieldCap]
  );
  const split = useMemo(
    () => splitBuyIn(Number(buyIn) || 0, quotedRakeRate),
    [buyIn, quotedRakeRate]
  );

  // MTT ladders are finalized against actual entries in the database.
  const payoutStructure = useMemo(() => {
    if (format === 'sng') {
      const mp = parseInt(maxPlayers) || 0;
      return mp <= 6 ? PAYOUT_STRUCTURES.sng6 : PAYOUT_STRUCTURES.sng9;
    }
    return provisionalMttPayoutStructure();
  }, [maxPlayers, format]);

  // Display the same Free Buy overrides that buildRpcConfig applies. Keep the
  // draft inputs: omitted rebuy chips follow the selected starting stack, and
  // returning to a paid format retains its editable terms.
  const freeBuyTerms = freeBuyConfig({
    buyIn: Number(buyIn),
    type: format,
    startingStack: parseInt(startingChips),
    rebuyChips: isRebuy || isReentry ? parseInt(rebuyChips) || parseInt(startingChips) : undefined,
    rebuyLevels: isRebuy || isReentry ? parseInt(lateRegLevels) || 8 : undefined,
    addOnChips: addOnAvailable ? parseInt(addOnChips) || parseInt(startingChips) : undefined,
    addOnLevels: addOnAvailable ? 1 : undefined,
  });
  const isFreeBuy = freeBuyTerms.freeBuy === true;
  const showCustomBlinds =
    !isSngOrSpin && mttPreset !== null ? mttPreset === 'custom' : blindSpeed === 'custom';

  // The selected custom blind ladder is used only while its control is on.
  const effectiveBlinds = useMemo(() => {
    if (showCustomBlinds) return customBlinds;
    /* A SPIN GETS THE SPIN LADDER (2026-08-31). This read `BLIND_STRUCTURES[
       blindSpeed]` for every format, and `blindSpeed` defaults to 'turbo' and
       is never touched when the format becomes a Spin — so a Spin created here
       ran the thirty-level MTT turbo ramp instead of `SPIN_BLIND_STRUCTURE`.
       A Spin & Go is a hyper-turbo by definition; on the MTT ramp its three
       players sat deep for levels the format is not built to reach.
       `tournamentFromTableConfig` has always picked the spin ladder for spins;
       this screen was the one that did not. */
    if (format === 'spin') return SPIN_BLIND_STRUCTURE;
    if (!isSngOrSpin && mttPreset && mttPreset !== 'custom') {
      const values = manualMttCreationProfile(mttPreset);
      return newTournamentPlayingLevels(manualTournamentBlindPreset(values.blindStructure)).map(
        (level) => ({ ...level, durationMinutes: values.blindsUpMinutes })
      );
    }
    if (blindSpeed === 'custom') return customBlinds;
    return isSngOrSpin
      ? BLIND_STRUCTURES[blindSpeed]
      : newTournamentPlayingLevels(BLIND_STRUCTURES[blindSpeed]);
  }, [blindSpeed, customBlinds, format, isSngOrSpin, mttPreset, showCustomBlinds]);
  const mttPresetSelection = showCustomBlinds
    ? 'custom'
    : mttPreset && mttPreset !== 'custom'
      ? selectedManualMttProfile({
          ...manualMttCreationProfile(mttPreset),
          startingChips: parseInt(startingChips),
        })
      : 'custom';
  // Preview the same whole-chip input the existing submit path serializes.
  const structureFacts = describeStoredMttStructure(effectiveBlinds, parseInt(startingChips));

  const applyMttPreset = (selection: MttCreationProfileId | 'custom') => {
    setMttPreset(selection);
    if (selection !== 'custom') {
      setStartingChips(String(manualMttCreationProfile(selection).startingChips));
    }
  };
  const effectivePayouts = useMemo(
    () => capPaidPlaces(payoutStructure, fieldCap),
    [payoutStructure, fieldCap]
  );

  /* TournamentService rejects a payout table that does not total 100%, and a
     rejection AFTER the operator has clicked Create reads as a failure they
     cannot see the cause of. Same rule, checked here, so the button is simply
     disabled with the reason printed beside it. It is the SHARED rule
     (tournamentCreationRules): within 1 of 100, as the database allows, and a
     zero total is refused. This screen used to hold its own 0.5. */
  const payoutsTotal = useMemo(
    () => effectivePayouts.reduce((sum, pp) => sum + (Number(pp.percentage) || 0), 0),
    [effectivePayouts]
  );
  const payoutsValid = payoutTotalIsValid(payoutsTotal);
  const blindsValid = Array.isArray(effectiveBlinds) && effectiveBlinds.length > 0;

  const isSatellite = format === 'satellite';
  /** Heads Up, Spin and Satellite carry no entry-rules or prize-style axes. */
  const isFixedCategory = format === 'sng' || format === 'spin' || isSatellite;

  // Load candidate target tournaments (upcoming, non-satellite in this club) once
  // the satellite format is chosen, so the organiser can pick what seats feed into.
  useEffect(() => {
    if (!isSatellite) return;
    let alive = true;
    (async () => {
      try {
        const resolved = await resolveClubUUID(clubId);
        const { data, error } = await supabase
          .from('tournaments')
          .select(
            'id, name, tournament_type, status, start_time, variant, is_bounty, is_pko, is_mystery_bounty, is_premium_spin'
          )
          .eq('club_id', resolved)
          .neq('tournament_type', 'satellite')
          .in('status', ['registering', 'scheduled', 'upcoming', 'announced', 'pending', 'open'])
          .order('start_time', { ascending: true })
          .limit(50);
        /* A refused read is not an empty club: reported, and the picker says
           it could not load rather than "No Upcoming Tournaments". */
        if (error) throw error;
        // A satellite can only award a seat the settlement authority can
        // deliver: never into a bounty, PKO, mystery-bounty or Spin event
        // (the database refuses that insert too, 20260911110907).
        const deliverable = (data || []).filter(
          (t: any) =>
            t.is_bounty === false &&
            t.is_pko === false &&
            t.is_mystery_bounty === false &&
            t.is_premium_spin === false &&
            String(t.variant ?? '').toLowerCase() !== 'spin' &&
            String(t.tournament_type ?? '').toUpperCase() !== 'SPIN'
        );
        if (alive) {
          setSatelliteTargets(deliverable.map((t: any) => ({ id: t.id, name: t.name })));
          setSatelliteTargetsFailed(false);
        }
      } catch (e) {
        reportError(e, 'CreateTournamentModal.loadSatelliteTargets');
        if (alive) setSatelliteTargetsFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isSatellite, clubId]);

  // Apply the selected format's defaults.
  const handleFormatChange = (f: TournamentFormat) => {
    setFormat(f);
    switch (f) {
      case 'sng':
        setMttEntryRules('freezeout');
        setMaxPlayers('6');
        setLateRegLevels('0');
        setStartTimeMode('now');
        setAddOnAvailable(false);
        setRecurrence('none');
        break;
      case 'spin':
        setMttEntryRules('freezeout');
        setMaxPlayers('3');
        setLateRegLevels('0');
        setStartTimeMode('now');
        setAddOnAvailable(false);
        setRecurrence('none');
        /* The catalogue narrows on the way IN as well as in the list. Picking
           Short Deck and then switching the format to Spin would otherwise
           leave a value the shortened <select> no longer contains, which a
           controlled select renders as a blank row while still submitting the
           stale value. */
        setGameVariant((v) => (canRunAsSpin(v) ? v : 'NLH'));
        break;
      case 'mtt_rebuy':
        setMttEntryRules('rebuy');
        setLateRegLevels('8');
        setAddOnAvailable(true);
        break;
      case 'mtt_reentry':
        setMttEntryRules('reentry');
        setLateRegLevels('8');
        setAddOnAvailable(true);
        break;
      case 'bounty':
      case 'progressive_bounty':
      case 'mystery_bounty':
        setLateRegLevels('10');
        setAddOnAvailable(false);
        break;
      case 'satellite':
        setMttEntryRules('freezeout');
        setLateRegLevels('8');
        setAddOnAvailable(false);
        break;
      case 'xmtt':
        setLateRegLevels('8');
        setAddOnAvailable(false);
        break;
      case 'mtt_freezeout':
      default:
        setMttEntryRules('freezeout');
        setLateRegLevels('8');
        setAddOnAvailable(false);
    }
  };

  const mttPrizeStyle: MttPrizeStyle =
    format === 'bounty' || format === 'progressive_bounty' || format === 'mystery_bounty'
      ? format
      : 'regular';

  /* ENTRY RULES AND PRIZE STYLE ARE INDEPENDENT AXES. `format` carries the
     prize style (and, for a Regular event, the entry rules as well), so both
     handlers resolve a Regular format through this ONE map. The prize-style
     handler used to have no Free Buy branch: choosing Regular while Entry Rules
     was Free Buy wrote 'mtt_freezeout' while freeBuy:true was still sent. */
  const regularFormatFor = (rules: MttEntryRules): TournamentFormat =>
    rules === 'free_buy'
      ? 'mtt_free_buy'
      : rules === 'rebuy'
        ? 'mtt_rebuy'
        : rules === 'reentry'
          ? 'mtt_reentry'
          : 'mtt_freezeout';

  const applyMttEntryRules = (rules: MttEntryRules) => {
    // A bounty is funded out of the buy-in; a Free Buy's buy-in is 0. The
    // option is disabled, and this refuses the same pair for any other caller.
    if (rules === 'free_buy' && mttPrizeStyle !== 'regular') return;
    setMttEntryRules(rules);
    setLateRegLevels('8');
    setAddOnAvailable(rules !== 'freezeout');
    /* FREE BUY (Dan 2026-09-04). The first entry is free and the rebuys and
       add-ons are paid, so it is NOT a freeroll - a freeroll never charges.
       Selecting it fills in the house standard so an owner does not have to
       remember five numbers: 3,000 start, 10,000 add-on chips, and an add-on
       window that opens at sit-down instead of only at the break. */
    if (rules === 'free_buy') {
      setBuyIn('0');
      setStartingChips('3000');
      setAddOnAvailable(true);
      setAddOnChips('10000');
      setAddOnCost('1');
      setRebuyCost('1');
      setRebuyChips('3000');
      setGuaranteedPrize('250');
    }
    if (mttPrizeStyle === 'regular') setFormat(regularFormatFor(rules));
  };

  const applyMttPrizeStyle = (style: MttPrizeStyle) => {
    if (style !== 'regular' && mttEntryRules === 'free_buy') return;
    if (style === 'regular') {
      setFormat(regularFormatFor(mttEntryRules));
      return;
    }
    setFormat(style);
    setLateRegLevels('8');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    /* A REF, BEFORE ANYTHING IS AWAITED. `isSubmitting` is state and does not
       change until React re-renders, so two submits in the same tick - a
       double tap, or Enter held down - both got through and created two
       tournaments, and createTournament carries no idempotency key. */
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);

    /* A SCHEDULED start in the past creates a tournament that can never begin.
       coreValid only checks the two date strings are non-empty, so an owner
       picking yesterday got no feedback at all. A minute of slack, for a form
       filled in while the clock moves: the shared rule every surface uses. */
    if (startTimeMode === 'scheduled') {
      const startsAt = new Date(joinLocalStart(scheduledDate, scheduledTime)).getTime();
      if (!Number.isFinite(startsAt) || startTimeIsPast(startsAt)) {
        toast.error(TOURNAMENT_CREATE_ERRORS.start_time_in_past);
        submittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
    }

    try {
      // ── Satellite validation: without a target it silently becomes a cash
      // payout, defeating the point (winners should earn seats). ──
      if (isSatellite && !satelliteTargetId) {
        toast.error(TOURNAMENT_CREATE_ERRORS.satellite_target_required);
        submittingRef.current = false;
        setIsSubmitting(false);
        return;
      }

      // ── WHOLE-NUMBER MONEY BACKSTOP (Dan 2026-08-20) ──
      // The inputs already strip anything that is not a digit, so this can only
      // fire on a pasted or programmatically-set value. It refuses rather than
      // silently rounding: a club owner has to know the price changed.
      const wholeFields: Array<[string, string, boolean]> = [
        // A Free Buy's first entry is free, so zero is the correct value
        // rather than a missing one. Every other price stays whole and positive.
        ['Buy-in', buyIn, mttEntryRules !== 'free_buy'],
        ['Guaranteed prize', guaranteedPrize, false],
        ...((isRebuy || isReentry) && rebuyCost.trim()
          ? ([[isRebuy ? 'Rebuy cost' : 'Re-entry cost', rebuyCost, true]] as Array<
              [string, string, boolean]
            >)
          : []),
        ...(addOnAvailable && addOnCost.trim()
          ? ([['Add-on cost', addOnCost, true]] as Array<[string, string, boolean]>)
          : []),
        ...(isBountyFormat
          ? ([['Bounty amount', bountyAmount, true]] as Array<[string, string, boolean]>)
          : []),
      ];
      for (const [label, raw, mustBePositive] of wholeFields) {
        const value = raw.trim();
        if (!mustBePositive && (value === '' || Number(value) === 0)) continue;
        if (!isWholeBuyIn(value)) {
          toast.error(`${label} must be a whole number of chips, with no decimals.`);
          submittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
      }

      const parsedBuyIn = Math.round(Number(buyIn));
      // The house fee is a CUT OF the buy-in, not a surcharge on top, and prize
      // + fee is exactly what the player pays. The RATE comes from rakeRateFor
      // (10% MTT, 5% heads-up, 0 on a Spin) so what is quoted here is what
      // fn_create_tournament writes, rather than a flat 10% the server then
      // silently disagreed with.
      const parsedRake = splitBuyIn(parsedBuyIn, quotedRakeRate).fee;

      // ── Bounty validation (defense-in-depth) ──
      if (isBountyFormat) {
        const ba = Math.round(Number(bountyAmount));
        if (!ba || ba <= 0) {
          toast.error('Bounty amount is required for bounty tournaments');
          submittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
        // The bounty is funded out of the buy-in, so it can never exceed the
        // prize half of the split — otherwise the prize pool would go negative
        // and registration would reject every entrant with
        // 'misconfigured_bounty'.
        if (ba > splitBuyIn(parsedBuyIn, quotedRakeRate).prize) {
          toast.error(
            `Bounty ${money(ba)} plus the ${money(parsedRake)} fee exceeds the ${money(parsedBuyIn)} buy-in. Lower the bounty or raise the buy-in.`
          );
          submittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
      }

      // Build start time
      let startTime: Date | undefined;
      if (startTimeMode === 'scheduled' && scheduledDate && scheduledTime) {
        startTime = new Date(joinLocalStart(scheduledDate, scheduledTime));
      } else {
        // Start 1 minute from now to allow last-second registrations
        startTime = new Date(Date.now() + 60 * 1000);
      }

      // Map new format types to internal service format
      const serviceFormat = format
        .replace('mtt_freezeout', 'mtt')
        .replace('mtt_rebuy', 'mtt')
        .replace('mtt_reentry', 'mtt')
        .replace('progressive_bounty', 'progressive_bounty')
        .replace('mystery_bounty', 'mystery_bounty')
        .replace('satellite', 'satellite')
        .replace('xmtt', 'mtt');

      // ── Advanced-options validation mirroring the server ──
      const restartMinutes = restartEvery.trim() === '' ? null : Math.round(Number(restartEvery));
      if (restartMinutes !== null && (restartMinutes < 5 || restartMinutes > RESTART_MAX_MINUTES)) {
        toast.error('Restart interval must be between 5 minutes and one week (10080 minutes).');
        submittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      // Repeats Weekly: the slot is the start time's own weekday and hour,
      // read at submit so a start time changed after the box was ticked still
      // wins. The event is spawner-owned (no hand-made first instance).
      const effectiveSchedule: WeeklyScheduleValue = repeatsWeekly
        ? {
            ...schedule,
            mode: 'times',
            intervalMinutes: schedule.intervalMinutes,
            ...weeklySlotFromStart(),
          }
        : scheduleCadence === 'weekly'
          ? schedule
          : // Daily and Monthly run at set times on every day; the monthly
            // day filter is the spawner's. An interval can never ride along.
            { ...schedule, mode: 'times', daysOfWeek: EVERY_DAY_OF_WEEK };
      const effectiveScheduleEnabled = scheduleEnabled || repeatsWeekly;
      const effectiveCadence: 'daily' | 'weekly' | 'monthly' = repeatsWeekly
        ? 'weekly'
        : scheduleCadence;
      const effectiveStartTimeMode = repeatsWeekly ? 'schedule_only' : startTimeMode;
      if (effectiveScheduleEnabled) {
        const problem = validateWeeklySchedule(effectiveSchedule);
        if (problem) {
          toast.error(problem);
          submittingRef.current = false;
          setIsSubmitting(false);
          return;
        }
      }

      const clampInt = (raw: string, lo: number, hi: number, dflt: number) => {
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
      };
      const maxRebuysNum =
        maxRebuysStr.trim() === '' ? undefined : Math.round(Number(maxRebuysStr));

      const tournamentConfig: import('../../services/TournamentService').TournamentConfig = {
        name,
        type: serviceFormat as import('../../services/TournamentService').TournamentType,
        gameVariant,
        buyIn: parsedBuyIn,
        rake: parsedRake,
        startingStack: parseInt(startingChips),
        /* A REAL CAP FOR EVERY FORMAT. See handleFormatChange: the database
           refuses a non-positive field, so "0 = unlimited" created nothing. */
        maxPlayers: fieldCap,
        /* MIN FOLLOWS THE FORMAT, and was hardcoded 3 for all of them.
           An SNG starts only when it is FULL (GameServer: `isSngOrSpin ?
           maxReached : ...`), so a 9-max SNG stored with min 3 advertises a
           threshold that means nothing — and the RPC only masked it for the
           2-max case, where it clamps min down to max. An MTT keeps a real
           minimum, never above the cap. */
        minPlayers: minPlayersFor(isSngOrSpin, fieldCap),
        blindStructure: effectiveBlinds,
        payoutStructure: effectivePayouts,
        payoutPercent: !isSngOrSpin && !isSatellite ? payoutPercent : undefined,
        lateRegistrationLevels: parseInt(lateRegLevels) || 0,
        startTime,
        isRebuy,
        isReentry,
        // Rebuy/re-entry cutoff = late reg cutoff (always the same)
        rebuyLevels: isRebuy || isReentry ? parseInt(lateRegLevels) || 8 : undefined,
        rebuyChips:
          isRebuy || isReentry ? parseInt(rebuyChips) || parseInt(startingChips) : undefined,
        rebuyCost: isRebuy || isReentry ? Math.round(Number(rebuyCost)) || parsedBuyIn : undefined,
        addOnAvailable,
        addOnChips: addOnAvailable ? parseInt(addOnChips) || parseInt(startingChips) : undefined,
        addOnCost: addOnAvailable ? Math.round(Number(addOnCost)) || parsedBuyIn : undefined,
        // Exactly one 60-second add-on period begins when rebuys close.
        // `addonBreakMinutes` carries the duration; addonLevels remains one
        // only for compatibility with older database rows.
        addOnLevels: addOnAvailable ? 1 : undefined,
        freeBuy: mttEntryRules === 'free_buy',
        // One window, opening at sit-down and staying open through the break.
        addOnFromStart: mttEntryRules === 'free_buy',
        guaranteedPrize: Math.max(0, Math.round(Number(guaranteedPrize)) || 0),
        satelliteTarget:
          isSatellite && satelliteTargetId
            ? {
                tournamentId: satelliteTargetId,
                seatsAwarded: Math.max(1, parseInt(satelliteSeats) || 1),
              }
            : undefined,
        // Day 2 resume and flight merging are unavailable; the database refuses them.
        isMultiDay: false,
        totalDays: undefined,
        isXmtt: !!unionId,
        unionId: unionId || undefined,
        bountyConfig:
          format === 'bounty' || format === 'progressive_bounty' || format === 'mystery_bounty'
            ? {
                bountyType:
                  format === 'bounty'
                    ? 'fixed'
                    : format === 'progressive_bounty'
                      ? 'progressive'
                      : 'mystery',
                baseBounty: Math.round(Number(bountyAmount)) || 5,
                // The fifty lines that used to sit here built a `mysteryTiers`
                // multiplier ladder out of the min/max pair and returned it on
                // this object. `buildRpcConfig` never sent it, so it reached
                // nothing: every mystery tournament ever created ran on the
                // hard-coded ladder inside the SQL register function instead.
                // Deleted 2026-08-25 along with that ladder. The chest sizes
                // now come from the funded pool at activation, and the club
                // picks a PROFILE (below) rather than authoring a ladder.
              }
            : undefined,
        spinType: format === 'spin' ? spinType : undefined,
        spinConfig:
          format === 'spin'
            ? {
                possibleMultipliers: SPIN_MULTIPLIERS[spinType] || SPIN_MULTIPLIERS.standard,
              }
            : undefined,

        // ── PokerBros parity (2026-08-22) ──
        shortDescription: shortDescription.trim() || undefined,
        isVipOnly,
        banChat,
        allInOrFold,
        labelAsNew,
        hideClubName,
        isFeatured,
        acceleratedMtt,
        bigBlindAnte,
        authorizedToRegister,
        synchronizedBreaks,
        actionTimeSeconds: clampInt(actionTimeSeconds, 5, 60, 15),
        /* CLAMPED BY THE DECK, not only by the slider's 2-10 (2026-08-31).
           PLO5 deals five cards a seat and PLO6 six, so a ten-handed table
           wants 50 or 60 hole cards plus a board out of one 52-card deck and
           `PokerEngine.deal()` THROWS rather than dealing short — the
           tournament starts and then sits there. `tournamentFromTableConfig`
           has applied `maxSeatsTheDeckAllows` since 2026-08-24; this screen
           did not, so the same 10-seat PLO5 was creatable from one form and
           refused by the other. Also never above the field itself. */
        tableSize: Math.min(
          clampInt(tableSize, 2, 10, 9),
          maxSeatsTheDeckAllows(gameVariant.toLowerCase()),
          fieldCap ?? 10
        ),
        addonBreakMinutes: addOnAvailable ? 1 : undefined,
        earlyBirdEnabled,
        earlyBirdChips: earlyBirdEnabled
          ? Math.max(0, Math.round(Number(earlyBirdChips) || 0))
          : undefined,
        bubbleProtection,
        finalTableDealEnabled: finalTableDeal,
        restartEveryMinutes: restartMinutes ?? undefined,
        maxRebuys: isRebuy ? maxRebuysNum : undefined,
        maxReentries: isReentry ? maxRebuysNum : undefined,
        mysteryBountyProfile: format === 'mystery_bounty' ? mysteryProfile : undefined,
        mysteryBountyActivation: format === 'mystery_bounty' ? mysteryActivation : undefined,
        mysteryBountyActivationValue:
          format === 'mystery_bounty' && mysteryActivation !== 'at_the_money'
            ? Math.max(1, Math.round(Number(mysteryActivationValue)) || 20)
            : undefined,
        mysteryBountyPoolPercent:
          format === 'mystery_bounty'
            ? Math.min(100, Math.max(1, Math.round(Number(mysteryPoolPercent)) || 50))
            : undefined,
      };

      // ── Weekly recurring schedule (2026-08-22): save the recurrence with
      // the exact p_config a hand-created tournament would send, minus
      // startTime (the spawner owns it). A one-off is also created unless the
      // owner chose "Schedule only". ──
      if (effectiveScheduleEnabled) {
        const resolvedClubId = await resolveClubUUID(clubId);
        const rpcConfig = tournamentService.buildRpcConfig(tournamentConfig);
        delete rpcConfig.startTime;
        rpcConfig.recurrenceCadence = effectiveCadence;
        if (effectiveCadence === 'monthly') rpcConfig.recurrenceDayOfMonth = scheduleDayOfMonth;
        // A weekly event is on the board a week ahead, the way the house
        // programme's Sunday majors are: next week's copy appears the moment
        // this week's is created.
        if (repeatsWeekly) rpcConfig.spawnAheadMinutes = RESTART_WEEKLY_MINUTES;
        await tournamentScheduleService.upsert({
          clubId: resolvedClubId,
          unionId: unionId || null,
          name,
          daysOfWeek: effectiveSchedule.daysOfWeek,
          startTimesUtc:
            effectiveSchedule.mode === 'times'
              ? effectiveSchedule.startTimesUtc.filter((t) => t.trim() !== '')
              : [],
          timeZone: scheduleTimeZone,
          intervalMinutes:
            effectiveSchedule.mode === 'interval' ? effectiveSchedule.intervalMinutes : null,
          active: true,
          config: rpcConfig,
        });
        toast.success(
          repeatsWeekly ? 'Saved. This Event Repeats Every Week.' : 'Recurring schedule saved.'
        );
      }

      if (!effectiveScheduleEnabled || effectiveStartTimeMode !== 'schedule_only') {
        const mainTournament = await tournamentService.createTournament(clubId, tournamentConfig);

        // Auto Satellite Generation
        // Satellites can only feed an event whose seat they can deliver, so a
        // bounty, PKO, mystery-bounty or Spin main event gets none.
        const mainTakesSatellites =
          format !== 'bounty' &&
          format !== 'progressive_bounty' &&
          format !== 'mystery_bounty' &&
          format !== 'spin';
        if (!isSatellite && mainTakesSatellites && generateSatellites) {
          const satCount = Math.max(1, parseInt(genSatCount) || 1);
          const satBuyIn = parseInt(genSatBuyIn) || Math.max(1, Math.round(parsedBuyIn * 0.1));
          const satSeats = Math.max(1, parseInt(genSatSeats) || 1);

          for (let i = 0; i < satCount; i++) {
            await tournamentService.createTournament(clubId, {
              ...tournamentConfig,
              name: `Satellite to ${tournamentConfig.name}${satCount > 1 ? ` #${i + 1}` : ''}`,
              type: 'satellite',
              buyIn: satBuyIn,
              guaranteedPrize: 0,
              satelliteTarget: {
                tournamentId: mainTournament.id,
                seatsAwarded: satSeats,
              },
            });
          }
          toast.success(`Main Event and ${satCount} Satellite(s) Created`);
        } else {
          toast.success('Tournament created');
        }
      }
      onSuccess();
    } catch (error: any) {
      reportError(error, 'CreateTournamentModal.Failed_to_create_tournament');
      toast.error(error?.message || 'Failed to create tournament');
    } finally {
      submittingRef.current = false;
      /* onSuccess() unmounts this modal, so a bare setState here wrote to a
         torn-down component on the happy path. */
      if (isMountedRef.current) setIsSubmitting(false);
    }
  };

  const isBountyFormat =
    format === 'bounty' || format === 'progressive_bounty' || format === 'mystery_bounty';

  // ── Validation: ALL fields required before tournament can be created ──
  // DAN'S SPEC 2026-08-15: a bounty event's buy-in is the player's ALL-IN entry
  // cost and splits three ways at registration —
  //   rake (10%) + bounty pool (bounty x entrants) + prize pool (remainder).
  // "A $50 bounty tournament with a $25 bounty: $25 to the bounty pool, $5
  //  rake, $20 into the prize pool."
  // The bounty is therefore FUNDED, not minted, which means the owner cannot
  // configure a bounty that leaves nothing for the prize pool. Compute the
  // split here so the form can both block it and show the owner the breakdown.
  const bountySplit = (() => {
    if (!isBountyFormat || split.total <= 0) return null;
    const bountyNum = Math.round(Number(bountyAmount)) || 0;
    // Every figure here is a whole number of chips: the split itself is whole,
    // and the bounty input is digits-only.
    return {
      buyIn: split.total,
      bounty: bountyNum,
      rake: split.fee,
      prize: split.prize - bountyNum,
    };
  })();

  const bountyValid = (() => {
    if (!isBountyFormat) return true;
    if (!isWholeBuyIn(bountyAmount)) return false;
    // The split must leave a non-negative prize pool.
    if (bountySplit && bountySplit.prize < 0) return false;
    return true;
  })();

  /* "Anything typed" is the right bar for a destructive backdrop click: the
     defaults alone are not worth protecting, a name or a buy-in is. */
  const formIsDirty = Boolean(name.trim()) || Boolean(buyIn.trim());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, isSubmitting]);

  // Whole numbers only — no decimal buy-ins on any tournament or SNG.
  // A Free Buy is the one event whose entry price is legitimately 0, so the
  // field border and the summary ask the same question coreValid asks.
  const buyInValid = mttEntryRules === 'free_buy' ? Number(buyIn) === 0 : isWholeBuyIn(buyIn);
  const rebuyWindowOpen = rebuyWindowIsOpen({
    isRebuy,
    isReentry,
    lateRegistrationLevels: parseInt(lateRegLevels) || 0,
    buyIn: Number(buyIn) || 0,
    type: format,
  });

  const coreValid = (() => {
    if (!name.trim()) return false;
    if (!buyInValid) return false;
    if (isNaN(parseInt(startingChips)) || parseInt(startingChips) <= 0) return false;
    if (isSngOrSpin && (!Number.isFinite(parseInt(maxPlayers)) || parseInt(maxPlayers) < 2)) {
      return false;
    }
    // Scheduled tournament must have date+time
    if (startTimeMode === 'scheduled' && (!scheduledDate || !scheduledTime)) return false;
    // Rebuys and re-entries are sold only while late registration is open.
    // `parseInt('') <= 0` is false, so a cleared field used to pass here and
    // send a window of 0. The shared rule reads it as 0 and refuses.
    if (!rebuyWindowOpen) return false;
    return true;
  })();

  const canSubmit = coreValid && bountyValid && payoutsValid && blindsValid && !isSubmitting;

  return (
    /* THE BACKDROP DOES NOT DISCARD A CONFIGURED TOURNAMENT.
       `onClick={onClose}` threw away a fully filled form on a mis-tap, with no
       confirmation, and it was live while a create was in flight. Escape and
       the body-scroll lock were missing too - every other modal in this folder
       has both. */
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Create Game"
      onClick={() => {
        if (isSubmitting) return;
        if (formIsDirty) return;
        onClose();
      }}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <form className={styles.form} onSubmit={handleSubmit}>
          <SpadeConsole
            onClose={isSubmitting ? undefined : onClose}
            eyebrow={unionId ? 'Union Tournament Command' : 'Club Tournament Command'}
            title={unionId ? 'Create Union Tournament' : 'Create Tournament'}
            subtitle="Configure, Validate, Then Publish"
            pill={format === 'spin' ? 'Spins' : format === 'sng' ? 'Sit N Go' : 'Event'}
            crest="club"
            className={styles.consoleShell}
            plates={{
              secondary: {
                label: 'Cancel',
                type: 'button',
                onClick: onClose,
                disabled: isSubmitting,
              },
              primary: {
                label: isSubmitting ? 'Creating...' : 'Create Tournament',
                type: 'submit',
                disabled: !canSubmit,
                ink: 'blue',
              },
            }}
          >
            <div className={styles.formGroup}>
              <label>
                Tournament Name <span className={styles.required}>*</span>
              </label>
              <input
                className={`${styles.input}${!name.trim() ? ` ${styles.invalid}` : ''}`}
                aria-invalid={!name.trim()}
                value={name}
                maxLength={44}
                onChange={(e) => setName(e.target.value.slice(0, 44))}
                placeholder="E.G. Saturday Night Turbo"
                required
              />
            </div>

            {/* THE CATEGORY IS ALWAYS REACHABLE (2026-09-20). This select used to
                render only when the format was ALREADY a Heads Up, Spin or
                Satellite, so an Event opened from the tournament page or a
                union (no initialFormat) could never become a Satellite: the
                target picker, seat award and their tests were all live code
                with no way in. Same four options, same handler. */}
            <div className={styles.formGroup}>
              <label htmlFor="tournament-category">Tournament Category</label>
              <select
                id="tournament-category"
                className={styles.select}
                value={isFixedCategory ? format : 'mtt_freezeout'}
                onChange={(e) => handleFormatChange(e.target.value as TournamentFormat)}
              >
                <option value="mtt_freezeout">Multi-Table Tournament</option>
                <option value="satellite">Satellite</option>
                <option value="sng">Heads Up</option>
                <option value="spin">Spin & Go</option>
              </select>
            </div>

            {/* Entry rules and prize style are independent tournament axes. */}
            {!isFixedCategory && (
              <div className={styles.formatAxes}>
                <div className={styles.formGroup}>
                  <label htmlFor="tournament-entry-rules">Entry Rules</label>
                  <select
                    id="tournament-entry-rules"
                    className={styles.select}
                    value={mttEntryRules}
                    onChange={(e) => applyMttEntryRules(e.target.value as MttEntryRules)}
                  >
                    <option value="freezeout">Freezeout</option>
                    {/* A bounty is funded out of the buy-in and a Free Buy's
                        buy-in is 0, so that pair can never be created. It is
                        refused HERE, on both axes, instead of one axis
                        silently rewriting the other. */}
                    <option value="free_buy" disabled={mttPrizeStyle !== 'regular'}>
                      Free Buy (First Entry Free)
                    </option>
                    <option value="rebuy">Rebuy (Same Seat)</option>
                    <option value="reentry">Re-Entry (New Seat)</option>
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label htmlFor="tournament-prize-style">Prize Style</label>
                  <select
                    id="tournament-prize-style"
                    className={styles.select}
                    value={mttPrizeStyle}
                    onChange={(e) => applyMttPrizeStyle(e.target.value as MttPrizeStyle)}
                  >
                    <option value="regular">Regular Tournament</option>
                    <option value="bounty" disabled={mttEntryRules === 'free_buy'}>
                      Knockout Bounty
                    </option>
                    <option value="progressive_bounty" disabled={mttEntryRules === 'free_buy'}>
                      Progressive Knockout (PKO)
                    </option>
                    <option value="mystery_bounty" disabled={mttEntryRules === 'free_buy'}>
                      Mystery Bounty
                    </option>
                  </select>
                  {mttEntryRules === 'free_buy' && (
                    <span className={styles.helperText}>
                      Bounties Are Funded From The Buy-In, So A Free Buy Is Always A Regular
                      Tournament.
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Game Variant Selection */}
            <div className={styles.formGroup}>
              <label>
                Game <span className={styles.required}>*</span>
              </label>
              <select
                className={styles.select}
                value={gameVariant}
                onChange={(e) => setGameVariant(e.target.value as TournamentGameVariant)}
              >
                {variantOptions.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.row}>
              {/* Fixed-seat formats expose their exact seat count. MTT fields do
                not have an operator-set maximum. */}
              {format === 'spin' && (
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label>Players</label>
                    <input
                      type="text"
                      className={styles.input}
                      value="3 Players (Fixed)"
                      disabled
                      style={{ opacity: 0.7 }}
                    />
                    <span className={styles.helperText}>Spins Always Start With 3 Players</span>
                  </div>
                </div>
              )}
              {format === 'spin' && (
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    {/*
                    THIS WAS A CHOICE BETWEEN TWO IDENTICAL THINGS, PRICED WRONG
                    (removed 2026-09-02).

                    `SPIN_MULTIPLIERS.standard` and `.hyper` are the SAME array
                    (TournamentService), nothing persists the selection, and
                    there is no `spin_config` column for it to land in - so the
                    control changed nothing an operator could observe. It also
                    advertised two different expected values, 2.24X and 2.33X,
                    for one distribution whose real expectation is
                    seats x (1 - rake_rate) = 2.76. 2.24 is verbatim the
                    retired table that spinSpec was written to kill, so the
                    screen told an operator the house edge was 25.3% when it is
                    8%.

                    Replaced with the one true number, COMPUTED from the live
                    tier table rather than typed, so it cannot drift again the
                    next time a tier changes.
                  */}
                    <label>Spin Payout Table</label>
                    <span className={styles.helperText}>
                      {`One Table, ${SPIN_TIERS.length} Multipliers. Expected Return ${expectedMultiplier().toFixed(2)}X Per Buy In Across ${SPIN_SEATS} Seats, A House Edge Of ${(impliedHouseEdge() * 100).toFixed(1)}%.`}
                    </span>
                  </div>
                </div>
              )}
              {format === 'sng' && (
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label>
                      Max Players <span className={styles.required}>*</span>
                    </label>
                    <select
                      className={styles.select}
                      value={maxPlayers}
                      onChange={(e) => setMaxPlayers(e.target.value)}
                    >
                      <option value="2">Heads Up (2)</option>
                      <option value="3">3 Players</option>
                      <option value="6">6-Max</option>
                      <option value="9">Full Ring (9)</option>
                    </select>
                  </div>
                </div>
              )}
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  {isSngOrSpin ? (
                    <>
                      <label>
                        Speed <span className={styles.required}>*</span>
                      </label>
                      <select
                        className={styles.select}
                        value={blindSpeed}
                        onChange={(e) =>
                          setBlindSpeed(
                            e.target.value as 'turbo' | 'regular' | 'deepStack' | 'custom'
                          )
                        }
                      >
                        <option value="turbo">Turbo (3M)</option>
                        <option value="regular">Regular (8M)</option>
                        <option value="deepStack">Deep Stack (15M)</option>
                        <option value="custom">Custom Structure</option>
                      </select>
                    </>
                  ) : (
                    <>
                      <label htmlFor="club-mtt-setup-preset">Setup Preset</label>
                      <select
                        id="club-mtt-setup-preset"
                        className={styles.select}
                        value={
                          showCustomBlinds
                            ? 'custom'
                            : mttPresetSelection === 'custom'
                              ? 'custom_setup'
                              : mttPresetSelection
                        }
                        onChange={(event) =>
                          applyMttPreset(event.target.value as MttCreationProfileId | 'custom')
                        }
                      >
                        <option value="custom_setup" disabled>
                          Custom Setup
                        </option>
                        {MTT_CREATION_PROFILES.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {titleCase(profile.label)} · {profile.depthBB} BB · {profile.minutes}{' '}
                            Min
                          </option>
                        ))}
                        <option value="custom">Custom Structure</option>
                      </select>
                    </>
                  )}
                </div>
              </div>
            </div>

            {!isSngOrSpin && (
              <div className={styles.helperText} aria-label="MTT Structure Preview">
                {mttClockDescription(structureFacts)} ·{' '}
                {structureFacts.startingDepthBB === null
                  ? 'Opening Depth Unconfirmed'
                  : `${structureFacts.startingDepthBB.toLocaleString(undefined, { maximumFractionDigits: 2 })} Big Blinds At Start`}
              </div>
            )}

            {!isSngOrSpin && (
              <div className={styles.helperText} aria-label="Tournament Break Policy">
                {synchronizedBreaks
                  ? 'Synchronized Tournament Breaks Begin At :55 Each Hour After Hands Finish.'
                  : 'No Scheduled Tournament Breaks. Custom Level Breaks Are Not Supported.'}{' '}
                Platform Maintenance And Add-On Pauses Still Apply.
              </div>
            )}

            {(showCustomBlinds || customBlinds.length > 0) && (
              <fieldset
                hidden={!showCustomBlinds}
                disabled={!showCustomBlinds}
                aria-label="Custom Blind Structure"
                style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
              >
                <div className={styles.formGroup}>
                  <span className={styles.sectionLabel}>Blind Structure</span>
                  <span className={styles.helperText}>
                    Playing Levels Are Sent Exactly As Shown. Breaks Follow The Tournament Break
                    Policy.
                  </span>
                  <BlindStructureBuilder
                    onChange={setCustomBlinds}
                    startingChips={parseInt(startingChips) || 10000}
                  />
                </div>
              </fieldset>
            )}

            <div className={styles.row}>
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label>
                    Buy-In <span className={styles.required}>*</span>
                  </label>
                  {/* WHOLE NUMBERS ONLY (Dan 2026-08-20). step/min/inputMode set
                    the browser and the mobile keypad, and digitsOnly stops a
                    decimal point being typed or pasted at all. */}
                  <input
                    type="number"
                    className={`${styles.input}${!buyInValid ? ` ${styles.invalid}` : ''}`}
                    aria-invalid={!buyInValid}
                    value={buyIn}
                    onChange={(e) => setBuyIn(digitsOnly(e.target.value))}
                    min={1}
                    step={1}
                    inputMode="numeric"
                  />
                  <span className={styles.helperText}>
                    Whole Chips Only. This Is The Total The Player Pays.
                  </span>
                </div>
              </div>
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  {/* RAKE-AUDIT 2026-07-24: fee is the HOUSE RULE 10% of buy-in,
                    auto-computed and read-only. It was a free-form field (any
                    value incl. 0), so the platform-wide 10% rule was only a
                    coincidence of defaults. fn_create_tournament recomputes the
                    same split server-of-record side.
                    2026-08-20: the fee is a CUT OUT OF the buy-in, rounded to a
                    whole number, so the player pays exactly the figure typed on
                    the left and never a decimal. */}
                  <label>
                    {quotedRakeRate === 0
                      ? 'Fee (Spins Carry None)'
                      : `Fee (${Math.round(quotedRakeRate * 100)}% Of Buy-In)`}
                  </label>
                  <input
                    type="number"
                    className={styles.input}
                    value={split.fee}
                    readOnly
                    disabled
                    min={0}
                    step={1}
                  />
                  <span className={styles.helperText}>
                    {split.total > 0
                      ? `${money(split.total)} Entry = ${money(split.prize)} To The Prize Pool + ${money(split.fee)} Fee`
                      : 'Taken Out Of The Buy-In, Not Added On Top'}
                  </span>
                </div>
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label htmlFor="tournament-starting-chips">
                    Starting Chips <span className={styles.required}>*</span>
                  </label>
                  <input
                    id="tournament-starting-chips"
                    type="number"
                    className={styles.input}
                    value={startingChips}
                    onChange={(e) => setStartingChips(e.target.value)}
                  />
                </div>
              </div>
              <div className={styles.col}>
                <div className={styles.formGroup}>
                  <label>Guaranteed Prize</label>
                  <input
                    type="number"
                    className={styles.input}
                    value={guaranteedPrize}
                    onChange={(e) => setGuaranteedPrize(digitsOnly(e.target.value))}
                    min={0}
                    step={1}
                    inputMode="numeric"
                  />
                  <span className={styles.helperText}>0 = No Guarantee</span>
                </div>
              </div>
            </div>

            {/* ── Satellite Target ── */}
            {isSatellite && (
              <div className={styles.row}>
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label>Awards Seats Into</label>
                    <select
                      className={styles.select}
                      value={satelliteTargetId}
                      onChange={(e) => setSatelliteTargetId(e.target.value)}
                    >
                      <option value="">Select Target Tournament…</option>
                      {satelliteTargets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {titleCase(t.name)}
                        </option>
                      ))}
                    </select>
                    <span className={styles.helperText}>
                      {satelliteTargetsFailed
                        ? 'Target Tournaments Could Not Be Loaded. Close And Reopen To Try Again.'
                        : satelliteTargets.length === 0
                          ? 'No Upcoming Tournaments To Feed Into - Create One First.'
                          : 'Winners Earn A Seat Into This Tournament.'}
                    </span>
                  </div>
                </div>
                <div className={styles.col}>
                  <div className={styles.formGroup}>
                    <label>Seats Awarded</label>
                    <input
                      type="number"
                      className={styles.input}
                      value={satelliteSeats}
                      onChange={(e) => setSatelliteSeats(e.target.value)}
                      min="1"
                      step="1"
                    />
                    <span className={styles.helperText}>Top N Finishers Win A Seat</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── Start Time ── */}
            {format !== 'sng' && format !== 'spin' && !isSatellite && (
              <div className={styles.formGroup}>
                <label>Start Time</label>
                <div className={styles.row}>
                  <div className={styles.col}>
                    <select
                      className={styles.select}
                      value={startTimeMode}
                      onChange={(e) =>
                        setStartTimeMode(e.target.value as 'now' | 'scheduled' | 'schedule_only')
                      }
                    >
                      <option value="now">Start In 1 Min</option>
                      <option value="scheduled">Schedule</option>
                      {scheduleEnabled && (
                        <option value="schedule_only">Recurring Schedule Only</option>
                      )}
                    </select>
                  </div>
                  {startTimeMode === 'scheduled' && (
                    <>
                      <div className={styles.col}>
                        <select
                          className={`${styles.select} ${styles.calendarSelect}`}
                          value={scheduledDate}
                          onChange={(e) => setScheduledDate(e.target.value)}
                          aria-label="Tournament Start Date"
                        >
                          <option value="">Select Date</option>
                          {scheduledDateOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={styles.col}>
                        <select
                          className={styles.select}
                          value={scheduledTime}
                          onChange={(e) => setScheduledTime(e.target.value)}
                          aria-label="Tournament Start Time"
                        >
                          <option value="">Select Time</option>
                          {scheduledTimeOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* ── Late Registration & Rebuy/Re-Entry Period (level-based) ── */}
            {format !== 'spin' && (
              <div className={styles.sectionDivider}>
                <span className={styles.sectionLabel}>Late Registration / Rebuy Period</span>
                <div className={styles.row}>
                  <div className={styles.col}>
                    <div className={styles.formGroup}>
                      <label>Late Reg Cutoff (Levels)</label>
                      <select
                        className={styles.select}
                        value={lateRegLevels}
                        onChange={(e) => setLateRegLevels(e.target.value)}
                      >
                        <option value="0">No Late Registration</option>
                        {[...Array(20)].map((_, i) => (
                          <option key={i + 1} value={String(i + 1)}>
                            Through Level {i + 1}
                            {i + 1 >= 8 && i + 1 <= 12 ? ' (Recommended)' : ''}
                          </option>
                        ))}
                      </select>
                      <span className={styles.helperText}>
                        {parseInt(lateRegLevels) > 0
                          ? `Late Reg, Rebuys, And Re-Entries Close After Level ${lateRegLevels}`
                          : 'No Late Registration - Registration Closes When Tournament Starts'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {!isSngOrSpin && !isSatellite && (
              <div className={styles.formGroup}>
                <label htmlFor="mtt-paid-field">Field Paid</label>
                <select
                  id="mtt-paid-field"
                  className={styles.select}
                  value={payoutPercent}
                  onChange={(e) => {
                    const next = CREATOR_PAID_FIELD_PERCENTS.find(
                      (percent) => percent === Number(e.target.value)
                    );
                    if (next) setPayoutPercent(next);
                  }}
                >
                  {CREATOR_PAID_FIELD_PERCENTS.map((percent) => (
                    <option key={percent} value={percent}>
                      Top {percent} Percent
                    </option>
                  ))}
                </select>
                <span className={styles.helperText}>
                  Paid Places Follow Actual Entries When Registration Closes, Rounded Up.
                </span>
              </div>
            )}

            {/* ── Bounty Config ── */}
            {isBountyFormat && (
              <div className={styles.sectionDivider}>
                <span className={styles.sectionLabel}>
                  {format === 'bounty'
                    ? 'Bounty'
                    : format === 'progressive_bounty'
                      ? 'PKO'
                      : 'Mystery Bounty'}{' '}
                  Settings
                  <span className={styles.required}>*</span>
                </span>
                <div className={styles.row}>
                  <div className={styles.col}>
                    <div className={styles.formGroup}>
                      <label>
                        {format === 'mystery_bounty'
                          ? 'Base Bounty (Chips)'
                          : 'Bounty Per KO (Chips)'}{' '}
                        <span className={styles.required}>*</span>
                      </label>
                      <input
                        type="number"
                        className={`${styles.input}${!isWholeBuyIn(bountyAmount) ? ` ${styles.invalid}` : ''}`}
                        aria-invalid={!isWholeBuyIn(bountyAmount)}
                        value={bountyAmount}
                        onChange={(e) => setBountyAmount(digitsOnly(e.target.value))}
                        min={1}
                        step={1}
                        inputMode="numeric"
                        required
                      />
                      <span className={styles.helperText}>
                        {format === 'mystery_bounty'
                          ? 'Bounty Contribution Per Entry'
                          : 'Amount Awarded For Each Knockout'}
                      </span>
                    </div>
                  </div>
                  {format === 'mystery_bounty' && (
                    <>
                      {/* MYSTERY BOUNTY OPTIONS (Dan section 72). Four settings,
                        all with a working default, so an owner who ignores this
                        block still gets the ladder Dan specified. */}
                      <div className={styles.col}>
                        <div className={styles.formGroup}>
                          <label>Prize Ladder</label>
                          <select
                            className={styles.input}
                            value={mysteryProfile}
                            onChange={(e) =>
                              setMysteryProfile(e.target.value as typeof mysteryProfile)
                            }
                          >
                            <option value="balanced">Balanced (Flatter Payouts)</option>
                            <option value="classic">Classic (Recommended)</option>
                            <option value="jackpot">Jackpot (Top Heavy)</option>
                          </select>
                          <span className={styles.helperText}>
                            How Much Of The Pool Sits On The Biggest Chest
                          </span>
                        </div>
                      </div>
                      <div className={styles.col}>
                        <div className={styles.formGroup}>
                          <label>Chests Open</label>
                          <select
                            className={styles.input}
                            value={mysteryActivation}
                            onChange={(e) =>
                              setMysteryActivation(e.target.value as typeof mysteryActivation)
                            }
                          >
                            <option value="at_the_money">At The Money</option>
                            <option value="percent_field">At A Percent Of The Field</option>
                            <option value="player_count">At A Player Count</option>
                          </select>
                          <span className={styles.helperText}>
                            Never Before Late Registration Closes
                          </span>
                        </div>
                      </div>
                      {mysteryActivation !== 'at_the_money' && (
                        <div className={styles.col}>
                          <div className={styles.formGroup}>
                            <label>
                              {mysteryActivation === 'percent_field'
                                ? 'Percent Of Field Left'
                                : 'Players Left'}
                            </label>
                            <input
                              type="number"
                              className={styles.input}
                              value={mysteryActivationValue}
                              onChange={(e) =>
                                setMysteryActivationValue(digitsOnly(e.target.value))
                              }
                              min={mysteryActivation === 'percent_field' ? 1 : 2}
                              step={1}
                              inputMode="numeric"
                            />
                            <span className={styles.helperText}>
                              {mysteryActivation === 'percent_field'
                                ? 'E.G. 20 Opens Chests With The Last Fifth Left'
                                : 'E.G. 27 Opens Chests With 27 Players Left'}
                            </span>
                          </div>
                        </div>
                      )}
                      <div className={styles.col}>
                        <div className={styles.formGroup}>
                          <label>Percent Of Bounties In Chests</label>
                          <input
                            type="number"
                            className={styles.input}
                            value={mysteryPoolPercent}
                            onChange={(e) => setMysteryPoolPercent(digitsOnly(e.target.value))}
                            min={1}
                            max={100}
                            step={1}
                            inputMode="numeric"
                          />
                          <span className={styles.helperText}>
                            The Rest Pays Ordinary Bounties Before The Chests Open
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {format === 'bounty' && (
                  <span className={styles.helperText}>
                    Full Bounty Amount Is Awarded To The Knocker On Each Elimination
                  </span>
                )}
                {format === 'progressive_bounty' && (
                  <span className={styles.helperText}>
                    50% Of Bounty Goes To Knocker, 50% Added To Knocker's Own Bounty
                  </span>
                )}
                {format === 'mystery_bounty' && (
                  <span className={styles.helperText}>
                    The Chest Inventory Is Built From The Funded Mystery Pool When The Selected
                    Phase Opens, After Registration And Purchases Close. The Selected Prize Ladder
                    Sets The Chest Amounts And Counts. Knockouts Draw From That Inventory.
                  </span>
                )}
                {bountySplit && (
                  <div className={styles.splitRows} role="group" aria-label="Bounty Entry Split">
                    <span className={styles.sectionLabel}>
                      Each {money(bountySplit.buyIn)} Entry Splits
                    </span>
                    <div className={styles.splitRow}>
                      <span>Bounty Pool</span>
                      <strong>{money(bountySplit.bounty)}</strong>
                    </div>
                    <div className={styles.splitRow}>
                      <span>Rake</span>
                      <strong>{money(bountySplit.rake)}</strong>
                    </div>
                    <div
                      className={`${styles.splitRow}${bountySplit.prize < 0 ? ` ${styles.splitRowShort}` : ''}`}
                    >
                      <span>Prize Pool</span>
                      <strong>{money(bountySplit.prize)}</strong>
                    </div>
                    <span className={styles.helperText}>
                      Bounty And Prize Pools Are Tracked Separately; Unclaimed Bounty Money Goes To
                      The Champion.
                    </span>
                  </div>
                )}
                {!bountyValid && (
                  <p className={styles.errorText}>
                    {!isWholeBuyIn(bountyAmount)
                      ? 'Bounty Amount Is Required And Must Be A Whole Number Greater Than 0'
                      : bountySplit && bountySplit.prize < 0
                        ? `Bounty ${money(bountySplit.bounty)} + ${money(bountySplit.rake)} Rake Exceeds The ${money(bountySplit.buyIn)} Buy-In - Nothing Left For The Prize Pool`
                        : 'Check The Bounty Amount And Buy-In'}
                  </p>
                )}
              </div>
            )}

            {/* ── Rebuy / Re-Entry / Add-On ── */}
            {format !== 'spin' && (
              <div className={styles.sectionDivider}>
                <span className={styles.sectionLabel}>Rebuy / Re-Entry / Add-On</span>
                <div className={styles.row}>
                  <div className={styles.col}>
                    <div className={styles.toggleRow}>
                      {/* Locked: Entry Rules owns this. The switch reports it. */}
                      <Toggle
                        label="Allow Rebuys (Same Seat)"
                        value={isRebuy || isFreeBuy}
                        onChange={() => {}}
                        disabled
                      />
                      {!isRebuy && !isFreeBuy && (
                        <span className={styles.helperText}>
                          Set Entry Rules To Rebuy To Turn This On
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={styles.col}>
                    <div className={styles.toggleRow}>
                      <Toggle
                        label="Allow Re-Entry (New Seat)"
                        value={isReentry || isFreeBuy}
                        onChange={() => {}}
                        disabled
                      />
                      {!isReentry && !isFreeBuy && (
                        <span className={styles.helperText}>
                          Set Entry Rules To Re-Entry To Turn This On
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={styles.col}>
                    <div className={styles.toggleRow}>
                      <Toggle
                        label="Allow Add-Ons"
                        value={addOnAvailable || isFreeBuy}
                        onChange={setAddOnAvailable}
                        disabled={isFreeBuy}
                      />
                    </div>
                  </div>
                </div>

                {isFreeBuy && <span className={styles.helperText}>{FREE_BUY_HELPER}</span>}
                {(isRebuy || isReentry || isFreeBuy) && (
                  <>
                    <div className={styles.row}>
                      <div className={styles.col}>
                        <div className={styles.formGroup}>
                          <label>
                            {isFreeBuy ? 'Rebuy / Re-Entry' : isRebuy ? 'Rebuy' : 'Re-Entry'} Cost
                          </label>
                          <input
                            type="number"
                            className={styles.input}
                            value={isFreeBuy ? freeBuyTerms.rebuyCost : rebuyCost}
                            disabled={isFreeBuy}
                            onChange={(e) => setRebuyCost(digitsOnly(e.target.value))}
                            placeholder={buyIn}
                            min={1}
                            step={1}
                            inputMode="numeric"
                          />
                          <span className={styles.helperText}>
                            {isFreeBuy ? 'Fixed Free Buy Price' : 'Blank = Same As Buy-In'}
                          </span>
                        </div>
                      </div>
                      <div className={styles.col}>
                        <div className={styles.formGroup}>
                          <label>
                            {isFreeBuy ? 'Rebuy / Re-Entry' : isRebuy ? 'Rebuy' : 'Re-Entry'} Chips
                          </label>
                          <input
                            type="number"
                            className={styles.input}
                            value={isFreeBuy ? freeBuyTerms.rebuyChips : rebuyChips}
                            disabled={isFreeBuy}
                            /* digitsOnly, like every other chip field. A raw value let
                             parseInt('-500') through into the config. */
                            onChange={(e) => setRebuyChips(digitsOnly(e.target.value))}
                            placeholder={startingChips}
                          />
                          <span className={styles.helperText}>
                            {isFreeBuy && !isRebuy && !isReentry
                              ? 'Matches The Selected Starting Stack'
                              : 'Blank = Starting Stack'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <span className={styles.helperText} style={{ display: 'block', marginTop: 4 }}>
                      {isFreeBuy
                        ? `Rebuys And Re-Entries Close After Level ${freeBuyTerms.rebuyLevels}`
                        : isRebuy && isReentry
                          ? `Rebuy (Same Seat) And Re-Entry (New Seat) Both Close After Level ${lateRegLevels || 0}`
                          : isRebuy
                            ? `Rebuy Period Closes After Level ${lateRegLevels || 0} (Same As Late Registration)`
                            : `Re-Entry Period Closes After Level ${lateRegLevels || 0} (Same As Late Registration)`}
                    </span>
                  </>
                )}

                {(addOnAvailable || isFreeBuy) && (
                  <div className={styles.row} style={{ marginTop: 8 }}>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>Add-On Cost</label>
                        <input
                          type="number"
                          className={styles.input}
                          value={isFreeBuy ? freeBuyTerms.addOnCost : addOnCost}
                          disabled={isFreeBuy}
                          onChange={(e) => setAddOnCost(digitsOnly(e.target.value))}
                          placeholder={buyIn}
                          min={1}
                          step={1}
                          inputMode="numeric"
                        />
                        <span className={styles.helperText}>
                          {isFreeBuy ? 'Fixed Free Buy Price' : 'Blank = Same As Buy-In'}
                        </span>
                      </div>
                    </div>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>Add-On Chips</label>
                        <input
                          type="number"
                          className={styles.input}
                          value={addOnChips}
                          onChange={(e) => setAddOnChips(digitsOnly(e.target.value))}
                          placeholder={startingChips}
                        />
                        <span className={styles.helperText}>Blank = Starting Stack</span>
                      </div>
                    </div>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>Add-On Period</label>
                        <div className={styles.readOnlyRule}>
                          {isFreeBuy
                            ? 'From Seating Until The Add-On Window Closes'
                            : 'One 60-Second Period When The Rebuy Period Closes'}
                        </div>
                        <span className={styles.helperText}>
                          {isFreeBuy
                            ? 'Play Pauses After The Current Hand For The Final 60 Seconds. The Full Add-On Cost Goes To The Prize Pool With No Rake.'
                            : 'It Opens Once, When Late Registration, Rebuys And Re-Entries Close, Or When A Break Already Running Then Ends. Play Pauses After The Current Hand. The Full Add-On Cost Goes To The Prize Pool With No Rake.'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Multi-day creation is refused until Day 2 and flight merging exist. */}
            {(format === 'mtt_freezeout' || format === 'mtt_rebuy' || format === 'mtt_reentry') && (
              <div className={styles.formGroup}>
                <span className={styles.toggleLabel}>Multi-Day Tournament</span>
                <span className={styles.helperText}>
                  Not Available Yet. Day 2 Resume And Flight Merging Are Not Supported.
                </span>
              </div>
            )}

            {/* ── Auto Satellite Generation ── */}
            {!isSatellite && !isBountyFormat && format !== 'spin' && (
              <div className={styles.row}>
                <div className={styles.col} style={{ flex: '1 1 100%' }}>
                  <div className={`${styles.formGroup} ${styles.engravedTop}`}>
                    <div className={styles.toggleRow}>
                      <Toggle
                        label="Generate Satellites To This Event"
                        value={generateSatellites}
                        onChange={setGenerateSatellites}
                      />
                    </div>
                    {generateSatellites && (
                      <div
                        style={{
                          marginTop: '16px',
                          display: 'flex',
                          gap: '16px',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div className={styles.formGroup} style={{ flex: 1, minWidth: '120px' }}>
                          <label>Number Of Satellites</label>
                          <input
                            type="text"
                            inputMode="numeric"
                            className={styles.input}
                            value={genSatCount}
                            onChange={(e) => setGenSatCount(digitsOnly(e.target.value))}
                            min="1"
                            max="10"
                          />
                        </div>
                        <div className={styles.formGroup} style={{ flex: 1, minWidth: '120px' }}>
                          <label>Satellite Buy-In</label>
                          <input
                            type="text"
                            inputMode="numeric"
                            className={styles.input}
                            value={genSatBuyIn}
                            onChange={(e) => setGenSatBuyIn(digitsOnly(e.target.value))}
                            min="1"
                            placeholder={Math.round(parseInt(buyIn) * 0.1 || 10).toString()}
                          />
                        </div>
                        <div className={styles.formGroup} style={{ flex: 1, minWidth: '120px' }}>
                          <label>Seats Awarded</label>
                          <input
                            type="text"
                            inputMode="numeric"
                            className={styles.input}
                            value={genSatSeats}
                            onChange={(e) => setGenSatSeats(digitsOnly(e.target.value))}
                            min="1"
                          />
                        </div>
                      </div>
                    )}
                    {generateSatellites && (
                      <span
                        className={styles.helperText}
                        style={{ marginTop: 8, display: 'block' }}
                      >
                        Satellites Will Be Created Automatically Using The Same Format/Rules As This
                        Event, But Linked As Feeders. You Can Edit Their Start Times In The Lobby
                        Later.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Advanced Options (PokerBros parity, 2026-08-22) ── */}
            <div className={styles.sectionDivider}>
              <button
                type="button"
                className={styles.litWord}
                aria-expanded={showAdvanced}
                aria-controls="tournament-advanced-options"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
              </button>

              {showAdvanced && (
                <div id="tournament-advanced-options">
                  <div className={styles.formGroup} style={{ marginTop: 8 }}>
                    <label>Short Description</label>
                    <input
                      className={styles.input}
                      value={shortDescription}
                      maxLength={200}
                      onChange={(e) => setShortDescription(e.target.value)}
                      placeholder="Optional Line Shown On The Tournament Page"
                    />
                  </div>

                  <div className={styles.toggleGrid}>
                    {(
                      [
                        ['VIP Only', isVipOnly, setIsVipOnly],
                        ['All-In Or Fold', allInOrFold, setAllInOrFold],
                        ['Label As NEW', labelAsNew, setLabelAsNew],
                        ['Hide Club Name', hideClubName, setHideClubName],
                        ['Featured (Pinned)', isFeatured, setIsFeatured],
                        ['Accelerated MTT', acceleratedMtt, setAcceleratedMtt],
                        ['Big Blind Ante', bigBlindAnte, setBigBlindAnte],
                        ['Authorized To Register', authorizedToRegister, setAuthorizedToRegister],
                        ['Synchronized Breaks', synchronizedBreaks, setSynchronizedBreaks],
                        ['Bubble Protection', bubbleProtection, setBubbleProtection],
                        ['Final Table Deal', finalTableDeal, setFinalTableDeal],
                      ] as Array<[string, boolean, (v: boolean) => void]>
                    ).map(([label, value, setter]) => (
                      <div className={styles.toggleRow} key={label}>
                        <Toggle label={label} value={value} onChange={setter} />
                      </div>
                    ))}
                  </div>

                  <div className={styles.lockedRule}>
                    <strong>Chat: Off</strong>
                    <span>Chat Is Always Disabled In Multi-Table Tournaments.</span>
                  </div>

                  <div className={styles.row}>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>Action Time (Seconds)</label>
                        <input
                          type="number"
                          className={styles.input}
                          value={actionTimeSeconds}
                          onChange={(e) => setActionTimeSeconds(digitsOnly(e.target.value))}
                          min={5}
                          max={60}
                          step={1}
                          inputMode="numeric"
                        />
                        <span className={styles.helperText}>5 To 60 Seconds Per Action</span>
                      </div>
                    </div>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>Table Size</label>
                        <input
                          type="number"
                          className={styles.input}
                          value={tableSize}
                          onChange={(e) => setTableSize(digitsOnly(e.target.value))}
                          min={2}
                          max={10}
                          step={1}
                          inputMode="numeric"
                        />
                        <span className={styles.helperText}>2 To 10 Seats Per Table</span>
                      </div>
                    </div>
                  </div>

                  <div className={styles.row}>
                    <div className={styles.col}>
                      <div className={styles.toggleRow}>
                        <Toggle
                          label="Early Bird Registration"
                          value={earlyBirdEnabled}
                          onChange={setEarlyBirdEnabled}
                        />
                      </div>
                    </div>
                    {earlyBirdEnabled && (
                      <div className={styles.col}>
                        <div className={styles.formGroup}>
                          <label>Early Bird Chips</label>
                          <input
                            type="number"
                            className={styles.input}
                            value={earlyBirdChips}
                            onChange={(e) => setEarlyBirdChips(digitsOnly(e.target.value))}
                            min={0}
                            step={1}
                            inputMode="numeric"
                          />
                          <span className={styles.helperText}>
                            Bonus Chips For Registering Before The Start
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className={styles.row}>
                    <div className={styles.col}>
                      <div className={styles.formGroup}>
                        <label>Restart Every (Minutes)</label>
                        <input
                          type="number"
                          className={styles.input}
                          value={restartEvery}
                          onChange={(e) => setRestartEvery(digitsOnly(e.target.value))}
                          placeholder="Off"
                          min={5}
                          max={RESTART_MAX_MINUTES}
                          step={5}
                          inputMode="numeric"
                        />
                        <span className={styles.helperText}>
                          Blank = Off. 5 To 10080: The Tournament Respawns On This Interval.
                        </span>
                      </div>
                    </div>
                    {(isRebuy || isReentry) && (
                      <div className={styles.col}>
                        <div className={styles.formGroup}>
                          <label>Max {isRebuy ? 'Rebuys' : 'Re-Entries'} Per Player</label>
                          <input
                            type="number"
                            className={styles.input}
                            value={maxRebuysStr}
                            onChange={(e) => setMaxRebuysStr(digitsOnly(e.target.value))}
                            placeholder="Unlimited"
                            min={0}
                            step={1}
                            inputMode="numeric"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── Recurrence: ONE control, last thing on the form ── */}
            {!isSngOrSpin && (
              <div className={styles.sectionDivider}>
                <span className={styles.sectionLabel}>Recurrence</span>
                <div className={styles.formGroup}>
                  <label htmlFor="tournament-recurrence">Repeat</label>
                  <select
                    id="tournament-recurrence"
                    className={styles.select}
                    value={recurrence}
                    onChange={(e) => applyRecurrence(e.target.value as Recurrence)}
                  >
                    <option value="none">Does Not Repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                  <span className={styles.helperText}>
                    {recurrence === 'none'
                      ? 'This Event Runs Once.'
                      : recurrence === 'daily'
                        ? 'Runs Every Day At The Start Times Below, With This Configuration.'
                        : recurrence === 'monthly'
                          ? 'Runs Once A Month On The Day Below, With This Configuration.'
                          : 'Runs Every Week With This Configuration.'}
                  </span>
                  {repeatsWeekly && (
                    <span className={styles.helperText} data-testid="repeats-weekly-local-time">
                      {`Every ${WEEKDAY_NAMES[weeklySlotFromStart().daysOfWeek[0]] ?? ''} At ${
                        weeklySlotFromStart().startTimesUtc[0] ?? ''
                      } ${scheduleZoneLabel(scheduleTimeZone)}`}
                    </span>
                  )}
                </div>
                {recurrence === 'weekly' && (
                  <div className={styles.toggleRow}>
                    <Toggle
                      label="Use This Event's Day And Time"
                      value={weeklyMatchesStart}
                      onChange={(matches) => applyRecurrence('weekly', matches)}
                    />
                    <span className={styles.helperText}>
                      {weeklyMatchesStart
                        ? "Same Day And Time Every Week. Next Week's Event Is Published As Soon As This One Is Created."
                        : 'Pick The Days And Start Times Below.'}
                    </span>
                  </div>
                )}
                {recurrence === 'monthly' && (
                  <div className={styles.formGroup}>
                    <label htmlFor="tournament-recurrence-day">Day Of Month</label>
                    <select
                      id="tournament-recurrence-day"
                      className={styles.select}
                      value={scheduleDayOfMonth}
                      onChange={(event) =>
                        setScheduleDayOfMonth(
                          Math.min(31, Math.max(1, Number(event.target.value) || 1))
                        )
                      }
                    >
                      {DAYS_OF_MONTH.map((day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                    <span className={styles.helperText}>
                      {scheduleDayOfMonth >= 29
                        ? `Counted In ${scheduleZoneLabel(scheduleTimeZone)}. A Month With No Day ${scheduleDayOfMonth} Is Skipped.`
                        : `Counted In ${scheduleZoneLabel(scheduleTimeZone)}, Like The Start Times.`}
                    </span>
                  </div>
                )}
                {scheduleEnabled && (
                  <WeeklyScheduleEditor
                    timeZone={scheduleTimeZone}
                    value={schedule}
                    onChange={(next) =>
                      setSchedule(scheduleCadence === 'weekly' ? next : { ...next, mode: 'times' })
                    }
                    hideDays={scheduleCadence !== 'weekly'}
                    hideInterval={scheduleCadence !== 'weekly'}
                  />
                )}
              </div>
            )}

            {/* ── Validation Summary ── */}
            {!canSubmit && !isSubmitting && (
              <div className={styles.errorSummary} aria-label="What Still Needs Fixing">
                {!name.trim() && <p>Tournament Name Is Required</p>}
                {!blindsValid && <p>Blind Structure Must Have At Least One Level</p>}
                {!payoutsValid && (
                  <p>
                    Payouts Must Total 100 Percent. They Currently Total {payoutsTotal.toFixed(1)}
                  </p>
                )}
                {!buyInValid && (
                  <p>
                    {mttEntryRules === 'free_buy'
                      ? 'A Free Buy Entry Is Always 0 Chips'
                      : 'Buy-In Must Be A Whole Number Of Chips Greater Than 0'}
                  </p>
                )}
                {/* `NaN <= 0` is FALSE, so clearing the field disabled Create with
                  no explanation at all - the one field most likely to be
                  blank. */}
                {!(parseInt(startingChips) > 0) && <p>Starting Chips Must Be Greater Than 0</p>}
                {startTimeMode === 'scheduled' && (!scheduledDate || !scheduledTime) && (
                  <p>Scheduled Date And Time Are Required</p>
                )}
                {!rebuyWindowOpen && (
                  <p>{TOURNAMENT_CREATE_ERRORS.rebuy_requires_late_registration}</p>
                )}
                {!bountyValid && isBountyFormat && <p>Bounty Configuration Is Incomplete</p>}
              </div>
            )}
          </SpadeConsole>
        </form>
      </div>
    </div>
  );
}
