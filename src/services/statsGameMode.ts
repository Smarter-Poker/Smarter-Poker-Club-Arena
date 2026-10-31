/** Game mode is independent of poker variant, club and denomination. */
export type StatsGameMode = 'cash' | 'tournament';
export function statsGameMode(value: unknown): StatsGameMode {
  return value === 'tournament' ? 'tournament' : 'cash';
}
export function statsGameModeLabel(mode: StatsGameMode): string {
  return mode === 'tournament' ? 'Tournaments' : 'Cash Games';
}
