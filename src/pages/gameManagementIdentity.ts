export interface ManagedGameIdentity {
  kind: 'table' | 'tournament';
  id: string;
}

export const managedGameKey = (game: ManagedGameIdentity): string => `${game.kind}:${game.id}`;

/**
 * Claims one logical game synchronously. The mutable set is deliberately the
 * authority for the click-sized window before React can paint disabled state.
 */
export function claimManagedGameWork(inFlight: Set<string>, game: ManagedGameIdentity): boolean {
  const key = managedGameKey(game);
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function releaseManagedGameWork(inFlight: Set<string>, game: ManagedGameIdentity): void {
  inFlight.delete(managedGameKey(game));
}
