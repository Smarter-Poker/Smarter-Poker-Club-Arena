/**
 * THE CASHIER STATEMENT CSV (Cashier Phase 5, 2026-09-23)
 * ============================================================================
 * One builder for the file a club operator settles money from, so it is written
 * once and tested once.
 *
 * A statement cell is text a player can author: an alias, a note on a send, a
 * label from the chip ledger. A spreadsheet executes a cell that begins with a
 * formula trigger, so every cell here is escaped at least as strongly as
 * `FinancialExportContract.safeText`, and further:
 *
 *   1. Every cell is quoted, and every quote inside it is doubled (RFC 4180).
 *   2. Control characters (C0, DEL, C1, the Unicode line and paragraph
 *      separators) become a space, so no cell can open a new row or smuggle a
 *      tab or carriage return past the leading-character check.
 *   3. Invisible direction and zero-width marks are removed, so a cell cannot
 *      hide its first character behind one.
 *   4. A text cell that then begins with whitespace, an apostrophe, = + - @ |
 *      % or a full-width or small-form = + - @ gets a leading apostrophe, which
 *      every spreadsheet reads as "this is text".
 *   5. Figures, timestamps and ids are printed raw ONLY when they match their
 *      strict shape. Anything else is treated as untrusted text and escaped.
 *
 * The export never computes a figure: every amount is the server's own decimal
 * string, copied through.
 */

export type CsvCellKind = 'text' | 'decimal' | 'timestamp' | 'uuid';

const DECIMAL = /^-?\d{1,30}(?:\.\d{1,12})?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* eslint-disable no-control-regex */
/** C0 controls, DEL, C1 controls, and the Unicode line/paragraph separators. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/* eslint-enable no-control-regex */
/** Direction overrides/isolates, marks, zero-width characters and the BOM. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/**
 * A cell a spreadsheet may evaluate: leading whitespace, an apostrophe, the
 * four formula triggers, the DDE pipe, a percent, and the full-width and
 * small-form variants of = + - @ that some locales normalise to ASCII.
 */
const FORMULA_LEAD = /^[\s'=+\-@|%\uff1d\uff0b\uff0d\uff20\ufe66\ufe62\ufe63\u2212]/u;

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** The text-cell escaper. Exported so the tests can pin every shape it refuses. */
export function safeStatementText(value: string): string {
  const flat = value.replace(CONTROL, ' ').replace(INVISIBLE, '');
  return FORMULA_LEAD.test(flat) ? `'${flat}` : flat;
}

/** One quoted CSV cell. */
export function statementCsvCell(value: unknown, kind: CsvCellKind = 'text'): string {
  if (value === null || value === undefined) return '""';
  const text = typeof value === 'string' ? value : String(value);
  if (kind === 'decimal' && DECIMAL.test(text)) return quote(text);
  if (kind === 'timestamp' && TIMESTAMP.test(text)) return quote(text);
  if (kind === 'uuid' && UUID.test(text)) return quote(text);
  return quote(safeStatementText(text));
}

export interface StatementCsvColumn<Row> {
  label: string;
  kind: CsvCellKind;
  read: (row: Row) => unknown;
}

/**
 * The whole document: header, one line per row, CRLF, with the byte order
 * mark that makes Excel read UTF-8 instead of guessing (club and player names
 * are not all ASCII).
 */
export function buildStatementCsv<Row>(
  columns: ReadonlyArray<StatementCsvColumn<Row>>,
  rows: ReadonlyArray<Row>
): string {
  const lines = [columns.map((c) => statementCsvCell(c.label, 'text')).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => statementCsvCell(c.read(row), c.kind)).join(','));
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
