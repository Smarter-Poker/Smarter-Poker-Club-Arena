import type { HandRecord } from '../services/HandHistoryService';

export interface StatsHandDrilldown {
  variant?: string;
  position?: string;
  bigBlind?: number;
  from?: string;
  to?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function readStatsDrilldown(params: URLSearchParams): StatsHandDrilldown {
  const variant = params.get('variant')?.trim().toLowerCase();
  const position = params.get('position')?.trim().toUpperCase();
  const bigBlindRaw = Number(params.get('bigBlind'));
  const fromRaw = params.get('from') || '';
  const toRaw = params.get('to') || '';
  return {
    ...(variant ? { variant } : {}),
    ...(position ? { position } : {}),
    ...(Number.isFinite(bigBlindRaw) && bigBlindRaw > 0 ? { bigBlind: bigBlindRaw } : {}),
    ...(DATE_ONLY.test(fromRaw) ? { from: fromRaw } : {}),
    ...(DATE_ONLY.test(toRaw) ? { to: toRaw } : {}),
  };
}

function canonicalVariant(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact === 'holdem' || compact === 'texasholdem' || compact === 'nlh') return 'nlh';
  if (compact === 'omaha' || compact === 'plo' || compact === 'plo4') return 'plo4';
  return compact;
}

function handBigBlind(stakes: string): number | null {
  const numbers =
    stakes
      .match(/\d+(?:\.\d+)?/g)
      ?.map(Number)
      .filter(Number.isFinite) ?? [];
  return numbers.length > 0 ? numbers[numbers.length - 1] : null;
}

export function filterHandsByStatsDrilldown(
  hands: HandRecord[],
  drilldown: StatsHandDrilldown,
  userId: string
): HandRecord[] {
  const from = drilldown.from ? Date.parse(`${drilldown.from}T00:00:00Z`) : null;
  const to = drilldown.to ? Date.parse(`${drilldown.to}T23:59:59.999Z`) : null;
  return hands.filter((hand) => {
    if (
      drilldown.variant &&
      canonicalVariant(hand.game_type) !== canonicalVariant(drilldown.variant)
    )
      return false;
    if (drilldown.bigBlind) {
      const bb = handBigBlind(hand.stakes);
      if (bb === null || Math.abs(bb - drilldown.bigBlind) > 0.000001) return false;
    }
    if (
      drilldown.position &&
      !hand.players.some(
        (player) => player.user_id === userId && player.position === drilldown.position
      )
    )
      return false;
    const playedAt = Date.parse(hand.played_at);
    if (from !== null && (!Number.isFinite(playedAt) || playedAt < from)) return false;
    if (to !== null && (!Number.isFinite(playedAt) || playedAt > to)) return false;
    return true;
  });
}
