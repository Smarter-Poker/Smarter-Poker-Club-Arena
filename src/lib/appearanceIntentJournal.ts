import type { AppearancePatch } from './applyTableAppearance';
export type AppearanceIntent = { mutationId: string; gameType: string; patch: AppearancePatch };
const key = (userId: string) => `ca_appearance_intents:${userId}`;
export function pendingAppearanceIntents(userId: string): AppearanceIntent[] {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) ?? '[]');
    if (!Array.isArray(value)) return [];
    const fields = ['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id', 'faceDeckId'];
    return value.flatMap((entry) => {
      if (
        !entry ||
        typeof entry.mutationId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(entry.mutationId) ||
        typeof entry.gameType !== 'string' ||
        !['ALL', 'NLH', '6+', 'PLO', 'PINEAPPLE', 'MTT', 'SNG'].includes(entry.gameType) ||
        !entry.patch ||
        typeof entry.patch !== 'object' ||
        Array.isArray(entry.patch)
      )
        return [];
      const patch = Object.fromEntries(
        Object.entries(entry.patch).filter(
          ([field, selected]) =>
            fields.includes(field) &&
            typeof selected === 'string' &&
            selected.length > 0 &&
            selected.length <= 256
        )
      );
      return Object.keys(patch).length
        ? [{ mutationId: entry.mutationId, gameType: entry.gameType, patch }]
        : [];
    });
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
