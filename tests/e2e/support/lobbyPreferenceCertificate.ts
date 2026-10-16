/** A cold return opens two documents. Each keeps its existing readiness
 * limits; preference writes get their own bounded response deadline. */
export const LOBBY_SAVE_TIMEOUT_MS = 30_000;
export const LOBBY_COLD_RETURN_TIMEOUT_MS = 2 * 120_000 + 2 * LOBBY_SAVE_TIMEOUT_MS;

const tabKeys: Record<string, string> = {
  ALL: 'ALL',
  MTT: 'MTT',
  NLH: 'HOLDEM',
  PLO: 'OMAHA',
  LIMIT: 'LIMIT',
  SPINS: 'SPIN',
  'HEADS UP': 'SNG',
};

export function isLobbyPreferenceSave(
  payload: unknown,
  owner: string,
  club: string,
  label: string
): boolean {
  const row = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
  if (!row || typeof row !== 'object' || !tabKeys[label]) return false;
  const value = row as { user_id?: unknown; club_id?: unknown; view_prefs?: { tab?: unknown } };
  return (
    value.user_id === owner && value.club_id === club && value.view_prefs?.tab === tabKeys[label]
  );
}

/** Restoration still runs and its failure still fails an otherwise successful
 * journey. It must never replace the original failure with a cleanup timeout. */
export async function withLobbyPreferenceRestoration(
  journey: () => Promise<void>,
  restore: () => Promise<void>
): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await journey();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await restore();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}
