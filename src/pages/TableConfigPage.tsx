/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TABLE CONFIGURATION PAGE — Full Premium-Style Form
 * ═══════════════════════════════════════════════════════════════════════════════
 * Comprehensive table configuration with 40+ options:
 * - Game mode tabs (Regular/SNG/MTT)
 * - Toggle options (Private, VIP, Bomb Pot, etc.)
 * - Sliders (Blinds, Buy-in, Action Time, etc.)
 * - Run It Multi-Times selection
 * - Rake settings (default 10%, cap 3BB)
 * - Security restrictions
 * - Save & Start buttons
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import { resolveClubUUID } from '../utils/clubIdResolver';
import './TableConfigPage.css';
import { reportError } from '../utils/errorReporter';
import { formatCurrency } from '../lib/utils';
import { RAKE_INHERIT, getRakeConfig } from '../config/RakeConfig';
import { stakesLabel, isFixedLimitVariant } from '../lib/bettingStructure';
import {
  DEFAULT_BLINDS_INDEX,
  presetsFor,
  blindsIndexFor,
  nearestBlindsIndex,
} from '../config/blindsPresets';
import {
  restoreTemplateConfig,
  defaultTableName,
  templateFitsGame,
} from '../lib/tableTemplateRestore';
import {
  clampSeatsForVariant,
  maxSeatsForVariant,
  maxSeatsTheDeckAllows,
} from '../config/tableSeating';

import { tournamentService } from '../services/TournamentService';
import { buildTournamentConfig } from '../lib/tournamentFromTableConfig';
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

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
type GameMode = 'regular' | 'sng' | 'mtt';
/**
 * The variants a 7-2 bounty can actually pay out on.
 *
 * ServerTableEngineSettlement gates the bounty to Hold'em and says why:
 * "meaningless in PLO; short-deck has no deuces". Holding four cards, a 7 and
 * a 2 is nearly every hand, and a bounty that always fires is not a bounty.
 * The engine rule is right; offering the switch on a table that can never
 * honour it is what was wrong.
 */
/**
 * The variants the 7-2 bounty can actually pay out on.
 *
 * EXACTLY WHAT THE ENGINE PAYS, AND NOTHING ELSE (2026-08-31 audit). The gate
 * in ServerTableEngineSettlement is a string equality:
 *
 *     const sevenDeuceIsNlh = (this.tableInfo?.game_variant || 'nlh') === 'nlh';
 *
 * so `nlhe`, `flh`, `limit_holdem` and `pineapple` all failed it. The toggle
 * rendered on a Fixed Limit Hold'em and a Pineapple table, wrote
 * `seven_deuce_enabled: true`, and the bounty was never paid — the owner
 * advertised a prize the table could not award. This is the same shape as the
 * PLO and short-deck removal recorded two comments down; those were taken out
 * of the set and these four were left in.
 *
 * FLH is a legitimate candidate — it is Hold'em and it has deuces — but making
 * it pay is an ENGINE change to a settlement path, with its own tests, not a
 * set entry. Until then the honest UI is the one that only offers what pays.
 */
const SEVEN_DEUCE_VARIANTS = new Set(['nlh']);

/**
 * Fixed-limit tables (FLH, FLO8) cannot honour three of this form's controls,
 * and the engine is the reason for each (2026-08-31 audit):
 *
 *  • STRADDLE. `HandController` posts a straddle by assigning
 *    `state.currentBet = straddleAmount` with no structure branch, while a
 *    legal fixed-limit wager for the same street is exactly
 *    `fixedLimitBetSize(bigBlind, stage)`. A straddle is also none of
 *    bet/raise/full-raise all-in, so `fixedLimitWagerCount` does not count it
 *    against the four-wager cap — the street silently gains a betting round.
 *  • CAP. `ServerTableEngineTurns` assigns the mandatory fixed size and THEN
 *    clamps it with `Math.min(amount, capRemaining)`, so a capped limit table
 *    can emit a bet that is not the legal size, which the validator refuses.
 *  • BOMB-POT VARIANT OVERRIDE. The bomb hand's variant is what
 *    `bettingStructureFor` reads, so a `plo4` bomb on an FLH table plays a
 *    POT-LIMIT hand at a table the player sat down at for fixed limit.
 *    (`resolveBombPotVariant` refuses this server-side as well, for the writers
 *    that are not this form.)
 *
 * Hidden rather than disabled, and forced false on the write, so a template
 * saved on a no-limit table cannot carry a stale `true` onto a limit one.
 */
const isFixedLimitGame = (gameType: string | undefined): boolean =>
  isFixedLimitVariant(String(gameType || 'nlh').toLowerCase());

/**
 * The variants a Pineapple Hold'em table can be dealt as.
 *
 * ServerTableEngineBase.dealtGameVariant deals a table carrying
 * `pineapple_holdem` as pineapple only when its variant is 'nlh' or 'nlhe',
 * "because 'Pineapple PLO' is not a game and a stray flag must not silently
 * turn a PLO table into one". This mirrors that gate exactly, so the switch
 * is offered where and only where the engine will honour it.
 */
const PINEAPPLE_VARIANTS = new Set(['nlh', 'nlhe']);
const canDealPineapple = (gameType: string | undefined): boolean =>
  PINEAPPLE_VARIANTS.has(String(gameType || 'nlh').toLowerCase());

type RunItMode = 'none' | 'player_choice' | 'mandatory_twice' | 'mandatory_three';
type BlindStructure = 'slow' | 'standard' | 'turbo' | 'hyper_turbo';
type PayoutStructure = 'payout1' | 'payout2' | 'payout3' | 'winner_take_all';

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
  noRathole: boolean;

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
  maxPlayersRange: number;
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
  pineapple: { name: 'PINEAPPLE', color: '#f59e0b' },
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
  noRathole: false,

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
  payoutStructure: 'payout1',
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
  minPlayers: 30,
  maxPlayersRange: 300,
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
const Toggle = ({
  label,
  value,
  onChange,
  tooltip,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  tooltip?: string;
}) => (
  <div className="config-toggle">
    <span className="toggle-label">
      {label}
      {tooltip && (
        <span className="tooltip-icon" title={tooltip}>
          ?
        </span>
      )}
    </span>
    <label className="toggle-switch">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb"></span>
      </span>
      <span className={`toggle-status ${value ? 'on' : 'off'}`}>{value ? 'ON' : 'OFF'}</span>
    </label>
  </div>
);

const Slider = ({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = '',
  tooltip,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  tooltip?: string;
  /** Render the value yourself — used to show "Schedule" for the -1 sentinel. */
  format?: (v: number) => string;
}) => (
  <div className="config-slider">
    <div className="slider-header">
      <span className="slider-label">
        {label}: {format ? format(value) : `${value}${suffix}`}
        {format ? '' : ''}
        {tooltip && (
          <span className="tooltip-icon" title={tooltip}>
            ?
          </span>
        )}
      </span>
    </div>
    <div className="slider-track-container">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-input"
      />
    </div>
  </div>
);

/**
 * Whole-number entry row (2026-08-22). Used wherever a "Custom ..." toggle
 * switches a slider to free numeric entry — buy-in, rebuy cost, add-on cost,
 * GTD amount, early-bird chips, total days. Whole numbers only: anything a
 * player pays must never be a decimal (Dan 2026-08-20), so the field rounds
 * on input rather than letting a fraction sit in state.
 */
