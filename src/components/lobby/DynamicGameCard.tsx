/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DYNAMIC GAME CARD — Premium-Style Lobby Cards
 * ═══════════════════════════════════════════════════════════════════════════════
 * Renders color-coded cards for cash games, MTTs, SNGs, and Spins
 * with dynamic badges, feature icons, and animated elements.
 */

import { Link } from 'react-router-dom';
import './DynamicGameCard.css';
import { reportError } from '../../utils/errorReporter';

// ─── Types ──────────────────────────────────────────────────────────────

interface TableSettings {
  // Snake_case keys (interface standard)
  insurance_enabled?: boolean;
  run_it_twice?: boolean;
  run_it_twice_mandatory?: boolean;
  straddle_enabled?: boolean;
  straddle_type?: string;
  bomb_pot_enabled?: boolean;
  bomb_pot_frequency?: number;
  bomb_pot_ante_bb?: number;
  vpip_display?: boolean;
  // CamelCase keys (DB storage format)
  straddle?: boolean;
  straddleType?: string;
  bombPot?: boolean;
  bombPotFrequency?: number;
  bombPotAnte?: number;
  runItTwice?: boolean;
  vpipDisplay?: boolean;
  allInInsurance?: boolean;
  autoMuck?: boolean;
  callTime?: boolean;
  noRathole?: boolean;
  doubleBoard?: boolean;
  [key: string]: unknown;
}

interface CashTableData {
  id: string;
  name: string;
  game_variant: string;
  stakes: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  current_players: number;
  max_players: number;
  status: string;
  settings?: TableSettings | string;
}

interface TournamentData {
  id: string;
  name: string;
  game_type: string;
  buy_in_amount: number;
  buy_in_fee: number;
  guaranteed_prize: number | null;
  start_time: string;
  status: string;
  current_players: number;
  max_players: number;
  starting_chips: number;
}

// ─── Variant Display Mappings ──────────────────────────────────────────

// FIX 116: Dead variants removed — 9 approved variants only
const VARIANT_DISPLAY: Record<string, { label: string; sub?: string; css: string }> = {
  nlh: { label: 'NLH', css: 'nlh' },
  plo4: { label: 'PLO', sub: '4', css: 'plo4' },
  plo5: { label: 'PLO', sub: '5', css: 'plo5' },
  plo6: { label: 'PLO', sub: '6', css: 'plo6' },
  plo8: { label: 'PLO', sub: '8', css: 'plo8' },
  pineapple: { label: 'PNPL', css: 'pineapple' },
  short_deck: { label: '6+', sub: 'SD', css: 'short_deck' },
  ofc: { label: 'OFC', css: 'ofc' },
  ofc_pineapple: { label: 'OFC', sub: 'P', css: 'ofc_pineapple' },
};

// FIX 116: Dead variants removed — 9 approved variants only
const TOURNEY_VARIANT_MAP: Record<string, string> = {
  NLH: 'nlh',
  PLO4: 'plo4',
  PLO5: 'plo5',
  PLO6: 'plo6',
  PLO8: 'plo8',
  PINEAPPLE: 'pineapple',
  SHORT_DECK: 'short_deck',
  OFC: 'ofc',
  OFC_PINEAPPLE: 'ofc_pineapple',
  PLO: 'plo4', // Legacy mapping
};

// ─── Helper Functions ──────────────────────────────────────────────────

