import type { LightningDecisionEntry } from './lightningDecisionQueue';

export type LightningShortcutModifier = 'shift' | 'alt_shift' | 'off';
export type LightningShortcutAction = 'fold' | 'watch' | 'nextUrgent' | 'previous' | 'focus';
const KEYS: Record<string, LightningShortcutAction> = {
  f: 'fold',
  v: 'watch',
  n: 'nextUrgent',
  p: 'previous',
  d: 'focus',
};

/** Safe modifier profiles; never take a browser, IME or held key. */
export function lightningShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'repeat' | 'isComposing'
  >,
  modifier: LightningShortcutModifier
): LightningShortcutAction | null {
  if (
    modifier === 'off' ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    !event.shiftKey ||
    event.altKey !== (modifier === 'alt_shift')
  )
    return null;
  return KEYS[event.key.toLowerCase()] ?? null;
}

/** Only mounted rooms with a still-owed server decision are eligible. No navigation here. */
export function lightningShortcutRoom(
  action: 'nextUrgent' | 'previous' | 'focus',
  rooms: readonly string[],
  current: string | null,
  decisions: readonly LightningDecisionEntry[],
  now: number
): string | null {
  if (!rooms.length) return null;
  if (action === 'previous') {
    const index = rooms.indexOf(current ?? '');
    return rooms[(index <= 0 ? rooms.length : index) - 1];
  }
  const owed = [...decisions]
    .filter((d) => d.deadlineAt > now && rooms.includes(d.poolSessionId))
    .sort((a, b) => a.deadlineAt - b.deadlineAt || a.poolSessionId.localeCompare(b.poolSessionId));
  const ids = [...new Set(owed.map((d) => d.poolSessionId))];
  if (action === 'focus') return ids.includes(current ?? '') ? current : (ids[0] ?? null);
  const index = ids.indexOf(current ?? '');
  return ids.length ? ids[(index + 1) % ids.length] : null;
}
