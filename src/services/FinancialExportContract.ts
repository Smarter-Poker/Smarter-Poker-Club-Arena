/** Pure export representation checks. These do not certify payment or history. */
export class FinancialExportError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'FinancialExportError';
  }
}
export function exportRefusal(code: string): never {
  throw new FinancialExportError(code);
}
export function exportUUID(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    value === '00000000-0000-0000-0000-000000000000'
  )
    return exportRefusal('export_identity_unavailable');
  return value.toLowerCase();
}
export function exportTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32)
    return exportRefusal('export_timestamp_unavailable');
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!m || !Number.isFinite(Date.parse(value)))
    return exportRefusal('export_timestamp_unavailable');
  const [y, month, day, h, minute, second] = m.slice(1).map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (
    y < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ||
    h > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return exportRefusal('export_timestamp_unavailable');
  }
  return value;
}
export function exportWindow(value: unknown): string {
  return exportTimestamp(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value
  );
}
export function exportInstant(value: string): bigint {
  exportTimestamp(value);
  const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
export function exportDecimal(
  value: unknown,
  scale?: number,
  integralDigits?: number,
  positive = false
): string {
  // This length bounds parsing work, not the valid financial domain. Larger
  // unconstrained numerics refuse; they are never shortened or rounded.
  if (
    (scale !== undefined && (!Number.isSafeInteger(scale) || scale < 0 || scale > 126)) ||
    (integralDigits !== undefined &&
      (!Number.isSafeInteger(integralDigits) || integralDigits < 1 || integralDigits > 128)) ||
    typeof positive !== 'boolean' ||
    typeof value !== 'string' ||
    value.length > 128
  )
    return exportRefusal('export_decimal_unavailable');
  const m = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (
    !m ||
    (integralDigits !== undefined && m[2].length > integralDigits) ||
    (scale !== undefined && /[1-9]/.test((m[3] ?? '').slice(scale)))
  )
    return exportRefusal('export_decimal_unavailable');
  if (positive && (m[1] === '-' || BigInt(m[2] + (m[3] ?? '')) === 0n))
    return exportRefusal('export_decimal_unavailable');
  const output =
    scale === undefined
      ? value
      : scale === 0
        ? `${m[1]}${m[2]}`
        : `${m[1]}${m[2]}.${(m[3] ?? '').padEnd(scale, '0').slice(0, scale)}`;
  if (output.length > 128) return exportRefusal('export_decimal_unavailable');
  return output;
}
export function sumExportDecimals(values: string[]): string {
  values.forEach((v) => exportDecimal(v));
  const scale = Math.max(0, ...values.map((v) => (v.split('.')[1] ?? '').length));
  const total = values.reduce((sum, v) => {
    const negative = v.startsWith('-');
    const [whole, part = ''] = (negative ? v.slice(1) : v).split('.');
    const n = BigInt(whole + part.padEnd(scale, '0'));
    return sum + (negative ? -n : n);
  }, 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
  return `${total < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
export interface ExportColumn {
  key: string;
  label: string;
  kind: 'uuid' | 'timestamp' | 'decimal' | 'text' | 'boolean' | 'integer';
  nullable?: boolean;
  scale?: number;
  integralDigits?: number;
  positive?: boolean;
}
export type ExportRow = Record<string, string | boolean | number | null>;
export function exportRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return exportRefusal('export_row_unavailable');
  return value as Record<string, unknown>;
}
export function validateExportRow(value: unknown, columns: readonly ExportColumn[]): ExportRow {
  const source = exportRecord(value);
  const keys = columns.map((c) => c.key);
  if (
    Object.keys(source).length !== keys.length ||
    Object.keys(source).some((k) => !keys.includes(k))
  )
    return exportRefusal('export_row_shape_unavailable');
  const row: ExportRow = Object.create(null);
  for (const c of columns) {
    const v = source[c.key];
    if (v === null && c.nullable) {
      row[c.key] = null;
      continue;
    }
    switch (c.kind) {
      case 'uuid':
        row[c.key] = exportUUID(v);
        break;
      case 'timestamp':
        row[c.key] = exportTimestamp(v);
        break;
      case 'decimal':
        row[c.key] = exportDecimal(v, c.scale, c.integralDigits, c.positive);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') exportRefusal('export_boolean_unavailable');
        row[c.key] = v as boolean;
        break;
      case 'integer':
        if (!Number.isSafeInteger(v)) exportRefusal('export_integer_unavailable');
        row[c.key] = v as number;
        break;
      case 'text':
        if (typeof v !== 'string' || v.length > 65536) exportRefusal('export_text_unavailable');
        row[c.key] = v as string;
        break;
    }
  }
  return row;
}
export function generateExportCSV(
  columns: readonly ExportColumn[],
  rows: Record<string, unknown>[]
): string {
  if (
    !Array.isArray(columns) ||
    columns.length === 0 ||
    columns.length > 64 ||
    rows.length > 1000 ||
    columns.some(
      (c) =>
        !c ||
        typeof c.key !== 'string' ||
        !c.key ||
        typeof c.label !== 'string' ||
        c.label.length > 256 ||
        !['uuid', 'timestamp', 'decimal', 'text', 'boolean', 'integer'].includes(c.kind) ||
        (c.nullable !== undefined && typeof c.nullable !== 'boolean') ||
        (c.positive !== undefined && typeof c.positive !== 'boolean') ||
        (c.scale !== undefined &&
          (!Number.isSafeInteger(c.scale) || c.scale < 0 || c.scale > 126)) ||
        (c.integralDigits !== undefined &&
          (!Number.isSafeInteger(c.integralDigits) ||
            c.integralDigits < 1 ||
            c.integralDigits > 128)) ||
        (c.kind !== 'decimal' &&
          (c.scale !== undefined || c.integralDigits !== undefined || c.positive !== undefined))
    ) ||
    new Set(columns.map((c) => c.key)).size !== columns.length
  )
    return exportRefusal('export_columns_required');
  const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
  // Quotes protect CSV structure, not spreadsheet formulas. Text escaping is
  // separate from strictly parsed decimal cells; never emit ="..." formulas.
  const safeText = (v: string) => {
    const first = v.charCodeAt(0);
    return first <= 31 || first === 127 || /^[\s'=+\-@]/u.test(v) ? `'${v}` : v;
  };
  const lines = [columns.map((c) => quote(safeText(c.label))).join(',')];
  for (const source of rows) {
    const row = validateExportRow(source, columns);
    lines.push(
      columns
        .map((c) =>
          quote(
            row[c.key] === null
              ? ''
              : c.kind === 'text'
                ? safeText(String(row[c.key]))
                : String(row[c.key])
          )
        )
        .join(',')
    );
  }
  return lines.join('\r\n');
}
