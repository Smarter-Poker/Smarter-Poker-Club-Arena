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

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import { resolveClubUUID } from '../utils/clubIdResolver';
import './TableConfigPage.css';
import { reportError } from '../utils/errorReporter';
import { formatCurrency } from '../lib/utils';
import { RAKE_INHERIT } from '../config/RakeConfig';
import { tournamentService } from '../services/TournamentService';
import {
  buildTournamentConfig,
  canRunAsTournament as gameTypeCanRunAsTournament,
} from '../lib/tournamentFromTableConfig';
import {
  gameCreationDeniedMessage,
  type GameCreationAccess,
} from '../lib/gameCreationAccess';
import { fetchGameCreationAccess } from '../services/GameAccessService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
type GameMode = 'regular' | 'sng' | 'mtt';
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

// SNG Player Count Options (3=Spins, 9=Single Table, then multi-table)
const SNG_PLAYER_OPTIONS = [
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
  bombPotEnabled: boolean;
  doubleBoard: boolean;
  tripleBoard: boolean;
  pineappleHoldem: boolean;
  sevenDeuceEnabled: boolean;
  sevenDeuceAmountBB: number;
  nitGame: boolean;
  capEnabled: boolean;
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
  gameLengthHours: number;

  // Time & Auto Settings (toggles)
  calltimeEnabled: boolean;
  autoExtension: boolean;
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

  // Security Settings
  agentDownlineLimit: number | null;
  buyInAuthorization: boolean;
  restrictDevice: boolean;
  restrictObservers: boolean;
  gpsRestriction: boolean;
  ipRestriction: boolean;
  pcEmulatorRestriction: boolean;
  photoRotationVerification: boolean;
}

const GAME_TYPE_LABELS: Record<string, { name: string; color: string }> = {
  nlh: { name: 'NLH', color: '#dc2626' },
  flh: { name: 'FLH', color: '#b45309' },
  shortdeck: { name: '6+', color: '#0d9488' },
  plo: { name: 'OMAHA', color: '#7c3aed' },
  flo: { name: 'FLO', color: '#eab308' },
  mixed: { name: 'MIXED', color: '#db2777' },
  ofc: { name: 'OFC', color: '#16a34a' },
};

