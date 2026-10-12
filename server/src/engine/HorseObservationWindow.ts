/** Original contributing-action timestamp envelope. This does not establish a
 * complete hand census, exact source membership, or calibrated model freshness. */
export interface HorseObservationWindow {
  readonly version: 1;
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly fromMs: number | null;
  readonly toMs: number | null;
}

const UNKNOWN: HorseObservationWindow = Object.freeze({
  version: 1,
  coverage: 'unknown',
  fromMs: null,
  toMs: null,
});
const positiveTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/** Missing legacy metadata and malformed bounds never acquire authority. */
export function normalizeHorseObservationWindow(value: unknown): HorseObservationWindow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return UNKNOWN;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 4 ||
    !['version', 'coverage', 'fromMs', 'toMs'].every((key) => Object.hasOwn(row, key)) ||
    row.version !== 1
  )
    return UNKNOWN;
  if (row.coverage === 'unknown') return UNKNOWN;
  if (
    !['complete', 'partial'].includes(String(row.coverage)) ||
    !positiveTime(row.fromMs) ||
    !positiveTime(row.toMs) ||
    row.fromMs > row.toMs
  )
    return UNKNOWN;
  return Object.freeze({
    version: 1,
    coverage: row.coverage as 'complete' | 'partial',
    fromMs: row.fromMs,
    toMs: row.toMs,
  });
}

/** Merge only windows of populations that contribute to the resulting row.
 * Known bounds survive an unknown contributor as a PARTIAL envelope. */
export function mergeHorseObservationWindows(
  ...values: readonly unknown[]
): HorseObservationWindow {
  const windows = values.map(normalizeHorseObservationWindow);
  const known = windows.filter((window) => window.coverage !== 'unknown');
  if (!known.length) return UNKNOWN;
  return Object.freeze({
    version: 1,
    coverage: windows.every((window) => window.coverage === 'complete') ? 'complete' : 'partial',
    fromMs: Math.min(...known.map((window) => window.fromMs!)),
    toMs: Math.max(...known.map((window) => window.toMs!)),
  });
}

/** Called only after a real counter contribution, never for a read or duplicate.
 * An empty row has no legacy contribution; a nonempty legacy row always does. */
export function observeHorseObservationWindow(
  previous: unknown,
  timestamp: unknown,
  hasPriorContributions: boolean
): HorseObservationWindow {
  const current = positiveTime(timestamp)
    ? { version: 1, coverage: 'complete', fromMs: timestamp, toMs: timestamp }
    : UNKNOWN;
  return hasPriorContributions
    ? mergeHorseObservationWindows(previous, current)
    : normalizeHorseObservationWindow(current);
}
