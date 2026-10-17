/**
 * THE POKER ALIAS RULE, IN ONE PLACE.
 *
 * CompleteProfileModal (first run) and UserProfileEdit (the profile page)
 * both accept a handle. They used to carry their own copies of the rule and
 * could drift; the database only knows the unique index. Same limits, same
 * message, whichever door the player came through.
 */
import { sanitizeInput } from './sanitizeInput';

export const ALIAS_MIN = 3;
export const ALIAS_MAX = 16;
export const BIO_MAX = 100;

/** null when the alias is acceptable, otherwise the player-facing reason. */
export function aliasProblem(raw: string): string | null {
  const alias = sanitizeInput(raw).trim();
  if (alias.length < ALIAS_MIN) return `Alias must be at least ${ALIAS_MIN} characters.`;
  if (alias.length > ALIAS_MAX) return `Alias must be ${ALIAS_MAX} characters or fewer.`;
  if (!/^[a-zA-Z0-9_]+$/.test(alias)) return 'Only letters, numbers, and underscores allowed.';
  return null;
}

/**
 * A stored username the first-run form may offer back as the alias: a legal
 * alias that the player chose. A default (`Player...`) or a session stub
 * (`email.split('@')[0]`, which can carry a dot) is not offered.
 */
export function isOfferableAlias(username: string): boolean {
  return aliasProblem(username) === null && !username.startsWith('Player');
}

/**
 * ILIKE reads `%` and `_` as wildcards and `\` as their escape. An alias may
 * contain `_`, so an availability check matches it literally: "Tom_Tamale"
 * must not be reported Taken because "TomXTamale" exists.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