function parseSettings(settings: TableSettings | string | undefined): TableSettings {
  if (!settings) return {};
  if (typeof settings === 'string') {
    try {
      return JSON.parse(settings);
    } catch (err) {
      reportError(err, 'DynamicGameCard.Error');
      return {};
    }
  }
  return settings;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d.getDate().toString().padStart(2, '0')}-${months[d.getMonth()]}`;
}

function detectTourneyType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('freeroll') || lower.includes('free roll')) return 'freeroll';
  if (lower.includes('mystery')) return 'mystery';
  if (lower.includes('pko') || lower.includes('progressive')) return 'pko';
  if (lower.includes('bounty') || lower.includes('ko ')) return 'ko';
  if (lower.includes('turbo')) return 'turbo';
  return 'freezeout';
}

function getTourneyTypeLabel(type: string): string {
  switch (type) {
    case 'ko':
      return 'KO';
    case 'pko':
      return 'PKO';
    case 'mystery':
      return '?KO';
    case 'freeroll':
      return 'FREE';
    case 'turbo':
      return '⚡';
    default:
      return 'FO';
  }
}

// ─── Cash Game Card ────────────────────────────────────────────────────

interface CashCardProps {
  table: CashTableData;
  isAdmin?: boolean;
  onDelete?: (id: string) => void;
}

export function CashGameCard({ table, isAdmin, onDelete }: CashCardProps) {
  const variant = VARIANT_DISPLAY[(table.game_variant || '').toLowerCase()] || {
    label: (table.game_variant || 'NLH').toUpperCase(),
    css: 'nlh',
  };
  const settings = parseSettings(table.settings);
  const hasPlayers = table.current_players > 0;
  // Support both snake_case (interface) and camelCase (DB) key names
  const isBombPot =
    settings.bomb_pot_enabled || settings.bombPot || table.name.toLowerCase().includes('bomb pot');
  const isStraddle =
    settings.straddle_enabled || settings.straddle || table.name.toLowerCase().includes('straddle');
  const isRIT =
    settings.run_it_twice || settings.runItTwice || table.name.toLowerCase().includes('rit');
  const isInsurance =
    settings.insurance_enabled ||
    settings.allInInsurance ||
    table.name.toLowerCase().includes('insurance');
  const isVPIP =
    settings.vpip_display || settings.vpipDisplay || table.name.toLowerCase().includes('vpip');
  const isDoubleBoard =
    settings.doubleBoard ||
    table.name.toLowerCase().includes('double') ||
    table.name.toLowerCase().includes('dbl');

  return (
    <div
      className="table-card-wrapper"
      style={{
        position: 'relative',
        opacity: 1,
        animation: 'slideUp 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <style>{`
                @keyframes slideUp {
                    from { opacity: 0; transform: translateY(12px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
      <Link
        to={`/table/${table.id}`}
        className={`dgc dgc--${variant.css}${hasPlayers ? ' dgc--live' : ''}`}
      >
        {/* Ambient glow */}
        <div className="dgc__glow" />

        {/* Decorative card backs */}
        <div className="dgc__card-deco dgc__card-deco--left">🂠</div>
        <div className="dgc__card-deco dgc__card-deco--right">🂠</div>

        {/* Feature badges */}
        <div className="dgc__badges">
          <span className="dgc__badge dgc__badge--bbj">BBJ</span>
          {isStraddle && <span className="dgc__badge dgc__badge--straddle">STR</span>}
          {isBombPot && <span className="dgc__badge dgc__badge--bombpot">BOMB</span>}
          {isRIT && <span className="dgc__badge dgc__badge--rit">RIT</span>}
          {isInsurance && <span className="dgc__badge dgc__badge--insurance">INS</span>}
          {isVPIP && <span className="dgc__badge dgc__badge--vpip">VPIP</span>}
          {isDoubleBoard && <span className="dgc__badge dgc__badge--db">DB</span>}
        </div>

        {/* Variant Logo */}
        <div className="dgc__variant-logo">
          {variant.label}
          {variant.sub && <span className="dgc__variant-sub">{variant.sub}</span>}
        </div>

        {/* Blinds */}
        <div className="dgc__blinds-section">
          <span className="dgc__blinds-label">Blinds</span>
          <span className="dgc__blinds-value">
            {table.small_blind}/{table.big_blind}
            {isStraddle && (settings.straddle_type || settings.straddleType)
              ? `/${(settings.straddle_type || settings.straddleType || '').substring(0, 3).toUpperCase()}`
              : ''}
          </span>
          <span className="dgc__timer">00:30:00</span>
        </div>

        {/* Player indicator */}
        <div className="dgc__players">
          <span className={`dgc__players-dot ${!hasPlayers ? 'dgc__players-dot--empty' : ''}`} />
          {table.current_players}/{table.max_players}
        </div>

        {/* Union badge */}
        <div className="dgc__union-badge">U</div>

        {/* Bottom bar */}
        <div className="dgc__bottom">
          <span className="dgc__date">{formatDate(new Date().toISOString())}</span>
          <span className="dgc__buyin">
            <span className="dgc__buyin-icon" />
            <span className="dgc__buyin-range">{table.min_buy_in || table.big_blind * 20}</span>
          </span>
          <span className="dgc__buyin">
            <span className="dgc__max-icon" />
            <span className="dgc__buyin-range">{table.max_buy_in || table.big_blind * 100}</span>
          </span>
          <span className="dgc__seat-info">
            {table.max_players <= 2 ? 'HU' : table.max_players <= 6 ? '6MAX' : '9MAX'}
          </span>
        </div>
      </Link>
      {/* Admin delete button */}
      {isAdmin && onDelete && (
        <button
          className="dgc__delete-btn"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(table.id);
          }}
          title="Delete table"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ─── Tournament Card (MTT) ─────────────────────────────────────────────

interface TournamentCardProps {
  tournament: TournamentData;
}

export function TournamentCard({ tournament }: TournamentCardProps) {
  const variantKey = TOURNEY_VARIANT_MAP[tournament.game_type] || 'nlh';
  const variant = VARIANT_DISPLAY[variantKey] || { label: 'NLH', css: 'nlh' };
  const tourneyType = detectTourneyType(tournament.name);
  const typeLabel = getTourneyTypeLabel(tourneyType);
  const isFreeroll = tournament.buy_in_amount === 0;
  const isLive = tournament.status === 'running';
  const isReg = tournament.status === 'registering';
  const hasGTD = tournament.guaranteed_prize && tournament.guaranteed_prize > 0;

  return (
    <Link to={`/tournaments/${tournament.id}`} className={`dgc dgc--${variant.css} dgc--mtt`}>
      {/* Ambient glow */}
      <div className="dgc__glow" />

      {/* Tournament type icon */}
      <div className="dgc__tourney-type">
        <div className={`dgc__tourney-type-icon dgc__tourney-type-icon--${tourneyType}`}>
          {typeLabel}
        </div>
      </div>

      {/* Event tier */}
      {tournament.max_players >= 40 && (
        <span className="dgc__event-tier dgc__event-tier--main">Main</span>
      )}

      {/* Max players badge */}
      <div className="dgc__max-badge">
        {tournament.max_players <= 2 ? 'HU' : tournament.max_players <= 6 ? '6 Max' : '9 Max'}
      </div>

      {/* Variant + Buy-in */}
      <div style={{ paddingTop: '38px' }}>
        <div className="dgc__mtt-buyin">
          <span className="dgc__mtt-buyin-label">Buy-in</span>
        </div>
        <div className="dgc__variant-logo" style={{ padding: '0 10px' }}>
          {variant.label}
          {variant.sub && <span className="dgc__variant-sub">{variant.sub}</span>}
        </div>
        <div className="dgc__mtt-buyin" style={{ marginTop: '-2px' }}>
          <span className="dgc__mtt-buyin-value">
            {isFreeroll ? 'FREE' : tournament.buy_in_amount + tournament.buy_in_fee}
          </span>
        </div>
      </div>

      {/* Timer */}
      <div className="dgc__blinds-section" style={{ flex: 'unset', padding: '0 10px' }}>
        <span className="dgc__timer">
          {isLive
            ? 'In Progress'
            : `${Math.max(0, Math.floor((new Date(tournament.start_time).getTime() - Date.now()) / 60000))}min`}
        </span>
      </div>

      {/* Status badge */}
      {isLive && <span className="dgc__status dgc__status--live">LIVE</span>}
      {isReg && <span className="dgc__status dgc__status--reg">REG</span>}

      {/* Players */}
      <div className="dgc__players">
        <span
          className={`dgc__players-dot ${tournament.current_players > 0 ? '' : 'dgc__players-dot--empty'}`}
        />
        {tournament.current_players}
      </div>

      {/* Tournament name + GTD */}
      <div className="dgc__mtt-name">{tournament.name}</div>
      {hasGTD && (
        <div className="dgc__mtt-gtd">
          {isFreeroll ? '🏆' : '💰'} {tournament.guaranteed_prize!.toLocaleString()} GTD
        </div>
      )}

      {/* Union badge */}
      <div className="dgc__union-badge">U</div>

      {/* Bottom bar */}
      <div className="dgc__bottom">
        <span className="dgc__date">{formatDate(tournament.start_time)}</span>
        <span className="dgc__seat-info">
          {tournament.game_type} {tournament.current_players}/{tournament.max_players}
        </span>
      </div>
    </Link>
  );
}

// ─── SNG Card ──────────────────────────────────────────────────────────

export function SNGCard({ tournament }: TournamentCardProps) {
  const variantKey = TOURNEY_VARIANT_MAP[tournament.game_type] || 'nlh';
  const variant = VARIANT_DISPLAY[variantKey] || { label: 'NLH', css: 'nlh' };
  const isHU = tournament.max_players <= 2;
  const isTurbo = tournament.name.toLowerCase().includes('turbo');

  return (
    <Link to={`/tournaments/${tournament.id}`} className={`dgc dgc--sng`}>
      {/* Ambient glow */}
      <div className="dgc__glow" />

      {/* HU badge */}
      {isHU && <div className="dgc__hu-badge">HU</div>}
      {!isHU && (
        <div className="dgc__max-badge">{tournament.max_players <= 6 ? '6 Max' : '9 Max'}</div>
      )}

      {/* Variant logo */}
      <div className="dgc__variant-logo" style={{ paddingTop: '14px' }}>
        SNG
        <span className="dgc__variant-sub">{variant.label}</span>
      </div>

      {/* Buy-in */}
      <div className="dgc__blinds-section">
        <span className="dgc__blinds-label">Buy-in</span>
        <span className="dgc__blinds-value">
          {tournament.buy_in_amount + tournament.buy_in_fee}
        </span>
        <span className="dgc__timer">3min</span>
      </div>

      {/* Turbo badge */}
      {isTurbo && (
        <div className="dgc__badges">
          <span className="dgc__badge dgc__badge--straddle">⚡ TURBO</span>
        </div>
      )}

      {/* Players */}
      <div className="dgc__players">
        <span
          className={`dgc__players-dot ${tournament.current_players > 0 ? '' : 'dgc__players-dot--empty'}`}
        />
        {tournament.current_players}/{tournament.max_players}
      </div>

      {/* Union badge */}
      <div className="dgc__union-badge">U</div>

      {/* Bottom bar */}
      <div className="dgc__bottom">
        <span className="dgc__date">{formatDate(tournament.start_time)}</span>
        <span className="dgc__seat-info">
          {isHU
            ? 'HEADS-UP'
            : isTurbo
              ? `HeadsUp TURBO ${tournament.buy_in_amount + tournament.buy_in_fee}`
              : `${variant.label} ${tournament.max_players} Max`}
        </span>
      </div>
    </Link>
  );
}

// ─── Spin Card ─────────────────────────────────────────────────────────

export function SpinCard({ tournament }: TournamentCardProps) {
  const variantKey = TOURNEY_VARIANT_MAP[tournament.game_type] || 'nlh';
  const variant = VARIANT_DISPLAY[variantKey] || { label: 'NLH', css: 'nlh' };
  const maxMultiplier = 100; // Could be dynamic

  return (
    <Link to={`/tournaments/${tournament.id}`} className={`dgc dgc--spin`}>
      {/* Ambient glow */}
      <div className="dgc__glow" />

      {/* Max badge */}
      <div className="dgc__max-badge">3 Max</div>

      {/* Spin-It label */}
      <div className="dgc__variant-logo">
        Spin-It
        <span className="dgc__variant-sub">{variant.label}</span>
      </div>

      {/* Buy-in */}
      <div className="dgc__blinds-section">
        <span className="dgc__blinds-label">Buy-in</span>
        <span className="dgc__blinds-value">
          {tournament.buy_in_amount + tournament.buy_in_fee}
        </span>
        <span className="dgc__timer">3min</span>
      </div>

      {/* Win multiplier */}
      <div className="dgc__spin-multiplier">
        Win up to <strong>{maxMultiplier}</strong>
      </div>

      {/* Players */}
      <div className="dgc__players">
        <span
          className={`dgc__players-dot ${tournament.current_players > 0 ? '' : 'dgc__players-dot--empty'}`}
        />
        {tournament.current_players}/{tournament.max_players}
      </div>

      {/* Union badge */}
      <div className="dgc__union-badge">U</div>

      {/* Bottom bar */}
      <div className="dgc__bottom">
        <span className="dgc__date">{formatDate(tournament.start_time)}</span>
        <span className="dgc__seat-info">
          {variant.label} {tournament.name.includes('DEEP') ? 'DEEP' : ''}
          {tournament.name.match(/\(\d+\)/) || ''}
        </span>
      </div>
    </Link>
  );
}

// ─── Exports ───────────────────────────────────────────────────────────

export default {
  CashGameCard,
  TournamentCard,
  SNGCard,
  SpinCard,
};
