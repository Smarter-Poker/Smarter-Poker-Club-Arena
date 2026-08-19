/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB SETTINGS RULES — pure, testable helpers for the Club Settings surface
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These rules used to live inline in ClubSettingsPage/StatsExport where they
 * could not be unit tested, and each one has already shipped a real bug:
 *   - buy-in clamping snapped the field to the ceiling while you were typing;
 *   - the CSV formula-injection guard quoted negative NUMBERS and corrupted
 *     every chips_lost / net column;
 *   - the realtime subscription had no notion of which columns matter, so it
 *     refetched on chip_pool churn.
 */

/** Buy-in bounds, in big blinds. A table cannot be seated below one big
 *  blind, and 1000 BB is the deepest stack the lobby renders sanely. */
export const BUYIN_BB_FLOOR = 1;
export const BUYIN_BB_CEILING = 1000;

/**
 * Clamp a buy-in value into range, tolerating the transient NaN produced
 * while the field is empty mid-edit. Clamping on every keystroke made the
 * inputs impossible to retype.
 */
export function clampBuyin(value: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(BUYIN_BB_CEILING, Math.max(BUYIN_BB_FLOOR, value))
    : fallback;
}

/**
 * Human-readable reason the buy-in pair is invalid, or null when it is fine.
 * The min/max attributes on a number input are advisory outside a submitting
 * <form>, and this page never submits one — so this is the real guard.
 */
export function validateBuyinRange(min: number, max: number): string | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Buy-in limits must be numbers.';
  if (min < BUYIN_BB_FLOOR) return `Minimum buy-in must be at least ${BUYIN_BB_FLOOR} BB.`;
  if (max > BUYIN_BB_CEILING) return `Maximum buy-in cannot exceed ${BUYIN_BB_CEILING} BB.`;
  if (max <= min) return 'Maximum buy-in must be greater than the minimum.';
  return null;
}

/**
 * The clubs columns the settings page renders. Used to ignore realtime churn
 * on columns it does not show (chip_pool, member_count and friends are
 * rewritten on hot paths), and kept in step with the audit trigger's watched
 * list in supabase/migrations/20260819c_*.sql.
 */
export const WATCHED_COLUMNS = [
  'name',
  'description',
  'is_public',
  'requires_approval',
  'default_rake_percent',
  'rake_cap',
  'allow_straddle',
  'allow_run_it_twice',
  'allow_rabbit_hunt',
  'min_buyin_bb',
  'max_buyin_bb',
] as const;

/**
 * Encode one CSV cell, neutralising spreadsheet formula injection.
 *
 * A STRING cell beginning with = + - or @ executes when the file is opened
 * in Excel/Sheets even when quoted, so it gets an apostrophe prefix. Numbers
 * are inert and must be left alone — guarding them corrupted every negative
 * value in the export.
 */
export function csvSafeCell(value: unknown): string {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return JSON.stringify(`'${value}`);
  }
  return JSON.stringify(value ?? '');
}

/** Render an array of flat objects as CSV, formula-safe. */
export function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const body = rows.map((row) => headers.map((h) => csvSafeCell(row[h])).join(','));
  return [headers.join(','), ...body].join('\n');
}

/** Club name bounds. The column is NOT NULL but has no CHECK against an
 *  empty string, and the page had no validation at all — so an owner could
 *  blank the name and save a nameless club. Worse, the delete confirmation
 *  compares typed text against the saved name, so a blank name armed the
 *  Delete button with an empty box. */
export const CLUB_NAME_MAX = 50;

/**
 * Reason the club name is unacceptable, or null when it is fine.
 * Checks the SANITIZED value, because that is what actually gets stored:
 * a name of "<b></b>" survives the length check and lands as "".
 */
export function validateClubName(rawName: string, sanitized?: string): string | null {
  const effective = (sanitized ?? rawName ?? '').trim();
  if (effective.length === 0) return 'Club name cannot be empty.';
  if (effective.length > CLUB_NAME_MAX) {
    return `Club name cannot exceed ${CLUB_NAME_MAX} characters.`;
  }
  return null;
}

/**
 * True when sanitising would silently change what the user typed. The page
 * strips HTML on save; without this the owner watched their text change
 * after a save with no explanation.
 */
export function sanitizationWouldAlter(raw: string, sanitized: string): boolean {
  return raw.trim() !== sanitized.trim();
}

/**
 * Excel refuses to read a UTF-8 CSV as UTF-8 unless it starts with a byte
 * order mark, so exported player names with accents arrived mojibake.
 */
export const CSV_BOM = '\ufeff';
