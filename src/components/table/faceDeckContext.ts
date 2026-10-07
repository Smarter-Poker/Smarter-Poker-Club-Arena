/**
 * THE FACE DECK A CARD IS DRAWN WITH, CARRIED BY THE TABLE IT SITS ON (2026-10-07).
 *
 * A face deck (Broadcast Pro, Ivory Club, ...) is chosen per game type, so two
 * tables open side by side in MultiTablePage can wear two different decks while
 * the document root carries only the account-wide one. Until this date a felt
 * card carried no deck of its own: it relied on CSS inheritance from the
 * nearest `[data-face-deck]` ancestor, so the card element could not say which
 * deck it was drawn with, and a card rendered anywhere outside its table root
 * would silently take the account-wide finish instead of its table's.
 *
 * TablePage provides its own table's deck here, and CardImage stamps it on
 * every face it renders. The card is then an owner in its own right
 * (CardImage.css resets every material token at each owner), so what the
 * player sees and what the markup reports are the same thing on every card.
 *
 * An explicit `faceDeckId` prop still wins: the Table Studio preview shows one
 * card in each deck side by side, on purpose. `undefined` means no table said,
 * and the card then inherits exactly as it always did.
 */
import { createContext, useContext } from 'react';
import type { FaceDeckId } from '../../lib/faceDeck';

export const FaceDeckContext = createContext<FaceDeckId | undefined>(undefined);

export function useTableFaceDeck(): FaceDeckId | undefined {
  return useContext(FaceDeckContext);
}
