import { useSyncExternalStore } from 'react';

// MultiTablePage owns the visible surface. A lobby/Hub tab can borrow a table
// URL, so the URL alone is insufficient authority for a table-local popup.
let visibleTableId: string | null = null;
const subscribers = new Set<() => void>();
export function setVisiblePokerTable(id: string | null) {
  if (id === visibleTableId) return;
  visibleTableId = id;
  subscribers.forEach((notify) => notify());
}
function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}
export function useVisiblePokerTable() {
  return useSyncExternalStore(
    subscribe,
    () => visibleTableId,
    () => null
  );
}
