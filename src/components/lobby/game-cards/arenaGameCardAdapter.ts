import { compactChips } from '../../../utils/format';
import {
  cashTemplateLabel,
  cashTitleLines,
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
  /* One rule for every printed chip figure outside the felt (utils/format). */
  return compactChips(value);
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

/* "Pineapple 1", "Short Deck #2": the lobby's auto-numbering suffix. Dan
   2026-09-03: "PINEAPPLE 1 SHOULD JUST BE CALLED PINEAPPLE." Only a short
   standalone index after a space, dash or hash is stripped - "NLH 25/50" ends
   in a stake, not an index, and is left alone. */
const TRAILING_INDEX = /(?:\s+|\s*[-\u2013\u2014#]\s*)#?\d{1,2}\s*$/;

function stripTableIndex(name: string): string {
  const stripped = name.replace(TRAILING_INDEX, '').trim();
  return /[A-Za-z]/.test(stripped) ? stripped : name.trim();
}

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether the variant name would only repeat the title. "Short Deck" under
 * "Short Deck", "Crazy Pineapple" under "Pineapple": the second line says
 * nothing the first did not (Dan 2026-09-03, "remove the duplicate"). "No
 * Limit Hold'em" under "NLH Straddle" is kept - the title never spells it out.
 */
function repeatsTitle(title: string, variantLabel: string): boolean {
  const titleWords = normalizedWords(title);
  const variantWords = normalizedWords(variantLabel);
  if (!titleWords.length || !variantWords.length) return false;
  const titleSet = new Set(titleWords);
  const variantSet = new Set(variantWords);
  return (
    variantWords.every((word) => titleSet.has(word)) ||
    titleWords.every((word) => variantSet.has(word))
  );
}

export function cashCardTitle(entry: LobbyEntry): { title: string; subtitle?: string } {
  const family = familyOf(entry);
  const tableName = stripTableIndex(entry.name || '');

  if (family === 'plo') {
    /* Dan 2026-09-03: "Make sure the Variant Name is first, Like PLO5 25/50
       and then the table name under it." */
    const title = [entry.gameLabel, entry.stakesLabel].filter(Boolean).join(' ').trim();
    const residual = stripTableIndex(cashTitleLines(entry).subtitle || '');
    const subtitle =
      residual ||
      entry.clubLabel ||
      (repeatsTitle(title, entry.variantLabel) ? undefined : entry.variantLabel);
    return { title: title || tableName, subtitle: subtitle || undefined };
  }

  const title = tableName || entry.gameLabel;
  /* THE MOBILE CARD SAYS THE STYLE TOO (Dan 2026-09-05). The desktop board
     has said Classic / Action / Madness on line two since 2026-09-04; the
     phone card said the club or the long variant name. A templated game now
     leads its second line with the style - unless the title already carries
     the word (the default game name is "NLH 1/2 Classic"), in which case the
     line is left as Dan approved it for phones. The club name, when the board
     shows one, rides after the style; the variant gives way to it, as it does
     on the desktop. The stakes and the player count are separate zones of the
     card and are never touched by this line. */
  const style = cashTemplateLabel(entry.game?.template);
  const titleSaysStyle = style ? normalizedWords(title).includes(style.toLowerCase()) : false;
  if (style && !titleSaysStyle) {
    const subtitle = [style, entry.clubLabel].filter(Boolean).join(', ');
    return { title, subtitle };
  }
  const subtitle =
    entry.clubLabel || (repeatsTitle(title, entry.variantLabel) ? undefined : entry.variantLabel);
  return { title, subtitle: subtitle || undefined };
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

  const heading =
    entry.kind === 'cash'
      ? cashCardTitle(entry)
      : { title: entry.name, subtitle: entry.clubLabel || entry.variantLabel };

  return {
    id: entry.id,
    family,
    title: heading.title,
    subtitle: heading.subtitle,
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
