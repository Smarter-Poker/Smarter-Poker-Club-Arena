import { titleCase } from './titleCase';

/**
 * Usernames are displayed as names but remain identifiers in storage and exports.
 * Title-case each underscore-delimited segment without changing the separator.
 */
export function leaderboardDisplayName(username: string | null | undefined): string {
  if (!username) return '';

  return username
    .split(/(_+)/)
    .map((part) => (/^_+$/.test(part) ? part : titleCase(part)))
    .join('');
}
