export const CASH_TABLE_CARD_SELECTOR =
  '.club-home__games [data-testid="arena-lobby-game-card"]' +
  '[data-kind="cash"][data-live="true"]:is([data-target="table"], [data-target="game"])';

export const CASH_SPECTATOR_ACTION = /^(?:View|Watch) (?:Table|Game)$/i;

/** This callback is serialized into the page, so its dependencies are arguments. */
export function collectVisibleCashCandidates(cards: Element[], actionPattern: string) {
  const spectatorAction = new RegExp(actionPattern, 'i');
  return cards
    .map((card) => {
      const id = card.getAttribute('data-id') || '';
      const name =
        card.querySelector('.arena-game-card')?.getAttribute('aria-label')?.split(',')[0]?.trim() ||
        id;
      const players = Number(card.getAttribute('data-players'));
      const view = [...card.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        spectatorAction.test(button.getAttribute('aria-label') || button.textContent?.trim() || '')
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
