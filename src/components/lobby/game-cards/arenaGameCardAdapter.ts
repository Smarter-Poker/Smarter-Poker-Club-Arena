import {
  levelSpeedLabel,
  spinPayoutLabel,
  spinPrizeLabel,
  stackDepthLabel,
  type LobbyEntry,
  type LobbyTournamentRow,
} from '../lobbyEntries';
import { tournamentBlinds, tournamentLevel } from '../tournamentFigures';
import type { ArenaGameCardData, ArenaGameFamily, ArenaGameStatus } from './arenaGameCardTypes';

function compactChipAmount(value: number): string {
  if (!Number.isFinite(value) || value < 1_000) return value.toLocaleString('en-US');
  const thousands = value / 1_000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1).replace(/\.0$/, '')}K`;
}

/**
 * Cash-card bays are intentionally narrow. Keep the full precision below 1K,
 * then use the poker-room convention above it (1K, 1.2K, 10K). The source
 * label remains untouched everywhere else in the lobby.
 */
export function compactCashBuyInLabel(label: string): string {
  return label.replace(/\d[\d,]*(?:\.\d+)?/g, (token) => {
    const value = Number(token.replace(/,/g, ''));
    return Number.isFinite(value) ? compactChipAmount(value) : token;
  });
}

function familyOf(entry: LobbyEntry): ArenaGameFamily {
  if (entry.kind === 'mtt') return 'mtt';
  if (entry.kind === 'spin') return 'spins';
  if (entry.kind === 'sng' && entry.capacity <= 2) return 'heads-up';
  return /^PLO|OMAHA/i.test(entry.gameLabel) ? 'plo' : 'nlh';
}

function statusOf(entry: LobbyEntry): ArenaGameStatus {
  const map: Record<LobbyEntry['status'], ArenaGameStatus> = {
    open: 'open',
    full: 'full',
    waitlist: 'waitlist',
    registering: entry.players > 0 ? 'filling' : 'registering',
    late_reg: 'late-reg',
    starting_soon: 'starting',
    running: 'running',
    completed: 'closed',
    closed: 'closed',
  };
  return map[entry.status];
}

function timeLabel(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function arenaGameCardDataFromEntry(entry: LobbyEntry): ArenaGameCardData {
  const family = familyOf(entry);
  const tournament = entry.kind === 'cash' ? null : (entry.raw as LobbyTournamentRow);
  const blinds = tournament ? tournamentBlinds(tournament) : null;
  const level = tournament ? tournamentLevel(tournament) : null;
  const startingStack = tournament ? Number(tournament.starting_chips) || 0 : 0;

  return {
    id: entry.id,
    family,
    title: entry.name,
    subtitle: entry.clubLabel || entry.variantLabel,
    gameType: entry.gameLabel,
    stakes: entry.stakesLabel || undefined,
    players: entry.capacity > 0 ? `${entry.players}/${entry.capacity}` : String(entry.players),
    buyIn:
      entry.kind === 'cash' && entry.buyInLabel
        ? compactCashBuyInLabel(entry.buyInLabel)
        : entry.buyInLabel || undefined,
    guarantee: entry.guaranteeLabel || undefined,
    registered:
      entry.kind === 'cash'
        ? undefined
        : entry.capacity > 0
          ? `${entry.players}/${entry.capacity}`
          : String(entry.players),
    startTime: timeLabel(entry.startTime),
    startingStack: startingStack > 0 ? startingStack.toLocaleString('en-US') : undefined,
    currentLevel: level ? String(level) : undefined,
    currentBlinds: blinds || undefined,
    waitlist: entry.status === 'waitlist' ? entry.statusLabel : undefined,
    maxPayout: family === 'spins' ? spinPayoutLabel(entry) || undefined : undefined,
    topPrize: family === 'spins' ? spinPrizeLabel(entry) || undefined : undefined,
    blindLevels: tournament ? levelSpeedLabel(tournament) || undefined : undefined,
    format: tournament ? stackDepthLabel(entry) || entry.speedLabel || undefined : undefined,
    status: statusOf(entry),
    statusLabel: entry.statusLabel,
    featured: entry.featured,
    rules: entry.rules,
    source: entry,
  };
}