const BLINDS_PRESETS = [
  { label: '0.01/0.02', sb: 0.01, bb: 0.02 },
  { label: '0.02/0.05', sb: 0.02, bb: 0.05 },
  { label: '0.05/0.10', sb: 0.05, bb: 0.1 },
  { label: '0.10/0.25', sb: 0.1, bb: 0.25 },
  { label: '0.25/0.50', sb: 0.25, bb: 0.5 },
  { label: '0.50/1', sb: 0.5, bb: 1 },
  { label: '1/2', sb: 1, bb: 2 },
  { label: '2/5', sb: 2, bb: 5 },
  { label: '5/10', sb: 5, bb: 10 },
  { label: '10/25', sb: 10, bb: 25 },
  { label: '25/50', sb: 25, bb: 50 },
  { label: '50/100', sb: 50, bb: 100 },
];

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
  doubleBoard: false,
  tripleBoard: false,
  pineappleHoldem: false,
  sevenDeuceEnabled: false,
  sevenDeuceAmountBB: 2,
  nitGame: false,
  capEnabled: false,
  noRathole: false,

  // Table Parameters
  maxPlayers: 9,
  actionTimeSeconds: 15,
  smallBlind: 0.05,
  bigBlind: 0.1,
  minBuyInBB: 40,
  maxBuyInBB: 100,
  anteBB: 0,
  careerPercentMin: 0,
  maintainPercentMin: 0,
  maintainHands: 10,
  autoStartPlayers: 2,
  gameLengthHours: 12,

  // Time & Auto Settings
  calltimeEnabled: false,
  autoExtension: false,
  autoRestart: false,
  autoCreateTable: false,
  autoUtgStraddle: false,
  voluntaryStraddle: false,
  insuranceEnabled: false,

  // Run It Multi-Times
  runItMode: 'none',

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

  // Security Settings
  agentDownlineLimit: null,
  buyInAuthorization: false,
  restrictDevice: true,
  restrictObservers: false,
  gpsRestriction: true,
  ipRestriction: true,
  pcEmulatorRestriction: false,
  photoRotationVerification: false,
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

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function TableConfigPage() {
  const { clubId, gameType } = useParams<{ clubId: string; gameType: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [config, setConfig] = useState<TableConfig>({ ...DEFAULT_CONFIG });
  const [blindsIndex, setBlindsIndex] = useState(2); // Default 0.05/0.10
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [templates, setTemplates] = useState<TableTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [savingTemplate, setSavingTemplate] = useState(false);

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
        navigate(`/clubs/${clubId}`);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [clubId]);

  const gameInfo = GAME_TYPE_LABELS[gameType || 'nlh'] || GAME_TYPE_LABELS.nlh;

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
            console.warn('[TableConfigPage] ⏱️ Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[TableConfigPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // Generate default table name
  useEffect(() => {
    const blindsLabel = `${config.smallBlind}/${config.bigBlind}`;
    setConfig((prev) => ({
      ...prev,
      name: prev.name || `${gameInfo.name} ${blindsLabel}`,
    }));
  }, [gameInfo.name]);

  const updateConfig = <K extends keyof TableConfig>(key: K, value: TableConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  // Load a template's config into the form
  const loadTemplate = (templateId: string) => {
    if (!templateId) {
      setSelectedTemplateId('');
      return;
    }
    const template = templates.find((t) => t.id === templateId);
    if (template) {
      setConfig({
        ...DEFAULT_CONFIG,
        ...template.config,
        name: '', // Clear name so user enters new name
      });
      setSelectedTemplateId(templateId);
      toast.success(`Loaded template: ${template.name}`);
    }
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

  // Handle SNG player count change (auto-set spins mode for 3 players)
  const handleSngPlayerChange = (playerCount: number) => {
    const option = SNG_PLAYER_OPTIONS.find((o) => o.value === playerCount);
    setConfig((prev) => ({
      ...prev,
      sngPlayerCount: playerCount,
      isSpins: option?.isSpins || false,
    }));
  };

  const handleBlindsChange = (index: number) => {
    setBlindsIndex(index);
    const preset = BLINDS_PRESETS[index];
    setConfig((prev) => ({
      ...prev,
      smallBlind: preset.sb,
      bigBlind: preset.bb,
    }));
  };

  // FIX: Accept resolved UUID — raw clubId from URL params may not be a UUID
  const canRunAsTournament = gameTypeCanRunAsTournament(gameType);

  const buildTableData = (resolvedClubId?: string) => ({
    club_id: resolvedClubId || clubId,
    // Stamp the owning union when there is one, so a game the union built for a
    // member club also shows up in the union's own views (getUnionTables).
    // NULL for a standalone club — matching every existing union table, which
    // carries BOTH union_id and the member club's club_id.
    union_id: access?.unionId ?? null,
    name: config.name,
    game_type: gameType?.toUpperCase() || 'NLH',
    game_variant: gameType || 'nlh',
    game_mode: config.gameMode,

    // Stakes
    small_blind: config.smallBlind,
    big_blind: config.bigBlind,
    stakes: `${config.smallBlind}/${config.bigBlind}`,

    // Basic settings
    is_private: config.isPrivate,
    is_vip_only: config.isVipOnly,
    is_anonymous: config.isAnonymous,
    ban_chat: config.banChat,
    label_as_new: config.labelAsNew,
    is_featured: config.isFeatured,
    hide_club_name: config.hideClubName,

    // Game variants
    bomb_pot_enabled: config.bombPotEnabled,
    // FIX-D10 2026-07-19: the engine only fires bomb pots when
    // bomb_pot_frequency > 0, but the config page exposes just an on/off toggle,
    // so "enabled" bomb pots never occurred. Write sensible defaults when enabled
    // (every 10 hands, 2x BB ante per Bible V8 §4.22) until the UI exposes knobs.
    bomb_pot_frequency: config.bombPotEnabled ? 10 : 0,
    bomb_pot_ante_multiplier: config.bombPotEnabled ? 2 : 0,
    double_board: config.doubleBoard,
    triple_board: config.tripleBoard,
    pineapple_holdem: config.pineappleHoldem,
    seven_deuce_enabled: config.sevenDeuceEnabled,
    // 7-2 bounty size in big blinds each other dealt-in player pays a post-flop
    // 7-2 winner. Only meaningful when the toggle is on; default 2 BB.
    seven_deuce_amount: config.sevenDeuceEnabled ? config.sevenDeuceAmountBB : 2,
    nit_game: config.nitGame,
    cap_enabled: config.capEnabled,
    no_rathole: config.noRathole,

    // Table parameters
    max_players: config.maxPlayers,
    action_time_seconds: config.actionTimeSeconds,
    min_buy_in: config.minBuyInBB * config.bigBlind,
    max_buy_in: config.maxBuyInBB * config.bigBlind,
    min_buy_in_bb: config.minBuyInBB,
    max_buy_in_bb: config.maxBuyInBB,
    ante_bb: config.anteBB,
    career_percent_min: config.careerPercentMin,
    maintain_percent_min: config.maintainPercentMin,
    maintain_hands: config.maintainHands,
    auto_start_players: config.autoStartPlayers,
    game_length_hours: config.gameLengthHours,

    // Time & auto settings
    calltime_enabled: config.calltimeEnabled,
    auto_extension: config.autoExtension,
    auto_restart: config.autoRestart,
    auto_create_table: config.autoCreateTable,
    auto_utg_straddle: config.autoUtgStraddle,
    voluntary_straddle: config.voluntaryStraddle,
    insurance_enabled: config.insuranceEnabled,
    // FIX-D2 2026-07-19: the engine reads the canonical top-level columns
    // straddle_enabled / run_it_twice_enabled, NOT auto_utg_straddle /
    // voluntary_straddle / run_it_mode. Without these mirrors, straddle and
    // run-it-twice configured on this page never took effect.
    straddle_enabled: config.autoUtgStraddle || config.voluntaryStraddle,
    run_it_twice_enabled: config.runItMode !== 'none',

    // Run it multi-times
    run_it_mode: config.runItMode,

    // Rake settings
    rake_percent: config.rakePercent,
    rake_cap_bb: config.rakeCapBB,

    // SNG/MTT specific
    sng_buy_in: config.buyIn,
    sng_custom_buy_in: config.customBuyIn,
    blind_structure: config.blindStructure,
    payout_structure: config.payoutStructure,
    starting_chips: config.startingChips,
    blinds_up_minutes: config.blindsUpMinutes,
    next_step_satellite: config.nextStepSatellite,

    // MTT specific
    short_description: config.shortDescription,
    accelerated_mtt: config.acceleratedMtt,
    all_in_or_fold: config.allInOrFold,
    custom_rebuy_reentry_cost: config.customRebuyReentryCost,
    number_of_rebuys_reentries: config.numberOfRebuysReentries,
    add_on_multiplier: config.addOnMultiplier,
    custom_add_on: config.customAddOn,
    add_on_break_length_minutes: config.addOnBreakLengthMinutes,
    ko_bounty: config.koBounty,
    gtd_prize_pool: config.gtdPrizePool,
    final_table_deal: config.finalTableDeal,
    big_blind_ante: config.bigBlindAnte,
    authorized_to_register: config.authorizedToRegister,
    late_registration_level: config.lateRegistrationLevel,
    early_bird_registration: config.earlyBirdRegistration,
    bubble_protection: config.bubbleProtection,
    featured_tournament: config.featuredTournament,
    min_players_mtt: config.minPlayers,
    max_players_mtt: config.maxPlayersRange,
    multi_day_mtt: config.multiDayMtt,
    save_start_time: config.saveStartTime,
    start_time: config.startTime || null,
    restart_tournament_every: config.restartTournamentEvery,
    tournament_schedule: config.tournamentSchedule,
    synchronized_breaks: config.synchronizedBreaks,

    // Security
    agent_downline_limit: config.agentDownlineLimit,
    buy_in_authorization: config.buyInAuthorization,
    restrict_device: config.restrictDevice,
    restrict_observers: config.restrictObservers,
    gps_restriction: config.gpsRestriction,
    ip_restriction: config.ipRestriction,
    pc_emulator_restriction: config.pcEmulatorRestriction,
    photo_rotation_verification: config.photoRotationVerification,

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
    if (!canCreate) {
      toast.error(
        checkingAccess
          ? 'Still checking your permission to create games here.'
          : gameCreationDeniedMessage(access!)
      );
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
        is_template: true,
      };

      const { error } = await supabase.from('tables').insert(tableData);
      if (error) throw error;

      toast.success('Table template saved!');
      navigate(`/clubs/${clubId}`);
    } catch (error) {
      reportError(error, 'TableConfigPage.Failed_to_save_table');
      toast.error('Failed to save table');
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
  const handleStartTournament = async () => {
    setStarting(true);
    try {
      const created = await tournamentService.createTournament(
        clubId || '',
        buildTournamentConfig(config, gameType)
      );
      toast.success(
        config.gameMode === 'sng'
          ? 'Sit & Go created — it starts as soon as it fills.'
          : 'Tournament created — registration is open.'
      );
      const createdId = (created as { id?: string } | null)?.id;
      if (createdId) {
        masterBus.emit('TOURNAMENT_UPDATED', { tournamentId: createdId, status: 'REGISTERING' });
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
    if (!canCreate) {
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

      const tableData = {
        ...buildTableData(resolvedId),
        created_by: user.id,
        status: 'active',
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
      toast.error('Failed to start table');
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
      {templates.length > 0 && (
        <div className="template-selector">
          <label className="template-label">Load Template:</label>
          <select
            className="template-dropdown"
            value={selectedTemplateId}
            onChange={(e) => loadTemplate(e.target.value)}
          >
            <option value="">-- Start Fresh --</option>
            {templates.map((t) => (
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
          placeholder="Enter table name here..."
          value={config.name}
          onChange={(e) => updateConfig('name', e.target.value)}
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
          tooltip="Enable bomb pot rounds"
        />
        <Toggle
          label="Double Board"
          value={config.doubleBoard}
          onChange={(v) => updateConfig('doubleBoard', v)}
        />
        <Toggle
          label="Triple Board"
          value={config.tripleBoard}
          onChange={(v) => updateConfig('tripleBoard', v)}
        />
        <Toggle
          label="Pineapple Hold'em"
          value={config.pineappleHoldem}
          onChange={(v) => updateConfig('pineappleHoldem', v)}
          tooltip="3 hole cards, discard 1"
        />
        <Toggle
          label="Seven-Deuce"
          value={config.sevenDeuceEnabled}
          onChange={(v) => updateConfig('sevenDeuceEnabled', v)}
          tooltip="Winner holding any 7-2 collects a bounty from each other player (post-flop only)"
        />
        {config.sevenDeuceEnabled && (
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
        <Toggle
          label="NIT Game"
          value={config.nitGame}
          onChange={(v) => updateConfig('nitGame', v)}
          tooltip="Penalty for tight play"
        />
        <Toggle
          label="Anonymous Table"
          value={config.isAnonymous}
          onChange={(v) => updateConfig('isAnonymous', v)}
        />
        <Toggle
          label="Cap"
          value={config.capEnabled}
          onChange={(v) => updateConfig('capEnabled', v)}
          tooltip="Cap the max bet"
        />
        <Toggle
          label="Ban Chat"
          value={config.banChat}
          onChange={(v) => updateConfig('banChat', v)}
        />
        <Toggle
          label="Label as NEW"
          value={config.labelAsNew}
          onChange={(v) => updateConfig('labelAsNew', v)}
          tooltip="Show NEW badge"
        />
        <Toggle
          label="Featured Table"
          value={config.isFeatured}
          onChange={(v) => updateConfig('isFeatured', v)}
          tooltip="Feature at top of list"
        />
        <Toggle
          label="No Rathole"
          value={config.noRathole}
          onChange={(v) => updateConfig('noRathole', v)}
          tooltip="Prevent leaving with winnings"
        />

        {/* SECTION: Table Parameters */}
        <Slider
          label="Table Size"
          value={config.maxPlayers}
          onChange={(v) => updateConfig('maxPlayers', v)}
          min={2}
          max={10}
          suffix=" max"
        />

        <Toggle
          label="Calltime"
          value={config.calltimeEnabled}
          onChange={(v) => updateConfig('calltimeEnabled', v)}
          tooltip="Shot clock for action"
        />

        <Slider
          label="Action Time"
          value={config.actionTimeSeconds}
          onChange={(v) => updateConfig('actionTimeSeconds', v)}
          min={5}
          max={60}
          suffix=" sec"
        />

        {/* Blinds Slider */}
        <div className="config-slider">
          <div className="slider-header">
            <span className="slider-label">
              Blinds: {config.smallBlind}/{config.bigBlind}
            </span>
          </div>
          <div className="slider-track-container">
            <input
              type="range"
              min={0}
              max={BLINDS_PRESETS.length - 1}
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
              Buy-in: {config.minBuyInBB} - {config.maxBuyInBB}
            </span>
          </div>
          <div className="buyin-sliders">
            <input
              type="range"
              min={2}
              max={config.maxBuyInBB}
              value={config.minBuyInBB}
              onChange={(e) => updateConfig('minBuyInBB', Number(e.target.value))}
              className="slider-input"
            />
            <input
              type="range"
              min={config.minBuyInBB}
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
          max={10}
          suffix=" players"
        />

        {/* SECTION: Auto Settings */}
        <Toggle
          label="Auto Extension"
          value={config.autoExtension}
          onChange={(v) => updateConfig('autoExtension', v)}
          tooltip="Extend table automatically"
        />
        <Toggle
          label="Auto Restart"
          value={config.autoRestart}
          onChange={(v) => updateConfig('autoRestart', v)}
        />
        <Toggle
          label="Auto Create Table"
          value={config.autoCreateTable}
          onChange={(v) => updateConfig('autoCreateTable', v)}
          tooltip="Create new table when full"
        />
        <Toggle
          label="Auto UTG Straddle"
          value={config.autoUtgStraddle}
          onChange={(v) => updateConfig('autoUtgStraddle', v)}
          tooltip="Automatic UTG straddle"
        />
        <Toggle
          label="Voluntary Straddle"
          value={config.voluntaryStraddle}
          onChange={(v) => updateConfig('voluntaryStraddle', v)}
          tooltip="Allow voluntary straddle"
        />
        <Toggle
          label="Insurance"
          value={config.insuranceEnabled}
          onChange={(v) => updateConfig('insuranceEnabled', v)}
          tooltip="All-in insurance option"
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
              <span>Player's choice</span>
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
              <span>Mandatory 3 times</span>
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
                  <span className="tooltip-icon" title="Number of players in SNG">
                    ?
                  </span>
                </span>
                <select
                  className="config-select sng-player-select"
                  value={config.sngPlayerCount}
                  onChange={(e) => handleSngPlayerChange(Number(e.target.value))}
                >
                  {SNG_PLAYER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Slider
              label="Buy-in"
              value={config.buyIn}
              onChange={(v) => updateConfig('buyIn', v)}
              min={10}
              max={1000}
              step={10}
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
                <span className="tooltip-icon" title="Prize distribution">
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
          </>
        )}

        {/* MTT-ONLY OPTIONS */}
        {config.gameMode === 'mtt' && (
          <>
            <Slider
              label="Number of Rebuys/Re-entries"
              value={config.numberOfRebuysReentries}
              onChange={(v) => updateConfig('numberOfRebuysReentries', v)}
              min={0}
              max={10}
            />

            {/* Add-on Options */}
            <Slider
              label="Add-on"
              value={config.addOnMultiplier}
              onChange={(v) => updateConfig('addOnMultiplier', v)}
              min={0.5}
              max={3}
              step={0.5}
              suffix="x"
            />
            {/* Tournament Features */}
            <Toggle
              label="KOBounty"
              value={config.koBounty}
              onChange={(v) => updateConfig('koBounty', v)}
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
          tooltip="Percentage of each raked pot. Schedule = use the house rake schedule."
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
          tooltip="Most that can be raked from one pot. Schedule = use the house cap for this stake."
        />

        {/* SECTION: Security */}
        <Slider
          label="Same Agent Downline Number Limit"
          value={config.agentDownlineLimit ?? 100}
          onChange={(v) => updateConfig('agentDownlineLimit', v === 100 ? null : v)}
          min={1}
          max={100}
          suffix={config.agentDownlineLimit === null ? '' : ''}
        />

        <Toggle
          label="Buy-in Authorization"
          value={config.buyInAuthorization}
          onChange={(v) => updateConfig('buyInAuthorization', v)}
        />
        <Toggle
          label="Restrict Device"
          value={config.restrictDevice}
          onChange={(v) => updateConfig('restrictDevice', v)}
          tooltip="One device per player"
        />
        <Toggle
          label="Restrict Observers"
          value={config.restrictObservers}
          onChange={(v) => updateConfig('restrictObservers', v)}
        />
        <Toggle
          label="GPS Restriction"
          value={config.gpsRestriction}
          onChange={(v) => updateConfig('gpsRestriction', v)}
        />
        <Toggle
          label="IP Restriction"
          value={config.ipRestriction}
          onChange={(v) => updateConfig('ipRestriction', v)}
        />
        <Toggle
          label="PC Emulator Restriction"
          value={config.pcEmulatorRestriction}
          onChange={(v) => updateConfig('pcEmulatorRestriction', v)}
        />
        <Toggle
          label="Photo Rotation Verification"
          value={config.photoRotationVerification}
          onChange={(v) => updateConfig('photoRotationVerification', v)}
          tooltip="Verify identity with photo"
        />
        <Toggle
          label="Hide Club Name"
          value={config.hideClubName}
          onChange={(v) => updateConfig('hideClubName', v)}
        />

        <Slider
          label="Game Length"
          value={config.gameLengthHours}
          onChange={(v) => updateConfig('gameLengthHours', v)}
          min={1}
          max={24}
          suffix=" hour"
        />
          </>
        )}
      </div>

      {/* Footer Buttons */}
      <footer className="config-footer">
        <button className="btn-template" onClick={handleSaveAsTemplate} disabled={savingTemplate}>
          {savingTemplate ? 'Saving...' : 'Save as Template'}
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
