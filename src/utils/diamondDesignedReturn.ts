import type { DiamondGame } from '../services/DiamondGamesService';

/** Every Diamond game is built to pay back 80 percent of what it takes in, except Crash. */
export const DESIGNED_RETURN = 0.8;
/** Diamond Crash pays back 95 percent at every cash-out target from contract 5
 * (Dan, 2026-10-12: "CRASH CAN BE A 5% HOUSE EDGE GAME"; migration 20261012052305). */
export const CRASH_DESIGNED_RETURN = 0.95;

/**
 * What the game is built to return: the live Plinko table's own figure when
 * there is one, the house spec otherwise. Realised return only means something
 * next to it, so the console prints the two side by side.
 */
export function designedReturn(
  game: DiamondGame,
  tables: ReadonlyArray<{ spec_rtp: number | null; activated_at: string | null }> | undefined
): number {
  if (game === 'crash') return CRASH_DESIGNED_RETURN;
  if (game === 'plinko') {
    // The table activated last is the one the board is dropping on now.
    let live: { spec_rtp: number | null; activated_at: string | null } | null = null;
    for (const t of tables ?? []) {
      if (!t.activated_at || t.spec_rtp === null) continue;
      if (!live || (live.activated_at ?? '') < t.activated_at) live = t;
    }
    if (live?.spec_rtp != null) return live.spec_rtp;
  }
  return DESIGNED_RETURN;
}
