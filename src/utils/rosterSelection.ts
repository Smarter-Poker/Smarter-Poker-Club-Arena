export const MAX_ROSTER_SELECTION = 5000;

/** Selection applies only to unique identities in the current loaded directory. */
export function loadedRosterSelection(
  selected: ReadonlySet<string>,
  loadedIds: readonly string[]
): Set<string> {
  const loaded = new Set(loadedIds);
  return new Set([...selected].filter((id) => loaded.has(id)).slice(0, MAX_ROSTER_SELECTION));
}

export function selectLoadedRoster(loadedIds: readonly string[]): Set<string> {
  return new Set([...new Set(loadedIds)].slice(0, MAX_ROSTER_SELECTION));
}

export function allLoadedSelected(
  selected: ReadonlySet<string>,
  loadedIds: readonly string[]
): boolean {
  const eligible = selectLoadedRoster(loadedIds);
  return (
    eligible.size > 0 &&
    selected.size === eligible.size &&
    [...eligible].every((id) => selected.has(id))
  );
}
