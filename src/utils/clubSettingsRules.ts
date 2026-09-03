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

/** What a club deletion would destroy. Gathered before the confirm modal
 *  arms, because `tables` and `club_wallets` both CASCADE on clubs. */
export interface ClubDeletionImpact {
  members: number;
  runningTables: number;
  walletChips: number;
}

/**
 * Reason this club must not be deleted yet, or null when it is safe.
 *
 * The FKs from `tables` and `club_wallets` to `clubs` are ON DELETE CASCADE,
 * so deleting a club silently destroys every table under it — including
 * running tables with players seated — and the club's wallets with them.
 * The confirmation modal said only "all club data, members, and tables will
 * be permanently removed" and showed no numbers at all.
 */
export function blockingDeletionReason(impact: ClubDeletionImpact): string | null {
  if (impact.runningTables > 0) {
    return `Close the ${impact.runningTables} running table${
      impact.runningTables === 1 ? '' : 's'
    } before deleting this club - deleting now would remove them with players seated.`;
  }
  if (impact.walletChips > 0) {
    return `This club still holds ${impact.walletChips.toLocaleString()} chips. Settle the club wallet before deleting.`;
  }
  return null;
}

/**
 * Turning a club private while approval is off does NOT close it: the join
 * RPC (fn_join_club) reads only requires_approval, so anyone holding the
 * club code still joins instantly. Club creation already couples these two
 * (requires_approval = !isPublic); the settings page did not.
 */
export function privateClubNeedsApproval(isPublic: boolean, requiresApproval: boolean): boolean {
  return !isPublic && !requiresApproval;
}

/**
 * Storage path inside the club-assets bucket for a public URL we issued, or
 * null for anything else. Replacing a logo used to leave the previous object
 * in the bucket forever; this is what lets the replace path delete it, while
 * refusing to touch URLs that are not ours (data: URLs from the old
 * create-club fallback, or a hand-set external image).
 */
export function clubAssetPathFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = '/storage/v1/object/public/club-assets/';
  const i = url.indexOf(marker);
  if (i === -1) return null;
  const path = url.slice(i + marker.length).split('?')[0];
  // Only the prefix this page writes to, and never a traversal.
  if (!path.startsWith('club-logos/') || path.includes('..')) return null;
  return decodeURIComponent(path);
}
