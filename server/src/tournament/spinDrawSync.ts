/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DRAW REACHES MEMORY WHOLE, OR IT DOES NOT REACH IT AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When a Spin's tier is drawn at start, fn_spin_draw_and_settle commits its
 * multiplier, prize pool and locked tiers in the same transaction as the
 * reserve/journal receipt. TournamentManagerBase then proves its separate
 * presentation patch (blind ladder, payout structure and reveal timing) and
 * merges both proven shapes into `spinMemoryPatch`. The live `tournament`
 * object drives table creation and the level clock, and `this.tournamentCache`
 * is what the elimination and bubble paths read for the rest of the game.
 *
 * That sync was written out field by field, and it copied FOUR of the five
 * fields the patch carried. `payout_structure` was the one left behind, so for
 * the whole life of a started Spin the cache held the pre-draw winner-take-all
 * PLACEHOLDER. `recalculateEliminatedPrizes` and the hand-for-hand bubble check
 * both read that cache, so the top-up of an eliminated player's prize was
 * computed against a different structure than the payment it was topping up —
 * on a 10x (80/20) or a 25x+ (80/12/8) those are not the same money.
 *
 * The sync block's own comment already said the in-memory object "must agree
 * with what was just written". A hand-written list of field names cannot keep
 * that promise: it is correct only until the next field is added to the patch,
 * and nothing fails when somebody forgets. THIS function is the promise made
 * mechanical — the patch is the single list, and every key in it lands on
 * every target. Add a sixth field to `spinRowPatch` and it is synced by
 * construction; there is no second per-field list to remember.
 *
 * `SpinDrawIntegrity.guard.test.ts` pins both halves: that this copies every
 * key of whatever it is handed, and that the draw site hands it the whole
 * patch rather than naming fields again.
 */

/** Anything the draw patch can be applied onto: the row object or the cache. */
export type SpinDrawTarget = Record<string, unknown> | null | undefined;

const INVALID_STRUCTURED_VALUE = Symbol('invalid-structured-launch-value');

type CanonicalLaunchValue =
  | null
  | boolean
  | number
  | string
  | CanonicalLaunchValue[]
  | { [key: string]: CanonicalLaunchValue };

/**
 * Canonicalize a JSON value without changing array order. Object keys are
 * sorted because Postgres json/jsonb and PostgREST do not promise to preserve
 * the insertion order used by the JavaScript patch.
 */
function canonicalLaunchValue(
  value: unknown
): CanonicalLaunchValue | typeof INVALID_STRUCTURED_VALUE {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : INVALID_STRUCTURED_VALUE;
  }
  if (Array.isArray(value)) {
    const out: CanonicalLaunchValue[] = [];
    for (const item of value) {
      const normalized = canonicalLaunchValue(item);
      if (normalized === INVALID_STRUCTURED_VALUE) return INVALID_STRUCTURED_VALUE;
      out.push(normalized);
    }
    return out;
  }
  if (!value || typeof value !== 'object') return INVALID_STRUCTURED_VALUE;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return INVALID_STRUCTURED_VALUE;
  // A normal `{}` would execute the inherited `__proto__` setter instead of
  // recording that own JSON key. The key could then disappear and make an
  // over-specified/malformed database value compare equal to the launch
  // patch. A null-prototype record makes every JSON key data, including
  // `__proto__`, `constructor`, and `prototype`.
  const out = Object.create(null) as { [key: string]: CanonicalLaunchValue };
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const normalized = canonicalLaunchValue((value as Record<string, unknown>)[key]);
    if (normalized === INVALID_STRUCTURED_VALUE) return INVALID_STRUCTURED_VALUE;
    out[key] = normalized;
  }
  return out;
}

/**
 * Compare a structured launch field as JSON semantics, not transport shape.
 * PostgREST can return legacy json columns as encoded JSON text while jsonb
 * columns arrive as arrays/objects. Only a root string which parses to a
 * structured value is accepted; malformed or scalar JSON fails closed.
 */
export function launchStructuredValueMatches(actual: unknown, expected: object): boolean {
  let decoded = actual;
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return false;
    }
  }
  if (!decoded || typeof decoded !== 'object') return false;
  const canonicalActual = canonicalLaunchValue(decoded);
  const canonicalExpected = canonicalLaunchValue(expected);
  return (
    canonicalActual !== INVALID_STRUCTURED_VALUE &&
    canonicalExpected !== INVALID_STRUCTURED_VALUE &&
    JSON.stringify(canonicalActual) === JSON.stringify(canonicalExpected)
  );
}

/**
 * Compare one projected launch column without JavaScript coercion turning a
 * missing or malformed PostgREST value into proof. Numeric database columns
 * may legitimately arrive as finite numbers or JSON-number strings; booleans,
 * nulls, blank strings, arrays, and inherited/missing properties are never
 * numeric read-back evidence.
 */
export function launchPatchValueMatches(
  row: Record<string, unknown>,
  key: string,
  expected: unknown
): boolean {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return false;
  const actual = row[key];
  if (expected === null) return actual === null;
  if (typeof expected === 'number') {
    if (!Number.isFinite(expected)) return false;
    if (typeof actual === 'number') return Number.isFinite(actual) && actual === expected;
    if (typeof actual !== 'string' || actual.trim() !== actual) return false;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(actual)) return false;
    const parsed = Number(actual);
    return Number.isFinite(parsed) && parsed === expected;
  }
  if (key.endsWith('_at') && typeof expected === 'string') {
    if (typeof actual !== 'string') return false;
    const actualMs = Date.parse(actual);
    const expectedMs = Date.parse(expected);
    return Number.isFinite(actualMs) && actualMs === expectedMs;
  }
  if (expected !== null && typeof expected === 'object') {
    return launchStructuredValueMatches(actual, expected);
  }
  return actual === expected;
}

/**
 * Copy EVERY field of the draw patch onto each in-memory target.
 *
 * Null and undefined targets are skipped rather than thrown on: the cache is
 * legitimately absent on some start paths, and a sync that could throw would
 * be a new way for a drawn spin to fail to start.
 */
export function applySpinDrawPatch(
  patch: Record<string, unknown>,
  ...targets: SpinDrawTarget[]
): void {
  if (!patch || typeof patch !== 'object') return;
  const keys = Object.keys(patch);
  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    for (const key of keys) target[key] = patch[key];
  }
}
