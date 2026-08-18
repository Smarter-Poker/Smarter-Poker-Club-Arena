/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DYNAMIC GAME CARD — Neon Poker-Table Lobby Cards
 * ═══════════════════════════════════════════════════════════════════════════════
 * Each card is a neon poker-table (color per category) with the club's custom
 * emblem art laid on the felt and the game's attributes composed into badges +
 * a live info block. Emblems live in /public/game-card-icons/ (background-removed
 * PNGs); the attribute→emblem map is VARIANT_DISPLAY / feature lists below. Cash
 * cards have no clock; tournaments show their start time + a live countdown. Same
 * exports/props as before (CashGameCard / TournamentCard / SNGCard / SpinCard).
 */

import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import './DynamicGameCard.css';
import './NeonCard.css';
import { reportError } from '../../utils/errorReporter';
import { MEDIA_BASE } from '../../utils/mediaBase';

// ─── Types ──────────────────────────────────────────────────────────────
interface TableSettings {
  insurance_enabled?: boolean;
  run_it_twice?: boolean;
  run_it_twice_mandatory?: boolean;
  straddle_enabled?: boolean;
  straddle_type?: string;
  bomb_pot_enabled?: boolean;
  bomb_pot_frequency?: number;
  bomb_pot_ante_bb?: number;
  vpip_display?: boolean;
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

// ─── Variant display + emblem/neon maps ──────────────────────────────────
const VARIANT_DISPLAY: Record<
  string,
  { label: string; sub?: string; artName: string; neon: string }
> = {
  nlh: { label: 'NLH', artName: 'nlh', neon: 'red' },
  plo4: { label: 'PLO', sub: '4', artName: 'plo4', neon: 'blue' },
  plo5: { label: 'PLO', sub: '5', artName: 'plo5', neon: 'blue' },
  plo6: { label: 'PLO', sub: '6', artName: 'plo6', neon: 'blue' },
  plo8: { label: 'PLO', sub: '8', artName: 'plo8', neon: 'blue' },
  pineapple: { label: 'PNPL', artName: 'pineapple', neon: 'purple' },
  short_deck: { label: '6+', sub: 'SD', artName: 'short-deck', neon: 'amber' },
};

const TOURNEY_VARIANT_MAP: Record<string, string> = {
  NLH: 'nlh',
  PLO4: 'plo4',
  PLO5: 'plo5',
  PLO6: 'plo6',
  PLO8: 'plo8',
  PINEAPPLE: 'pineapple',
  SHORT_DECK: 'short_deck',
  PLO: 'plo4',
};

// MUST resolve through MEDIA_BASE, not a root-absolute literal. This app is
// served under `base: '/hub/club-arena/'` (vite.config.ts), so
// '/game-card-icons/nlh.png' pointed at the SITE ROOT - where World Hub's
// public/game-card-icons/ is EMPTY - and every emblem 404'd. Verified live:
//   /game-card-icons/nlh.png                -> 404 text/html
//   /hub/club-arena/game-card-icons/nlh.png -> 200 image/png  (51 files there)
// The <img onError> handlers then hid each broken emblem, which is why the
// lobby cards rendered as empty dark tiles with no game-type art. mediaBase.ts
// already names game-card-icons/ as a directory that must go through this
// helper; this file was the one place that did not.
const ICON_BASE = `${MEDIA_BASE}game-card-icons/`;
const NEON_HEX: Record<string, string> = {
  red: '#ff2d43',
  blue: '#22a7ff',
  amber: '#ffb020',
  purple: '#b06bff',
  gold: '#f4c94b',
  green: '#39d17a',
};
const art = (name: string) => `${ICON_BASE}${name}.png`;

// ─── Helpers ─────────────────────────────────────────────────────────────
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
  const l = name.toLowerCase();
  if (l.includes('freeroll') || l.includes('free roll')) return 'freeroll';
  if (l.includes('mystery')) return 'mystery';
  if (l.includes('pko') || l.includes('progressive')) return 'pko';
  if (l.includes('bounty') || l.includes('ko ')) return 'ko';
  if (l.includes('satellite')) return 'satellite';
  if (l.includes('turbo')) return 'turbo';
  return 'freezeout';
}
const seatLabel = (max: number) => (max <= 2 ? 'HU' : max <= 6 ? '6 MAX' : '9 MAX');
const pad = (n: number) => String(n).padStart(2, '0');

