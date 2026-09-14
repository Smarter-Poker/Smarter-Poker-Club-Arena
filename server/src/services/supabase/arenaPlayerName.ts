/** Engine mirror of the arena branch of src/utils/playerDisplayName.ts.
 * The independent server build cannot import browser source. The shared
 * behavior matrix in tests/unit/arenaSeatNameParity.test.ts prevents drift.
 */
export interface ArenaNameProfile {
  alias?: string | null;
  username?: string | null;
  display_name?: string | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

const clean = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function arenaPlayerName(profile: ArenaNameProfile | null | undefined): string {
  if (!profile) return 'Player';
  const handle = clean(profile.alias) || clean(profile.username);
  if (handle) return handle;
  const legacy = clean(profile.display_name);
  const real =
    clean(profile.full_name) ||
    [clean(profile.first_name), clean(profile.last_name)].filter(Boolean).join(' ') ||
    null;
  return legacy && (!real || legacy.toLowerCase() !== real.toLowerCase()) ? legacy : 'Player';
}
