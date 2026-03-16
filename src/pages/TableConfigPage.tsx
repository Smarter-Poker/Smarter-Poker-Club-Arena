/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TABLE CONFIGURATION PAGE — Full PokerBros-Style Form
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
  rakePercent: 10,
  rakeCapBB: 3,

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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // UNION GUARD: Clubs inside a union CANNOT create standalone tables/tournaments.
  const [isInUnion, setIsInUnion] = useState(false);
  const [checkingUnion, setCheckingUnion] = useState(true);

  useEffect(() => {
    if (!clubId) {
      setCheckingUnion(false);
      return;
    }
    let isMounted = true;
    (async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (!isMounted) return;
        if (data) {
          setIsInUnion(true);
          toast.error('Union clubs cannot create standalone tables.');
          navigate(`/clubs/${clubId}`);
        }
      } catch {
        /* fail-open */
      }
      if (isMounted) setCheckingUnion(false);
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
        if (isMounted) console.error('Failed to fetch templates:', err);
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

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'table_templates',
          filter: `club_id=eq.${clubId}`,
        },
        () => {
          resolveClubUUID(clubId!).then((resolvedId) => {
            supabase
              .from('table_templates')
              .select('id, name, game_type, game_mode, config, club_id, is_deleted, created_at')
              .eq('club_id', resolvedId)
              .eq('is_deleted', false)
              .order('created_at', { ascending: false })
              .then(({ data }) => {
                if (isMounted && data) setTemplates(data);
              });
          });
        }
      )
      .subscribe();
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
      console.error('Failed to save template:', err);
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

  // Delete a table (soft delete)
  const handleDeleteTable = async (tableId: string) => {
    setDeleting(true);
    try {
      const { error } = await supabase
        .from('tables')
        .update({ status: 'deleted', is_active: false })
        .eq('id', tableId);
      if (error) throw error;

      toast.success('Table deleted');
      setShowDeleteConfirm(false);
      navigate(`/clubs/${clubId}`);
    } catch (err) {
      console.error('Failed to delete table:', err);
      toast.error('Failed to delete table');
    } finally {
      setDeleting(false);
    }
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
  const buildTableData = (resolvedClubId?: string) => ({
    club_id: resolvedClubId || clubId,
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
    double_board: config.doubleBoard,
    triple_board: config.tripleBoard,
    pineapple_holdem: config.pineappleHoldem,
    seven_deuce_enabled: config.sevenDeuceEnabled,
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
    // UNION GUARD: double-check at save time (defense-in-depth)
    if (isInUnion || checkingUnion) {
      toast.error('Union clubs cannot create standalone tables.');
      return;
    }

    setSaving(true);
    try {
      const {
        data: { user },
      } = await getAuthUser();
      if (!user) throw new Error('Not authenticated');

      // Runtime union check — prevents race if navigation guard was bypassed
      const resolvedId = await resolveClubUUID(clubId || '');
      const { data: unionCheck } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle();
      if (unionCheck) {
        toast.error('Union clubs cannot create standalone tables.');
        setSaving(false);
        return;
      }

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
      console.error('Failed to save table:', error);
      toast.error('Failed to save table');
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    if (!config.name.trim()) {
      toast.error('Please enter a table name');
      return;
    }
    // UNION GUARD: double-check at start time (defense-in-depth)
    if (isInUnion || checkingUnion) {
      toast.error('Union clubs cannot create standalone tables.');
      return;
    }

    setStarting(true);
    try {
      const {
        data: { user },
      } = await getAuthUser();
      if (!user) throw new Error('Not authenticated');

      // Runtime union check — prevents race if navigation guard was bypassed
      const resolvedId = await resolveClubUUID(clubId || '');
      const { data: unionCheck } = await supabase
        .from('union_clubs')
        .select('union_id')
        .eq('club_id', resolvedId)
        .limit(1)
        .maybeSingle();
      if (unionCheck) {
        toast.error('Union clubs cannot create standalone tables.');
        setStarting(false);
        return;
      }

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
      console.error('Failed to start table:', error);
      toast.error('Failed to start table');
    } finally {
      setStarting(false);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
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
  }: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    min: number;
    max: number;
    step?: number;
    suffix?: string;
    tooltip?: string;
  }) => (
    <div className="config-slider">
      <div className="slider-header">
        <span className="slider-label">
          {label}: {value}
          {suffix}
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

  return (
    <div className="table-config-page">
      {/* Header */}
      <header className="config-header">
        <button className="back-btn" onClick={() => navigate(`/clubs/${clubId}/create-table`)}>
          ‹‹
        </button>
        <h1 className="config-title">{gameInfo.name}</h1>
      </header>

      {/* Game Mode Tabs */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${config.gameMode === 'regular' ? 'active' : ''}`}
          onClick={() => updateConfig('gameMode', 'regular')}
        >
          Regular
        </button>
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
          tooltip="Bonus for winning with 7-2"
        />
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

            <Toggle
              label="Next Step (Satellite)"
              value={config.nextStepSatellite}
              onChange={(v) => updateConfig('nextStepSatellite', v)}
              tooltip="Winner advances to next tournament"
            />

            <Slider
              label="Buy-in"
              value={config.buyIn}
              onChange={(v) => updateConfig('buyIn', v)}
              min={10}
              max={1000}
              step={10}
            />

            <Toggle
              label="Custom Buy-in"
              value={config.customBuyIn}
              onChange={(v) => updateConfig('customBuyIn', v)}
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
            {/* Short Description */}
            <div className="config-textarea">
              <label className="textarea-label">Short Description</label>
              <textarea
                className="config-textarea-input"
                placeholder="Write a short description of the tournament."
                value={config.shortDescription}
                onChange={(e) => updateConfig('shortDescription', e.target.value)}
                rows={3}
              />
            </div>

            <Toggle
              label="Accelerated MTT"
              value={config.acceleratedMtt}
              onChange={(v) => updateConfig('acceleratedMtt', v)}
              tooltip="Faster blind increases"
            />
            <Toggle
              label="All-in or Fold"
              value={config.allInOrFold}
              onChange={(v) => updateConfig('allInOrFold', v)}
              tooltip="Only all-in or fold allowed"
            />

            {/* Rebuy/Re-entry Options */}
            <Toggle
              label="Custom Rebuy/Re-entry Cost"
              value={config.customRebuyReentryCost}
              onChange={(v) => updateConfig('customRebuyReentryCost', v)}
            />
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
            <Toggle
              label="Custom Add-on"
              value={config.customAddOn}
              onChange={(v) => updateConfig('customAddOn', v)}
            />
            <Slider
              label="Add-on Break Length"
              value={config.addOnBreakLengthMinutes}
              onChange={(v) => updateConfig('addOnBreakLengthMinutes', v)}
              min={1}
              max={10}
              suffix=" min"
            />

            {/* Tournament Features */}
            <Toggle
              label="KOBounty"
              value={config.koBounty}
              onChange={(v) => updateConfig('koBounty', v)}
            />
            <Toggle
              label="GTD Prize Pool"
              value={config.gtdPrizePool}
              onChange={(v) => updateConfig('gtdPrizePool', v)}
            />
            <Toggle
              label="Final Table Deal"
              value={config.finalTableDeal}
              onChange={(v) => updateConfig('finalTableDeal', v)}
              tooltip="Allow deal at final table"
            />
            <Toggle
              label="Big Blind Ante"
              value={config.bigBlindAnte}
              onChange={(v) => updateConfig('bigBlindAnte', v)}
            />
            <Toggle
              label="Authorized to Register"
              value={config.authorizedToRegister}
              onChange={(v) => updateConfig('authorizedToRegister', v)}
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
              tooltip="Early registration bonus"
            />
            <Toggle
              label="Bubble Protection"
              value={config.bubbleProtection}
              onChange={(v) => updateConfig('bubbleProtection', v)}
              tooltip="Protect players on bubble"
            />
            <Toggle
              label="Featured Tournament"
              value={config.featuredTournament}
              onChange={(v) => updateConfig('featuredTournament', v)}
              tooltip="Feature at top of list"
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

            {/* Scheduling */}
            <Toggle
              label="Multi-Day MTT"
              value={config.multiDayMtt}
              onChange={(v) => updateConfig('multiDayMtt', v)}
              tooltip="Tournament spans multiple days"
            />
            <Toggle
              label="Save the Start Time"
              value={config.saveStartTime}
              onChange={(v) => updateConfig('saveStartTime', v)}
              tooltip="Remember start time"
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

            <Toggle
              label="Restart the Tournament every..."
              value={config.restartTournamentEvery}
              onChange={(v) => updateConfig('restartTournamentEvery', v)}
              tooltip="Auto-restart after completion"
            />
            <Toggle
              label="Tournament Schedule"
              value={config.tournamentSchedule}
              onChange={(v) => updateConfig('tournamentSchedule', v)}
            />
            <Toggle
              label="Synchronized Breaks"
              value={config.synchronizedBreaks}
              onChange={(v) => updateConfig('synchronizedBreaks', v)}
              tooltip="Sync breaks across all tables"
            />
          </>
        )}

        {/* SECTION: Rake Settings */}
        <Slider
          label="Fee"
          value={config.rakePercent}
          onChange={(v) => updateConfig('rakePercent', v)}
          min={0}
          max={10}
          step={0.5}
          suffix="%"
        />

        <Slider
          label="FeeCap"
          value={config.rakeCapBB}
          onChange={(v) => updateConfig('rakeCapBB', v)}
          min={1}
          max={10}
          suffix=" x Big Blind"
          tooltip="Maximum rake cap"
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
