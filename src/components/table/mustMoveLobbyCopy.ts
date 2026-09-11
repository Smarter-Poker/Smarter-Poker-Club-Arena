/**
 * THE LOBBY NEVER PRINTS A DATABASE ERROR (audit 2026-09-09, lane H).
 *
 * MustMoveLobbyModal used to put `String(err.message)` straight into its
 * `.mml-error` box, so a player whose tab still pointed at a game that had
 * since closed read "GAME_NOT_FOUND: 2f3a...-uuid" in the lobby, and a
 * PostgREST outage read as its raw JSON message. CashClusterHUD swallowed the
 * same error and kept its last figures, so a Seat Change button stayed lit for
 * a game that no longer existed. The code is the database's; the sentence is
 * ours, and the game-gone case is named so both surfaces can drop what they
 * hold for a game that is not there any more.
 *
 * Title Case, no em dash (the popup law in src/utils/popupStyle.ts). Shared by
 * the felt corner and the lobby so the two cannot describe one failure two
 * ways. Kept out of src/services/cashGameLobby.ts, which the read-side audit
 * lane owns.
 */

export const LOBBY_READ_REFUSALS: Record<string, string> = {
  GAME_NOT_FOUND: 'This Game Is No Longer Here.',
  NOT_AUTHENTICATED: 'Sign In To See The Lobby.',
  PLATFORM_FROZEN: 'The Platform Is On Its Maintenance Break.',
};

export const LOBBY_READ_FALLBACK = 'The Lobby Could Not Be Read. Trying Again.';

/** The door's code, the part before the colon: "GAME_NOT_FOUND: <uuid>" -> GAME_NOT_FOUND. */
export function lobbyReadErrorCode(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  return msg.split(':')[0]?.trim() ?? '';
}

/** The sentence the player reads for a lobby read that failed. */
export function lobbyReadErrorText(err: unknown): string {
  const code = lobbyReadErrorCode(err);
  return (code && LOBBY_READ_REFUSALS[code]) || LOBBY_READ_FALLBACK;
}

/** The game is gone: nothing read for it before is worth keeping on screen. */
export function isGameGone(err: unknown): boolean {
  return lobbyReadErrorCode(err) === 'GAME_NOT_FOUND';
}
