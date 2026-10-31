export interface PrivateRecordProfile {
  id: string;
  player_number: string;
  avatar_url: string | null;
  arena_avatar_url: string | null;
}

/** A raw alias is optional; the roster exposes the account's stable player number. */
export function ownPrivateRecordProfile(rows: unknown, userId: string): PrivateRecordProfile {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('Own profile identity missing');
  const profile = rows[0];
  if (
    !profile ||
    profile.id !== userId ||
    typeof profile.player_number !== 'string' ||
    !profile.player_number.trim()
  )
    throw Error('Own profile identity missing');
  return profile;
}
