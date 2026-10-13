import type { DiamondGame } from '../services/DiamondGamesService';
import { crashReturnPpmV5 } from './diamondGamesFairness';

/** Every Diamond game is built to pay back 80 percent of what it takes in, except Crash. */
export const DESIGNED_RETURN = 0.8;
/** Diamond Crash pays back each round's own return from contract 5, chosen for a
 * 2.9x average (Dan, 2026-10-12: "CRASH CAN GO NEGATIVE, IT CAN PAY OUT UP TO
 * 120%"; migration 20261012140447). The console prints the return of the round
 * nearly every award is played on, a standard one at half the stake: 1.006430.
 * A Super award with the add-on returns 1.137983, and none returns above 1.20. */
export const CRASH_DESIGNED_RETURN = crashReturnPpmV5(1, 0.5) / 1e6;

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
