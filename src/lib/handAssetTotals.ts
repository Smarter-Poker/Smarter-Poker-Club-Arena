/** Monetary history totals are comparable only inside one arena asset. */
export type HistoryAsset = 'chips' | 'diamonds';
export function handAssetTotals(
  rows: Array<{ arenaAsset?: HistoryAsset; net: number; pot: number }>
): Array<{ asset: HistoryAsset | 'unclassified'; net: number; biggestPot: number }> {
  const totals = new Map<HistoryAsset | 'unclassified', { net: number; biggestPot: number }>();
  for (const row of rows) {
    // Missing metadata cannot prove denomination. Keep the hand visible,
    // but never combine its money with another unclassified hand.
    if (!row.arenaAsset) continue;
    const asset = row.arenaAsset;
    const previous = totals.get(asset) ?? { net: 0, biggestPot: 0 };
    previous.net = Math.round((previous.net + row.net) * 100) / 100;
    previous.biggestPot = Math.max(previous.biggestPot, row.pot);
    totals.set(asset, previous);
  }
  return [...totals].map(([asset, values]) => ({ asset, ...values }));
}
export function historyAssetLabel(asset: HistoryAsset | 'unclassified'): string {
  return asset === 'diamonds' ? 'Diamonds' : asset === 'chips' ? 'Chips' : 'Unclassified';
}
