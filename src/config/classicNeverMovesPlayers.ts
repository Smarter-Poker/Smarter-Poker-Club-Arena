/**
 * A CLASSIC GAME NEVER MOVES ITS PLAYERS (Dan 2026-10-24: "PLAYERS SHOULD NOT
 * BE MOVING ON CLASSIC GAMES PERIOD").
 *
 * The database owns the rule: public.fn_cash_game_never_moves_players
 * (20261024213758) decides it, the cluster tick and balancer obey it, and a
 * trigger on cash_seat_moves refuses every automatic move on such a game.
 * fn_cash_game_lobby says it outright as `game.never_moves_players`, and a
 * surface holding that answer uses it. This mirror is for the lobby board,
 * whose rows carry the game's template and rules profile but not that flag.
 * It is the same two lines as the SQL, so the board and the database cannot
 * disagree about which games never move anyone.
 */
export const MADNESS_WITHOUT_LIGHTNING_PROFILE = 'madness_without_lightning';

export function cashGameNeverMovesPlayers(
  template: string | null | undefined,
  rulesProfile: string | null | undefined
): boolean {
  return (
    String(template ?? '').toLowerCase() === 'classic' &&
    (rulesProfile ?? '') !== MADNESS_WITHOUT_LIGHTNING_PROFILE
  );
}
