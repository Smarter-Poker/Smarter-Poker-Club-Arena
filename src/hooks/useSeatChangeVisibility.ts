import { useCallback, useSyncExternalStore } from 'react';
import { useUserStore } from '../stores/useUserStore';

const listeners = new Set<() => void>();
const memory = new Map<string, boolean>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key) memory.delete(event.key);
    else memory.clear();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};

/** One account preference shared by the hamburger and every mounted table. */
export function useSeatChangeVisibility() {
  const userId = useUserStore((state) => state.user?.id ?? 'guest');
  const key = `smarter-poker:seat-change-visible:v1:${userId}`;
  const read = useCallback(() => {
    if (memory.has(key)) return memory.get(key)!;
    try {
      return localStorage.getItem(key) !== 'false';
    } catch {
      return memory.get(key) ?? true;
    }
  }, [key]);
  const visible = useSyncExternalStore(subscribe, read, () => true);
  const setVisible = useCallback(
    (next: boolean) => {
      memory.set(key, next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // The in-session preference still works when storage is unavailable.
      }
      notify();
    },
    [key]
  );
  return { visible, setVisible };
}
