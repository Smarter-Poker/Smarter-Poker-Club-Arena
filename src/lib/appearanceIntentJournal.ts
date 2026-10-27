import type { AppearancePatch } from './applyTableAppearance';
export type AppearanceIntent = { mutationId: string; gameType: string; patch: AppearancePatch };
const key = (userId: string) => `ca_appearance_intents:${userId}`;
export function pendingAppearanceIntents(userId: string): AppearanceIntent[] {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) ?? '[]');
    return Array.isArray(value)
      ? value.filter(
          (entry) =>
            entry &&
            typeof entry.mutationId === 'string' &&
            typeof entry.gameType === 'string' &&
            entry.patch &&
            typeof entry.patch === 'object' &&
            !Array.isArray(entry.patch)
        )
      : [];
  } catch {
    return [];
  }
}
export function rememberAppearanceIntent(userId: string, intent: AppearanceIntent): void {
  try {
    localStorage.setItem(
      key(userId),
      JSON.stringify([...pendingAppearanceIntents(userId), intent])
    );
  } catch {
    /* Live state survives unavailable storage. */
  }
}
export function finishAppearanceIntent(userId: string, mutationId: string): void {
  try {
    const remaining = pendingAppearanceIntents(userId).filter(
      (entry) => entry.mutationId !== mutationId
    );
    if (remaining.length) localStorage.setItem(key(userId), JSON.stringify(remaining));
    else localStorage.removeItem(key(userId));
  } catch {
    /* A confirmed id can be replayed safely by the idempotent RPC. */
  }
}
export function pendingAppearancePatch(userId: string, gameType: string): AppearancePatch {
  return pendingAppearanceIntents(userId).reduce(
    (patch, entry) =>
      entry.gameType === 'ALL' || entry.gameType === gameType
        ? { ...patch, ...entry.patch }
        : patch,
    {}
  );
}
