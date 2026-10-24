/** Competition ranks: equal settled stacks share a rank (1, 1, 3).
 * Callers supply only active entries; recorded finishing places stay separate.
 */
export function tournamentChipRanks(rows: readonly { user_id: string; chips?: number | null }[]) {
  const ordered = [...rows].sort((a, b) => Number(b.chips ?? 0) - Number(a.chips ?? 0));
  const ranks = new Map<string, number>();
  let rank = 0;
  let previous: number | undefined;
  ordered.forEach((row, index) => {
    const chips = Number(row.chips ?? 0);
    if (previous === undefined || chips !== previous) rank = index + 1;
    ranks.set(row.user_id, rank);
    previous = chips;
  });
  return ranks;
}
