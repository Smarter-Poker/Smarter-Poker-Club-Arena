import type { DiamondGame } from '../services/DiamondGamesService';

/** Every Diamond game is built to pay back 80 percent of what it takes in. */
export const DESIGNED_RETURN = 0.8;

/**
 * What the game is built to return: the live Plinko table's own figure when
 * there is one, the house spec otherwise. Realised return only means something
 * next to it, so the console prints the two side by side.
 */
export function designedReturn(
  game: DiamondGame,
  tables: ReadonlyArray<{ spec_rtp: number | null; activated_at: string | null }> | undefined
): number {
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
