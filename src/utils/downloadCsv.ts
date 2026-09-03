/**
 * CSV DOWNLOAD
 * ============================================================================
 * One definition of "hand the user a file", because three financial screens
 * had three copies of it and every copy shared the same two faults:
 *
 *   1. The anchor was never added to the document. Firefox will not act on a
 *      click for a detached element, so the tap did nothing at all.
 *   2. URL.revokeObjectURL ran in the same tick as .click(). Safari, iOS in
 *      particular, has often not started reading the blob by then, so the
 *      download silently produced nothing.
 *
 * Both fail identically: no file, no error, no clue. On pages whose exports
 * are used to settle money that is the worst available outcome, so the anchor
 * is attached for the duration of the click and the revoke is deferred.
 *
 * Returns false when there is no DOM to download into, so a caller can say so
 * rather than assume it worked.
 */

/** RFC 4180: quote anything containing a quote, comma or newline. */
export function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Excel and other spreadsheet apps may execute string cells beginning with
  // one of these characters as formulas. Numeric values remain numeric; only
  // user-controlled strings are prefixed with an apostrophe.
  if (typeof value === 'string' && /^[\t ]*[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header row and a matrix of cells. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join(
    '\n'
  );
}

export function downloadCsv(filename: string, csv: string): boolean {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;

  // The BOM is what makes Excel read this as UTF-8 instead of guessing;
  // club and player names are not all ASCII.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred, not synchronous: Safari may not have read the blob yet.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}
