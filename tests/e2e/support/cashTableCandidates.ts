export const CASH_TABLE_CARD_SELECTOR =
  '.club-home__games :is([data-testid="arena-lobby-game-card"], [data-testid="lobby-game-row"])' +
  '[data-kind="cash"][data-live="true"]:is([data-target="table"], [data-target="game"])';

export const CASH_SPECTATOR_ACTION = /^(?:View|Watch) (?:Table|Game)$/i;

/** This callback is serialized into the page, so its dependencies are arguments. */
export function collectVisibleCashCandidates(cards: Element[], actionPattern: string) {
  const spectatorAction = new RegExp(actionPattern, 'i');
  return cards
    .filter(
      (card) =>
        card.getAttribute('data-kind') === 'cash' &&
        card.getAttribute('data-live') === 'true' &&
        ['game', 'table'].includes(card.getAttribute('data-target') || '')
    )
    .map((card) => {
      const id = card.getAttribute('data-id') || '';
      const name =
        card.querySelector('.arena-game-card')?.getAttribute('aria-label')?.split(',')[0]?.trim() ||
        card.querySelector('.compact-lobby__title')?.textContent?.trim() ||
        id;
      const players = Number(card.getAttribute('data-players'));
      const view = [...card.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) =>
          spectatorAction.test(
            button.getAttribute('aria-label') || button.textContent?.trim() || ''
          ) || button.classList.contains('compact-lobby__open')
      );
      const style = view ? getComputedStyle(view) : null;
      const viewIsVisible =
        !!view &&
        !view.disabled &&
        style?.display !== 'none' &&
        style?.visibility !== 'hidden' &&
        view.getBoundingClientRect().width > 0 &&
        view.getBoundingClientRect().height > 0;
      return { id, name, players, viewIsVisible };
    })
    .filter((card) => /^[0-9a-f-]{8,}$/i.test(card.id) && card.players >= 2 && card.viewIsVisible)
    .sort((a, b) => b.players - a.players)
    .map(({ id, name, players }) => ({ id, name, players }));
}

/** A classic diagnostic needs an exact, positively identified ordinary-mode catalogue row. */
export function selectClassicCashCandidate<T extends { id: string }>(
  candidates: readonly T[],
  catalogue: readonly unknown[]
): T | undefined {
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const rows = new Map<string, Record<string, unknown>>();
  for (const value of catalogue) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string') continue;
    if (rows.has(row.id)) throw new Error('Duplicate cash catalogue identity');
    rows.set(row.id, row);
  }
  return candidates.find((candidate) => {
    const row = rows.get(candidate.id);
    const cluster = row?.cluster;
    return (
      uuid.test(candidate.id) &&
      typeof row?.cluster_id === 'string' &&
      uuid.test(row.cluster_id) &&
      cluster !== null &&
      typeof cluster === 'object' &&
      !Array.isArray(cluster) &&
      (cluster as Record<string, unknown>).cluster_mode === 'must_move'
    );
  });
}
