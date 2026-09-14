/**
 * THE AVATAR A PLAYER SHOWS AT A POKER TABLE - engine mirror (2026-09-07)
 *
 * Byte-for-byte the same constants as `src/lib/tableAvatar.ts` on the
 * client. The engine cannot import client code, so the rule is mirrored and
 * `tests/the-felt-reads-one-avatar-column.law.test.ts` imports BOTH files and
 * fails the build if they ever disagree. Read the client file for the rule;
 * the short version:
 *
 *   profiles.arena_avatar_url   the Club Arena avatar. What every seat shows,
 *                               human or horse (CLAUDE.md 10.5).
 *   profiles.avatar_url         the social media photo. Never on a seat.
 *
 * `loadSeatedPlayers` in `./tables.ts` is the highest-leverage avatar read on
 * the platform - it feeds every seat at every table - and it reads through
 * `SEATED_PROFILE_SELECT` below.
 */

/** The `profiles` column a poker seat shows. The only one. */
export const TABLE_AVATAR_COLUMN = 'arena_avatar_url' as const;

/** PostgREST select fragment, aliased back to `avatar_url` for the roster types. */
export const TABLE_AVATAR_SELECT = `avatar_url:${TABLE_AVATAR_COLUMN}` as const;

/**
 * The full `profiles` projection behind a seat. Identity (name, avatar,
 * cosmetics) plus the flags the roster needs. One string, one place, so a
 * column cannot be added to the engine's idea of a seat without this file
 * saying so.
 */
export const SEATED_PROFILE_SELECT =
  `id, display_name, username, alias, first_name, last_name, full_name, is_horse, horse_profile, ${TABLE_AVATAR_SELECT}, use_real_name, equipped_frame, equipped_aura` as const;
