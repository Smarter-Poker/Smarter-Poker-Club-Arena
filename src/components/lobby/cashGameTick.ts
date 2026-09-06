/**
 * THE TICK FOR STAFF (Dan 2026-09-05). The cluster controller writes
 * `cash_games.last_tick_at` and `last_tick_actions` on every pass; a club's
 * staff read them as one monospace line on the game's lobby panel:
 *
 *     Tick 4s Ago: Moves Planned 2, Feeder Opened, Buyers 3
 *
 * `last_tick_actions` is a jsonb ARRAY of one-key (sometimes two-key) objects
 * the tick appends as it acts - `[{"moves_planned": 2}, {"feeder": "opened",
 * "buyers": 3}, {"closed": "<table uuid>"}]`. Keys are snake_case words, values
 * are counts, words, or table / player uuids. Everything here is pure so it
 * can be pinned; the read itself lives in GameLobbyPanel.
 */

export type TickActions = unknown;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function titleWords(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function valueWord(v: unknown): string {
  if (v === null || v === undefined || v === true) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (UUID.test(v)) return v.slice(0, 8);
    return titleWords(v);
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return '';
}

/** "Moves Planned 2, Feeder Opened, Buyers 3"; "Quiet" when the tick did nothing. */
export function tickActionsCopy(actions: TickActions): string {
  const items: unknown[] = Array.isArray(actions)
    ? actions
    : actions && typeof actions === 'object'
      ? [actions]
      : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      const word = valueWord(v);
      parts.push(word ? `${titleWords(k)} ${word}` : titleWords(k));
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'Quiet';
}

/** "Tick 4s Ago" / "Tick 2m Ago" / "Tick 1h Ago"; "No Tick Yet" when never ticked. */
export function tickAgeCopy(lastTickAt: string | null | undefined, now: number): string {
  if (!lastTickAt) return 'No Tick Yet';
  const at = new Date(lastTickAt).getTime();
  if (!Number.isFinite(at)) return 'No Tick Yet';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `Tick ${s}s Ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Tick ${m}m Ago`;
  const h = Math.floor(m / 60);
  return `Tick ${h}h Ago`;
}

/** The whole line. */
export function staffTickLine(
  lastTickAt: string | null | undefined,
  actions: TickActions,
  now: number
): string {
  const age = tickAgeCopy(lastTickAt, now);
  return lastTickAt ? `${age}: ${tickActionsCopy(actions)}` : age;
}

/**
 * A tick older than this is a controller that has stopped - the tick runs
 * every 5s and a dormant game every 60s - so the line turns amber.
 */
export const TICK_STALE_MS = 120_000;

export function tickIsStale(lastTickAt: string | null | undefined, now: number): boolean {
  if (!lastTickAt) return true;
  const at = new Date(lastTickAt).getTime();
  return !Number.isFinite(at) || now - at > TICK_STALE_MS;
}
