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

function familyOf(entry: LobbyEntry): ArenaGameFamily {
  if (entry.kind === 'mtt') return 'mtt';
  if (entry.kind === 'spin') return 'spin';
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
    buyIn: entry.buyInLabel || undefined,
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
    maxPayout: family === 'spin' ? spinPayoutLabel(entry) || undefined : undefined,
    topPrize: family === 'spin' ? spinPrizeLabel(entry) || undefined : undefined,
    blindLevels: tournament ? levelSpeedLabel(tournament) || undefined : undefined,
    format: tournament ? stackDepthLabel(entry) || entry.speedLabel || undefined : undefined,
    status: statusOf(entry),
    statusLabel: entry.statusLabel,
    featured: entry.featured,
    rules: entry.rules,
    source: entry,
  };
}
