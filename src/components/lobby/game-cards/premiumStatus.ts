import type { ArenaGameCardData, ArenaGameStatus } from './arenaGameCardTypes';

export type PremiumStatusTone = 'blue' | 'green' | 'red' | 'gold' | 'neutral';

export interface PremiumStatusBadge {
  label: string;
  tone: PremiumStatusTone;
}

const TONE: Record<ArenaGameStatus, PremiumStatusTone> = {
  open: 'green',
  running: 'blue',
  filling: 'blue',
  registering: 'blue',
  starting: 'gold',
  'late-reg': 'gold',
  waitlist: 'gold',
  full: 'red',
  closed: 'neutral',
  paused: 'neutral',
};

/**
 * What the status pill on a layered card says, and in which colour.
 *
 * Dan 2026-09-03: the pill "should have the Running - Empty - Full badge added
 * to it". The lobby's own word for a cash table with nobody seated is "Open",
 * which on a card sitting next to "Running" reads as a door rather than a
 * count; "Empty" is what a player means by it. Every other status keeps the
 * lobby label so a waitlist keeps its number ("Waitlist 2") and a paused
 * table says Paused.
 */
export function premiumStatusBadge(
  data: Pick<ArenaGameCardData, 'status' | 'statusLabel' | 'statusTone'>
) {
  if (data.statusTone) {
    return { label: data.statusLabel, tone: data.statusTone } satisfies PremiumStatusBadge;
  }
  const label =
    data.status === 'open'
      ? 'Empty'
      : data.status === 'running'
        ? 'Running'
        : data.status === 'full'
          ? 'Full'
          : data.statusLabel || data.status.replace('-', ' ');
  return { label, tone: TONE[data.status] || 'neutral' } satisfies PremiumStatusBadge;
}
