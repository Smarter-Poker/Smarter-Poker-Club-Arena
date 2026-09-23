import { describe, expect, it } from 'vitest';
import {
  buildStatementCsv,
  safeStatementText,
  statementCsvCell,
} from '../../src/utils/cashierStatementCsv';
import { STATEMENT_CSV_COLUMNS, type StatementEntry } from '../../src/hooks/useCashierStatement';

/**
 * THE STATEMENT FILE IS A SPREADSHEET SOMEBODY WILL OPEN (Cashier Phase 5).
 *
 * Every text cell is player-authorable (aliases, notes, ledger labels), so the
 * escaper must refuse every shape a spreadsheet can evaluate, at least as
 * strongly as FinancialExportContract.safeText. Characters outside ASCII are
 * built with String.fromCharCode so this file stays plain ASCII.
 */

const ch = (code: number) => String.fromCharCode(code);

describe('safeStatementText refuses every formula shape', () => {
  it.each([
    ['=HYPERLINK("http://x","y")'],
    ['+1+1'],
    ['-2+3'],
    ['@SUM(A1)'],
    ['|cmd'],
    ['%0A'],
    ["'already quoted"],
    [' =leading space'],
    ['\t=tab'],
    ['\r=carriage'],
    ['\n=newline'],
  ])('prefixes %j with an apostrophe', (value) => {
    expect(safeStatementText(value).startsWith("'")).toBe(true);
  });

  it.each([
    [0xff1d, 'full-width equals'],
    [0xff0b, 'full-width plus'],
    [0xff0d, 'full-width minus'],
    [0xff20, 'full-width at'],
    [0xfe66, 'small equals'],
    [0xfe62, 'small plus'],
    [0xfe63, 'small minus'],
    [0x2212, 'minus sign'],
  ])('prefixes a leading U+%s (%s)', (code) => {
    expect(safeStatementText(`${ch(code)}SUM(A1)`)).toBe(`'${ch(code)}SUM(A1)`);
  });

  it('flattens control characters so no cell can open a row or hide a trigger', () => {
    for (const code of [
      0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029,
    ]) {
      const out = safeStatementText(`a${ch(code)}b`);
      expect(out, `U+${code.toString(16)}`).toBe('a b');
    }
    // A leading control character becomes whitespace, which is itself refused.
    expect(safeStatementText(`${ch(0x0d)}=1+1`)).toBe("' =1+1");
    expect(safeStatementText(`${ch(0x00)}@x`)).toBe("' @x");
  });

  it('removes invisible direction and zero-width marks that could hide the first character', () => {
    for (const code of [0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff]) {
      expect(safeStatementText(`${ch(code)}=1+1`), `U+${code.toString(16)}`).toBe("'=1+1");
    }
  });

  it('leaves ordinary text alone', () => {
    expect(safeStatementText('KingFish')).toBe('KingFish');
    expect(safeStatementText('Float Top Up')).toBe('Float Top Up');
    expect(safeStatementText('agent_wallet_send')).toBe('agent_wallet_send');
  });
});

describe('statementCsvCell', () => {
  it('always quotes and doubles quotes', () => {
    expect(statementCsvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(statementCsvCell(null)).toBe('""');
    expect(statementCsvCell(undefined)).toBe('""');
    expect(statementCsvCell('')).toBe('""');
  });

  it('prints strict decimals, timestamps and uuids raw, and escapes anything else as text', () => {
    expect(statementCsvCell('2500.00', 'decimal')).toBe('"2500.00"');
    expect(statementCsvCell('-12.5', 'decimal')).toBe('"-12.5"');
    expect(statementCsvCell('-1+1', 'decimal')).toBe('"\'-1+1"');
    expect(statementCsvCell('=1', 'decimal')).toBe('"\'=1"');
    expect(statementCsvCell('2026-09-20T11:56:00Z', 'timestamp')).toBe('"2026-09-20T11:56:00Z"');
    expect(statementCsvCell('=NOW()', 'timestamp')).toBe('"\'=NOW()"');
    const id = 'bbbbbbbb-0001-4000-8000-000000000001';
    expect(statementCsvCell(id, 'uuid')).toBe(`"${id}"`);
    expect(statementCsvCell('-cmd', 'uuid')).toBe('"\'-cmd"');
  });

  it('a quote cannot break out of its cell', () => {
    expect(statementCsvCell('a","=1+1')).toBe('"a"",""=1+1"');
  });
});

describe('buildStatementCsv', () => {
  const entry: StatementEntry = {
    source: 'receipt',
    id: 'bbbbbbbb-0001-4000-8000-000000000001',
    at: '2026-09-20T11:56:00Z',
    kind: 'agent_wallet_send',
    wallet: 'agent',
    direction: 'out',
    amount: '2500.00',
    from: { type: 'agent_wallet', id: '22222222-2222-4222-8222-222222222222', label: 'KingFish' },
    to: { type: 'player_wallet', id: 'aaaaaaaa-0006-4000-8000-000000000006', label: '=cmd|x' },
    counterparty: '=cmd|x',
    notes: 'line one\nline two, "quoted"',
    state: 'posted',
    reference: {
      id: 'bbbbbbbb-0001-4000-8000-000000000001',
      source: 'receipt',
      op_id: 'op-1',
      idempotency_key: '@key',
      correlation_id: null,
      ledger_id: null,
      cashout_id: null,
      ticket_id: null,
    },
    balance_after: null,
    table_id: null,
    tournament_id: null,
    hand_id: null,
  };

  it('writes a BOM, a Title Case header, CRLF rows, and one line per entry', () => {
    const csv = buildStatementCsv(STATEMENT_CSV_COLUMNS, [entry, entry]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    for (const label of lines[0].split(',')) {
      expect(label).toMatch(/^"[A-Z][a-z]*(?: (?:[A-Z][a-z]*|ID))*"$/);
    }
    expect(lines[1]).toContain('"\'=cmd|x"');
    expect(lines[1]).toContain('"line one line two, ""quoted"""');
    expect(lines[1]).toContain('"\'@key"');
    expect(lines[1]).toContain('"2500.00"');
    // Every cell quoted: the number of cells equals the header's.
    expect(lines[1].match(/"(?:[^"]|"")*"/g)).toHaveLength(STATEMENT_CSV_COLUMNS.length);
  });

  it('never exports a horse marker or any column the contract does not name', () => {
    const csv = buildStatementCsv(STATEMENT_CSV_COLUMNS, [
      { ...entry, is_horse: true } as unknown as StatementEntry,
    ]);
    expect(csv.toLowerCase()).not.toContain('horse');
  });
});
