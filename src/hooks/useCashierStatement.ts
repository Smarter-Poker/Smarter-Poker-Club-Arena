/**
 * THE CASHIER STATEMENT (Cashier Phase 5, 2026-09-23)
 * ============================================================================
 * One hook owns every read the Full Statement page makes, so the rules that
 * keep money honest are written once:
 *
 *   - The server decides who sees what. `fn_cashier_statement_page` applies the
 *     same role matrix as the Trade Record (`fn_club_trade_ledger`), and the
 *     export is produced by the SAME row function, so the file can never hold
 *     an entry the screen could not.
 *   - Every async read carries a generation. A response that belongs to an
 *     older request, an older access generation or another account is dropped
 *     on arrival; it never paints over what is on screen.
 *   - Access loss clears first and asks later. `authorized:false`, an RPC
 *     42501, a membership or role event on the master bus, a sign-out or an
 *     account change empties the rows, the totals, the prepared export id and
 *     any in-memory CSV synchronously, before anything else is rendered.
 *   - A failed read is never an empty list and never a zero.
 *
 * Nothing here computes a figure. Amounts and totals are the server's own
 * decimal strings, validated and passed through.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';
import { downloadBlob } from '../utils/downloadCsv';
import { buildStatementCsv, type StatementCsvColumn } from '../utils/cashierStatementCsv';
import {
  accountingDateOnly,
  pacificAccountingDay,
  pacificAccountingDayClose,
  zonedAccountingInstant,
} from '../utils/pacificAccountingCalendar';

// ─── Contract ────────────────────────────────────────────────────────────────

export const STATEMENT_PAGE_SIZE = 100;
export const STATEMENT_EXPORT_PAGE_SIZE = 1000;
export const STATEMENT_EXPORT_MAX_ROWS = 20000;
export const STATEMENT_MAX_DAYS = 92;
const DAY_MS = 86_400_000;
const PACIFIC = 'America/Los_Angeles';

export type StatementScope = 'all' | 'downline' | 'self';
export const WALLET_FAMILIES = [
  'player',
  'agent',
  'promo',
  'bank',
  'union',
  'table',
  'ticket',
  'cashout',
  'other',
] as const;
export type WalletFamily = (typeof WALLET_FAMILIES)[number];
export const ENTRY_DIRECTIONS = ['in', 'out', 'managed'] as const;
export type EntryDirection = (typeof ENTRY_DIRECTIONS)[number];
export const ENTRY_STATES = ['posted', 'reversible', 'reversed', 'clawed_back', 'pending'] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

export interface StatementParty {
  type: string | null;
  id: string | null;
  label: string | null;
}

export interface StatementReference {
  id: string;
  source: string | null;
  op_id: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  ledger_id: string | null;
  cashout_id: string | null;
  ticket_id: string | null;
}

export interface StatementEntry {
  source: 'receipt' | 'movement';
  id: string;
  at: string;
  kind: string;
  wallet: WalletFamily;
  direction: EntryDirection;
  /** Positive decimal string, exactly as the server printed it. */
  amount: string;
  from: StatementParty;
  to: StatementParty;
  counterparty: string | null;
  notes: string | null;
  state: EntryState;
  reference: StatementReference;
  balance_after: string | null;
  table_id: string | null;
  tournament_id: string | null;
  hand_id: string | null;
}

export interface StatementTotals {
  in: string;
  out: string;
  managed: string;
  count: number;
}

export interface StatementFilters {
  wallet: WalletFamily | 'any';
  direction: EntryDirection | 'any';
  state: EntryState | 'any';
  operation: string;
  counterparty: string;
  reference: string;
}

export const EMPTY_STATEMENT_FILTERS: StatementFilters = {
  wallet: 'any',
  direction: 'any',
  state: 'any',
  operation: '',
  counterparty: '',
  reference: '',
};

export interface StatementRequest {
  from: string;
  to: string;
  filters: StatementFilters;
}

/**
 * Only the keys that narrow the statement, and only the six the server knows
 * (wallet, direction, operation, counterparty, state, reference): an unknown
 * key is a 22023. Empty ones are omitted; the server treats absent as any.
 */
export function statementRpcFilters(filters: StatementFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.wallet !== 'any') out.wallet = filters.wallet;
  if (filters.direction !== 'any') out.direction = filters.direction;
  if (filters.state !== 'any') out.state = filters.state;
  // Entry types are stored as snake_case ('agent_wallet_send'); a person types
  // them as words. The match on the server is exact, so normalise, never guess.
  const operation = filters.operation
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (operation) out.operation = operation;
  const counterparty = filters.counterparty.trim().slice(0, 64);
  if (counterparty) out.counterparty = counterparty;
  const reference = filters.reference.trim();
  if (reference) out.reference = reference;
  return out;
}

