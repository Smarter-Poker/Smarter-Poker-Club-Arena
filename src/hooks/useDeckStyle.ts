/** Every card reads the same store as the table settings switch. */
import { useSyncExternalStore } from 'react';
import { getSnapshot, subscribeToStore, useTableSettingsAccountSync } from './useTableSettings';

export type DeckStyle = '4color' | '2color';

export function getDeckStyle(): DeckStyle {
  return getSnapshot().fourColorDeck ? '4color' : '2color';
}

export function useDeckStyle(): DeckStyle {
  useTableSettingsAccountSync();
  return useSyncExternalStore(subscribeToStore, getDeckStyle, () => '4color');
}

export default useDeckStyle;
