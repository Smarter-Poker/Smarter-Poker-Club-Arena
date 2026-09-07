/**
 * THE AVATAR A PLAYER SHOWS AT A POKER TABLE (2026-09-07)
 *
 * One column, one rule, read identically by everything that draws a seat:
 *
 *   profiles.arena_avatar_url   the Club Arena avatar. Library bust art. This
 *                               is what the felt shows, for a human and for a
 *                               horse alike (CLAUDE.md 10.5).
 *   profiles.avatar_url         the SOCIAL MEDIA photo. Never shown on a seat,
 *                               never a fallback for one, never written by
 *                               this app (tests/unit/arenaAvatarSeparation).
 *
 * There is no precedence between them because there is no choice: a seat
 * reads `arena_avatar_url` and nothing else. A player with no arena avatar
 * gets the deterministic monogram from `getAvatarWithFallback`, not their
 * photograph.
 *
 * WHO READS THROUGH HERE
 *   - the engine roster load, `server/src/services/supabase/tables.ts`, via
 *     the byte-identical mirror `server/src/services/supabase/tableAvatar.ts`
 *     (the engine cannot import client code, so the constant is mirrored and
 *     `tests/the-felt-reads-one-avatar-column.law.test.ts` proves the two
 *     copies agree);
 *   - the client's live profile sync, `src/hooks/useSeatedProfileSync.ts`,
 *     which receives RAW column names from replication and must therefore
 *     name the column itself;
 *   - every PostgREST read that feeds a seat, through `TABLE_AVATAR_SELECT`,
 *     which aliases the column back to `avatar_url` so the downstream types
 *     and components stay untouched.
 *
 * Dan 2026-09-07: "WHEN A USER CHANGES THEIR AVATAR, IT BOUNCES BACK AND
 * FORTH FROM THEIR OLD AVATAR TO THE NEW ONE. IT NEEDS TO CHANGE AND STAY
 * ACROSS ALL GAMES AND TABLES REGARDLESS OF DEVICE AS WELL." The bounce was
 * not two columns disagreeing (both readers already named this one). It was
 * two READERS OF THE SAME COLUMN sampling it at different times - see
 * `src/lib/seatIdentityOverrides.ts`. This file exists so that the column
 * half of the story can never regress into a second cause.
 */

/** The `profiles` column a poker seat shows. The only one. */
export const TABLE_AVATAR_COLUMN = 'arena_avatar_url' as const;

/**
 * PostgREST select fragment: the table avatar, aliased back to `avatar_url`
 * so every consumer keeps reading `row.avatar_url` while the SOURCE is the
 * arena column. A select alias is a PostgREST feature; realtime payloads do
 * not carry it, which is why `tableAvatarFromProfileRow` exists.
 */
export const TABLE_AVATAR_SELECT = `avatar_url:${TABLE_AVATAR_COLUMN}` as const;

/**
 * The table avatar out of a RAW `profiles` row (realtime payload, or an
 * unaliased select). Reads `arena_avatar_url` only; `avatar_url` on the same
 * row is the photograph and is ignored on purpose. Empty and non-string
 * values collapse to `undefined`, meaning "this row did not say".
 */
export function tableAvatarFromProfileRow(
  row: Record<string, unknown> | null | undefined
): string | undefined {
  if (!row) return undefined;
  const raw = row[TABLE_AVATAR_COLUMN];
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}
