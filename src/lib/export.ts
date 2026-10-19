/**
 * Export utilities: CSV building and blob download.
 *
 * The print-to-PDF exporters (exportSettlementPDF, exportHandHistoryPDF) were
 * removed on 2026-10-19. Nothing in src/ or server/ called them, they returned
 * the HTML as a "placeholder" blob rather than a PDF, and they rendered through
 * a hidden iframe built with document.createElement outside the one sanctioned
 * frame (src/components/table/HubFrame.tsx, CLAUDE.md 1.3).
 */

import { downloadBlob as sharedDownloadBlob } from '../utils/downloadCsv';

/**
 * Download a blob as a file.
 *
 * Argument order is (blob, filename) for its existing callers; the shared
 * implementation in utils/downloadCsv takes (filename, blob) and carries the
 * native branch, so this is a thin adapter rather than a second copy.
 */
export function downloadBlob(blob: Blob, filename: string) {
  sharedDownloadBlob(filename, blob);
}

/**
 * Export data to CSV
 */
export function escapeCSVCell(value: unknown): string {
  let text = String(value ?? '');

  // Spreadsheet applications execute cells beginning with these characters as
  // formulas. A roster contains user-controlled aliases, usernames and notes,
  // so neutralise the formula while preserving the visible text.
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCSV<T extends object>(
  data: T[],
  columns?: Array<{ key: keyof T; label: string }>
): string {
  if (data.length === 0) return '';
  const cols = columns || Object.keys(data[0]).map((key) => ({ key: key as keyof T, label: key }));
  const header = cols.map((column) => escapeCSVCell(column.label)).join(',');
  const rows = data.map((row) => cols.map((column) => escapeCSVCell(row[column.key])).join(','));
  return [header, ...rows].join('\r\n');
}

export function exportToCSV<T extends object>(
  data: T[],
  filename: string,
  columns?: Array<{ key: keyof T; label: string }>
) {
  if (data.length === 0) return;

  const csv = buildCSV(data, columns);
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}

export default {
  exportToCSV,
  downloadBlob,
};
