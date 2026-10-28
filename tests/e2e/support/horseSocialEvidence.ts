export interface HorseSocialFrame {
  at: number;
  sender: string;
  message: string;
  throwId?: string;
}

/** Retain only public social facts; never retain a websocket URL or auth frame. */
export function horseSocialFrames(value: unknown, at: number, depth = 0): HorseSocialFrame[] {
  if (!value || typeof value !== 'object' || depth > 6) return [];
  const row = value as Record<string, unknown>;
  const payload = row.payload as Record<string, unknown> | undefined;
  if (
    row.type === 'CHAT' &&
    typeof row.sender === 'string' &&
    typeof payload?.message === 'string'
  ) {
    return [
      {
        at,
        sender: row.sender,
        message: payload.message,
        ...(typeof payload.throwId === 'string' ? { throwId: payload.throwId } : {}),
      },
    ];
  }
  return Object.values(row).flatMap((child) => horseSocialFrames(child, at, depth + 1));
}

export function postHandChatDelay(endedAt: string, createdAt: string): number {
  const delay = Date.parse(createdAt) - Date.parse(endedAt);
  if (!Number.isFinite(delay)) throw new Error('Missing authoritative hand/chat timestamp');
  return delay;
}

export function sharedPayout(winners: unknown): boolean {
  if (!Array.isArray(winners)) throw new Error('Unreadable hand winners');
  if (winners.some((winner) => !winner || typeof winner.userId !== 'string' || !winner.userId)) {
    throw new Error('Unreadable payout recipient');
  }
  return new Set(winners.map((winner) => winner.userId)).size > 1;
}

/** Same table class that permits the cash chat UI and its horse input device. */
export function horseSocialTableEligible(
  table: {
    max_players: number;
    ban_chat: boolean | null;
    tournament_id: string | null;
    game_type: string;
  },
  asset: string | undefined
): boolean {
  return (
    asset === 'chips' &&
    table.max_players > 2 &&
    table.ban_chat !== true &&
    table.tournament_id === null &&
    table.game_type !== 'tournament'
  );
}

/** Prefer observed natural showdown opportunity, never a predicted/forced gesture. */
export function rankHorseSocialCohorts<T extends { candidate: { id: string }; horseCount: number }>(
  cohorts: readonly T[],
  showdowns: readonly { table_id: string; ended_at: string }[],
  since: string
): (T & { showdownCount: number })[] {
  const floor = Date.parse(since);
  return cohorts
    .map((entry) => ({
      ...entry,
      showdownCount: showdowns.filter(
        (row) => row.table_id === entry.candidate.id && Date.parse(row.ended_at) >= floor
      ).length,
    }))
    .sort((a, b) => b.showdownCount - a.showdownCount || b.horseCount - a.horseCount);
}