// ─── Live countdown to a scheduled start ─────────────────────────────────
function Countdown({ startTime, live }: { startTime?: string; live?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  if (live) return <span className="ngc-cd ngc-cd--live">LIVE</span>;
  if (!startTime) return <span className="ngc-cd">⏳ when full</span>;
  const ms = new Date(startTime).getTime() - now;
  if (ms <= 0) return <span className="ngc-cd ngc-cd--live">LIVE NOW</span>;
  const s = Math.floor(ms / 1000);
  return (
    <span className="ngc-cd">
      ⏳ {pad(Math.floor(s / 3600))}:{pad(Math.floor((s % 3600) / 60))}:{pad(s % 60)}
    </span>
  );
}

// ─── Neon table shell ────────────────────────────────────────────────────
interface NeonCardProps {
  to: string;
  neon: string;
  emblem: string;
  bbj?: boolean;
  maxLabel?: string;
  children?: React.ReactNode;
  onDelete?: () => void;
}
function NeonCard({ to, neon, emblem, bbj, maxLabel, children, onDelete }: NeonCardProps) {
  return (
    <div className="ngc-wrap">
      <Link
        to={to}
        className="ngc"
        style={{ ['--neon' as string]: NEON_HEX[neon] || NEON_HEX.gold } as React.CSSProperties}
      >
        <div className="ngc-corner">
          {maxLabel && <span className="ngc-maxpill">{maxLabel}</span>}
          {bbj && <span className="ngc-bbj">BBJ</span>}
        </div>
        <div className="ngc-content">
          <div className="ngc-emblem">
            <img
              src={art(emblem)}
              alt=""
              loading="lazy"
              onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
            />
          </div>
          <div className="ngc-info">{children}</div>
        </div>
      </Link>
      {onDelete && (
        <button
          className="ngc-del"
          title="Delete table"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
const Badges = ({ names }: { names: string[] }) =>
  names.length ? (
    <div className="ngc-badges">
      {names.map((n, i) => (
        <img
          key={i}
          className="ngc-fic"
          src={art(n)}
          alt={n}
          title={n}
          loading="lazy"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      ))}
    </div>
  ) : null;

// ─── Cash Game Card ──────────────────────────────────────────────────────
interface CashCardProps {
  table: CashTableData;
  isAdmin?: boolean;
  onDelete?: (id: string) => void;
}

export function CashGameCard({ table, isAdmin, onDelete }: CashCardProps) {
  const v = VARIANT_DISPLAY[(table.game_variant || '').toLowerCase()] || VARIANT_DISPLAY.nlh;
  const s = parseSettings(table.settings);
  const n = table.name.toLowerCase();
  const feats: string[] = [];
  if (s.bomb_pot_enabled || s.bombPot || n.includes('bomb')) feats.push('bomb-pot');
  if (s.straddle_enabled || s.straddle || n.includes('straddle')) feats.push('straddle');
  if (s.run_it_twice || s.runItTwice || n.includes('rit')) feats.push('run-it-twice');
  if (s.insurance_enabled || s.allInInsurance || n.includes('insurance')) feats.push('insurance');
  if (s.vpip_display || s.vpipDisplay || n.includes('vpip')) feats.push('vpip-50');
  if (s.callTime || n.includes('call time')) feats.push('call-time');
  if (s.noRathole) feats.push('private-table');
  const seatPct = table.max_players
    ? Math.min(100, Math.round((table.current_players / table.max_players) * 100))
    : 0;
  const straddleSuffix =
    (s.straddle_enabled || s.straddle) && (s.straddle_type || s.straddleType)
      ? `/${String(s.straddle_type || s.straddleType || '')
          .substring(0, 3)
          .toUpperCase()}`
      : '';

  return (
    <NeonCard
      to={`/table/${table.id}`}
      neon={v.neon}
      emblem={v.artName}
      bbj
      onDelete={isAdmin && onDelete ? () => onDelete(table.id) : undefined}
    >
      <div className="ngc-head">
        <div className="ngc-lbl">Blinds</div>
        <div className="ngc-val">
          {table.small_blind} / {table.big_blind}
          {straddleSuffix}
        </div>
      </div>
      <div className="ngc-row">
        <span className="ngc-players">
          👤 {table.current_players}/{table.max_players}
        </span>
      </div>
      <div className="ngc-seats">
        <i style={{ width: `${seatPct}%` }} />
      </div>
      <Badges names={feats} />
      <div className="ngc-bottom">
        <span className="ngc-name">
          {table.min_buy_in || table.big_blind * 20}↓ {table.max_buy_in || table.big_blind * 100}↑ ·{' '}
          {seatLabel(table.max_players)}
        </span>
        <span className="ngc-date">{formatDate(new Date().toISOString())}</span>
      </div>
    </NeonCard>
  );
}

// ─── Tournament Card (MTT / XMTT) ────────────────────────────────────────
interface TournamentCardProps {
  tournament: TournamentData;
}

function tourneyFeatures(t: TournamentData): string[] {
  const type = detectTourneyType(t.name);
  const l = t.name.toLowerCase();
  const f: string[] = [];
  if (type === 'pko') f.push('pko');
  else if (type === 'mystery') f.push('mystery-bounty');
  else if (type === 'ko') f.push('bounty');
  else if (type === 'satellite') f.push('satellite');
  if (l.includes('re-entry') || l.includes('reentry')) f.push('re-entry');
  if (l.includes('rebuy')) f.push('add-on');
  if (l.includes('deep')) f.push('deep-stack');
  if (l.includes('turbo')) f.push('turbo');
  if (t.guaranteed_prize && t.guaranteed_prize > 0) f.push('guaranteed');
  return f.slice(0, 4);
}

export function TournamentCard({ tournament }: TournamentCardProps) {
  const vKey = TOURNEY_VARIANT_MAP[tournament.game_type] || 'nlh';
  const v = VARIANT_DISPLAY[vKey] || VARIANT_DISPLAY.nlh;
  const isXMTT =
    (tournament as unknown as { is_xmtt?: boolean }).is_xmtt || tournament.max_players >= 40;
  const emblem = isXMTT ? 'xmtt' : 'mtt';
  const label = `${isXMTT ? 'XMTT' : 'MTT'} · ${v.label}${v.sub || ''}`;
  const isFree = tournament.buy_in_amount === 0;
  const isLive = tournament.status === 'running' || tournament.status === 'RUNNING';
  const buyin = isFree ? 'FREE' : `${tournament.buy_in_amount + tournament.buy_in_fee}`;

  return (
    <NeonCard
      to={`/tournaments/${tournament.id}`}
      neon="gold"
      emblem={emblem}
      maxLabel={seatLabel(tournament.max_players)}
    >
      <div className="ngc-head">
        <div className="ngc-lbl">{label}</div>
        <div className="ngc-val">Buy In {buyin}</div>
      </div>
      <div className="ngc-row">
        {tournament.guaranteed_prize ? (
          <span>GTD {tournament.guaranteed_prize.toLocaleString()}</span>
        ) : null}
        <span className="ngc-players">👤 {tournament.current_players}</span>
      </div>
      <Badges names={tourneyFeatures(tournament)} />
      <div className="ngc-bottom">
        <span className="ngc-name">{tournament.name}</span>
        <span className="ngc-ttime">
          <span>🗓 {formatDate(tournament.start_time)}</span>
          <Countdown startTime={tournament.start_time} live={isLive} />
        </span>
      </div>
    </NeonCard>
  );
}

// ─── SNG Card ─────────────────────────────────────────────────────────────
export function SNGCard({ tournament }: TournamentCardProps) {
  const vKey = TOURNEY_VARIANT_MAP[tournament.game_type] || 'nlh';
  const v = VARIANT_DISPLAY[vKey] || VARIANT_DISPLAY.nlh;
  const isLive = tournament.status === 'running' || tournament.status === 'RUNNING';
  const feats: string[] = [];
  if (tournament.name.toLowerCase().includes('turbo')) feats.push('turbo');
  feats.push('freezeout');

  return (
    <NeonCard
      to={`/tournaments/${tournament.id}`}
      neon="gold"
      emblem="sng"
      maxLabel={seatLabel(tournament.max_players)}
    >
      <div className="ngc-head">
        <div className="ngc-lbl">
          Sit &amp; Go · {v.label}
          {v.sub || ''}
        </div>
        <div className="ngc-val">Buy In {tournament.buy_in_amount + tournament.buy_in_fee}</div>
      </div>
      <div className="ngc-row">
        <span className="ngc-players">
          👤 {tournament.current_players}/{tournament.max_players}
        </span>
      </div>
      <Badges names={feats} />
      <div className="ngc-bottom">
        <span className="ngc-name">{tournament.name}</span>
        <span className="ngc-ttime">
          <span>🗓 {tournament.start_time ? formatDate(tournament.start_time) : 'when full'}</span>
          <Countdown startTime={tournament.start_time} live={isLive} />
        </span>
      </div>
    </NeonCard>
  );
}

// ─── Spin Card ─────────────────────────────────────────────────────────────
export function SpinCard({ tournament }: TournamentCardProps) {
  const vKey = TOURNEY_VARIANT_MAP[tournament.game_type] || 'nlh';
  const v = VARIANT_DISPLAY[vKey] || VARIANT_DISPLAY.nlh;
  const mult = (tournament as unknown as { spin_multiplier?: number }).spin_multiplier || 100;

  return (
    <NeonCard
      to={`/tournaments/${tournament.id}`}
      neon="green"
      emblem="spin"
      maxLabel={`${tournament.max_players || 3} MAX`}
    >
      <div className="ngc-head">
        <div className="ngc-lbl">
          Spin-It · {v.label}
          {v.sub || ''}
        </div>
        <div className="ngc-val">Buy In {tournament.buy_in_amount + tournament.buy_in_fee}</div>
      </div>
      <div className="ngc-row">
        <span className="ngc-win">Win up to {mult}</span>
        <span className="ngc-players">
          👤 {tournament.current_players}/{tournament.max_players}
        </span>
      </div>
      <Badges names={['winner-takes-all']} />
      <div className="ngc-bottom">
        <span className="ngc-name">{tournament.name}</span>
        <span className="ngc-date">{formatDate(tournament.start_time)}</span>
      </div>
    </NeonCard>
  );
}

export default { CashGameCard, TournamentCard, SNGCard, SpinCard };
