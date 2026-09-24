/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TABLE CONFIGURATION PAGE
 * ═══════════════════════════════════════════════════════════════════════════════
 * Three tabs. Regular renders the New Cash Game flow
 * (components/cash/CashGameCreateFlow, Operation Table Stakes Slice 1,
 * 2026-09-04): the database resolves the ruleset and writes the game, this
 * page writes nothing for cash. SNG and MTT are the tournament form: name,
 * template load/save, the tournament controls, and Save / Start, both of which
 * create the tournament through TournamentService (the engine starts it).
 *
 * The cash fields still present in TableConfig / DEFAULT_CONFIG exist so a
 * saved table_templates row from before Slice 1 still restores without a
 * type error; nothing on this page writes them anywhere.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import { resolveClubUUID } from '../utils/clubIdResolver';
import './TableConfigPage.css';
import { reportError } from '../utils/errorReporter';
import { RAKE_INHERIT } from '../config/RakeConfig';
import {
  restoreTemplateConfig,
  defaultTableName,
  templateFitsGame,
} from '../lib/tableTemplateRestore';
import { maxSeatsForVariant, maxSeatsTheDeckAllows } from '../config/tableSeating';

import { tournamentService } from '../services/TournamentService';
import { buildTournamentConfig } from '../lib/tournamentFromTableConfig';
import { TOURNAMENT_CREATE_ERRORS } from '../lib/tournamentCreationRules';
import {
  canRunAsTournament as gameTypeCanRunAsTournament,
  canRunAsSpin as gameTypeCanRunAsSpin,
} from '../config/tournamentVariants';
import { gameCreationDeniedMessage, type GameCreationAccess } from '../lib/gameCreationAccess';
import { fetchGameCreationAccess } from '../services/GameAccessService';
import { tournamentScheduleService } from '../services/TournamentScheduleService';
import WeeklyScheduleEditor, {
  validateWeeklySchedule,
} from '../components/tournament/WeeklyScheduleEditor';
import { HelpPopover } from '../components/common/HelpPopover';
import { Toggle, Slider, NumberField } from '../components/table-config/controls';
import DayScheduleEditor from '../components/tournament/DayScheduleEditor';
import { usePlatformCapability } from '../hooks/usePlatformCapability';
import { sealStagePlan, stageRefusalMessage } from '../services/TournamentStageService';
import {
  MULTI_DAY_CAPABILITY,
  buildStagePlan,
  defaultStagePlanDraft,
  type StagePlanDraft,
} from '../utils/multiDaySchedule';
import CashGameCreateFlow from '../components/cash/CashGameCreateFlow';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { MttCreationStructurePreview } from '../components/tournament/MttCreationStructurePreview';
import { MttPayoutDepthOptions } from '../components/tournament/MttPayoutDepthOptions';
import { MttCreationProfileSelect } from '../components/tournament/MttCreationProfileSelect';
import {
  FREE_BUY_ADDON_COST,
  FREE_BUY_HELPER,
  FREE_BUY_LABEL,
  FREE_BUY_REBUY_COST,
  isFreeBuyEvent,
} from '../utils/freeBuy';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
type GameMode = 'regular' | 'sng' | 'mtt';

type RunItMode = 'none' | 'player_choice' | 'mandatory_twice' | 'mandatory_three';
type BlindStructure = 'slow' | 'standard' | 'turbo' | 'hyper_turbo';
type PayoutStructure = 'payout1' | 'payout2' | 'payout3' | 'payout20' | 'winner_take_all';

interface TableTemplate {
  id: string;
  name: string;
  game_type: string;
  game_mode: string;
  config: TableConfig;
}

// SNG Player Count Options (2=Heads-Up, 3=Spins, 9=Single Table, then multi-table)
const SNG_PLAYER_OPTIONS = [
  { value: 2, label: '2 Players (Heads-Up)', isSpins: false, tables: 1 },
  { value: 3, label: '3 Players (Spins)', isSpins: true, tables: 1 },
  { value: 9, label: '9 Players (Single Table)', isSpins: false, tables: 1 },
  { value: 18, label: '18 Players (2 Tables)', isSpins: false, tables: 2 },
  { value: 27, label: '27 Players (3 Tables)', isSpins: false, tables: 3 },
  { value: 36, label: '36 Players (4 Tables)', isSpins: false, tables: 4 },
  { value: 45, label: '45 Players (5 Tables)', isSpins: false, tables: 5 },
  { value: 54, label: '54 Players (6 Tables)', isSpins: false, tables: 6 },
  { value: 63, label: '63 Players (7 Tables)', isSpins: false, tables: 7 },
  { value: 72, label: '72 Players (8 Tables)', isSpins: false, tables: 8 },
  { value: 81, label: '81 Players (9 Tables)', isSpins: false, tables: 9 },
  { value: 90, label: '90 Players (10 Tables)', isSpins: false, tables: 10 },
  { value: 99, label: '99 Players (11 Tables)', isSpins: false, tables: 11 },
];

interface TableConfig {
  // Basic
  name: string;
  gameMode: GameMode;

  // Basic Settings (toggles)
  isPrivate: boolean;
  isVipOnly: boolean;
  isAnonymous: boolean;
  banChat: boolean;
  labelAsNew: boolean;
  isFeatured: boolean;
  hideClubName: boolean;

  // Game Variants (toggles)
  //
  // 2026-08-27: `tripleBoard` was removed. It wrote tables.triple_board, a
  // column with ZERO readers anywhere — engine, SQL, lobby. A host who turned
  // it on was promised a three-board game and dealt an ordinary one. Same
  // treatment as the seven dead security switches (2026-08-19): the column
  // stays so nothing is lost, the switch goes until the feature exists.
  bombPotEnabled: boolean;
  // The two numbers that make Bomb Pot real. The engine fires a bomb pot
  // every `bomb_pot_frequency` hands with `bomb_pot_ante_multiplier` x BB
  // antes; until 2026-08-27 both were hard-coded (10 / 2) and the host had
  // no say.
  bombPotFrequency: number;
  bombPotAnteBB: number;
  // BOMB POT STANDARDIZATION 2026-08-27 (Dan's spec §3): the trigger schedule
  // and board count are the host's now. every_n_hands keeps the legacy
  // frequency slider; timed uses the interval; bomb_pot_only makes every hand
  // a bomb. Boards 1-3 supersede the old double-board boolean (still written
  // for old readers). minPlayers holds a due bomb pending below the floor.
  bombPotTriggerMode: 'every_n_hands' | 'once_per_orbit' | 'timed' | 'bomb_pot_only';
  bombPotIntervalMinutes: number;
  bombPotBoards: number;
  bombPotMinPlayers: number;
  /** FIXED ante mode (spec §3): exact chip amount; 0 = use the BB multiple. */
  bombPotAnteFixed: number;
  /** VARIANT OVERRIDE (spec §10.1): '' = same as table, else nlh/plo4/plo5/plo6. */
  bombPotVariant: '' | 'nlh' | 'plo4' | 'plo5' | 'plo6';
  /** ANNOUNCE WINDOW (spec §3): minutes before a timed bomb the clock appears; 0 = always. */
  bombPotAnnounceMinutes: number;
  /** SEPARATE BOMB BUTTON (spec §5.3): bomb hands rotate their own button. */
  bombPotSeparateButton: boolean;
  pineappleHoldem: boolean;
  sevenDeuceEnabled: boolean;
  sevenDeuceAmountBB: number;
  nitGame: boolean;
  capEnabled: boolean;
  capBB: number;

  // Table Parameters (sliders)
  maxPlayers: number;
  actionTimeSeconds: number;
  smallBlind: number;
  bigBlind: number;
  minBuyInBB: number;
  maxBuyInBB: number;
  anteBB: number;
  careerPercentMin: number;
  maintainPercentMin: number;
  maintainHands: number;
  autoStartPlayers: number;
  // 2026-08-27: `gameLengthHours` and `calltimeEnabled` removed — both wrote
  // columns (game_length_hours, calltime_enabled) with zero readers anywhere.
  // A "12 hour" table ran forever; a Calltime shot clock never ticked.
  // Columns stay; the switches return in the commit that implements them.

