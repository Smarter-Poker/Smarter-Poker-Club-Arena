/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH FIELDS ACTUALLY CHANGED, WITHOUT THE OLD ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two of PostgresSyncHooks' mirrors decided what to publish by diffing the new
 * row against `payload.old`. Neither could work.
 *
 *   user_theme_settings   REPLICA IDENTITY DEFAULT. Postgres writes only the
 *                         replica identity columns into the WAL's old tuple,
 *                         and for DEFAULT that is the primary key alone. The
 *                         key is `id`; none of the five theme columns is `id`.
 *   user_table_settings   REPLICA IDENTITY FULL — which looks like it should
 *                         make the old row complete, and does not: Supabase
 *                         documents that an RLS-enabled table sends only the
 *                         primary key as the old row, and says plainly there
 *                         is no way around it while RLS is on.
 *
 * In both, `previous[field]` was `undefined`, so `value !== previous[field]`
 * was TRUE for every field on every update. The guard that was supposed to
 * publish only what changed published everything, every time — including on an
 * update that touched nothing but `updated_at`.
 *
 * `user_table_settings` mirrors FORTY-EIGHT columns and emits one
 * SETTINGS_CHANGED per changed column, so one toggle became forty-eight bus
 * events. `useDeckStyle` invalidates its cache on ANY SETTINGS_CHANGED, and
 * useTableButtonStyle, useTableSettings, useUserTableSettings, TablePage and
 * AdminDashboardPage all listen too. Turning off "show badges" re-rendered
 * every card on the table forty-eight times.
 *
 * The values were never wrong — `payload.new` is a complete post image — so
 * this was never a wrong-setting bug. It was a repaint nobody asked for, off a
 * comparison that could not work.
 *
 * THE REPAIR DOES NOT DEPEND ON SETTLING THE DOCS. Comparing against what this
 * client last saw is correct whether or not `payload.old` is complete, because
 * it never asks. That is the point: a decision that cannot be wrong about the
 * transport is better than one that is right only if a vendor page is.
 */

/** What a mirrored column may carry onto the bus. */
export type EchoValue = string | number | boolean;

export type EchoFields = Record<string, EchoValue>;

export interface FieldEchoDecision {
  /** Fields worth telling the rest of the app about. Empty = emit nothing. */
  changed: EchoFields;
  /**
   * Every acceptable field on the row, to remember for the next comparison.
   * Always returned, even when `changed` is empty, so a row that settles is
   * still a baseline for the update after it.
   */
  seed: EchoFields;
}

/**
 * Accepts any string (including ''), number or boolean. `false` and `0` are
 * legitimate settings values and must survive.
 */
export const acceptScalar = (v: unknown): v is EchoValue =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Accepts only a non-empty string. The theme mirror uses this: its consumers
 * merge onto previous state and have no representation for "unset", so a null
 * or '' would be spread in and read as garbage downstream.
 */
export const acceptNonEmptyString = (v: unknown): v is EchoValue =>
  typeof v === 'string' && v.length > 0;

/** Read the named columns off a realtime row, discarding anything `accept` rejects. */
export function readEchoFields(
  row: Record<string, unknown> | null | undefined,
  columns: readonly string[],
  accept: (v: unknown) => v is EchoValue = acceptScalar
): EchoFields {
  const out: EchoFields = {};
  if (!row) return out;
  for (const field of columns) {
    const value = row[field];
    if (accept(value)) out[field] = value;
  }
  return out;
}

/**
 * @param remembered The fields this client last saw for THIS ROW, or `undefined`
 *                   if it has seen none. `undefined` and `{}` are different:
 *                   `undefined` means "never seen, the local UI may be stale, so
 *                   send everything"; `{}` means "seen, and it was empty".
 *
 * An INSERT is always a first sighting, so callers pass `undefined` there and
 * get the whole row back as changed — which is what both handlers did before
 * this module existed, and is correct: a row appearing is news.
 */
export function decideFieldEcho(args: {
  row?: Record<string, unknown> | null;
  columns: readonly string[];
  remembered: EchoFields | undefined;
  accept?: (v: unknown) => v is EchoValue;
}): FieldEchoDecision {
  const accept = args.accept ?? acceptScalar;
  const seed = readEchoFields(args.row, args.columns, accept);
  if (args.remembered === undefined) return { changed: { ...seed }, seed };

  const changed: EchoFields = {};
  for (const field of args.columns) {
    const next = seed[field];
    if (next !== undefined && next !== args.remembered[field]) changed[field] = next;
  }
  return { changed, seed };
}