export function activeStatementFilterCount(filters: StatementFilters): number {
  return Object.keys(statementRpcFilters(filters)).length;
}

// ─── Date ranges (Pacific accounting days) ───────────────────────────────────

export type StatementPreset = 'today' | 'last7' | 'last30' | 'week';

export interface StatementRange {
  from: string;
  to: string;
  /** Inclusive Pacific accounting days, for the range line and the filename. */
  fromDay: string;
  toDay: string;
}

export function addAccountingDays(day: string, days: number): string {
  const d = accountingDateOnly(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function rangeOf(fromDay: string, toDay: string): StatementRange {
  return {
    from: zonedAccountingInstant(fromDay, 0, PACIFIC),
    to: new Date(pacificAccountingDayClose(toDay)).toISOString(),
    fromDay,
    toDay,
  };
}

export function statementPresetRange(preset: StatementPreset, nowMs: number): StatementRange {
  const today = pacificAccountingDay(nowMs);
  if (preset === 'today') return rangeOf(today, today);
  if (preset === 'last7') return rangeOf(addAccountingDays(today, -6), today);
  if (preset === 'last30') return rangeOf(addAccountingDays(today, -29), today);
  // The accounting week runs Monday through Sunday, Pacific.
  const mondayOffset = (accountingDateOnly(today).getUTCDay() + 6) % 7;
  const monday = addAccountingDays(today, -mondayOffset);
  return rangeOf(monday, addAccountingDays(monday, 6));
}

export type RangeProblem = 'missing' | 'order' | 'span';

/** A custom from and to date. The server enforces the same 92-day limit. */
export function customStatementRange(
  fromDay: string,
  toDay: string
): { range: StatementRange } | { problem: RangeProblem } {
  try {
    accountingDateOnly(fromDay);
    accountingDateOnly(toDay);
  } catch {
    return { problem: 'missing' };
  }
  if (toDay < fromDay) return { problem: 'order' };
  const range = rangeOf(fromDay, toDay);
  if (Date.parse(range.to) - Date.parse(range.from) > STATEMENT_MAX_DAYS * DAY_MS) {
    return { problem: 'span' };
  }
  return { range };
}

// ─── Parsing: strict, because these are money rows ──────────────────────────

class StatementMalformed extends Error {
  constructor(detail: string) {
    super(`statement_malformed: ${detail}`);
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const optionalText = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
const POSITIVE_DECIMAL = /^\d{1,30}(?:\.\d{1,12})?$/;
const SIGNED_DECIMAL = /^-?\d{1,30}(?:\.\d{1,12})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const decimalText = (v: unknown, signed: boolean): string | null => {
  const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  if (typeof text !== 'string') return null;
  return (signed ? SIGNED_DECIMAL : POSITIVE_DECIMAL).test(text) ? text : null;
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new StatementMalformed(field);
}

function parseParty(value: unknown): StatementParty {
  if (!isObject(value)) return { type: null, id: null, label: null };
  return {
    type: optionalText(value.type),
    id: optionalText(value.id),
    label: optionalText(value.label),
  };
}

export function parseStatementEntry(value: unknown): StatementEntry {
  if (!isObject(value)) throw new StatementMalformed('entry');
  const source = oneOf(value.source, ['receipt', 'movement'] as const, 'source');
  const id = optionalText(value.id);
  if (!id) throw new StatementMalformed('id');
  const at = optionalText(value.at);
  if (!at || !Number.isFinite(Date.parse(at))) throw new StatementMalformed('at');
  const kind = optionalText(value.kind);
  if (!kind) throw new StatementMalformed('kind');
  const amount = decimalText(value.amount, false);
  if (amount === null) throw new StatementMalformed('amount');
  const balanceRaw = value.balance_after;
  const balance_after =
    balanceRaw === null || balanceRaw === undefined ? null : decimalText(balanceRaw, true);
  if (balanceRaw !== null && balanceRaw !== undefined && balance_after === null) {
    throw new StatementMalformed('balance_after');
  }
  const ref = isObject(value.reference) ? value.reference : {};
  return {
    source,
    id,
    at,
    kind,
    wallet: oneOf(value.wallet, WALLET_FAMILIES, 'wallet'),
    direction: oneOf(value.direction, ENTRY_DIRECTIONS, 'direction'),
    amount,
    from: parseParty(value.from),
    to: parseParty(value.to),
    counterparty: optionalText(value.counterparty),
    notes: optionalText(value.notes),
    state: oneOf(value.state, ENTRY_STATES, 'state'),
    reference: {
      id: optionalText(ref.id) ?? id,
      source: optionalText(ref.source),
      op_id: optionalText(ref.op_id),
      idempotency_key: optionalText(ref.idempotency_key),
      correlation_id: optionalText(ref.correlation_id),
      ledger_id: optionalText(ref.ledger_id),
      cashout_id: optionalText(ref.cashout_id),
      ticket_id: optionalText(ref.ticket_id),
    },
    // A receipt never carries a balance: only a movement may, for the
    // viewer's own side. Anything else would be a figure nobody recorded.
    balance_after: source === 'movement' ? balance_after : null,
    table_id: optionalText(value.table_id),
    tournament_id: optionalText(value.tournament_id),
    hand_id: optionalText(value.hand_id),
  };
}

function parseTotals(value: unknown): StatementTotals {
  if (!isObject(value)) throw new StatementMalformed('totals');
  const count = typeof value.count === 'string' ? Number(value.count) : value.count;
  const totals = {
    in: decimalText(value.in, false),
    out: decimalText(value.out, false),
    managed: decimalText(value.managed, false),
  };
  if (
    totals.in === null ||
    totals.out === null ||
    totals.managed === null ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw new StatementMalformed('totals');
  }
  return { in: totals.in, out: totals.out, managed: totals.managed, count };
}

export type ParsedStatementPage =
  | { authorized: false }
  | {
      authorized: true;
      scope: StatementScope;
      viewer: string;
      rows: StatementEntry[];
      nextCursor: Json | null;
      generatedAt: string | null;
    };

export function parseStatementPage(data: unknown): ParsedStatementPage {
  if (!isObject(data)) throw new StatementMalformed('page');
  if (data.authorized !== true) {
    if (data.authorized === false) return { authorized: false };
    throw new StatementMalformed('authorized');
  }
  // 'none' with authorized:true is not a scope anyone can be shown.
  if (data.scope === 'none') return { authorized: false };
  const scope = oneOf(data.scope, ['all', 'downline', 'self'] as const, 'scope');
  const viewer = optionalText(data.viewer);
  if (!viewer) throw new StatementMalformed('viewer');
  if (!Array.isArray(data.rows)) throw new StatementMalformed('rows');
  const cursor = data.next_cursor;
  if (cursor !== null && cursor !== undefined && !isObject(cursor)) {
    throw new StatementMalformed('next_cursor');
  }
  return {
    authorized: true,
    scope,
    viewer,
    rows: data.rows.map(parseStatementEntry),
    nextCursor: isObject(cursor) ? cursor : null,
    generatedAt: optionalText(data.generated_at),
  };
}

export type ParsedStatementTotals =
  | { authorized: false }
  | { authorized: true; scope: StatementScope | null; totals: StatementTotals };

/** `fn_cashier_statement_totals`: the whole filtered range, server-side. */
export function parseStatementTotals(data: unknown): ParsedStatementTotals {
  if (!isObject(data)) throw new StatementMalformed('totals_door');
  if (data.authorized !== true) {
    if (data.authorized === false) return { authorized: false };
    throw new StatementMalformed('authorized');
  }
  if (data.scope === 'none') return { authorized: false };
  const scope =
    data.scope === undefined || data.scope === null
      ? null
      : oneOf(data.scope, ['all', 'downline', 'self'] as const, 'scope');
  return { authorized: true, scope, totals: parseTotals(data.totals) };
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** What a failed read means to the person reading it. Never "nothing here". */
export type StatementProblem =
  | 'range'
  | 'changed'
  | 'unavailable'
  | 'malformed'
  | 'too_large'
  | 'expired'
  | 'download_failed';

const errorCode = (e: unknown): string | null =>
  isObject(e) && typeof e.code === 'string' ? e.code : null;
const errorText = (e: unknown): string =>
  isObject(e) && typeof e.message === 'string'
    ? e.message
    : e instanceof Error
      ? e.message
      : String(e ?? '');

export const isAccessRefusal = (e: unknown) => errorCode(e) === '42501';

function readProblem(e: unknown): StatementProblem {
  const code = errorCode(e);
  if (code === '22023') return 'range';
  if (code === '55000') return 'changed';
  if (e instanceof StatementMalformed) return 'malformed';
  return 'unavailable';
}

function exportProblem(e: unknown): StatementProblem {
  const code = errorCode(e);
  const text = errorText(e).toLowerCase();
  if (code === '55000') {
    if (/narrow the range|20,000|20000/.test(text)) return 'too_large';
    return 'expired';
  }
  if (code === '22023') return 'range';
  if (e instanceof StatementMalformed) return 'malformed';
  return 'unavailable';
}

// ─── The CSV ─────────────────────────────────────────────────────────────────

export const STATEMENT_CSV_COLUMNS: ReadonlyArray<StatementCsvColumn<StatementEntry>> = [
  { label: 'Recorded At', kind: 'timestamp', read: (r) => r.at },
  { label: 'Source', kind: 'text', read: (r) => r.source },
  { label: 'Entry', kind: 'text', read: (r) => r.kind },
  { label: 'Wallet', kind: 'text', read: (r) => r.wallet },
  { label: 'Direction', kind: 'text', read: (r) => r.direction },
  { label: 'Amount', kind: 'decimal', read: (r) => r.amount },
  { label: 'State', kind: 'text', read: (r) => r.state },
  { label: 'Counterparty', kind: 'text', read: (r) => r.counterparty },
  { label: 'From Type', kind: 'text', read: (r) => r.from.type },
  { label: 'From', kind: 'text', read: (r) => r.from.label },
  { label: 'From ID', kind: 'uuid', read: (r) => r.from.id },
  { label: 'To Type', kind: 'text', read: (r) => r.to.type },
  { label: 'To', kind: 'text', read: (r) => r.to.label },
  { label: 'To ID', kind: 'uuid', read: (r) => r.to.id },
  { label: 'Notes', kind: 'text', read: (r) => r.notes },
  { label: 'Balance After', kind: 'decimal', read: (r) => r.balance_after },
  { label: 'Reference', kind: 'uuid', read: (r) => r.reference.id },
  { label: 'Operation ID', kind: 'text', read: (r) => r.reference.op_id },
  { label: 'Idempotency Key', kind: 'text', read: (r) => r.reference.idempotency_key },
  { label: 'Correlation ID', kind: 'text', read: (r) => r.reference.correlation_id },
  { label: 'Ledger ID', kind: 'uuid', read: (r) => r.reference.ledger_id },
  { label: 'Cashout ID', kind: 'uuid', read: (r) => r.reference.cashout_id },
  { label: 'Ticket ID', kind: 'uuid', read: (r) => r.reference.ticket_id },
  { label: 'Table ID', kind: 'uuid', read: (r) => r.table_id },
  { label: 'Tournament ID', kind: 'uuid', read: (r) => r.tournament_id },
  { label: 'Hand ID', kind: 'text', read: (r) => r.hand_id },
];

// ─── The hook ────────────────────────────────────────────────────────────────

export type StatementRefusal =
  | 'refused'
  | 'access_changed'
  | 'left_club'
  | 'signed_out'
  | 'account_changed';

export interface StatementListView {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unauthorized';
  rows: StatementEntry[];
  /** Server totals over the whole filtered range, from their own door. */
  totals: StatementTotals | null;
  /** 'unavailable' is a statement timeout or any failure: never a zero. */
  totalsStatus: 'idle' | 'calculating' | 'ready' | 'unavailable';
  scope: StatementScope | null;
  hasMore: boolean;
  generatedAt: string | null;
  problem: StatementProblem | null;
  refusal: StatementRefusal | null;
  loadingMore: boolean;
  moreProblem: StatementProblem | null;
}

export interface StatementExportView {
  status: 'idle' | 'preparing' | 'ready' | 'downloading' | 'expired' | 'too_large' | 'error';
  totalRows: number | null;
  expiresAt: string | null;
  downloaded: boolean;
  problem: StatementProblem | null;
}

interface ListState extends Omit<StatementListView, 'hasMore'> {
  nextCursor: Json | null;
}

const LIST_IDLE: ListState = {
  status: 'idle',
  rows: [],
  totals: null,
  totalsStatus: 'idle',
  scope: null,
  nextCursor: null,
  generatedAt: null,
  problem: null,
  refusal: null,
  loadingMore: false,
  moreProblem: null,
};

const EXPORT_IDLE: StatementExportView = {
  status: 'idle',
  totalRows: null,
  expiresAt: null,
  downloaded: false,
  problem: null,
};

interface PageArgs {
  p_club_id: string;
  p_from: string;
  p_to: string;
  p_filters: Record<string, string>;
}

interface ExportJob {
  exportId: string;
  clubId: string;
  requestKey: string;
  scopeKey: string;
  accessGeneration: number;
  totalRows: number;
  expiresAt: string;
}

export interface UseCashierStatementOptions {
  userId: string | undefined;
  clubId: string | null;
  request: StatementRequest | null;
  /** The account guard (useCashoutScope): false the moment the account changes. */
  isAccountCurrent: () => boolean;
}

export interface CashierStatement {
  list: StatementListView;
  exportView: StatementExportView;
  loadMore: () => Promise<void>;
  reload: () => void;
  prepareExport: () => Promise<void>;
  downloadExport: (filename: string) => Promise<void>;
  cancelExport: () => Promise<void>;
  /** Clears everything now. Exposed for the page's own access signals. */
  revoke: (reason: StatementRefusal) => void;
}

function newRequestId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through to the shim */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function cancelQuietly(exportId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('fn_cashier_statement_export_cancel', {
      p_export_id: exportId,
    });
    if (error) reportError(error, 'CashierStatements.exportCancel');
  } catch (e) {
    reportError(e, 'CashierStatements.exportCancel');
  }
}

const ACCESS_EVENTS = [
  'MEMBER_ROLE_CHANGED',
  'MEMBER_UPDATED',
  'CLUB_UPDATED',
  'GAME_MANAGEMENT_ACCESS_CHANGED',
] as const;

export function useCashierStatement({
  userId,
  clubId,
  request,
  isAccountCurrent,
}: UseCashierStatementOptions): CashierStatement {
  const [list, setList] = useState<ListState>(LIST_IDLE);
  const [exportView, setExportView] = useState<StatementExportView>(EXPORT_IDLE);
  const [reloadTick, setReloadTick] = useState(0);

  const mounted = useRef(true);
  const accountCurrent = useRef(isAccountCurrent);
  accountCurrent.current = isAccountCurrent;
  /** Bumped on every access loss: every read and export in flight is void. */
  const accessGeneration = useRef(0);
  /** Bumped on every first-page read: older first pages and their Load More are void. */
  const readGeneration = useRef(0);
  const moreGeneration = useRef(0);
  const totalsGeneration = useRef(0);
  const moreInFlight = useRef(false);
  const exportGeneration = useRef(0);
  const requestKeyRef = useRef<string | null>(null);
  /** The exact arguments the rows on screen were read with. Load More reuses them. */
  const shownArgs = useRef<PageArgs | null>(null);
  const cursorRef = useRef<Json | null>(null);
  /** viewer|scope of the rows on screen. A change mid-statement voids it. */
  const scopeKeyRef = useRef<string | null>(null);
  const exportJob = useRef<ExportJob | null>(null);
  /** The rows of a download being assembled. Dropped on access loss. */
  const exportBuffer = useRef<StatementEntry[] | null>(null);

  const args = useMemo<PageArgs | null>(
    () =>
      clubId && request
        ? {
            p_club_id: clubId,
            p_from: request.from,
            p_to: request.to,
            p_filters: statementRpcFilters(request.filters),
          }
        : null,
    [clubId, request]
  );
  const requestKey = args ? JSON.stringify(args) : null;
  const argsRef = useRef(args);
  argsRef.current = args;

  const dropExport = useCallback((cancel: boolean) => {
    const job = exportJob.current;
    exportJob.current = null;
    exportBuffer.current = null;
    exportGeneration.current += 1;
    setExportView(EXPORT_IDLE);
    if (job && cancel) void cancelQuietly(job.exportId);
  }, []);

  const revoke = useCallback(
    (reason: StatementRefusal) => {
      accessGeneration.current += 1;
      readGeneration.current += 1;
      moreGeneration.current += 1;
      totalsGeneration.current += 1;
      moreInFlight.current = false;
      shownArgs.current = null;
      cursorRef.current = null;
      scopeKeyRef.current = null;
      // The session that prepared the export is gone on sign-out and on an
      // account change; the server voids that job itself on its next page.
      dropExport(reason !== 'signed_out' && reason !== 'account_changed');
      setList({ ...LIST_IDLE, status: 'unauthorized', refusal: reason });
    },
    [dropExport]
  );

  /**
   * THE TOTALS DOOR. Asked once per first page, after the rows have painted,
   * never on Load More. It carries its own generation, so a total for an older
   * range or filter can never land beside newer rows.
   */
  const loadTotals = useCallback(
    async (pageArgs: PageArgs, key: string) => {
      const generation = ++totalsGeneration.current;
      const access = accessGeneration.current;
      const current = () =>
        mounted.current &&
        generation === totalsGeneration.current &&
        access === accessGeneration.current &&
        key === requestKeyRef.current &&
        accountCurrent.current();
      let response: { data: unknown; error: unknown };
      try {
        response = await supabase.rpc('fn_cashier_statement_totals', pageArgs);
      } catch (e) {
        response = { data: null, error: e };
      }
      if (!current()) return;
      const unavailable = () =>
        setList((s) => ({ ...s, totals: null, totalsStatus: 'unavailable' }));
      if (response.error) {
        // 57014 (statement timeout) and every other failure say so; a total
        // that could not be read is never shown as 0.
        reportError(response.error, 'CashierStatements.totals');
        if (isAccessRefusal(response.error)) return revoke('refused');
        return unavailable();
      }
      let parsed: ParsedStatementTotals;
      try {
        parsed = parseStatementTotals(response.data);
      } catch (e) {
        reportError(e, 'CashierStatements.totals');
        return unavailable();
      }
      if (!parsed.authorized) return revoke('refused');
      const shownScope = scopeKeyRef.current?.split('|')[1] ?? null;
      if (parsed.scope && shownScope && parsed.scope !== shownScope) {
        return revoke('access_changed');
      }
      const totals = parsed.totals;
      setList((s) => ({ ...s, totals, totalsStatus: 'ready' }));
    },
    [revoke]
  );

  const loadFirst = useCallback(
    async (pageArgs: PageArgs, key: string) => {
      const generation = ++readGeneration.current;
      moreGeneration.current += 1;
      totalsGeneration.current += 1;
      moreInFlight.current = false;
      const access = accessGeneration.current;
      if (exportJob.current && exportJob.current.requestKey !== key) dropExport(true);
      requestKeyRef.current = key;
      shownArgs.current = null;
      cursorRef.current = null;
      scopeKeyRef.current = null;
      setList({ ...LIST_IDLE, status: 'loading' });
      const current = () =>
        mounted.current &&
        generation === readGeneration.current &&
        access === accessGeneration.current &&
        accountCurrent.current();

      let response: { data: unknown; error: unknown };
      try {
        response = await supabase.rpc('fn_cashier_statement_page', {
          ...pageArgs,
          p_cursor: null,
          p_limit: STATEMENT_PAGE_SIZE,
        });
      } catch (e) {
        response = { data: null, error: e };
      }
      if (!current()) return;
      if (response.error) {
        reportError(response.error, 'CashierStatements.page');
        if (isAccessRefusal(response.error)) return revoke('refused');
        setList({ ...LIST_IDLE, status: 'error', problem: readProblem(response.error) });
        return;
      }
      let page: ParsedStatementPage;
      try {
        page = parseStatementPage(response.data);
      } catch (e) {
        reportError(e, 'CashierStatements.page');
        setList({ ...LIST_IDLE, status: 'error', problem: 'malformed' });
        return;
      }
      if (!page.authorized) return revoke('refused');
      if (userId && page.viewer !== userId) return revoke('account_changed');
      shownArgs.current = pageArgs;
      cursorRef.current = page.nextCursor;
      scopeKeyRef.current = `${page.viewer}|${page.scope}`;
      if (exportJob.current && exportJob.current.scopeKey !== scopeKeyRef.current) {
        dropExport(true);
      }
      setList({
        ...LIST_IDLE,
        status: 'ready',
        rows: page.rows,
        totalsStatus: 'calculating',
        scope: page.scope,
        nextCursor: page.nextCursor,
        generatedAt: page.generatedAt,
      });
      void loadTotals(pageArgs, key);
    },
    [dropExport, loadTotals, revoke, userId]
  );

  // First page: whenever the request changes, or on Retry / Check Again.
  useEffect(() => {
    const pageArgs = argsRef.current;
    if (!pageArgs || !requestKey) {
      readGeneration.current += 1;
      moreGeneration.current += 1;
      totalsGeneration.current += 1;
      requestKeyRef.current = null;
      shownArgs.current = null;
      cursorRef.current = null;
      scopeKeyRef.current = null;
      setList((s) => (s.status === 'unauthorized' ? s : LIST_IDLE));
      return;
    }
    void loadFirst(pageArgs, requestKey);
  }, [requestKey, reloadTick, loadFirst]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  const loadMore = useCallback(async () => {
    const pageArgs = shownArgs.current;
    const cursor = cursorRef.current;
    if (!pageArgs || !cursor || moreInFlight.current) return;
    moreInFlight.current = true;
    const generation = readGeneration.current;
    const more = ++moreGeneration.current;
    const access = accessGeneration.current;
    const key = requestKeyRef.current;
    const scopeKey = scopeKeyRef.current;
    setList((s) => ({ ...s, loadingMore: true, moreProblem: null }));
    const current = () =>
      mounted.current &&
      generation === readGeneration.current &&
      more === moreGeneration.current &&
      access === accessGeneration.current &&
      key === requestKeyRef.current &&
      accountCurrent.current();

    let response: { data: unknown; error: unknown };
    try {
      response = await supabase.rpc('fn_cashier_statement_page', {
        ...pageArgs,
        // Verbatim: the server checks its fingerprint against this request.
        p_cursor: cursor,
        p_limit: STATEMENT_PAGE_SIZE,
      });
    } catch (e) {
      response = { data: null, error: e };
    }
    if (!current()) return;
    moreInFlight.current = false;
    if (response.error) {
      reportError(response.error, 'CashierStatements.loadMore');
      if (isAccessRefusal(response.error)) return revoke('refused');
      setList((s) => ({ ...s, loadingMore: false, moreProblem: readProblem(response.error) }));
      return;
    }
    let page: ParsedStatementPage;
    try {
      page = parseStatementPage(response.data);
    } catch (e) {
      reportError(e, 'CashierStatements.loadMore');
      setList((s) => ({ ...s, loadingMore: false, moreProblem: 'malformed' }));
      return;
    }
    if (!page.authorized) return revoke('refused');
    // A role or downline change between pages would splice two scopes into
    // one statement. Clear it and let the server say what is visible now.
    if (`${page.viewer}|${page.scope}` !== scopeKey) return revoke('access_changed');
    cursorRef.current = page.nextCursor;
    setList((s) => {
      const seen = new Set(s.rows.map((r) => `${r.source}:${r.id}`));
      const fresh = page.rows.filter((r) => !seen.has(`${r.source}:${r.id}`));
      return {
        ...s,
        rows: [...s.rows, ...fresh],
        nextCursor: page.nextCursor,
        loadingMore: false,
        moreProblem: null,
      };
    });
  }, [revoke]);

  const prepareExport = useCallback(async () => {
    const pageArgs = shownArgs.current;
    const key = requestKeyRef.current;
    const scopeKey = scopeKeyRef.current;
    if (!pageArgs || !key || !scopeKey) return;
    if (exportJob.current) dropExport(true);
    const generation = ++exportGeneration.current;
    const access = accessGeneration.current;
    setExportView({ ...EXPORT_IDLE, status: 'preparing' });
    const current = () =>
      mounted.current &&
      generation === exportGeneration.current &&
      access === accessGeneration.current &&
      key === requestKeyRef.current &&
      scopeKey === scopeKeyRef.current &&
      accountCurrent.current();

    let response: { data: unknown; error: unknown };
    try {
      response = await supabase.rpc('fn_cashier_statement_export_start', {
        ...pageArgs,
        p_request_id: newRequestId(),
      });
    } catch (e) {
      response = { data: null, error: e };
    }
    const data = isObject(response.data) ? response.data : null;
    const exportId = data && typeof data.export_id === 'string' ? data.export_id : null;
    if (!current()) {
      // Prepared for a request that is no longer on screen: release it.
      if (!response.error && exportId && UUID.test(exportId) && accountCurrent.current()) {
        void cancelQuietly(exportId);
      }
      return;
    }
    if (response.error) {
      reportError(response.error, 'CashierStatements.exportStart');
      if (isAccessRefusal(response.error)) return revoke('refused');
      const problem = exportProblem(response.error);
      setExportView({
        ...EXPORT_IDLE,
        status: problem === 'too_large' ? 'too_large' : 'error',
        problem,
      });
      return;
    }
    const totalRows = data ? Number(data.total_rows) : NaN;
    const expiresAt = data ? optionalText(data.expires_at) : null;
    if (
      !exportId ||
      !UUID.test(exportId) ||
      !Number.isSafeInteger(totalRows) ||
      totalRows < 0 ||
      totalRows > STATEMENT_EXPORT_MAX_ROWS ||
      !expiresAt ||
      !Number.isFinite(Date.parse(expiresAt))
    ) {
      reportError(new StatementMalformed('export_start'), 'CashierStatements.exportStart');
      setExportView({ ...EXPORT_IDLE, status: 'error', problem: 'malformed' });
      return;
    }
    exportJob.current = {
      exportId,
      clubId: pageArgs.p_club_id,
      requestKey: key,
      scopeKey,
      accessGeneration: access,
      totalRows,
      expiresAt,
    };
    setExportView({ ...EXPORT_IDLE, status: 'ready', totalRows, expiresAt });
  }, [dropExport, revoke]);

  const downloadExport = useCallback(
    async (filename: string) => {
      const job = exportJob.current;
      if (!job) return;
      const generation = ++exportGeneration.current;
      /** THE one `isCurrent` the file door checks: same user, club, scope, no loss. */
      const current = () =>
        mounted.current &&
        exportJob.current === job &&
        generation === exportGeneration.current &&
        job.accessGeneration === accessGeneration.current &&
        job.requestKey === requestKeyRef.current &&
        job.scopeKey === scopeKeyRef.current &&
        accountCurrent.current();
      const failed = (problem: StatementProblem) => {
        exportBuffer.current = null;
        setExportView((s) => ({ ...s, status: 'ready', problem }));
      };
      setExportView((s) => ({ ...s, status: 'downloading', problem: null }));
      const rows: StatementEntry[] = [];
      exportBuffer.current = rows;
      let offset = 0;
      const maxPages = Math.ceil(STATEMENT_EXPORT_MAX_ROWS / STATEMENT_EXPORT_PAGE_SIZE) + 1;
      for (let pageNumber = 0; ; pageNumber += 1) {
        if (pageNumber >= maxPages) return failed('malformed');
        let response: { data: unknown; error: unknown };
        try {
          response = await supabase.rpc('fn_cashier_statement_export_page', {
            p_export_id: job.exportId,
            p_offset: offset,
            p_limit: STATEMENT_EXPORT_PAGE_SIZE,
          });
        } catch (e) {
          response = { data: null, error: e };
        }
        if (!current()) {
          if (exportBuffer.current === rows) exportBuffer.current = null;
          return;
        }
        if (response.error) {
          reportError(response.error, 'CashierStatements.exportPage');
          // A changed or lost scope: the door refuses without deleting the job,
          // so revoke() clears everything and cancels it (best effort).
          if (isAccessRefusal(response.error)) return revoke('refused');
          const problem = exportProblem(response.error);
          if (problem === 'expired') {
            exportJob.current = null;
            exportBuffer.current = null;
            setExportView({ ...EXPORT_IDLE, status: 'expired', problem });
            return;
          }
          return failed(problem);
        }
        const data = isObject(response.data) ? response.data : null;
        try {
          if (!data || !Array.isArray(data.rows)) throw new StatementMalformed('export_page');
          if (Number(data.total_rows) !== job.totalRows) {
            throw new StatementMalformed('export_total');
          }
          const metadata = isObject(data.metadata) ? data.metadata : null;
          if (metadata && typeof metadata.club_id === 'string' && metadata.club_id !== job.clubId) {
            throw new StatementMalformed('export_club');
          }
          rows.push(...data.rows.map(parseStatementEntry));
          if (data.has_more !== true) break;
          const next = Number(data.next_offset);
          if (!Number.isSafeInteger(next) || next <= offset) {
            throw new StatementMalformed('export_offset');
          }
          offset = next;
        } catch (e) {
          reportError(e, 'CashierStatements.exportPage');
          return failed('malformed');
        }
      }
      // A partial file is worse than none: it reads as a complete statement.
      const unique = new Set(rows.map((r) => `${r.source}:${r.id}`));
      if (rows.length !== job.totalRows || unique.size !== rows.length) {
        reportError(new StatementMalformed('export_incomplete'), 'CashierStatements.export');
        return failed('malformed');
      }
      const blob = new Blob([buildStatementCsv(STATEMENT_CSV_COLUMNS, rows)], {
        type: 'text/csv;charset=utf-8;',
      });
      exportBuffer.current = null;
      try {
        const handed = await downloadBlob(filename, blob, current);
        if (!current()) return;
        setExportView((s) => ({
          ...s,
          status: 'ready',
          downloaded: handed !== false,
          problem: handed === false ? 'download_failed' : null,
        }));
      } catch (e) {
        if (!current()) return;
        reportError(e, 'CashierStatements.download');
        failed('download_failed');
      }
    },
    [revoke]
  );

  const cancelExport = useCallback(async () => {
    dropExport(true);
  }, [dropExport]);

  // Access loss on the master bus. A left club, a sign-out or another account
  // is final for this page; a role, membership or management change clears
  // everything now and asks the server again before anything is shown.
  useEffect(() => {
    if (!clubId) return;
    const sameClub = (payload: unknown) => {
      if (!isObject(payload)) return true;
      const id = payload.clubId ?? (payload.scope === 'club' ? payload.scopeId : undefined);
      return typeof id !== 'string' || id === '' || id === 'unknown' || id === clubId;
    };
    const payloadOf = (event: unknown) => (isObject(event) ? event.payload : undefined);
    const offs = [
      masterBus.subscribe('CLUB_LEFT', (event) => {
        if (sameClub(payloadOf(event))) revoke('left_club');
      }),
      ...ACCESS_EVENTS.map((type) =>
        masterBus.subscribe(type, (event) => {
          const payload = payloadOf(event);
          if (!sameClub(payload)) return;
          if (isObject(payload) && payload.action === 'card_backfill') return;
          revoke('access_changed');
          setReloadTick((t) => t + 1);
        })
      ),
      masterBus.subscribe('AUTH_STATE_CHANGED', (event) => {
        const payload = payloadOf(event);
        if (!isObject(payload) || payload.isAuthenticated !== true || !payload.userId) {
          revoke('signed_out');
        } else if (payload.userId !== userId) {
          revoke('account_changed');
        }
      }),
    ];
    return () => {
      for (const off of offs) if (typeof off === 'function') off();
    };
  }, [clubId, userId, revoke]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const job = exportJob.current;
      exportJob.current = null;
      exportBuffer.current = null;
      if (job && accountCurrent.current()) void cancelQuietly(job.exportId);
    };
  }, []);

  // THE RENDER GATE: rows belong to the account that read them. The moment the
  // account guard fails, nothing it read is handed to the page.
  const accountOk = isAccountCurrent();
  const view: StatementListView = accountOk
    ? {
        status: list.status,
        rows: list.rows,
        totals: list.totalsStatus === 'ready' ? list.totals : null,
        totalsStatus: list.totalsStatus,
        scope: list.scope,
        hasMore: list.nextCursor !== null,
        generatedAt: list.generatedAt,
        problem: list.problem,
        refusal: list.refusal,
        loadingMore: list.loadingMore,
        moreProblem: list.moreProblem,
      }
    : {
        ...LIST_IDLE,
        hasMore: false,
        status: 'unauthorized',
        refusal: 'account_changed',
      };

  return {
    list: view,
    exportView: accountOk ? exportView : EXPORT_IDLE,
    loadMore,
    reload,
    prepareExport,
    downloadExport,
    cancelExport,
    revoke,
  };
}