  // Time & Auto Settings (toggles)
  autoExtension: boolean;
  // NOT DEAD, despite looking it from a TypeScript grep (2026-08-31). Both
  // are read by fn_table_lifecycle_pass — SQL, verified against the live
  // function, not a migration file. auto_restart reopens a host's closed
  // table the way the fleet reopens its own; auto_create_table is the
  // overflow spawn extended to a host's table. See
  // tests/unit/tableLifecycleSwitches.test.ts, which pins exactly this.
  autoRestart: boolean;
  autoCreateTable: boolean;
  autoUtgStraddle: boolean;
  voluntaryStraddle: boolean;
  insuranceEnabled: boolean;

  // Run It Multi-Times
  runItMode: RunItMode;

  // Rake Settings
  rakePercent: number;
  rakeCapBB: number;

  // SNG/MTT Specific
  buyIn: number;
  customBuyIn: boolean;
  blindStructure: BlindStructure;
  payoutStructure: PayoutStructure;
  startingChips: number;
  sngPlayerCount: number;
  isSpins: boolean;
  blindsUpMinutes: number;
  nextStepSatellite: boolean;

  // MTT Specific
  shortDescription: string;
  acceleratedMtt: boolean;
  allInOrFold: boolean;
  customRebuyReentryCost: boolean;
  numberOfRebuysReentries: number;
  addOnMultiplier: number;
  customAddOn: boolean;
  addOnBreakLengthMinutes: number;
  koBounty: boolean;
  gtdPrizePool: boolean;
  finalTableDeal: boolean;
  bigBlindAnte: boolean;
  authorizedToRegister: boolean;
  lateRegistrationLevel: number;
  earlyBirdRegistration: boolean;
  bubbleProtection: boolean;
  featuredTournament: boolean;
  minPlayers: number;
  multiDayMtt: boolean;
  saveStartTime: boolean;
  startTime: string;
  restartTournamentEvery: boolean;
  tournamentSchedule: boolean;
  synchronizedBreaks: boolean;

  // PokerBros parity (2026-08-22): the value halves of toggles that used to
  // exist without their number, plus the weekly recurrence for the
  // Tournament Schedule toggle above.
  tableSize: number;
  rebuyReentryCost: number;
  customAddOnCost: number;
  gtdPrizeAmount: number;
  earlyBirdChips: number;
  totalDays: number;
  restartEveryMinutes: number;
  satelliteTargetId: string;
  satelliteSeats: number;
  scheduleDays: number[];
  scheduleTimes: string[];
  scheduleMode: 'times' | 'interval';
  scheduleIntervalMinutes: number;

  // Security Settings
  //
  // 2026-08-19: seven switches were removed from here — Same Agent Downline
  // Limit, Buy-in Authorization, Restrict Device, Restrict Observers, GPS
  // Restriction, PC Emulator Restriction and Photo Rotation Verification.
  // Every one of them wrote a `tables` column that NOTHING reads, and the four
  // that sound like real protections have no data behind them at all:
  // user_devices and geofence_visits are both empty, and there is no emulator
  // detection or photo verification anywhere in the codebase. A switch labelled
  // "GPS Restriction" that an owner turns on and believes in is worse than no
  // switch. The columns are left in place so nothing is lost.
  //
  // ipRestriction is the one that CAN be honoured — the engine already has each
  // player's IP at connect — so it stays.
  ipRestriction: boolean;
}