const NumberField = ({
  label,
  value,
  onChange,
  min = 0,
  max,
  tooltip,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  tooltip?: string;
}) => (
  <div className="config-toggle">
    <span className="toggle-label">
      {label}
      {tooltip && (
        <span className="tooltip-icon" title={tooltip}>
          ?
        </span>
      )}
    </span>
    <input
      type="number"
      className="config-datetime"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={value}
      onChange={(e) => {
        let v = Math.round(Number(e.target.value) || 0);
        if (v < min) v = min;
        if (max !== undefined && v > max) v = max;
        onChange(v);
      }}
      style={{ width: 110, textAlign: 'right' }}
    />
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function TableConfigPage() {
  const { clubId, gameType } = useParams<{ clubId: string; gameType: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [config, setConfig] = useState<TableConfig>({ ...DEFAULT_CONFIG });
  const [blindsIndex, setBlindsIndex] = useState(DEFAULT_BLINDS_INDEX); // 0.05/0.10
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
  // 2026-08-19. This used to ask "is this club in a union?" and bounce every
  // visitor if so. That is not the rule — it locked out the union owner, the
  // one person who IS supposed to build games for a union's clubs. Now it asks
  // the same question the database enforces (fn_can_create_games), via
  // fn_game_creation_access, which also reports WHY and which union owns the
  // games so the row can be stamped with it.
  const [access, setAccess] = useState<GameCreationAccess | null>(null);
  const checkingAccess = access === null;
  const canCreate = access?.allowed === true;
  // Union governance (2026-08-19): a union club's own staff may not build
  // union-visible games, but they MAY build a PRIVATE club game here
  // (is_private forced true; RLS enforces who can actually insert it).
  const privateOnly = access?.allowed === false && access?.reason === 'union_only';
  const canBuildHere = canCreate || privateOnly;

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
        if (result.reason === 'union_only') {
          // Union governance: club staff may still build a PRIVATE club game.
          toast.info('This club is in a union - the game will be private to your club.');
        } else {
          toast.error(gameCreationDeniedMessage(result));
          navigate(`/clubs/${clubId}`);
        }
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

  /* Three controls the engine cannot honour under fixed-limit betting; see
     isFixedLimitGame for what each one does wrong. */
  const limitGame = isFixedLimitGame(gameType);

  /* The blind ladder THIS variant may be built on. A limit game's bet sizes
     are derived from the big blind alone, so a preset where bb is not twice
     sb produces a table whose posted small blind appears in no label anywhere
     (see config/blindsPresets). Declared here because loadTemplate needs it. */
  const offeredPresets = useMemo(() => presetsFor(limitGame), [limitGame]);

  /* Keep the slider ON the ladder this variant offers. Navigating an already
     mounted form from an nlh route to an flh one narrows the ladder, and the
     blinds in state may no longer be on it; this also derives the initial
     index from the config rather than trusting two pieces of state to have
     been initialised in agreement. */
  useEffect(() => {
    const exact = blindsIndexFor(config.smallBlind, config.bigBlind, offeredPresets);
    if (exact !== null) {
      setBlindsIndex(exact);
      return;
    }
    const snapped = nearestBlindsIndex(config.bigBlind, offeredPresets);
    const preset = offeredPresets[snapped];
    if (!preset) return;
    setBlindsIndex(snapped);
    setConfig((prev) => ({ ...prev, smallBlind: preset.sb, bigBlind: preset.bb }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offeredPresets]);

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
    setBlindsIndex(restored.blindsIndex);
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

  const handleBlindsChange = (index: number) => {
    setBlindsIndex(index);
    const preset = offeredPresets[index];
    if (!preset) return;
    setConfig((prev) => ({
      ...prev,
      smallBlind: preset.sb,
      bigBlind: preset.bb,
    }));
  };

  const buildTableData = (resolvedClubId?: string) => ({
    club_id: resolvedClubId || clubId,
    // Stamp the owning union when there is one, so a game the union built for a
    // member club also shows up in the union's own views (getUnionTables).
    // NULL for a standalone club — matching every existing union table, which
    // carries BOTH union_id and the member club's club_id.
    union_id: privateOnly ? null : (access?.unionId ?? null),
    name: config.name,
    // FORMAT, not variant (2026-08-30 audit). tables.game_type is the table
    // FORMAT ('cash' | 'tournament') platform-wide: HorseFleetManager writes
    // 'cash', and the sit-out / zero-chip eviction sweeps
    // (20260828220000_sitting_out_and_zero_chip_evictions.sql) gate on
    // t.game_type = 'cash'. This page wrote the VARIANT ('NLH', 'PLO6', ...)
    // here, so owner-created tables never booted 5-minute sit-outs or
    // zero-chip seats, and those zombie seats kept the table in
    // cash_tables_needing_engine, holding an engine forever. The variant
    // belongs in game_variant, one line down, where it already was.
    game_type: 'cash',
    game_variant: gameType || 'nlh',
    game_mode: config.gameMode,

    // Stakes
    small_blind: config.smallBlind,
    big_blind: config.bigBlind,
    // Bet sizes on a limit table ("2/4"), blinds everywhere else ("1/2").
    stakes: stakesLabel(config.smallBlind, config.bigBlind, gameType),

    // Basic settings — union clubs build private club games ONLY (the
    // trg_tables_union_ownership DB trigger enforces this server-side too)
    is_private: config.isPrivate || privateOnly,
    is_vip_only: config.isVipOnly,
    is_anonymous: config.isAnonymous,
    ban_chat: config.banChat,
    label_as_new: config.labelAsNew,
    is_featured: config.isFeatured,
    hide_club_name: config.hideClubName,

    // Game variants
    bomb_pot_enabled: config.bombPotEnabled,
    // FIX-D10 2026-07-19: the engine only fires bomb pots when
    // bomb_pot_frequency > 0. The knobs are the host's now (2026-08-27) —
    // they were hard-coded 10 / 2 "until the UI exposes knobs", and it does.
    bomb_pot_frequency: config.bombPotEnabled ? config.bombPotFrequency : 0,
    bomb_pot_ante_multiplier: config.bombPotEnabled ? config.bombPotAnteBB : 0,
    // BOMB POT STANDARDIZATION 2026-08-27 (spec §3): the canonical config —
    // trigger mode, timed interval, board count (1-3) and minimum players.
    // The engine's BombPotScheduler reads these; the legacy pair below stays
    // in lockstep for old readers (lobby badges, old engine builds).
    bomb_pot_trigger_mode: config.bombPotEnabled ? config.bombPotTriggerMode : 'every_n_hands',
    bomb_pot_interval_seconds:
      config.bombPotEnabled && config.bombPotTriggerMode === 'timed'
        ? Math.max(60, Math.round(config.bombPotIntervalMinutes * 60))
        : null,
    bomb_pot_board_count: config.bombPotEnabled ? config.bombPotBoards : 1,
    // Clamped for the same reason as auto_start_players: a template blob can
    // carry a value the slider would not allow (2026-08-31 audit).
    bomb_pot_min_players: config.bombPotEnabled
      ? Math.max(2, Math.min(config.bombPotMinPlayers, config.maxPlayers))
      : 3,
    // FIXED ante mode (spec §3): a positive amount overrides the multiplier.
    bomb_pot_ante_fixed:
      config.bombPotEnabled && config.bombPotAnteFixed > 0 ? config.bombPotAnteFixed : null,
    // VARIANT OVERRIDE (spec §10.1): NULL = bomb hands play the table's own
    // game. The engine whitelists; the DB CHECK mirrors it.
    /* A bomb hand's variant IS the hand's betting structure, so an override
       on a fixed-limit table would deal one pot-limit or no-limit hand at a
       table the player sat down at for fixed limit. */
    bomb_pot_variant:
      !limitGame && config.bombPotEnabled && config.bombPotVariant ? config.bombPotVariant : null,
    // ANNOUNCE WINDOW (spec §3): 0 = always show the timed clock.
    bomb_pot_announce_seconds:
      config.bombPotEnabled &&
      config.bombPotTriggerMode === 'timed' &&
      config.bombPotAnnounceMinutes > 0
        ? Math.round(config.bombPotAnnounceMinutes * 60)
        : null,
    // SEPARATE BOMB BUTTON (spec §5.3).
    bomb_pot_button_policy:
      config.bombPotEnabled && config.bombPotSeparateButton ? 'separate' : 'regular',
    // DOUBLE-BOARD BOMB POT 2026-08-20 (legacy pair, kept in sync): the
    // engine used to read bomb_pot_double_board; board_count supersedes it.
    bomb_pot_double_board: config.bombPotEnabled && config.bombPotBoards >= 2,
    // `double_board` is no longer written (2026-08-29), for the same reason
    // `triple_board` stopped being written in 2026-08-27: it has ZERO readers.
    // Verified across both repos — the lobby reads the settings-blob key of
    // the same name, never the column, and the engine reads
    // bomb_pot_double_board. Live proof: the column is `true` on 0 of 97,944
    // rows despite this line writing it on every double-board table created.
    // A write-only column is a promise to a reader that does not exist.
    // triple_board is no longer written (2026-08-27): the column has zero
    // readers, so the toggle that fed it promised a game that never existed.
    /**
     * 2026-08-25: THE COLUMN HAS A READER NOW.
     *
     * The note that stood here said nothing in server/src had ever read this,
     * and that the control "promised a different game and delivered ordinary
     * Hold'em". Both were true. The fix was never to delete the switch: the
     * pineapple VARIANT is fully built — three hole cards, a real discard
     * street, its own timer — and only the mapping was missing.
     * ServerTableEngineBase.dealtGameVariant now deals a Hold'em table with
     * this flag as pineapple, and refuses to apply it to anything else,
     * because "Pineapple PLO" is not a game.
     */
    /* Gated on the write as well as in the UI (2026-08-31): the engine
       ignores this flag off Hold'em, so a stale true from a template or a
       variant change would sit on a PLO row claiming a game it will never be
       dealt. lobbyEntries reads the column directly and would badge it. */
    pineapple_holdem: canDealPineapple(gameType) ? config.pineappleHoldem : false,
    /**
     * NLH ONLY, and that is the engine's rule, not an oversight.
     * ServerTableEngineSettlement: "meaningless in PLO; short-deck has no
     * deuces" — holding four cards, a 7 and a 2 is nearly every hand, and a
     * bounty that always fires is not a bounty.
     *
     * So the SWITCH is what was wrong: the creation screen offered it on PLO
     * and short-deck tables where it could never pay out once, and said
     * nothing. It is not offered there now (see the toggle below), and the
     * column is forced false so a variant change cannot leave a stale true
     * behind on a table that will never honour it.
     */
    seven_deuce_enabled: SEVEN_DEUCE_VARIANTS.has(String(gameType || 'nlh').toLowerCase())
      ? config.sevenDeuceEnabled
      : false,
    /* 7-2 bounty size in big blinds each other dealt-in player pays a
       post-flop 7-2 winner.
       2026-08-31: this read `config.sevenDeuceEnabled ? ... : 2` — the SAME
       stale-true class the line above was written to prevent, one gate short.
       A PLO6 table created after loading an NLH template wrote
       enabled:false alongside amount:8. The amount now follows the switch
       through the identical variant gate, so the two columns can never
       describe different tables. */
    seven_deuce_amount:
      SEVEN_DEUCE_VARIANTS.has(String(gameType || 'nlh').toLowerCase()) && config.sevenDeuceEnabled
        ? config.sevenDeuceAmountBB
        : 2,
    nit_game: config.nitGame,
    /**
     * CAP NEEDS AN AMOUNT (2026-08-27). `cap_enabled` alone is not a cap:
     * ServerTableEngineTurns computes the ceiling as cap_bb x big_blind and
     * treats cap_bb <= 0 as "no cap". This page toggled cap_enabled since
     * February and never wrote cap_bb, so every cap table it built played
     * uncapped. The amount is authored in big blinds and forced to 0 when the
     * toggle is off, so a stale amount cannot cap a table whose owner turned
     * the switch off.
     */
    /* Forced off on a fixed-limit table: the cap clamp runs AFTER the
       mandatory fixed size is assigned, so a capped limit table can emit a
       wager the validator refuses. See isFixedLimitGame. */
    cap_enabled: !limitGame && config.capEnabled && config.capBB > 0,
    cap_bb: !limitGame && config.capEnabled ? config.capBB : 0,
    no_rathole: config.noRathole,

    // Table parameters
    // Clamped to the variant's seat law even if UI state slipped past the
    // slider (template load, stale state, variant switch mid-edit). An
    // over-cap row is not a preference, it is a mid-hand engine crash.
    max_players: clampSeatsForVariant(String(gameType || 'nlh').toLowerCase(), config.maxPlayers),
    action_time_seconds: config.actionTimeSeconds,
    /**
     * THE BUY-IN BAND IS ONE PAIR OF COLUMNS, IN CHIPS.
     *
     * This page used to stamp `min_buy_in_bb` / `max_buy_in_bb` here as well,
     * in big blinds, beside a sibling written in chips. Nothing ever read
     * them: `atomic_table_buyin` — the only hard enforcement of a buy-in in
     * the product — reads `min_buy_in` / `max_buy_in`, and so do the engine
     * and src/lib/cashBuyIn.ts. What the extra pair did was give a future
     * reader a column that looks authoritative and is not; on a 1/2 table the
     * database still carried the 2/25 default, so anyone who picked it up
     * would have capped a player at 50 chips on a table advertising 400.
     *
     * They are now GENERATED columns derived from these two
     * (supabase/migrations/20260831133000_one_buy_in_band_and_the_rest_are
     * _derived.sql), so writing them raises 428C9 and the schema itself keeps
     * the families from disagreeing. Write the chips; the big blinds follow.
     */
    min_buy_in: config.minBuyInBB * config.bigBlind,
    max_buy_in: config.maxBuyInBB * config.bigBlind,
    ante_bb: config.anteBB,
    /**
     * THE ANTE SLIDER WAS DEAD ON EVERY TABLE THIS PAGE CREATED.
     *
     * `ante_bb` is not in the engine's select list (server/src/services/
     * supabase/tables.ts) — the engine reads `ante` and `ante_enabled`, and
     * this page wrote neither. So a host could drag Ante to 2 BB, save, sit
     * down, and no ante was ever posted. The only path that worked was the
     * older CreateTableModal, which happens to map to the right columns.
     *
     * `ante_bb` is kept because it is the authored unit (big blinds, which
     * survives a blind change); `ante` is the chip figure the engine actually
     * posts, derived here so the two cannot drift.
     */
    ante_enabled: Number(config.anteBB) > 0,
    ante: Number(config.anteBB) > 0 ? Number(config.anteBB) * Number(config.bigBlind || 0) : 0,
    career_percent_min: config.careerPercentMin,
    maintain_percent_min: config.maintainPercentMin,
    maintain_hands: config.maintainHands,
    /* CLAMPED (2026-08-31 audit). The slider is bounded to the seat count,
       but a saved template is raw JSONB spread straight into state, so a
       stale autoStartPlayers can arrive above it. auto_start_players over
       the seat count is a table that can never deal and is not even flagged
       as stuck (ServerTableEngineBase.minPlayersToDeal / dealThreshold). */
    auto_start_players: Math.max(
      2,
      Math.min(
        config.autoStartPlayers,
        clampSeatsForVariant(String(gameType || 'nlh').toLowerCase(), config.maxPlayers)
      )
    ),
    // game_length_hours and calltime_enabled are no longer written
    // (2026-08-27): zero readers each — see the TableConfig comment.

    // Time & auto settings
    auto_extension: config.autoExtension,
    auto_restart: config.autoRestart,
    auto_create_table: config.autoCreateTable,
    /* Forced off on a fixed-limit table: a straddle sets currentBet with no
       structure branch and is not counted against the four-wager cap. */
    auto_utg_straddle: !limitGame && config.autoUtgStraddle,
    voluntary_straddle: !limitGame && config.voluntaryStraddle,
    insurance_enabled: config.insuranceEnabled,
    // FIX-D2 2026-07-19: the engine reads the canonical top-level columns
    // straddle_enabled / run_it_twice_enabled, NOT auto_utg_straddle /
    // voluntary_straddle / run_it_mode. Without these mirrors, straddle and
    // run-it-twice configured on this page never took effect.
    straddle_enabled: !limitGame && (config.autoUtgStraddle || config.voluntaryStraddle),
    /* "NONE" DID NOT TURN RUN IT TWICE OFF (2026-08-31 audit).
       The engine's gate is
         ((run_it_twice ?? true) && (allow_run_it_twice ?? true)) || run_it_twice_enabled
       and this page wrote ONLY the third column. The other two carry a
       DEFAULT of true, so the first term was satisfied on every row this
       page has ever created and the radio could not switch the feature off.
       Measured on production the day it was found: 924 live cash tables,
       921 of them running RIT while the host's setting read 'none'. RIT
       splits real pots, so a host who declined it still had their players'
       money run twice. fn_tables_sync_rit cannot rescue it either - it
       mirrors only when one side is NULL, and this page writes a non-null
       false. All three columns are now written from the one control. */
    run_it_twice: config.runItMode !== 'none',
    allow_run_it_twice: config.runItMode !== 'none',
    run_it_twice_enabled: config.runItMode !== 'none',

    // Run it multi-times
    run_it_mode: config.runItMode,

    // Rake settings
    rake_percent: config.rakePercent,
    rake_cap_bb: config.rakeCapBB,

    /**
     * THE TOURNAMENT BLOCK STOPPED BEING WRITTEN ONTO CASH ROWS (2026-08-31).
     *
     * buildTableData runs ONLY when gameMode === 'regular' — handleSave and
     * handleStart both branch to the tournament path first — so every SNG/MTT
     * column below was landing on a CASH row. Twenty of them had zero readers
     * anywhere: not the engine, not the lobby, not any SQL beyond the ALTER
     * TABLE that created them. Removed by name:
     *   sng_buy_in, sng_custom_buy_in, blinds_up_minutes, next_step_satellite,
     *   custom_rebuy_reentry_cost, number_of_rebuys_reentries,
     *   add_on_multiplier, custom_add_on, add_on_break_length_minutes,
     *   ko_bounty, gtd_prize_pool, late_registration_level,
     *   early_bird_registration, featured_tournament, min_players_mtt,
     *   max_players_mtt, multi_day_mtt, save_start_time,
     *   restart_tournament_every, tournament_schedule.
     * Only `name` is NOT NULL without a default on this table
     * (scripts/ci/supabase-required-columns-manifest.json), so omitting them
     * cannot refuse the insert.
     *
     * TWO THAT LOOK DEAD AND ARE NOT — verified, do not "finish the job":
     *   game_mode    five live club-data RPCs read it
     *                (COALESCE(t.game_mode,'') ILIKE '%mixed%').
     *   ante_bb      live readers use the authored BB value while the engine
     *                posts the derived chip value in `ante`.
     * min_buy_in_bb / max_buy_in_bb are intentionally absent here: the schema
     * now generates them from min_buy_in / max_buy_in (see the buy-in comment
     * above), and Postgres refuses an explicit write to either mirror.
     * The rest that remain below have real readers on `tables` rows.
     */
    // SNG/MTT specific
    blind_structure: config.blindStructure,
    payout_structure: config.payoutStructure,
    starting_chips: config.startingChips,

    // MTT specific
    short_description: config.shortDescription,
    accelerated_mtt: config.acceleratedMtt,
    all_in_or_fold: config.allInOrFold,
    final_table_deal: config.finalTableDeal,
    big_blind_ante: config.bigBlindAnte,
    authorized_to_register: config.authorizedToRegister,
    bubble_protection: config.bubbleProtection,
    start_time: config.startTime || null,
    synchronized_breaks: config.synchronizedBreaks,

    // Security. Only the switch that is actually enforced is written; the
    // other seven were removed (see TableConfig above).
    ip_restriction: config.ipRestriction,

    // Status
    status: 'waiting',
    current_players: 0,
  });

  const handleSave = async () => {
    if (!config.name.trim()) {
      toast.error('Please enter a table name');
      return;
    }
    // PERMISSION GATE: re-check at save time (defense-in-depth).
    // privateOnly (union club staff) may proceed — the game is forced private.
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
    if (config.gameMode !== 'regular') {
      setSaving(true);
      try {
        await handleStartTournament();
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    try {
      const {
        data: { user },
      } = await getAuthUser();
      if (!user) throw new Error('Not authenticated');

      const resolvedId = await resolveClubUUID(clubId || '');

      const tableData = {
        ...buildTableData(resolvedId),
        created_by: user.id,
      };

      const { error } = await supabase.from('tables').insert(tableData);
      if (error) throw error;

      toast.success('Table created. It is open in your club lobby.');
      navigate(`/clubs/${clubId}`);
    } catch (error) {
      reportError(error, 'TableConfigPage.Failed_to_save_table');
      /* SAY WHAT WENT WRONG (2026-08-31 audit). fn_tables_creation_guard
         raises host-actionable messages ("big blind must exceed small
         blind", "seat law: plo6 allows at most 6 seats", the action-time
         range) and an RLS refusal returns a permission error. All of them
         rendered as the same five words, which is how an unsaveable
         configuration became an unexplainable one. handleStartTournament
         already surfaces error.message; this now matches it. */
      toast.error(error instanceof Error && error.message ? error.message : 'Failed to save table');
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
      unionId: privateOnly ? null : (access?.unionId ?? null),
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
        toast.error('Pick the target tournament this satellite awards seats into.');
        return;
      }

      const tournamentConfig = buildTournamentConfig(config, gameType);

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
        if (createdId) {
          masterBus.emit('TOURNAMENT_UPDATED', { tournamentId: createdId, status: 'REGISTERING' });
        }
      }
      navigate(`/clubs/${clubId}/tournaments`);
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
    if (config.gameMode !== 'regular') {
      await handleStartTournament();
      return;
    }

    setStarting(true);
    try {
      const {
        data: { user },
      } = await getAuthUser();
      if (!user) throw new Error('Not authenticated');

      const resolvedId = await resolveClubUUID(clubId || '');

      /**
       * STATUS IS 'waiting', NOT 'active' (2026-08-27).
       *
       * The engine discovers cash tables through cash_tables_needing_engine,
       * whose WHERE clause is `status IN ('waiting', 'running')`. 'active' is a
       * legal column value that no engine query has ever matched — so every
       * table Start created sat in the lobby, accepted seats, and never dealt
       * a hand: no engine adopted it and every socket closed 4404. 'waiting'
       * is what the working writers (TableService, the lifecycle pass) use;
       * the engine flips it to 'running' when it starts dealing.
       */
      const tableData = {
        ...buildTableData(resolvedId),
        created_by: user.id,
      };

      const { data, error } = await supabase
        .from('tables')
        .insert(tableData)
        .select()
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Table start returned no data');

      masterBus.emit('TABLE_CREATED', {
        tableId: data.id,
        clubId: clubId || undefined,
        table: data,
      });
      toast.success('Table created and started!');
      navigate(`/table/${data.id}`);
    } catch (error) {
      reportError(error, 'TableConfigPage.Failed_to_start_table');
      // Same reasoning as handleSave: the server's reason is the useful part.
      toast.error(
        error instanceof Error && error.message ? error.message : 'Failed to start table'
      );
    } finally {
      setStarting(false);
    }
  };

  return (
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

      {/* Template Selector - At TOP for easy duplication */}
      {templatesForThisGame.length > 0 && (
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

      {/* Table Name */}
      <div className="config-name">
        <input
          type="text"
          placeholder="Enter Table Name Here..."
          value={config.name}
          maxLength={30}
          onChange={(e) => updateConfig('name', e.target.value.slice(0, 30))}
        />
      </div>

      {/* Scrollable Options */}
      <div className="config-options">
        {/* 2026-08-19: everything from here to the tournament options is
            CASH-TABLE configuration. It writes `tables` columns, and a
            tournament does not use a `tables` row of its own — TournamentManager
            creates its tables with a fixed settings payload when the tournament
            starts. Leaving these on the SNG/MTT tabs meant an owner could set
            blinds, buy-in caps, bomb pots and straddle rules for a tournament
            and have every one of them silently ignored. */}
        {config.gameMode === 'regular' && (
          <>
            {/* SECTION: Basic Settings */}
            <Toggle
              label="Private Game"
              value={config.isPrivate}
              onChange={(v) => updateConfig('isPrivate', v)}
            />
            <Toggle
              label="VIP Only"
              value={config.isVipOnly}
              onChange={(v) => updateConfig('isVipOnly', v)}
            />
            <Toggle
              label="Bomb Pot"
              value={config.bombPotEnabled}
              onChange={(v) => updateConfig('bombPotEnabled', v)}
              tooltip="Everyone Antes And The Hand Starts On The Flop, On A Fixed Schedule"
            />
            {config.bombPotEnabled && (
              <>
                {/* HOST PRESETS (spec §3.2, 2026-08-28): one tap sets the
                    whole bomb configuration; every control below still works
                    for fine-tuning afterwards. */}
                <div className="config-radio-group">
                  <span className="radio-group-label">Bomb Pot Presets</span>
                  <div className="radio-options">
                    {(
                      [
                        [
                          'Classic Double Board',
                          {
                            bombPotTriggerMode: 'once_per_orbit' as const,
                            bombPotBoards: 2,
                            bombPotAnteBB: 3,
                            bombPotAnteFixed: 0,
                            bombPotVariant: '' as const,
                          },
                        ],
                        [
                          'Timed Bomb',
                          {
                            bombPotTriggerMode: 'timed' as const,
                            bombPotIntervalMinutes: 30,
                            bombPotBoards: 2,
                            bombPotAnteBB: 2,
                            bombPotAnteFixed: 0,
                            bombPotAnnounceMinutes: 5,
                            bombPotVariant: '' as const,
                          },
                        ],
                        [
                          'Triple Board Special',
                          {
                            bombPotTriggerMode: 'timed' as const,
                            bombPotIntervalMinutes: 60,
                            bombPotBoards: 3,
                            bombPotAnteBB: 2,
                            bombPotAnteFixed: 0,
                            bombPotAnnounceMinutes: 5,
                            bombPotVariant: '' as const,
                          },
                        ],
                        [
                          'PLO Bomb Only',
                          {
                            bombPotTriggerMode: 'bomb_pot_only' as const,
                            bombPotBoards: 2,
                            bombPotAnteBB: 2,
                            bombPotAnteFixed: 0,
                            bombPotVariant: 'plo4' as const,
                          },
                        ],
                      ] as const
                    ).map(([label, preset]) => (
                      <button
                        key={label}
                        type="button"
                        className="config-preset-chip"
                        onClick={() => setConfig((prev) => ({ ...prev, ...preset }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* BOMB POT STANDARDIZATION 2026-08-27 (spec §2.1): the host
                    picks WHEN bombs fire — the legacy every-N-hands cadence,
                    once per dealer-button orbit, on a timer, or every hand
                    (a dedicated bomb-pot table). */}
                <div className="config-radio-group">
                  <span className="radio-group-label">Bomb Pot Schedule</span>
                  <div className="radio-options">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombSchedule"
                        checked={config.bombPotTriggerMode === 'every_n_hands'}
                        onChange={() => updateConfig('bombPotTriggerMode', 'every_n_hands')}
                      />
                      <span>Every N Hands</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombSchedule"
                        checked={config.bombPotTriggerMode === 'once_per_orbit'}
                        onChange={() => updateConfig('bombPotTriggerMode', 'once_per_orbit')}
                      />
                      <span>Once Per Orbit</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombSchedule"
                        checked={config.bombPotTriggerMode === 'timed'}
                        onChange={() => updateConfig('bombPotTriggerMode', 'timed')}
                      />
                      <span>Timed</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombSchedule"
                        checked={config.bombPotTriggerMode === 'bomb_pot_only'}
                        onChange={() => updateConfig('bombPotTriggerMode', 'bomb_pot_only')}
                      />
                      <span>Every Hand</span>
                    </label>
                  </div>
                </div>
                {config.bombPotTriggerMode === 'every_n_hands' && (
                  <Slider
                    label="Bomb Pot Every"
                    value={config.bombPotFrequency}
                    onChange={(v) => updateConfig('bombPotFrequency', v)}
                    min={5}
                    max={50}
                    step={5}
                    suffix=" hands"
                  />
                )}
                {config.bombPotTriggerMode === 'timed' && (
                  <Slider
                    label="Bomb Pot Countdown Shows"
                    value={config.bombPotAnnounceMinutes}
                    onChange={(v) => updateConfig('bombPotAnnounceMinutes', v)}
                    min={0}
                    max={15}
                    step={1}
                    suffix=" min before (0 = always)"
                  />
                )}
                {config.bombPotTriggerMode === 'timed' && (
                  <Slider
                    label="Bomb Pot Interval"
                    value={config.bombPotIntervalMinutes}
                    onChange={(v) => updateConfig('bombPotIntervalMinutes', v)}
                    min={10}
                    max={60}
                    step={5}
                    suffix=" minutes"
                  />
                )}
                {/* Spec §3 anteMode: BB multiple (default) or a FIXED chip
                    amount. The fixed amount overrides the multiplier in the
                    engine (bomb_pot_ante_fixed > 0 wins). */}
                <div className="config-radio-group">
                  <span className="radio-group-label">Bomb Pot Ante Mode</span>
                  <div className="radio-options">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombAnteMode"
                        checked={!(config.bombPotAnteFixed > 0)}
                        onChange={() => updateConfig('bombPotAnteFixed', 0)}
                      />
                      <span>Multiple Of BB</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombAnteMode"
                        checked={config.bombPotAnteFixed > 0}
                        onChange={() =>
                          updateConfig(
                            'bombPotAnteFixed',
                            config.bombPotAnteFixed > 0
                              ? config.bombPotAnteFixed
                              : Math.max(config.bigBlind * 2, 1)
                          )
                        }
                      />
                      <span>Fixed Amount</span>
                    </label>
                  </div>
                </div>
                {config.bombPotAnteFixed > 0 ? (
                  <Slider
                    label="Bomb Pot Fixed Ante"
                    value={config.bombPotAnteFixed}
                    onChange={(v) => updateConfig('bombPotAnteFixed', v)}
                    min={Math.max(config.bigBlind * 0.5, 0.5)}
                    max={Math.max(config.bigBlind * 20, 10)}
                    step={Math.max(config.bigBlind * 0.5, 0.5)}
                    suffix=" chips"
                  />
                ) : (
                  <Slider
                    label="Bomb Pot Ante"
                    value={config.bombPotAnteBB}
                    onChange={(v) => updateConfig('bombPotAnteBB', v)}
                    min={1}
                    max={10}
                    /* 2026-08-29: was 0.5, and it was a LIE. tables
                       .bomb_pot_ante_multiplier is an INTEGER column (verified
                       against the live schema), so a host who dragged this to
                       2.5 had it silently stored as 3 and every player at the
                       table was charged the larger ante. A control must not
                       offer a value the database cannot hold.

                       The half-step is not lost: the Fixed Ante above is
                       `numeric` and takes any amount, which is the right home
                       for "two and a half big blinds" anyway — it states the
                       price in chips rather than in a multiple. */
                    step={1}
                    suffix=" Big Blind"
                  />
                )}
                <Slider
                  label="Bomb Pot Min Players"
                  value={config.bombPotMinPlayers}
                  onChange={(v) => updateConfig('bombPotMinPlayers', v)}
                  min={2}
                  /* NEVER ABOVE THE SEAT COUNT (2026-08-31 audit). A fixed 6
                     here meant a heads-up table could require 4 players for a
                     bomb pot: the switch reads ON and no bomb ever fires. */
                  max={Math.min(6, config.maxPlayers)}
                  step={1}
                  suffix=" players"
                />
                {/* VARIANT OVERRIDE (spec §10.1): the bomb hand can play a
                    different game from the table — the classic is an NLH
                    table whose bombs are PLO4 double boards. The engine
                    whitelists the value and skips the override if the deck
                    cannot cover the seats (9-handed PLO6). */}
                {/* Hidden on a fixed-limit table: the bomb hand's variant IS
                    the hand's betting structure, so an override would deal one
                    pot-limit or no-limit hand at a table the player sat down at
                    for fixed limit. resolveBombPotVariant refuses it
                    server-side too, for the writers that are not this form. */}
                <div
                  className="config-radio-group"
                  style={limitGame ? { display: 'none' } : undefined}
                >
                  <span className="radio-group-label">Bomb Pot Game</span>
                  <div className="radio-options">
                    {(
                      [
                        ['', 'Same As Table'],
                        ['nlh', 'NLH'],
                        ['plo4', 'PLO4'],
                        ['plo5', 'PLO5'],
                        ['plo6', 'PLO6'],
                      ] as const
                    ).map(([value, label]) => (
                      <label className="radio-option" key={value || 'same'}>
                        <input
                          type="radio"
                          name="bombVariant"
                          checked={config.bombPotVariant === value}
                          onChange={() => updateConfig('bombPotVariant', value)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {/* Spec §8/§9: each pot layer splits across the boards; the
                    engine downgrades when the deck cannot cover the boards. */}
                <div className="config-radio-group">
                  <span className="radio-group-label">Bomb Pot Boards</span>
                  <div className="radio-options">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombBoards"
                        checked={config.bombPotBoards <= 1}
                        onChange={() => updateConfig('bombPotBoards', 1)}
                      />
                      <span>Single</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombBoards"
                        checked={config.bombPotBoards === 2}
                        onChange={() => updateConfig('bombPotBoards', 2)}
                      />
                      <span>Double Board</span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="bombBoards"
                        checked={config.bombPotBoards >= 3}
                        onChange={() => updateConfig('bombPotBoards', 3)}
                      />
                      <span>Triple Board</span>
                    </label>
                  </div>
                </div>
                {/* SEPARATE BOMB BUTTON (spec §5.3): bomb hands rotate their
                    own button; the regular button never sees bomb hands. The
                    spec's own default is the regular button for ordinary cash
                    tables — this is for structured formats. */}
                <Toggle
                  label="Separate Bomb Button"
                  value={config.bombPotSeparateButton}
                  onChange={(v) => updateConfig('bombPotSeparateButton', v)}
                  tooltip="Bomb Pots Rotate Their Own Dealer Button, And The Regular Button Does Not Move On Bomb Hands"
                />
              </>
            )}
            {/* The freestanding Double Board toggle moved into the Bomb Pot
                Boards group above (2026-08-27) — it only ever meant "bomb
                pots deal two boards", so it belongs behind the Bomb Pot
                switch it modifies. Triple Board is back as a real choice now
                that the engine deals and settles three boards. */}
            {SEVEN_DEUCE_VARIANTS.has(String(gameType || 'nlh').toLowerCase()) && (
              <Toggle
                label="Seven-Deuce"
                value={config.sevenDeuceEnabled}
                onChange={(v) => updateConfig('sevenDeuceEnabled', v)}
                tooltip="Winner Holding Any 7-2 Collects A Bounty From Each Other Player (Post-Flop Only)"
              />
            )}
            {SEVEN_DEUCE_VARIANTS.has(String(gameType || 'nlh').toLowerCase()) &&
              config.sevenDeuceEnabled && (
                <Slider
                  label="7-2 Bounty"
                  value={config.sevenDeuceAmountBB}
                  onChange={(v) => updateConfig('sevenDeuceAmountBB', v)}
                  min={0.5}
                  max={10}
                  step={0.5}
                  suffix=" Big Blind"
                />
              )}
            {/* 2026-08-31 audit: `pineappleHoldem` had exactly three
                occurrences in this 2,800-line form — the interface field, the
                default false, and the write. THERE WAS NO CONTROL. The engine
                deals it, BettingStructure has the discard street, the lobby
                badges it, and the only live cash-creation path could not
                reach it. This is the switch. */}
            {canDealPineapple(gameType) && (
              <Toggle
                label="Pineapple Hold'em"
                value={config.pineappleHoldem}
                onChange={(v) => updateConfig('pineappleHoldem', v)}
                tooltip="Three Hole Cards, Discard One After The Flop"
              />
            )}
            <Toggle
              label="NIT Game"
              value={config.nitGame}
              onChange={(v) => updateConfig('nitGame', v)}
              tooltip="Penalty For Tight Play"
            />
            <Toggle
              label="Anonymous Table"
              value={config.isAnonymous}
              onChange={(v) => updateConfig('isAnonymous', v)}
            />
            {/* Hidden on a fixed-limit table: the cap clamp runs after the
                mandatory fixed size is assigned, so a capped limit table can
                emit a wager the validator refuses. See isFixedLimitGame. */}
            {!limitGame && (
              <Toggle
                label="Cap"
                value={config.capEnabled}
                onChange={(v) => updateConfig('capEnabled', v)}
                tooltip="Limit The Total Chips A Player Can Commit In One Hand"
              />
            )}
            {!limitGame && config.capEnabled && (
              <Slider
                label="Cap Amount"
                value={config.capBB}
                onChange={(v) => updateConfig('capBB', v)}
                min={10}
                max={200}
                step={5}
                suffix=" Big Blinds"
                tooltip="The Most A Player Can Put In Across The Whole Hand. Reaching The Cap Does Not Put Them All-In."
              />
            )}
            <Toggle
              label="Ban Chat"
              value={config.banChat}
              onChange={(v) => updateConfig('banChat', v)}
            />
            <Toggle
              label="Label As NEW"
              value={config.labelAsNew}
              onChange={(v) => updateConfig('labelAsNew', v)}
              tooltip="Show NEW Badge"
            />
            <Toggle
              label="Featured Table"
              value={config.isFeatured}
              onChange={(v) => updateConfig('isFeatured', v)}
              tooltip="Feature At Top Of List"
            />
            <Toggle
              label="No Rathole"
              value={config.noRathole}
              onChange={(v) => updateConfig('noRathole', v)}
              tooltip="Prevent Leaving With Winnings"
            />

            {/* SECTION: Table Parameters */}
            <Slider
              label="Table Size"
              value={config.maxPlayers}
              onChange={(v) => updateConfig('maxPlayers', v)}
              min={2}
              max={seatCap}
              suffix=" max"
            />

            {/* Calltime removed 2026-08-27: calltime_enabled has zero readers.
                The shot clock the tooltip promised never ticked. Action Time
                below is the real timer. */}
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

            {/* Blinds Slider */}
            <div className="config-slider">
              <div className="slider-header">
                <span className="slider-label">
                  {isFixedLimitVariant(gameType) ? (
                    <>
                      {/* A limit player thinks in bet sizes, but still needs to
                          know what they are posting — show both. */}
                      Limits: {stakesLabel(config.smallBlind, config.bigBlind, gameType)} (Blinds{' '}
                      {config.smallBlind}/{config.bigBlind})
                    </>
                  ) : (
                    <>
                      Blinds: {config.smallBlind}/{config.bigBlind}
                    </>
                  )}
                </span>
              </div>
              <div className="slider-track-container">
                <input
                  type="range"
                  min={0}
                  max={offeredPresets.length - 1}
                  value={blindsIndex}
                  onChange={(e) => handleBlindsChange(Number(e.target.value))}
                  className="slider-input"
                />
              </div>
            </div>

            {/* Buy-in Range */}
            <div className="config-slider">
              <div className="slider-header">
                <span className="slider-label">
                  Buy-In: {config.minBuyInBB} - {config.maxBuyInBB}
                </span>
              </div>
              <div className="buyin-sliders">
                {/* Dan 2026-08-28: cash buy-ins are 40BB-200BB. The min
                    slider used to reach down to 2BB, which is precisely the
                    shape of the broken "NLH 25/50, buy-in 100-200" row — a
                    2BB/4BB band nobody could play. 40BB is the floor. */}
                <input
                  type="range"
                  min={40}
                  max={config.maxBuyInBB}
                  value={config.minBuyInBB}
                  onChange={(e) => updateConfig('minBuyInBB', Number(e.target.value))}
                  className="slider-input"
                />
                <input
                  type="range"
                  min={Math.max(config.minBuyInBB, 40)}
                  max={500}
                  value={config.maxBuyInBB}
                  onChange={(e) => updateConfig('maxBuyInBB', Number(e.target.value))}
                  className="slider-input"
                />
              </div>
            </div>

            <Slider
              label="Ante"
              value={config.anteBB}
              onChange={(v) => updateConfig('anteBB', v)}
              min={0}
              max={5}
              step={0.5}
              suffix=" Big Blind"
            />

            <Slider
              label="Career %"
              value={config.careerPercentMin}
              onChange={(v) => updateConfig('careerPercentMin', v)}
              min={0}
              max={100}
              suffix="%"
            />

            <Slider
              label="Maintain %"
              value={config.maintainPercentMin}
              onChange={(v) => updateConfig('maintainPercentMin', v)}
              min={0}
              max={100}
              suffix="%"
            />

            <Slider
              label="Maintain #"
              value={config.maintainHands}
              onChange={(v) => updateConfig('maintainHands', v)}
              min={1}
              max={100}
              suffix=" hands"
            />

            <Slider
              label="AutoStart"
              value={config.autoStartPlayers}
              onChange={(v) => updateConfig('autoStartPlayers', v)}
              min={2}
              /* NEVER ABOVE THE SEAT COUNT (2026-08-31 audit). This was a
                 fixed 10 while Table Size is capped at seatCap (6 for PLO6,
                 7 for PLO5, 8 for PLO4/PLO8/FLO8). The engine honours
                 auto_start_players with only a lower bound
                 (ServerTableEngineBase.minPlayersToDeal), and dealThreshold
                 exports the same number to the zombie reaper - so a 6-seat
                 table asking for 10 players would sit forever, never deal,
                 and never even be reported as stuck. */
              max={Math.min(seatCap, config.maxPlayers)}
              suffix=" players"
            />

            {/* SECTION: Auto Settings */}
            <Toggle
              label="Auto Extension"
              value={config.autoExtension}
              onChange={(v) => updateConfig('autoExtension', v)}
              tooltip="Keep This Table Open When It Empties"
            />
            {/* Auto Restart and Auto Create Table look dead from a
                TypeScript grep and are NOT: fn_table_lifecycle_pass reads
                both columns in SQL. Checked against the live function on
                2026-08-31 before nearly deleting them. */}
            <Toggle
              label="Auto Restart"
              value={config.autoRestart}
              onChange={(v) => updateConfig('autoRestart', v)}
              tooltip="Reopen This Table If It Closes"
            />
            <Toggle
              label="Auto Create Table"
              value={config.autoCreateTable}
              onChange={(v) => updateConfig('autoCreateTable', v)}
              tooltip="Create New Table When Full"
            />
            {/* Hidden on a fixed-limit table: HandController posts a straddle
                by assigning currentBet with no structure branch, and the
                straddle is not counted against the four-wager cap. */}
            {!limitGame && (
              <>
                <Toggle
                  label="Auto UTG Straddle"
                  value={config.autoUtgStraddle}
                  onChange={(v) => updateConfig('autoUtgStraddle', v)}
                  tooltip="Automatic UTG Straddle"
                />
                <Toggle
                  label="Voluntary Straddle"
                  value={config.voluntaryStraddle}
                  onChange={(v) => updateConfig('voluntaryStraddle', v)}
                  tooltip="Allow Voluntary Straddle"
                />
              </>
            )}
            <Toggle
              label="Insurance"
              value={config.insuranceEnabled}
              onChange={(v) => updateConfig('insuranceEnabled', v)}
              tooltip="All-In Insurance Option"
            />

            {/* Run It Multi-Times */}
            <div className="config-radio-group">
              <span className="radio-group-label">Run It Multi-Times</span>
              <div className="radio-options">
                <label className="radio-option">
                  <input
                    type="radio"
                    name="runIt"
                    checked={config.runItMode === 'none'}
                    onChange={() => updateConfig('runItMode', 'none')}
                  />
                  <span>None</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="runIt"
                    checked={config.runItMode === 'player_choice'}
                    onChange={() => updateConfig('runItMode', 'player_choice')}
                  />
                  <span>Player's Choice</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="runIt"
                    checked={config.runItMode === 'mandatory_twice'}
                    onChange={() => updateConfig('runItMode', 'mandatory_twice')}
                  />
                  <span>Mandatory Twice</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="runIt"
                    checked={config.runItMode === 'mandatory_three'}
                    onChange={() => updateConfig('runItMode', 'mandatory_three')}
                  />
                  <span>Mandatory 3 Times</span>
                </label>
              </div>
            </div>
          </>
        )}

        {/* SNG/MTT SPECIFIC OPTIONS */}
        {(config.gameMode === 'sng' || config.gameMode === 'mtt') && (
          <>
            {/* SNG Player Count Dropdown - Only for SNG */}
            {config.gameMode === 'sng' && (
              <div className="config-toggle">
                <span className="toggle-label">
                  Players
                  <span className="tooltip-icon" title="Number Of Players In SNG">
                    ?
                  </span>
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
              value={config.isPrivate || privateOnly}
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
                <span
                  className="tooltip-icon"
                  title="Taken Out Of The Buy-In, Never Added On Top. Spins Carry No Fee."
                >
                  ?
                </span>
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
                <span className="tooltip-icon" title="Prize Distribution">
                  ?
                </span>
              </span>
              <select
                className="config-select"
                value={config.payoutStructure}
                onChange={(e) => updateConfig('payoutStructure', e.target.value as PayoutStructure)}
              >
                <option value="payout1">Payout 1</option>
                <option value="payout2">Payout 2</option>
                <option value="payout3">Payout 3</option>
                <option value="winner_take_all">Winner Take All</option>
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
              tooltip="All Tables Break At The Same Time"
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
                `trg_tournaments_refuse_unbuilt_multi_day` now refuses the flag
                at the database for every caller, so a control here could only
                produce an error. Restore the Toggle and the Total Days field
                in the commit that implements Day 2. */}
            <div className="config-toggle">
              <span className="toggle-label">
                Multi-Day MTT
                <span
                  className="tooltip-icon"
                  title="Day 2 Resume And Flight Merging Are Not Built. Setting This Would Badge The Event Multi-Day While It Played Down To One Winner In A Single Session, So It Is Refused Rather Than Promised."
                >
                  ?
                </span>
              </span>
              <span className="toggle-status off">NOT AVAILABLE YET</span>
            </div>
            {/* Player Number Range */}
            <div className="config-slider">
              <div className="slider-header">
                <span className="slider-label">
                  Player Number: {config.minPlayers} - {config.maxPlayersRange}
                </span>
              </div>
              <div className="buyin-sliders">
                <input
                  type="range"
                  min={2}
                  max={config.maxPlayersRange}
                  value={config.minPlayers}
                  onChange={(e) => updateConfig('minPlayers', Number(e.target.value))}
                  className="slider-input"
                />
                <input
                  type="range"
                  min={config.minPlayers}
                  max={1000}
                  value={config.maxPlayersRange}
                  onChange={(e) => updateConfig('maxPlayersRange', Number(e.target.value))}
                  className="slider-input"
                />
              </div>
            </div>

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

        {/* Rake, security and game length are cash-table settings for the same
            reason as the block above: a tournament is raked once at entry (a
            flat 10% of the buy-in, enforced in fn_create_tournament) and never
            per hand, so a per-pot rake override has nothing to act on. */}
        {config.gameMode === 'regular' && (
          <>
            {/* SECTION: Rake Settings
            Both sliders sit at -1 ("Schedule") by default, which means the
            published rake schedule decides — 10% with a cash cap that varies by
            stake. Sliding either one off -1 is a deliberate override, and an
            override can only ever take LESS than the schedule: the engine
            clamps percent to 10 and the cap to 10 BB (getFullRakeConfig).
            The cap is entered in big blinds; the live cash value is shown
            beside it because 3 BB is $0.60 at 0.10/0.20 and $75 at 10/25. */}
            <Slider
              label="Fee"
              value={config.rakePercent}
              onChange={(v) => updateConfig('rakePercent', v)}
              min={RAKE_INHERIT}
              max={10}
              step={0.5}
              format={(v) => (v < 0 ? 'Schedule (10%)' : `${v}%`)}
              tooltip="Percentage Of Each Raked Pot. Schedule = Use The House Rake Schedule."
            />

            <Slider
              label="FeeCap"
              value={config.rakeCapBB}
              onChange={(v) => updateConfig('rakeCapBB', v)}
              min={RAKE_INHERIT}
              max={10}
              format={(v) =>
                v < 0
                  ? 'Schedule'
                  : `${v} x Big Blind${config.bigBlind ? ` (= ${formatCurrency(v * config.bigBlind)})` : ''}`
              }
              tooltip="Most That Can Be Raked From One Pot. Schedule = Use The House Cap For This Stake."
            />

            {/*
              WHAT THIS TABLE WILL ACTUALLY CHARGE (2026-08-31).

              The two sliders above say "Schedule" by default and the schedule
              is a fourteen-row table in a config file, so an owner could set
              up a game without ever seeing its price. That is not
              hypothetical: the rake gap this audit found - six of the twelve
              blind presets had no schedule row, and the DEFAULT preset was
              being priced off a tier fallback at 30 big blinds - sat in the
              product for months precisely because nothing on this screen ever
              said the number out loud.

              Resolved through getRakeConfig, the same function and the same
              precedence the engine applies (an override may only ever move
              DOWN from the published schedule), so this cannot drift into
              advertising a rate we do not charge. The Game Rules modal made
              exactly that mistake in 2026-08 by rendering placeholder props.
            */}
            {(() => {
              const priced = getRakeConfig(config.bigBlind, gameType || 'nlh', config.smallBlind, {
                rakePercent: config.rakePercent,
                rakeCapBB: config.rakeCapBB,
              });
              const capInBB = config.bigBlind > 0 ? priced.rakeCap / config.bigBlind : 0;
              const overridden =
                config.rakePercent !== RAKE_INHERIT || config.rakeCapBB !== RAKE_INHERIT;
              return (
                <div className="config-slider">
                  <div className="slider-header">
                    <span className="slider-label">
                      This Table Charges {priced.rakePercent}% Of Each Raked Pot, Up To{' '}
                      {formatCurrency(priced.rakeCap)} ({Number(capInBB.toFixed(1))} Big Blinds)
                    </span>
                  </div>
                  <div className="slider-header">
                    <span className="slider-label">
                      {priced.bbjEnabled ? (
                        <>
                          Bad Beat Jackpot Drop {formatCurrency(config.bigBlind * priced.bbjFeeBB)}{' '}
                          Per Flopped Hand ({priced.bbjFeeBB} Big Blinds)
                        </>
                      ) : (
                        <>No Bad Beat Jackpot On This Game</>
                      )}
                    </span>
                  </div>
                  <div className="slider-header">
                    <span className="slider-label">
                      {overridden ? (
                        <>Your Override, Held To The Published Schedule</>
                      ) : (
                        <>Published Schedule For {priced.tier} Stakes</>
                      )}
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* SECTION: Security */}
            <Toggle
              label="IP Restriction"
              value={config.ipRestriction}
              onChange={(v) => updateConfig('ipRestriction', v)}
              tooltip="Two Different Accounts Cannot Sit At This Table From The Same Internet Connection. Players Already Seated Are Not Affected."
            />
            <Toggle
              label="Hide Club Name"
              value={config.hideClubName}
              onChange={(v) => updateConfig('hideClubName', v)}
            />

            {/* Game Length removed 2026-08-27: game_length_hours has zero
                readers. Every "12 hour" table ran forever; the closest real
                lifecycle controls are Auto Extension / Auto Restart above. */}
          </>
        )}
      </div>

      {/* Footer Buttons */}
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
    </div>
  );
}
