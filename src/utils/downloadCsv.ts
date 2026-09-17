/**
 * HANDING THE USER A FILE
 * ============================================================================
 * One definition of it, because three financial screens had three copies and
 * every copy shared the same two faults:
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

import { isNativePlatform } from '../lib/appBase';

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

/**
 * Hand the user any blob as a file. THE ONE implementation.
 *
 * Ten screens rolled their own `<a download>` between them (audited
 * 2026-09-09), two of them behind a local function also called `downloadCsv`,
 * which is why a grep for the helper looked clean. In the app every one of
 * them produced nothing at all: a webview does not honour the download
 * attribute, and there is no error to notice. Anything that hands the user a
 * file goes through here, so the native branch is written once.
 */
export function downloadBlob(filename: string, blob: Blob): boolean;
export function downloadBlob(
  filename: string,
  blob: Blob,
  isCurrent: () => boolean
): boolean | Promise<boolean>;
export function downloadBlob(
  filename: string,
  blob: Blob,
  isCurrent?: () => boolean
): boolean | Promise<boolean> {
  const check = () => {
    if (isCurrent && isCurrent() !== true) throw new Error('export_account_or_view_changed');
  };
  check();
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;

  // THE APP (2026-09-08): a webview does not honour the download attribute,
  // so the file goes to the system share sheet (src/lib/native/share.ts).
  if (isNativePlatform()) {
    const sharing = import('../lib/native/share').then(({ nativeShareBlob }) => {
      check();
      return nativeShareBlob(blob, filename, undefined, isCurrent);
    });
    // Guarded financial exports observe the actual handoff or refusal.
    if (isCurrent) return sharing;
    void sharing.catch(() => {});
    return true;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  let handedOff = false;
  try {
    check();
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    check();
    a.click();
    handedOff = true;
  } finally {
    a.remove();
    // Preserve Safari's read window only after a real handoff. A refused
    // account/view must release its never-handed-off bytes immediately.
    if (handedOff) setTimeout(() => URL.revokeObjectURL(url), 30_000);
    else URL.revokeObjectURL(url);
  }
  return true;
}

export function downloadCsv(filename: string, csv: string): boolean {
  // The BOM is what makes Excel read this as UTF-8 instead of guessing;
  // club and player names are not all ASCII.
  return downloadBlob(filename, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
}