// 2026-08-23: these keys are the route's :gameType, which is the same string as
// the variant id in CreateTablePage.GAME_TYPES. Four entries here keyed ids that
// screen has never emitted — `shortdeck` (it sends `short_deck`), `plo`, `flo`,
// `mixed` — so every PLO, Pineapple and Short Deck config page fell through to
// the nlh default at `gameInfo` and titled itself "NLH". Keyed correctly now,
// with the two limit games added. Anything genuinely unknown still falls back.
const GAME_TYPE_LABELS: Record<string, { name: string; color: string }> = {
  nlh: { name: 'NLH', color: '#dc2626' },
  plo4: { name: 'PLO4', color: '#7c3aed' },
  plo5: { name: 'PLO5', color: '#7c3aed' },
  plo6: { name: 'PLO6', color: '#7c3aed' },
  plo8: { name: 'PLO8', color: '#7c3aed' },
  pineapple: { name: 'CRAZY PINEAPPLE', color: '#f59e0b' },
  short_deck: { name: '6+', color: '#0d9488' },
  // Green, matching the limit cards on the create-table screen.
  flh: { name: 'FLH', color: '#059669' },
  flo8: { name: 'FLO8', color: '#0d9488' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const DEFAULT_CONFIG: TableConfig = {
  name: '',
  gameMode: 'regular',

  // Basic Settings
  isPrivate: false,
  isVipOnly: false,
  isAnonymous: false,
  banChat: false,
  labelAsNew: false,
  isFeatured: false,
  hideClubName: false,

  // Game Variants
  bombPotEnabled: false,
  bombPotTriggerMode: 'every_n_hands',
  bombPotIntervalMinutes: 30,
  bombPotBoards: 2,
  bombPotMinPlayers: 3,
  bombPotAnteFixed: 0,
  bombPotVariant: '',
  bombPotAnnounceMinutes: 0,
  bombPotSeparateButton: false,
  // Bible V8 section 4.22 defaults, previously hard-coded in buildTableData.
  bombPotFrequency: 10,
  bombPotAnteBB: 2,
  pineappleHoldem: false,
  sevenDeuceEnabled: false,
  sevenDeuceAmountBB: 2,
  nitGame: false,
  capEnabled: false,
  // 50 BB is the middle of the range cap games actually run at. The AMOUNT is
  // what makes the Cap toggle real: the engine caps on cap_bb (see
  // ServerTableEngineTurns), and until 2026-08-27 this page never wrote it, so
  // the switch was decorative.
  capBB: 50,

  // Table Parameters
  maxPlayers: 9,
  actionTimeSeconds: 15,
  smallBlind: 0.05,
  bigBlind: 0.1,
  minBuyInBB: 40,
  /* Dan 2026-08-28: cash buy-ins are 40BB-200BB across the platform (the
     fleet, the horse launcher and the create-table API all write bb*40 /
     bb*200). This default was 100BB, so every table a club owner created
     through this page was born capped at half the platform ceiling. */
  maxBuyInBB: 200,
  anteBB: 0,
  careerPercentMin: 0,
  maintainPercentMin: 0,
  maintainHands: 10,
  autoStartPlayers: 2,

  // Time & Auto Settings
  autoExtension: false,
  autoRestart: false,
  autoCreateTable: false,
  autoUtgStraddle: false,
  voluntaryStraddle: false,
  insuranceEnabled: false,

  /* Run It Multi-Times.
     DEFAULT IS player_choice, NOT none (2026-08-31 audit). While the radio
     was inert (see buildTableData) 'none' was a label with no effect: every
     table created here offered run-it-twice, and the engine treats 'none'
     and 'player_choice' identically anyway - RunItTwiceEngine.mandatoryRuns
     returns 0 for both, meaning "the players decide". Now that the control
     genuinely writes the booleans, leaving the default at 'none' would have
     silently switched run-it-twice OFF for every newly created table across
     the platform. player_choice is what these tables have always actually
     done, so this keeps live behaviour identical and makes "None" mean it. */
  runItMode: 'player_choice',

  // Rake Settings (default 10% with 3BB cap)
  // -1 = inherit: use the club default, then the published rake schedule.
  // These used to default to 10 / 3 and were written to columns the engine
  // never read. Now that it does read them, a literal 3 BB cap would REPLACE
  // the schedule cap ($5 at 1/2, $15 at 10/25) on every table created here.
  rakePercent: RAKE_INHERIT,
  rakeCapBB: RAKE_INHERIT,

  // SNG/MTT Specific
  buyIn: 100,
  customBuyIn: false,
  blindStructure: 'standard',
  payoutStructure: 'payout3',
  startingChips: 1000,
  blindsUpMinutes: 3,
  sngPlayerCount: 9,
  isSpins: false,
  nextStepSatellite: false,

  // MTT Specific
  shortDescription: '',
  acceleratedMtt: false,
  allInOrFold: false,
  customRebuyReentryCost: false,
  numberOfRebuysReentries: 3,
  addOnMultiplier: 1.0,
  customAddOn: false,
  addOnBreakLengthMinutes: 1,
  koBounty: false,
  gtdPrizePool: false,
  finalTableDeal: false,
  bigBlindAnte: false,
  authorizedToRegister: false,
  lateRegistrationLevel: 6,
  earlyBirdRegistration: false,
  bubbleProtection: false,
  featuredTournament: false,
  minPlayers: 3,
  multiDayMtt: false,
  saveStartTime: false,
  startTime: '',
  restartTournamentEvery: false,
  tournamentSchedule: false,
  synchronizedBreaks: true,

  // PokerBros parity (2026-08-22)
  tableSize: 9,
  rebuyReentryCost: 0,
  customAddOnCost: 0,
  gtdPrizeAmount: 0,
  earlyBirdChips: 0,
  totalDays: 2,
  restartEveryMinutes: 60,
  satelliteTargetId: '',
  satelliteSeats: 1,
  scheduleDays: [],
  scheduleTimes: ['18:00'],
  scheduleMode: 'times',
  scheduleIntervalMinutes: 60,

  // Security Settings.
  // OFF by default. The column default was `true`, so all 56,053 existing
  // tables carry ip_restriction = true — not because anyone chose it, but
  // because the switch never meant anything. Enforcement is opt-in: an owner
  // turns it on deliberately.
  ipRestriction: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER HELPERS (hoisted to module scope — they only use props, so defining them
// inside the component would create new component types every render and remount
// every <Toggle>/<Slider>, breaking slider drags mid-gesture)
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Where the operator goes when this form is finished with. In route mode the
 * page navigates to the host club; embedded inside Table Management (a club's
 * or a union's) the host page owns the URL and decides instead.
 */
export type TableConfigExit = 'denied' | 'saved' | 'tournament_created';

export interface TableConfigPageProps {
  /**
   * EMBEDDED MODE (2026-09-04). Table Management mounts this form on its own
   * page with the host club fixed by the page, not the URL. From the union
   * console the host is the union's own club row, so `clubIdOverride` is a
   * UUID and the URL stays at /unions/<union>/table-management. Before this,
   * the only way to reach the form was /clubs/<host>/create-table/<variant>,
   * which threw a union operator out of the union and onto a member club.
   */
  clubIdOverride?: string;
  gameTypeOverride?: string;
  /** Embedded hosts receive every exit instead of a club navigation. */
  onExit?: (exit: TableConfigExit) => void;
  /** The parent Table Management console already owns the painted chassis. */
  embedded?: boolean;
}

export default function TableConfigPage({
  clubIdOverride,
  gameTypeOverride,
  onExit,
  embedded = false,
}: TableConfigPageProps = {}) {
  const params = useParams<{ clubId: string; gameType: string }>();
  const clubId = clubIdOverride || params.clubId;
  const gameType = gameTypeOverride || params.gameType;
  const navigate = useNavigate();
  const toast = useToast();

  const [config, setConfig] = useState<TableConfig>({ ...DEFAULT_CONFIG });
  /* MULTI-DAY MTT (design R5). The switch exists only while the platform
     registry says tournament.multi_day.single_flight is available; the Day
     Schedule is sealed through fn_operator_seal_stage_plan right after the
     tournament is created. The badge columns (is_multi_day, total_days) are
     never written from here: buildTournamentConfig still refuses them and the
     database guard stays the gate until R6. */
  const multiDayGate = usePlatformCapability(MULTI_DAY_CAPABILITY);
  const [stagePlan, setStagePlan] = useState<StagePlanDraft>(defaultStagePlanDraft);
  /* FREEROLLS ARE FREE BUY (Dan 2026-09-02): a 0 buy-in MTT. Spins and SNGs
     never qualify, whatever the buy-in field says. */
  const isFreeBuy = isFreeBuyEvent({
    buyIn: config.buyIn,
    type: config.gameMode === 'mtt' ? 'mtt' : config.gameMode === 'sng' ? 'sng' : 'cash',
    tournamentType: config.gameMode === 'mtt' ? 'MTT' : config.gameMode === 'sng' ? 'SNG' : 'CASH',
  });
  /* What WE last auto-generated for the name. Anything else in the field was
     typed by the owner and is never overwritten. */
  const autoNameRef = useRef<string>('');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [templates, setTemplates] = useState<TableTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Next Step (Satellite): upcoming non-satellite tournaments in this club
  // that a satellite here can feed seats into.
  const [satelliteTargets, setSatelliteTargets] = useState<{ id: string; name: string }[]>([]);

  // PERMISSION GATE: who is allowed to build a game for this club.
  //
  // The same builder is reached from a standalone club or from the union
  // console. fn_game_creation_access distinguishes an authorized union
  // operator from the member club's own staff.
  const [access, setAccess] = useState<GameCreationAccess | null>(null);
  const checkingAccess = access === null;
  const canBuildHere = access?.allowed === true;

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setSaving(false);
    setStarting(false);
    setSelectedTemplateId('');
    setSavingTemplate(false);
    setAccess(null);
  }, [clubId]);

  useEffect(() => {
    if (!clubId) {
      setAccess({ allowed: false, unionId: null, reason: 'unknown_club' });
      return;
    }
    let isMounted = true;
    (async () => {
      let result: GameCreationAccess;
      try {
        const resolvedId = await resolveClubUUID(clubId);
        result = await fetchGameCreationAccess(resolvedId);
      } catch (e) {
        // Fail closed: the database would refuse the insert anyway, and a
        // wrong "yes" here means filling in the whole form for nothing.
        reportError(e, 'TableConfigPage.gameCreationAccess');
        result = { allowed: false, unionId: null, reason: 'check_failed' };
      }
      if (!isMounted) return;
      setAccess(result);
      if (!result.allowed) {
        toast.error(gameCreationDeniedMessage(result));
        if (onExit) onExit('denied');
        else navigate(`/clubs/${clubId}`);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [clubId]);

  const gameInfo = GAME_TYPE_LABELS[gameType || 'nlh'] || GAME_TYPE_LABELS.nlh;

  /**
   * SEAT LAW (Dan 2026-08-19, src/config/tableSeating.ts). The Table Size
   * slider used to offer 2..10 for EVERY variant, and this page is the only
   * live cash-table creation path. A 10-max PLO5/PLO6/PLO8 table overdraws
   * the deck and the server engine's PokerEngine.deal() throws
   * 'Not enough cards in deck' mid-hand. The cap is per variant: plo6 6,
   * plo5 7, plo4/plo8/flo8 8, everything else 9.
   */
  const seatCap = maxSeatsForVariant(gameType || 'nlh');

  // Tournaments are exempt from the cash law (see the tableSeating header)
  // but NOT from the deck: a 10-seat PLO6 SNG cannot physically be dealt.
  const sngSeatCap = Math.min(10, maxSeatsTheDeckAllows(gameType || 'nlh'));

  // Declared beside the seat caps because loadTemplate needs all three.
  const canRunAsTournament = gameTypeCanRunAsTournament(gameType);

  // If the route's variant changes under the mounted form (or a template
  // loaded an over-cap value), snap the seat counts down to the new caps.
  // Never up: the caps are ceilings, not targets.
  useEffect(() => {
    setConfig((c) =>
      c.maxPlayers > seatCap || c.tableSize > sngSeatCap
        ? {
            ...c,
            maxPlayers: Math.min(c.maxPlayers, seatCap),
            tableSize: Math.min(c.tableSize, sngSeatCap),
          }
        : c
    );
  }, [seatCap, sngSeatCap]);

  // Fetch templates for this club on mount
  useEffect(() => {
    let isMounted = true;
    const fetchTemplates = async () => {
      if (!clubId) return;
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data, error } = await supabase
          .from('table_templates')
          .select('id, name, game_type, game_mode, config, club_id, is_deleted, created_at')
          .eq('club_id', resolvedId)
          .eq('is_deleted', false)
          .order('created_at', { ascending: false });

        if (!isMounted) return;
        if (error) throw error;
        setTemplates(data || []);
      } catch (err) {
        if (isMounted) reportError(err, 'TableConfigPage.Failed_to_fetch_templates');
      }
    };
    fetchTemplates();
    return () => {
      isMounted = false;
    };
  }, [clubId]);

  // ── Realtime: live template updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `table-config-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'table_templates',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            supabase
              .from('table_templates')
              .select('id, name, game_type, game_mode, config, club_id, is_deleted, created_at')
              .eq('club_id', resolvedId)
              .eq('is_deleted', false)
              .order('created_at', { ascending: false })
              .then(({ data }) => {
                if (isMounted && data) setTemplates(data);
              });
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'TableConfigPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[TableConfigPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[TableConfigPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // ── Next Step (Satellite): load candidate target tournaments once the
  // toggle is on, mirroring CreateTournamentModal's satellite picker. ──
  useEffect(() => {
    if (!config.nextStepSatellite || config.gameMode !== 'mtt' || !clubId) return;
    let alive = true;
    (async () => {
      try {
        const resolved = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('tournaments')
          .select('id, name, tournament_type, status, start_time')
          .eq('club_id', resolved)
          .neq('tournament_type', 'satellite')
          .in('status', ['REGISTERING', 'ANNOUNCED'])
          .order('start_time', { ascending: true })
          .limit(50);
        if (alive) {
          setSatelliteTargets(
            ((data as Array<{ id: string; name: string }> | null) || []).map((t) => ({
              id: t.id,
              name: t.name,
            }))
          );
        }
      } catch (e) {
        reportError(e, 'TableConfigPage.loadSatelliteTargets');
      }
    })();
    return () => {
      alive = false;
    };
  }, [config.nextStepSatellite, config.gameMode, clubId]);

  // ── "Save the Start Time": prefill the last saved start time for this club
  // (localStorage — see the comment on the toggle) when it is still in the
  // future. ──
  useEffect(() => {
    if (!clubId) return;
    try {
      const saved = localStorage.getItem(`ca_saved_start_time_${clubId}`);
      if (saved && new Date(saved).getTime() > Date.now()) {
        setConfig((prev) =>
          prev.startTime ? prev : { ...prev, startTime: saved, saveStartTime: true }
        );
      }
    } catch {
      /* storage unavailable — the picker still works */
    }
  }, [clubId]);

  // Generate the default table name, and KEEP IT TRACKING THE BLINDS.
  //
  // 2026-08-23: limit games are named by BET size, not blind size — blinds
  // 1/2 is a "2/4" limit game. defaultTableName() defers to stakesLabel(),
  // the one place that decides, so the table name, the stakes column and the
  // lobby row all agree.
  //
  // 2026-08-31 audit: the dependency array was [gameInfo.name] and the write
  // was guarded by `prev.name ||`, so the name was decided once at mount and
  // never again. Accept the default, then drag the blinds to 10/25, and you
  // created a table NAMED "NLH 0.05/0.1" PLAYING 10/25 — tables.name flatly
  // disagreeing with tables.stakes. A name the OWNER typed is still never
  // touched: autoNameRef records what we last generated, and only that exact
  // string is replaced.
  useEffect(() => {
    const generated = defaultTableName(gameInfo.name, config.smallBlind, config.bigBlind, gameType);
    if (config.name && config.name !== autoNameRef.current) return;
    autoNameRef.current = generated;
    if (config.name === generated) return;
    setConfig((prev) => ({ ...prev, name: generated }));
  }, [gameInfo.name, gameType, config.smallBlind, config.bigBlind, config.name]);

  const updateConfig = <K extends keyof TableConfig>(key: K, value: TableConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Load a template's config into the form.
   *
   * 2026-08-31 audit. This used to be one line —
   * `setConfig({ ...DEFAULT_CONFIG, ...template.config, name: '' })` — and it
   * left the form describing a table the owner was NOT about to create: no
   * name (so Save and Start both bailed straight after the success toast), a
   * game mode the variant may not support, a blinds slider still pointing at
   * whatever it pointed at before, and a seat count the write would silently
   * clamp. restoreTemplateConfig() is that whole decision as a pure function,
   * pinned by tests/unit/templateLoadRestoresAConsistentForm.test.ts.
   */
  const loadTemplate = (templateId: string) => {
    if (!templateId) {
      setSelectedTemplateId('');
      return;
    }
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;

    const restored = restoreTemplateConfig<TableConfig>({
      defaults: DEFAULT_CONFIG,
      templateConfig: template.config,
      templateGameType: template.game_type,
      routeGameType: gameType,
      gameLabel: gameInfo.name,
      seatCap,
      sngSeatCap,
      canRunAsTournament,
    });

    if (!restored.ok) {
      toast.error(restored.reason);
      setSelectedTemplateId('');
      return;
    }

    setConfig(restored.config);
    // The restored name is OURS, so the blinds keep renaming the table until
    // the owner types over it.
    autoNameRef.current = restored.config.name;
    setSelectedTemplateId(templateId);
    toast.success(`Loaded Template: ${template.name}`);
    restored.notices.forEach((notice) => toast.info(notice));
  };

  // Save current config as a template
  const handleSaveAsTemplate = async () => {
    if (!config.name.trim()) {
      toast.error('Please enter a table name first');
      return;
    }

    setSavingTemplate(true);
    try {
      const {
        data: { user },
      } = await getAuthUser();
      if (!user) throw new Error('Not authenticated');

      const resolvedId = await resolveClubUUID(clubId || '');
      const templateData = {
        club_id: resolvedId, // FIX: was using raw clubId — must use resolved UUID
        name: config.name,
        game_type: gameType?.toUpperCase() || 'NLH',
        game_mode: config.gameMode,
        config: config,
        created_by: user.id,
      };

      const { data, error } = await supabase
        .from('table_templates')
        .insert(templateData)
        .select()
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Template save returned no data');

      setTemplates((prev) => [data, ...prev]);
      toast.success('Template saved! You can now duplicate this table easily.');
    } catch (err) {
      reportError(err, 'TableConfigPage.Failed_to_save_template');
      toast.error('Failed to save template');
    } finally {
      setSavingTemplate(false);
    }
  };

  /**
   * The Players dropdown, narrowed to what this game can actually be.
   *
   * "3 Players (Spins)" is the only entry that changes the PRODUCT rather than
   * the field size, and Spin & Go sells four games (SPIN_GAME_TYPES). Offering
   * it on a Short Deck or PLO8 page created a Spin the Spins board has no
   * filter chip for — it vanished from the lobby the moment a player ticked any
   * Games chip, with nothing to bring it back. Removing the OPTION is the fix;
   * `buildTournamentConfig` refuses the same combination independently, for a
   * draft or template that carries it in past this screen.
   */
  /**
   * Templates are fetched for the whole CLUB, not for this variant, so a PLO6
   * template used to sit in the dropdown of an FLH page. Loading it carried
   * PLO6's toggles, stakes and seat count onto a fixed-limit table — the same
   * "promised what it cannot pay" shape the fixed-limit sweep just closed.
   * Templates saved before game_type existed carry no variant and stay
   * offered; refusing those would strand every template an owner already has.
   */
  const templatesForThisGame = useMemo(
    () => templates.filter((t) => templateFitsGame(t.game_type, gameType)),
    [templates, gameType]
  );

  const sngPlayerOptions = useMemo(
    () => SNG_PLAYER_OPTIONS.filter((o) => !o.isSpins || gameTypeCanRunAsSpin(gameType)),
    [gameType]
  );

  // Handle SNG player count change (auto-set spins mode for 3 players)
  const handleSngPlayerChange = (playerCount: number) => {
    const option = SNG_PLAYER_OPTIONS.find((o) => o.value === playerCount);
    setConfig((prev) => ({
      ...prev,
      sngPlayerCount: playerCount,
      /* `isSpins` follows the CATALOGUE, not just the row: a stale draft that
         still says 3 on a game Spins does not sell becomes a three-handed Sit &
         Go rather than an unfilterable Spin. */
      isSpins: Boolean(option?.isSpins) && gameTypeCanRunAsSpin(gameType),
    }));
  };

  /* buildTableData was removed on 2026-09-04 (Operation Table Stakes, Slice
     1). A cash game's `tables` row is written by fn_cash_game_create from the
     game's resolved ruleset snapshot; this page no longer builds one. */

  const handleSave = async () => {
    if (!config.name.trim()) {
      toast.error('Please enter a table name');
      return;
    }
    // PERMISSION GATE: re-check at save time (defense-in-depth).
    if (!canBuildHere) {
      toast.error(
        checkingAccess
          ? 'Still checking your permission to create games here.'
          : gameCreationDeniedMessage(access!)
      );
      return;
    }

    /**
     * WHAT SAVE MEANS NOW (2026-08-27).
     *
     * Save used to insert a full `tables` row stamped with the is_template
     * flag and toast "Table template saved!". Both halves of that were false.
     * Nothing in src reads that flag — the template dropdown at the top of this page
     * reads `table_templates`, so the saved "template" never appeared in it.
     * And because every lobby query ignores `is_template` too, the row DID
     * appear in the club lobby as an ordinary joinable table. On the SNG/MTT
     * tabs it was worse: saving a tournament config produced a CASH table row.
     *
     * Save now does what its name says for each tab:
     *   Regular — create the table, open in the lobby, stay-or-leave is the
     *             only difference from Start (Start navigates to the felt).
     *   SNG/MTT — create the tournament exactly as Start does (the engine owns
     *             starting either way). Templates have their own button.
     */
    // Regular (cash) never reaches here: the New Cash Game flow owns Save and
    // Start for cash and this footer is tournament-only.
    if (config.gameMode === 'regular') return;
    setSaving(true);
    try {
      await handleStartTournament();
    } finally {
      setSaving(false);
    }
  };

  /**
   * SNG / MTT: create a real tournament and go to the tournament list.
   *
   * Deliberately does NOT start it. Starting is the engine's job — the
   * discovery loop picks up a REGISTERING tournament and starts an SNG when it
   * fills, or an MTT at its start time once the minimum field is present. The
   * client-side startTournament() path exists but duplicates the engine's
   * seating with hardcoded 9-max, so it is not used here.
   */
  /**
   * Save the weekly recurrence (Tournament Schedule toggle) via
   * fn_upsert_tournament_schedule. Shared by Start and Save so either button
   * lands the schedule. Returns false when validation refused (already
   * toasted); throws on RPC failure so callers surface the server's reason.
   */
  const saveTournamentSchedule = async (): Promise<boolean> => {
    const scheduleValue = {
      daysOfWeek: config.scheduleDays,
      startTimesUtc: config.scheduleTimes.filter((t) => t.trim() !== ''),
      mode: config.scheduleMode,
      intervalMinutes: config.scheduleIntervalMinutes,
    };
    const problem = validateWeeklySchedule(scheduleValue);
    if (problem) {
      toast.error(problem);
      return false;
    }
    const resolvedId = await resolveClubUUID(clubId || '');
    const rpcConfig = tournamentService.buildRpcConfig(buildTournamentConfig(config, gameType));
    delete rpcConfig.startTime;
    await tournamentScheduleService.upsert({
      clubId: resolvedId,
      unionId: null,
      name: config.name.trim() || 'Tournament',
      daysOfWeek: scheduleValue.daysOfWeek,
      startTimesUtc: scheduleValue.mode === 'times' ? scheduleValue.startTimesUtc : [],
      intervalMinutes: scheduleValue.mode === 'interval' ? scheduleValue.intervalMinutes : null,
      active: true,
      config: rpcConfig,
    });
    toast.success('Recurring schedule saved.');
    return true;
  };

  const handleStartTournament = async () => {
    setStarting(true);
    try {
      // Next Step (Satellite) sanity: an ON toggle with no target would
      // silently build a cash-paying MTT, so refuse before any round trip.
      if (config.gameMode === 'mtt' && config.nextStepSatellite && !config.satelliteTargetId) {
        toast.error(TOURNAMENT_CREATE_ERRORS.satellite_target_required);
        return;
      }

      const tournamentConfig = buildTournamentConfig(config, gameType);

      /* The Day Schedule is checked before anything is created, so a plan the
         database would refuse never leaves a one-day event behind it. */
      const multiDay =
        config.gameMode === 'mtt' && config.multiDayMtt && multiDayGate === 'available';
      let sealedPlan: ReturnType<typeof buildStagePlan> | null = null;
      if (multiDay) {
        if (config.tournamentSchedule) {
          toast.error('A Multi-Day MTT Cannot Also Repeat On A Weekly Schedule.');
          return;
        }
        if (!tournamentConfig.startTime) {
          toast.error('Set The Start Time For Day 1.');
          return;
        }
        sealedPlan = buildStagePlan(stagePlan, {
          entryLevels: Math.max(
            tournamentConfig.lateRegistrationLevels || 0,
            tournamentConfig.rebuyLevels || 0,
            tournamentConfig.addOnLevels || 1
          ),
          day1StartUtc: tournamentConfig.startTime.toISOString(),
        });
        if (!sealedPlan.ok) {
          toast.error(sealedPlan.message);
          return;
        }
      }

      // ── Tournament Schedule (2026-08-22): with the toggle ON, save a
      // tournament_schedules row carrying the exact p_config a hand-created
      // tournament would send (minus startTime — the spawner owns that). A
      // one-off is ALSO created only when the owner picked a start time. ──
      const scheduleOn = config.gameMode === 'mtt' && config.tournamentSchedule;
      if (scheduleOn) {
        const ok = await saveTournamentSchedule();
        if (!ok) return;
      }

      // "Save the Start Time": remember the picked time for next visit.
      if (config.gameMode === 'mtt' && config.saveStartTime && config.startTime) {
        try {
          localStorage.setItem(`ca_saved_start_time_${clubId}`, config.startTime);
        } catch {
          /* storage unavailable */
        }
      }

      const createOneOff = !scheduleOn || Boolean(tournamentConfig.startTime);
      if (createOneOff) {
        const created = await tournamentService.createTournament(clubId || '', tournamentConfig);
        // Say what was actually built: a 3-handed SNG is a Spin, a 2-handed
        // one is Heads Up, and the old message called every SNG "Heads Up".
        toast.success(
          config.gameMode === 'sng'
            ? config.isSpins
              ? 'Spin created. It starts as soon as three players sit.'
              : config.sngPlayerCount === 2
                ? 'Heads Up created. It starts as soon as it fills.'
                : 'Sit and Go created. It starts as soon as it fills.'
            : 'Tournament created. Registration is open.'
        );
        const createdId = (created as { id?: string } | null)?.id;
        if (createdId && sealedPlan?.ok) {
          const sealed = await sealStagePlan(createdId, sealedPlan.plan);
          if (sealed.ok) {
            toast.success(`Day Schedule Saved: ${sealedPlan.plan.stages.length} Days.`);
          } else {
            toast.error(
              `The Tournament Was Created As A One-Day Event. ${stageRefusalMessage(sealed.reason)}.`
            );
          }
        }
        if (createdId) {
          masterBus.emit('TOURNAMENT_UPDATED', { tournamentId: createdId, status: 'REGISTERING' });
        }
      }
      if (onExit) onExit('tournament_created');
      else navigate(`/clubs/${clubId}/tournaments`);
    } catch (error) {
      reportError(error, 'TableConfigPage.Failed_to_create_tournament');
      toast.error(error instanceof Error ? error.message : 'Failed to create tournament');
    } finally {
      setStarting(false);
    }
  };

  const handleStart = async () => {
    if (!config.name.trim()) {
      toast.error(
        config.gameMode === 'regular' ? 'Please enter a table name' : 'Please enter a name'
      );
      return;
    }

    // PERMISSION GATE: re-check at start time (defense-in-depth). This sits
    // ABOVE the tournament fork because the same rule covers both: cash games
    // and tournaments are built by the same people. The server enforces it
    // either way (the tables RLS policy and fn_create_tournament both call
    // fn_can_create_games); this is only so the message says why.
    if (!canBuildHere) {
      toast.error(
        checkingAccess
          ? 'Still checking your permission to create games here.'
          : gameCreationDeniedMessage(access!)
      );
      return;
    }

    // 2026-08-19: the SNG and MTT tabs used to fall through to the cash-table
    // insert below and produce an ordinary ring game. They build a real
    // tournament now.
    // Regular (cash) never reaches here: the New Cash Game flow owns Save and
    // Start for cash and this footer is tournament-only.
    if (config.gameMode === 'regular') return;
    setStarting(true);
    try {
      await handleStartTournament();
    } finally {
      setStarting(false);
    }
  };

  const content = (
    <div className="table-config-page">
      {/* Header */}
      <div className="config-header">
        <h1 className="config-title">{gameInfo.name}</h1>
      </div>

      {/* Game Mode Tabs.
          The SNG and MTT tabs only appear for game types the tournament engine
          can actually deal. HandController maps an unknown variant to 2 cards
          and a full deck, so offering a Limit Hold'em or Mixed tournament would
          silently run No Limit Hold'em instead. */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${config.gameMode === 'regular' ? 'active' : ''}`}
          onClick={() => updateConfig('gameMode', 'regular')}
        >
          Regular
        </button>
        {canRunAsTournament && (
          <>
            <button
              className={`mode-tab ${config.gameMode === 'sng' ? 'active' : ''}`}
              onClick={() => updateConfig('gameMode', 'sng')}
            >
              SNG
            </button>
            <button
              className={`mode-tab ${config.gameMode === 'mtt' ? 'active' : ''}`}
              onClick={() => updateConfig('gameMode', 'mtt')}
            >
              MTT
            </button>
          </>
        )}
      </div>

      {/* Template Selector - At TOP for easy duplication (tournaments; cash
          games have the three house templates inside the flow) */}
      {config.gameMode !== 'regular' && templatesForThisGame.length > 0 && (
        <div className="template-selector">
          <label className="template-label">Load Template:</label>
          <select
            className="template-dropdown"
            value={selectedTemplateId}
            onChange={(e) => loadTemplate(e.target.value)}
          >
            <option value="">-- Start Fresh --</option>
            {templatesForThisGame.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Spins Mode Indicator */}
      {config.isSpins && config.gameMode === 'sng' && (
        <div className="spins-indicator">
          <span className="spins-badge">SPINS</span>
          <span className="spins-text">3-Player Spins Mode Active</span>
        </div>
      )}

      {/* Table Name (tournaments; the cash flow names the game itself) */}
      {config.gameMode !== 'regular' && (
        <div className="config-name">
          <input
            type="text"
            placeholder="Enter Table Name Here..."
            value={config.name}
            maxLength={30}
            onChange={(e) => updateConfig('name', e.target.value.slice(0, 30))}
          />
        </div>
      )}

      {/* Scrollable Options */}
      <div className="config-options">
        {/* 2026-08-19: everything from here to the tournament options is
            CASH-TABLE configuration. It writes `tables` columns, and a
            tournament does not use a `tables` row of its own — TournamentManager
            creates its tables with a fixed settings payload when the tournament
            starts. Leaving these on the SNG/MTT tabs meant an owner could set
            blinds, buy-in caps, bomb pots and straddle rules for a tournament
            and have every one of them silently ignored. */}
        {/* OPERATION TABLE STAKES, Slice 1 (2026-09-04): a host creates a
            GAME, not a table. The cash configuration that lived here - every
            section from Basic Settings to Security, and the two
            `tables` inserts behind Save / Start - is replaced by the New
            Cash Game flow, which persists a `cash_games` row and its
            resolved ruleset snapshot through fn_cash_game_create. Nothing
            on this page writes `tables` for a cash game any more. */}
        {config.gameMode === 'regular' && (
          <CashGameCreateFlow
            clubId={clubId || ''}
            initialVariant={gameType}
            canBuildHere={canBuildHere}
            deniedMessage={access ? gameCreationDeniedMessage(access) : null}
            onSaved={onExit ? () => onExit('saved') : undefined}
          />
        )}

        {/* SNG/MTT SPECIFIC OPTIONS */}
        {(config.gameMode === 'sng' || config.gameMode === 'mtt') && (
          <>
            {/* SNG Player Count Dropdown - Only for SNG */}
            {config.gameMode === 'sng' && (
              <div className="config-toggle">
                <span className="toggle-label">
                  Players
                  <HelpPopover label="Players">Number Of Players In SNG</HelpPopover>
                </span>
                <select
                  className="config-select sng-player-select"
                  value={config.sngPlayerCount}
                  onChange={(e) => handleSngPlayerChange(Number(e.target.value))}
                >
                  {sngPlayerOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* ── Shared tournament settings (2026-08-22): every one of these
                maps to an fn_create_tournament p_config key, so nothing here
                is a dead switch. Same Toggle/Slider components and CSS as the
                Regular tab. ── */}
            <Toggle
              label="Private Game"
              value={config.isPrivate}
              onChange={(v) => updateConfig('isPrivate', v)}
              tooltip="Visible Only Inside Your Club, Never In The Union Lobby"
            />
            <Toggle
              label="VIP Only"
              value={config.isVipOnly}
              onChange={(v) => updateConfig('isVipOnly', v)}
            />
            <div className="config-textarea">
              <span className="textarea-label">Short Description</span>
              <textarea
                className="config-textarea-input"
                maxLength={200}
                placeholder="Optional Line Shown On The Tournament Page..."
                value={config.shortDescription}
                onChange={(e) => updateConfig('shortDescription', e.target.value)}
              />
            </div>
            <Toggle
              label="Ban Chat"
              value={config.banChat}
              onChange={(v) => updateConfig('banChat', v)}
              tooltip="Table Chat Is Disabled For Players In This Tournament"
            />
            <Toggle
              label="All-In Or Fold"
              value={config.allInOrFold}
              onChange={(v) => updateConfig('allInOrFold', v)}
              tooltip="Players May Only Move All-In Or Fold"
            />
            <Toggle
              label="Label As NEW"
              value={config.labelAsNew}
              onChange={(v) => updateConfig('labelAsNew', v)}
              tooltip="Show NEW Badge In The Lobby"
            />
            <Toggle
              label="Featured Tournament"
              value={config.featuredTournament}
              onChange={(v) => updateConfig('featuredTournament', v)}
              tooltip="Pinned To The Top Of Every Tournament List"
            />
            <Toggle
              label="Hide Club Name"
              value={config.hideClubName}
              onChange={(v) => updateConfig('hideClubName', v)}
            />
            <Slider
              label="Table Size"
              value={config.tableSize}
              onChange={(v) => updateConfig('tableSize', v)}
              min={2}
              max={sngSeatCap}
              suffix=" seats"
            />
            <Slider
              label="Action Time"
              value={config.actionTimeSeconds}
              onChange={(v) => updateConfig('actionTimeSeconds', v)}
              /* 10 IS THE FLOOR (2026-08-31 audit). The slider offered 5s while
                 the engine's own floor is 10 and the DB creation guard
                 (fn_tables_creation_guard) now refuses anything under it — so a
                 5s table was an unsaveable table. */
              min={10}
              max={60}
              suffix=" sec"
            />
            {/* Fee is the HOUSE RULE cut OUT of the buy-in — read-only,
                recomputed server-side in fn_create_tournament, which charges
                5% on an SNG, 10% on an MTT, and 0 on a Spin (its edge lives in
                the multiplier distribution). Until 2026-08-27 this label said
                10% for all of them. */}
            <div className="config-toggle">
              <span className="toggle-label">
                Fee
                <HelpPopover label="Fee">
                  Taken Out Of The Buy-In, Never Added On Top. Spins Carry No Fee.
                </HelpPopover>
              </span>
              <span style={{ color: '#1877f2', fontWeight: 600, fontSize: '0.85rem' }}>
                {config.gameMode === 'sng'
                  ? config.isSpins
                    ? 'No Fee'
                    : '5% Of Buy-In'
                  : '10% Of Buy-In'}
              </span>
            </div>

            <Toggle
              label="Custom Buy-In"
              value={config.customBuyIn}
              onChange={(v) => updateConfig('customBuyIn', v)}
              tooltip="Type Any Whole-Number Buy-In Instead Of Using The Slider"
            />
            {config.customBuyIn ? (
              <NumberField
                label="Buy-In"
                value={config.buyIn}
                onChange={(v) => updateConfig('buyIn', v)}
                min={0}
                tooltip="Whole Chips Only. 0 = Freeroll."
              />
            ) : (
              <Slider
                label="Buy-In"
                value={config.buyIn}
                onChange={(v) => updateConfig('buyIn', v)}
                min={10}
                max={1000}
                step={10}
              />
            )}
            {isFreeBuy && (
              <div className="config-free-buy" role="status" data-testid="free-buy-badge">
                <span className="config-free-buy__badge">{FREE_BUY_LABEL}</span>
                <span className="config-free-buy__text">{FREE_BUY_HELPER}</span>
              </div>
            )}

            <MttCreationProfileSelect
              config={config}
              onApply={(values) => setConfig((current) => ({ ...current, ...values }))}
            />

            {/* Blind Structure Radio */}
            <div className="config-radio-group">
              <span className="radio-group-label">Blind Structure</span>
              <div className="radio-options">
                <label className="radio-option">
                  <input
                    type="radio"
                    name="blindStructure"
                    checked={config.blindStructure === 'slow'}
                    onChange={() => updateConfig('blindStructure', 'slow')}
                  />
                  <span>Slow</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="blindStructure"
                    checked={config.blindStructure === 'standard'}
                    onChange={() => updateConfig('blindStructure', 'standard')}
                  />
                  <span>Standard</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="blindStructure"
                    checked={config.blindStructure === 'turbo'}
                    onChange={() => updateConfig('blindStructure', 'turbo')}
                  />
                  <span>Turbo</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="blindStructure"
                    checked={config.blindStructure === 'hyper_turbo'}
                    onChange={() => updateConfig('blindStructure', 'hyper_turbo')}
                  />
                  <span>HyperTurbo</span>
                </label>
              </div>
            </div>

            {/* Payout Structure Dropdown */}
            <div className="config-toggle">
              <span className="toggle-label">
                Payout Structure
                <HelpPopover label="Payout Structure">Prize Distribution</HelpPopover>
              </span>
              <select
                className="config-select"
                value={config.payoutStructure}
                onChange={(e) => updateConfig('payoutStructure', e.target.value as PayoutStructure)}
              >
                {config.gameMode === 'mtt' ? (
                  <MttPayoutDepthOptions currentChoice={config.payoutStructure} />
                ) : (
                  <>
                    {config.payoutStructure === 'payout20' && (
                      <option value="payout20" disabled>
                        Choose A Sit And Go Payout Structure
                      </option>
                    )}
                    <option value="payout1">Top 10% Of Field</option>
                    <option value="payout2">Top 12.5% Of Field</option>
                    <option value="payout3">Top 15% Of Field (Standard)</option>
                    <option value="winner_take_all">Winner Take All</option>
                  </>
                )}
              </select>
            </div>

            <Slider
              label="Starting Chips"
              value={config.startingChips}
              onChange={(v) => updateConfig('startingChips', v)}
              min={500}
              max={10000}
              step={100}
            />

            <Slider
              label="Blinds Up"
              value={config.blindsUpMinutes}
              onChange={(v) => updateConfig('blindsUpMinutes', v)}
              min={1}
              max={15}
              suffix=" min"
            />

            <MttCreationStructurePreview config={config} gameType={gameType} />

            <Toggle
              label="Big Blind Ante"
              value={config.bigBlindAnte}
              onChange={(v) => updateConfig('bigBlindAnte', v)}
              tooltip="The Big Blind Posts The Ante For The Whole Table"
            />
            <Toggle
              label="Authorized To Register"
              value={config.authorizedToRegister}
              onChange={(v) => updateConfig('authorizedToRegister', v)}
              tooltip="Only Players You Approve Can Register"
            />
            <Toggle
              label="Synchronized Breaks"
              value={config.synchronizedBreaks}
              onChange={(v) => updateConfig('synchronizedBreaks', v)}
              tooltip="Eligible Tournaments Break Together At :55 Each Hour. Turning This Off Does Not Disable Platform Maintenance Or Add-On Pauses."
            />
          </>
        )}

        {/* MTT-ONLY OPTIONS */}
        {config.gameMode === 'mtt' && (
          <>
            <Toggle
              label="Accelerated MTT"
              value={config.acceleratedMtt}
              onChange={(v) => updateConfig('acceleratedMtt', v)}
              tooltip="Faster Level Progression Once The Field Shrinks"
            />

            {/* FREEROLLS ARE FREE BUY (Dan 2026-09-02). A 0 buy-in MTT is a
                freeroll: rebuys and add-ons are ON at 1 chip each and the
                controls are locked, not hidden, so the owner can read what the
                rule set. buildTournamentConfig applies the same values on the
                write whatever these sliders held. */}
            {isFreeBuy ? (
              <div className="config-free-buy-lock" data-testid="free-buy-lock">
                <Toggle label="Rebuys" value={true} onChange={() => {}} disabled />
                <NumberField
                  label="Rebuy Cost"
                  value={FREE_BUY_REBUY_COST}
                  onChange={() => {}}
                  disabled
                />
                <Toggle label="Add-On" value={true} onChange={() => {}} disabled />
                <NumberField
                  label="Add-On Cost"
                  value={FREE_BUY_ADDON_COST}
                  onChange={() => {}}
                  disabled
                />
                <p className="config-free-buy__text">{FREE_BUY_HELPER}</p>
                <Slider
                  label="Add-On Break Length"
                  value={config.addOnBreakLengthMinutes}
                  onChange={(v) => updateConfig('addOnBreakLengthMinutes', v)}
                  min={1}
                  max={10}
                  suffix=" min"
                />
              </div>
            ) : (
              <>
                <Slider
                  label="Number Of Rebuys/Re-Entries"
                  value={config.numberOfRebuysReentries}
                  onChange={(v) => updateConfig('numberOfRebuysReentries', v)}
                  min={0}
                  max={10}
                />
                {config.numberOfRebuysReentries > 0 && (
                  <>
                    <Toggle
                      label="Custom Rebuy/Re-Entry Cost"
                      value={config.customRebuyReentryCost}
                      onChange={(v) => updateConfig('customRebuyReentryCost', v)}
                      tooltip="Charge A Different Price Than The Buy-In"
                    />
                    {config.customRebuyReentryCost && (
                      <NumberField
                        label="Rebuy/Re-Entry Cost"
                        value={config.rebuyReentryCost}
                        onChange={(v) => updateConfig('rebuyReentryCost', v)}
                        min={0}
                        tooltip="Whole Chips Only. 0 = Same As The Buy-In."
                      />
                    )}
                  </>
                )}

                {/* Add-on Options */}
                <Slider
                  label="Add-On"
                  value={config.addOnMultiplier}
                  onChange={(v) => updateConfig('addOnMultiplier', v)}
                  min={0}
                  max={3}
                  step={0.5}
                  suffix="x"
                  tooltip="Add-On Chips As A Multiple Of The Starting Stack. 0 = No Add-On."
                />
                {config.addOnMultiplier > 0 && (
                  <>
                    <Toggle
                      label="Custom Add-On"
                      value={config.customAddOn}
                      onChange={(v) => updateConfig('customAddOn', v)}
                      tooltip="Charge A Different Add-On Price Than The Buy-In"
                    />
                    {config.customAddOn && (
                      <NumberField
                        label="Add-On Cost"
                        value={config.customAddOnCost}
                        onChange={(v) => updateConfig('customAddOnCost', v)}
                        min={0}
                        tooltip="Whole Chips Only. 0 = Same As The Buy-In."
                      />
                    )}
                    <Slider
                      label="Add-On Break Length"
                      value={config.addOnBreakLengthMinutes}
                      onChange={(v) => updateConfig('addOnBreakLengthMinutes', v)}
                      min={1}
                      max={10}
                      suffix=" min"
                    />
                  </>
                )}
              </>
            )}

            {/* Tournament Features */}
            <Toggle
              label="KO Bounty"
              value={config.koBounty}
              onChange={(v) => updateConfig('koBounty', v)}
            />
            <Toggle
              label="GTD Prize Pool"
              value={config.gtdPrizePool}
              onChange={(v) => updateConfig('gtdPrizePool', v)}
              tooltip="Guarantee A Minimum Prize Pool. The Club Covers Any Overlay."
            />
            {config.gtdPrizePool && (
              <NumberField
                label="Guaranteed Prize"
                value={config.gtdPrizeAmount}
                onChange={(v) => updateConfig('gtdPrizeAmount', v)}
                min={0}
                tooltip="Whole Chips Only"
              />
            )}
            <Toggle
              label="Final Table Deal"
              value={config.finalTableDeal}
              onChange={(v) => updateConfig('finalTableDeal', v)}
              tooltip="Final Table Players May Vote To Split The Remaining Prizes"
            />
            <Toggle
              label="Bubble Protection"
              value={config.bubbleProtection}
              onChange={(v) => updateConfig('bubbleProtection', v)}
              tooltip="The Bubble Finisher Gets Their Buy-In Back"
            />

            {/* Registration & Players */}
            <Slider
              label="Late Registration"
              value={config.lateRegistrationLevel}
              onChange={(v) => updateConfig('lateRegistrationLevel', v)}
              min={0}
              max={20}
              suffix=" level"
            />
            <Toggle
              label="Early Bird Registration"
              value={config.earlyBirdRegistration}
              onChange={(v) => updateConfig('earlyBirdRegistration', v)}
              tooltip="Players Who Register Before The Start Get Bonus Chips"
            />
            {config.earlyBirdRegistration && (
              <NumberField
                label="Early Bird Chips"
                value={config.earlyBirdChips}
                onChange={(v) => updateConfig('earlyBirdChips', v)}
                min={0}
                tooltip="Extra Starting Chips For Registering Before The Start"
              />
            )}
            <Toggle
              label="Next Step (Satellite)"
              value={config.nextStepSatellite}
              onChange={(v) => updateConfig('nextStepSatellite', v)}
              tooltip="Winners Earn Seats Into A Bigger Tournament Instead Of Cash"
            />
            {config.nextStepSatellite && (
              <>
                <div className="config-toggle">
                  <span className="toggle-label">Awards Seats Into</span>
                  <select
                    className="config-select"
                    value={config.satelliteTargetId}
                    onChange={(e) => updateConfig('satelliteTargetId', e.target.value)}
                  >
                    <option value="">Select Target Tournament...</option>
                    {satelliteTargets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <NumberField
                  label="Seats Awarded"
                  value={config.satelliteSeats}
                  onChange={(v) => updateConfig('satelliteSeats', v)}
                  min={1}
                  tooltip="Top N Finishers Win A Seat"
                />
              </>
            )}
            {/* MULTI-DAY MTT: A TOGGLE THAT LIED, REPLACED BY THE TRUTH.
                2026-08-26. This was a working switch over a feature that does
                not exist. Ticking it set `is_multi_day` and `total_days`,
                painted a "Multi-Day" tag on the lobby card and a badge in the
                details tab, and changed nothing about how the event ran: there
                is no day end, no Day 2 resume, no flight merge, and nothing
                anywhere writes `flight_end_chips_snapshot`. The tournament
                played down to one winner in a single session and paid the
                whole prize pool, with the lobby promising otherwise.
                `trg_tournaments_refuse_unbuilt_multi_day` refuses the flag at
                the database for every caller.
                2026-09-24: Day 2 is built (single flight: bag at the end of a
                level, resume at a scheduled time). The switch is back, but it
                writes no flag column: it seals a Day Schedule into the stage
                tables through fn_operator_seal_stage_plan, and it appears only
                when the capability registry says the platform runs multi-day
                events; until then the honest status stays. There is no Total
                Days field: the number of days is the number of rows. */}
            {multiDayGate === 'available' ? (
              <>
                <Toggle
                  label="Multi-Day MTT"
                  value={config.multiDayMtt}
                  onChange={(v) => updateConfig('multiDayMtt', v)}
                  tooltip="The Event Bags At The End Of A Level And Resumes On A Later Day At The Time You Set"
                />
                {config.multiDayMtt && (
                  <DayScheduleEditor
                    value={stagePlan}
                    onChange={setStagePlan}
                    day1StartLocal={config.startTime}
                  />
                )}
              </>
            ) : (
              <div className="config-toggle">
                <span className="toggle-label">
                  Multi-Day MTT
                  <HelpPopover label="Multi-Day MTT">
                    Multi-Day Events Are Not Switched On For This Platform Yet. Until They Are,
                    Every Tournament Plays Down To One Winner In A Single Session.
                  </HelpPopover>
                </span>
                <span className="toggle-status off">NOT AVAILABLE YET</span>
              </div>
            )}
            <NumberField
              label="Minimum Players To Start"
              value={config.minPlayers}
              onChange={(value) => updateConfig('minPlayers', value)}
              min={3}
              tooltip="Minimum Registrations Needed To Start. Tournament Entries Are Unlimited."
            />

            {/* Start Time */}
            <div className="config-toggle">
              <span className="toggle-label">Start Time</span>
              <input
                type="datetime-local"
                className="config-datetime"
                value={config.startTime}
                onChange={(e) => updateConfig('startTime', e.target.value)}
              />
            </div>
            {/* "Save the Start Time" (2026-08-22): table_templates snapshots
                the whole config including startTime, but a saved datetime goes
                stale the moment it passes. This toggle instead remembers the
                picked start time in localStorage per club and prefills it on
                the next visit — simple and honest about what it does. */}
            <Toggle
              label="Save The Start Time"
              value={config.saveStartTime}
              onChange={(v) => updateConfig('saveStartTime', v)}
              tooltip="Remember This Start Time On This Device And Prefill It Next Time"
            />

            <Toggle
              label="Restart The Tournament"
              value={config.restartTournamentEvery}
              onChange={(v) => updateConfig('restartTournamentEvery', v)}
              tooltip="Automatically Respawn This Tournament On A Fixed Interval"
            />
            {config.restartTournamentEvery && (
              <Slider
                label="Restart Every"
                value={config.restartEveryMinutes}
                onChange={(v) => updateConfig('restartEveryMinutes', v)}
                min={5}
                max={1440}
                step={5}
                suffix=" min"
              />
            )}

            {/* Tournament Schedule: weekly recurrence. Saving with this ON
                writes a tournament_schedules row via
                fn_upsert_tournament_schedule; the engine's spawner creates the
                tournaments from it. */}
            <Toggle
              label="Tournament Schedule"
              value={config.tournamentSchedule}
              onChange={(v) => updateConfig('tournamentSchedule', v)}
              tooltip="Repeat This Tournament Weekly. With No Start Time Picked, Only The Schedule Is Created."
            />
            {config.tournamentSchedule && (
              <WeeklyScheduleEditor
                value={{
                  daysOfWeek: config.scheduleDays,
                  startTimesUtc: config.scheduleTimes,
                  mode: config.scheduleMode,
                  intervalMinutes: config.scheduleIntervalMinutes,
                }}
                onChange={(next) =>
                  setConfig((prev) => ({
                    ...prev,
                    scheduleDays: next.daysOfWeek,
                    scheduleTimes: next.startTimesUtc,
                    scheduleMode: next.mode,
                    scheduleIntervalMinutes: next.intervalMinutes,
                  }))
                }
              />
            )}
          </>
        )}
      </div>

      {/* Footer Buttons (tournaments; the cash flow carries its own) */}
      {config.gameMode !== 'regular' && (
        <footer className="config-footer">
          <button className="btn-template" onClick={handleSaveAsTemplate} disabled={savingTemplate}>
            {savingTemplate ? 'Saving...' : 'Save As Template'}
          </button>
          <button className="btn-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button className="btn-start" onClick={handleStart} disabled={starting}>
            {starting ? 'Starting...' : 'Start'}
          </button>
        </footer>
      )}
    </div>
  );

  if (embedded) return content;

  return (
    <main className="table-config-page__standalone">
      <SpadeConsole
        eyebrow="Table Management"
        title={`${gameInfo.name} Setup`}
        subtitle="Configure, Validate, Then Publish"
        pill="Creator"
        crest="club"
      >
        {content}
      </SpadeConsole>
    </main>
  );
}
