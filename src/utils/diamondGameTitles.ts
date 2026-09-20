/** One name per game, and one rule for its Super form (Dan, 2026-09-19: an
 * upgraded game is "Super" plus the game title, nowhere "Upgraded"). Every
 * page title, prize card, replay title and award panel reads from here. */
export type DiamondBonusGame = 'plinko' | 'crash' | 'crossing' | 'mines';

export const DIAMOND_GAME_TITLES: Record<DiamondBonusGame, string> = {
  plinko: 'Diamond Plinko',
  crash: 'Diamond Crash',
  crossing: 'Donkey Cross',
  mines: 'Diamond Mines',
};

export const SUPER_GAME_TITLES: Record<DiamondBonusGame, string> = {
  plinko: 'Super Plinko',
  crash: 'Super Crash',
  crossing: 'Super Donkey Cross',
  mines: 'Super Diamond Mines',
};

/** The title a player sees for a game at a stake kind: boost 2 is the Super form. */
export function diamondGameTitle(game: DiamondBonusGame, boost: number = 1): string {
  return boost === 2 ? SUPER_GAME_TITLES[game] : DIAMOND_GAME_TITLES[game];
}
