/**
 * CASHIER FULL STATEMENT (Cashier Phase 5, 2026-09-23)
 * ============================================================================
 * Route `clubs/:clubId/cashier/statements`, linked from the Trade Record tab.
 *
 * Every entry the viewer may see across the club's wallets for a date range:
 * operation receipts (chip_transactions) and the balance movements that have
 * no receipt (chip_ledger), unified by `fn_cashier_statement_page`. The route
 * is member-reachable (`getRequiredClubOperationAccess` reads `cashier`), so
 * AUTHORIZATION COMES FROM THE SERVER: the RPC's `authorized` flag and its
 * 42501 are the only things that decide what this page may show, and a
 * refusal clears everything (useCashierStatement).
 *
 * One console, the approved spade master, `foot="foot"`. Head zones print
 * compactChips(); figures on the glass print whole chips, with cents only when
 * the ledger really holds them. Every data word reaches the screen through
 * titleCase(); immutable references print exactly as stored, so they can be
 * copied and matched.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useCashoutScope, useCashoutScopeKey } from '../hooks/useCashoutScope';
import {
  EMPTY_STATEMENT_FILTERS,
  ENTRY_DIRECTIONS,
  ENTRY_STATES,
  STATEMENT_EXPORT_MAX_ROWS,
  WALLET_FAMILIES,
  activeStatementFilterCount,
  customStatementRange,
  statementPresetRange,
  useCashierStatement,
  type EntryDirection,
  type EntryState,
  type StatementEntry,
  type StatementFilters,
  type StatementPreset,
  type StatementProblem,
  type StatementRange,
  type StatementRefusal,
  type StatementScope,
  type WalletFamily,
} from '../hooks/useCashierStatement';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { isUUID, resolveClubUUID } from '../utils/clubIdResolver';
import { copyCashierText, readCashierOnlineState } from '../services/CashierResilience';
import { compactChips } from '../utils/format';
import { enumToTitleCase, titleCase } from '../utils/titleCase';
import styles from './CashierStatementsPage.module.css';

// ─── Copy ────────────────────────────────────────────────────────────────────

const PRESETS: ReadonlyArray<[StatementPreset | 'custom', string]> = [
  ['today', 'Today'],
  ['last7', 'Last 7 Days'],
  ['last30', 'Last 30 Days'],
  ['week', 'This Week'],
  ['custom', 'Custom'],
];

const WALLET_WORD: Record<WalletFamily, string> = {
  player: 'Player',
  agent: 'Agent',
  promo: 'Promo',
  bank: 'Club Bank',
  union: 'Union',
  table: 'Table',
  ticket: 'Ticket',
  cashout: 'Cashout',
  other: 'Other',
};

const DIRECTION_WORD: Record<EntryDirection, string> = {
  in: 'Incoming',
  out: 'Outgoing',
  managed: 'Managed',
};

const STATE_WORD: Record<EntryState, string> = {
  posted: 'Posted',
  reversible: 'Reversible',
  reversed: 'Reversed',
  clawed_back: 'Clawed Back',
  pending: 'Pending',
};

const SCOPE_WORD: Record<StatementScope, string> = {
  all: 'Every Entry In This Club',
  downline: 'Your Entries And Your Downline',
  self: 'Your Own Entries',
};

const PROBLEM_WORD: Record<StatementProblem, string> = {
  range: 'Statements Cover Up To 92 Days. Narrow The Range And Try Again.',
  changed: 'This Statement Changed Since It Loaded. Reload It From The Top.',
  unavailable: 'Could Not Load This Statement. Check Your Connection And Try Again.',
  malformed: 'The Statement Came Back Incomplete, So None Of It Is Shown. Try Again.',
  too_large: `Narrow The Range. One Export Holds Up To ${STATEMENT_EXPORT_MAX_ROWS.toLocaleString('en-US')} Entries.`,
  expired: 'This Export Expired. Prepare It Again.',
  download_failed: 'The File Could Not Be Handed Off. Try The Download Again.',
};

const REFUSAL_WORD: Record<StatementRefusal, string> = {
  refused: 'Your Role In This Club Does Not Include This Statement.',
  access_changed: 'Your Access In This Club Changed. Checking What You Can Still See.',
  left_club: 'You Are No Longer A Member Of This Club.',
  signed_out: 'Sign In Again To Read This Statement.',
  account_changed: 'This Statement Belonged To Another Signed In Account.',
};

const RANGE_PROBLEM_WORD = {
  missing: 'Choose A Start Date And An End Date.',
  order: 'The Start Date Must Come Before The End Date.',
  span: 'Statements Cover Up To 92 Days. Narrow The Range.',
} as const;

// ─── Figures ─────────────────────────────────────────────────────────────────

/**
 * EXACT LEDGER FIGURES ON THE GLASS, from the server's decimal string with no
 * float in between: 12,500 when whole, 32,482.58 when the ledger holds cents.
 */
function chips(value: string): string {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const grouped = (whole.replace(/^0+(?=\d)/, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const held = /[1-9]/.test(fraction);
  const cents = fraction.length <= 2 ? fraction.padEnd(2, '0') : fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${grouped}${held ? `.${cents}` : ''}`;
}

/** A zero total carries no sign: "+0" is not a figure anybody earned. */
const isZero = (value: string) => !/[1-9]/.test(value);

const signed = (direction: EntryDirection) =>
  direction === 'in' ? '+' : direction === 'out' ? '-' : '';

const recordedAt = (iso: string, withYear = false) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });

const dayWord = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * A side of an entry. A label prints as the person or account named; with no
 * label, a receipt side ('user') is a member and a movement side is its chip
 * ledger account type ('club_treasury' -> 'Club Treasury').
 */
const partyWord = (label: string | null, type: string | null) =>
  label
    ? titleCase(label)
    : type === 'user'
      ? 'Member'
      : type
        ? titleCase(type.replace(/_/g, ' '))
        : 'Club';

/** The other side of the entry, relative to the viewer; both sides when managed. */
function counterpartyWord(entry: StatementEntry): string {
  if (entry.direction === 'managed') {
    return `${partyWord(entry.from.label, entry.from.type)} To ${partyWord(entry.to.label, entry.to.type)}`;
  }
  if (entry.counterparty) return titleCase(entry.counterparty);
  const other = entry.direction === 'in' ? entry.from : entry.to;
  return partyWord(other.label, other.type);
}

function referenceFacts(entry: StatementEntry): Array<[string, string]> {
  const r = entry.reference;
  const facts: Array<[string, string | null]> = [
    ['Reference', r.id],
    ['Operation ID', r.op_id],
    ['Idempotency Key', r.idempotency_key],
    ['Correlation ID', r.correlation_id],
    ['Ledger ID', r.ledger_id],
    ['Cashout ID', r.cashout_id],
    ['Ticket ID', r.ticket_id],
    ['Table', entry.table_id],
    ['Tournament', entry.tournament_id],
    ['Hand', entry.hand_id],
  ];
  return facts.filter((f): f is [string, string] => Boolean(f[1]));
}

function receiptText(entry: StatementEntry): string {
  const lines = [
    'Smarter Poker Cashier Statement Entry',
    `Recorded: ${entry.at}`,
    `Entry: ${enumToTitleCase(entry.kind)}`,
    `Wallet: ${WALLET_WORD[entry.wallet]}`,
    `Direction: ${DIRECTION_WORD[entry.direction]}`,
    `Amount: ${signed(entry.direction)}${chips(entry.amount)} Chips`,
    `From: ${partyWord(entry.from.label, entry.from.type)}`,
    `To: ${partyWord(entry.to.label, entry.to.type)}`,
    `State: ${STATE_WORD[entry.state]}`,
    `Source: ${entry.source === 'receipt' ? 'Cashier Receipt' : 'Ledger Movement'}`,
  ];
  if (entry.balance_after !== null) lines.push(`Balance After: ${chips(entry.balance_after)}`);
  for (const [label, value] of referenceFacts(entry)) lines.push(`${label}: ${value}`);
  return lines.join('\n');
}

// ─── The page ────────────────────────────────────────────────────────────────

/** Remounts per account and club, so nothing read for one reaches the other. */
export default function CashierStatementsPage() {
  const { clubId: clubParam } = useParams<{ clubId: string }>();
  const { user } = useAuthUser();
  const key = useCashoutScopeKey(user?.id, JSON.stringify([clubParam]));
  return <StatementsContent key={key} clubParam={clubParam ?? ''} userId={user?.id} />;
}

function StatementsContent({ clubParam, userId }: { clubParam: string; userId?: string }) {
  const navigate = useNavigate();
  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [clubMissing, setClubMissing] = useState(false);
  const [isOnline, setIsOnline] = useState(readCashierOnlineState);
  const isAccountCurrent = useCashoutScope(userId, JSON.stringify([clubParam, clubUuid]));

  const [preset, setPreset] = useState<StatementPreset | 'custom'>('last7');
  const [range, setRange] = useState<StatementRange>(() =>
    statementPresetRange('last7', Date.now())
  );
  const [customFrom, setCustomFrom] = useState(range.fromDay);
  const [customTo, setCustomTo] = useState(range.toDay);
  const [rangeProblem, setRangeProblem] = useState<keyof typeof RANGE_PROBLEM_WORD | null>(null);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState<StatementFilters>(EMPTY_STATEMENT_FILTERS);
  const [filters, setFilters] = useState<StatementFilters>(EMPTY_STATEMENT_FILTERS);

  const [openId, setOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    setIsOnline(readCashierOnlineState());
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  // isUUID, not truthiness: resolveClubUUID returns its input when it cannot
  // resolve, and a club code in a uuid argument is a 22P02, not an empty book.
  useEffect(() => {
    let live = true;
    (async () => {
      if (!clubParam) {
        setClubMissing(true);
        return;
      }
      const uuid = await resolveClubUUID(clubParam);
      if (!live) return;
      if (isUUID(uuid)) setClubUuid(uuid);
      else setClubMissing(true);
    })();
    return () => {
      live = false;
    };
  }, [clubParam]);

  const request = useMemo(
    () => (userId && clubUuid ? { from: range.from, to: range.to, filters } : null),
    [userId, clubUuid, range.from, range.to, filters]
  );

  const statement = useCashierStatement({ userId, clubId: clubUuid, request, isAccountCurrent });
  const { list, exportView } = statement;
  const refused = list.status === 'unauthorized';
  const activeFilters = activeStatementFilterCount(filters);

  const choosePreset = useCallback((next: StatementPreset | 'custom') => {
    setPreset(next);
    setRangeProblem(null);
    setOpenId(null);
    if (next !== 'custom') setRange(statementPresetRange(next, Date.now()));
  }, []);

  const applyCustom = useCallback(() => {
    const result = customStatementRange(customFrom, customTo);
    if ('problem' in result) {
      setRangeProblem(result.problem);
      return;
    }
    setRangeProblem(null);
    setOpenId(null);
    setRange(result.range);
  }, [customFrom, customTo]);

  const copy = useCallback(async (id: string, text: string) => {
    const ok = await copyCashierText(text);
    setCopiedId(ok ? id : null);
  }, []);

  const pillText = refused
    ? 'Refused'
    : !isOnline
      ? 'Locked'
      : list.status === 'ready' && list.totals
        ? `${compactChips(list.totals.count)} ${list.totals.count === 1 ? 'Entry' : 'Entries'}`
        : list.status === 'ready'
          ? 'Live Ledger'
          : list.status === 'error'
            ? 'Unverified'
            : 'Checking';
  const pillInk =
    refused || !isOnline || list.status === 'error'
      ? 'red'
      : list.status === 'ready'
        ? 'green'
        : 'muted';

  const backToCashier = () => navigate(`/clubs/${clubParam}/cashier`);
  const ready = list.status === 'ready';
  const filename = `cashier-statement-${(clubUuid ?? 'club').slice(0, 8)}-${range.fromDay}-to-${range.toDay}.csv`;

  return (
    <div className={styles.page} data-cashier-surface="statements">
      <SpadeConsole
        eyebrow="Full Statement"
        title="Cashier"
        pill={pillText}
        pillInk={pillInk}
        foot="foot"
        className={styles.console}
      >
        <div className={styles.glass}>
          <div className={styles.topBar}>
            <button type="button" onClick={backToCashier}>
              Back To Cashier
            </button>
            <span className={styles.sectionMeta}>Pacific Accounting Days</span>
          </div>

          {clubMissing ? (
            <section className={styles.refusal} role="alert" aria-labelledby="statement-refusal">
              <span className={styles.sectionEyebrow}>Club Not Found</span>
              <h2 className={styles.sectionTitle} id="statement-refusal">
                Statement Unavailable
              </h2>
              <p className={styles.statusLine}>We Could Not Find That Club.</p>
            </section>
          ) : refused ? (
            <section className={styles.refusal} role="alert" aria-labelledby="statement-refusal">
              <span className={styles.sectionEyebrow}>Access Refused</span>
              <h2 className={styles.sectionTitle} id="statement-refusal">
                Statement Unavailable
              </h2>
              <p className={styles.statusLine}>
                {list.refusal ? REFUSAL_WORD[list.refusal] : REFUSAL_WORD.refused}
              </p>
              <div className={styles.actions}>
                {list.refusal !== 'signed_out' && list.refusal !== 'account_changed' && (
                  <button type="button" onClick={statement.reload} disabled={!isOnline}>
                    Check Again
                  </button>
                )}
              </div>
            </section>
          ) : (
            <>
              <section className={styles.section} aria-label="What You Can See">
                <span className={styles.sectionEyebrow}>What You Can See</span>
                <strong className={styles.scopeValue} role="status">
                  {ready && list.scope
                    ? SCOPE_WORD[list.scope]
                    : list.status === 'error'
                      ? 'Not Verified'
                      : 'Checking Your Access'}
                </strong>
                {!isOnline && (
                  <p className={`${styles.statusLine} ${styles.warn}`}>
                    Offline. Reconnect To Read The Statement.
                  </p>
                )}
              </section>

              <section className={styles.section} aria-labelledby="statement-range-title">
                <div className={styles.sectionHeading}>
                  <h2 className={styles.sectionTitle} id="statement-range-title">
                    Date Range
                  </h2>
                  <span className={styles.sectionMeta}>
                    {dayWord(range.fromDay)} To {dayWord(range.toDay)}
                  </span>
                </div>
                <div className={styles.choices} aria-label="Choose A Date Range">
                  {PRESETS.map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`${styles.choice} ${preset === key ? styles.choiceActive : ''}`}
                      aria-pressed={preset === key}
                      onClick={() => choosePreset(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {preset === 'custom' && (
                  <>
                    <div className={styles.customRange}>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>From</span>
                        <input
                          type="date"
                          value={customFrom}
                          max={customTo || undefined}
                          onChange={(event) => setCustomFrom(event.target.value)}
                          aria-label="Statement Start Date"
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>To</span>
                        <input
                          type="date"
                          value={customTo}
                          min={customFrom || undefined}
                          onChange={(event) => setCustomTo(event.target.value)}
                          aria-label="Statement End Date"
                        />
                      </label>
                    </div>
                    <div className={styles.actions}>
                      <button type="button" onClick={applyCustom}>
                        Show Range
                      </button>
                      <span className={styles.sectionMeta}>Up To 92 Days</span>
                    </div>
                    {rangeProblem && (
                      <p className={`${styles.statusLine} ${styles.warn}`} role="alert">
                        {RANGE_PROBLEM_WORD[rangeProblem]}
                      </p>
                    )}
                  </>
                )}
              </section>

              <section className={styles.section} aria-labelledby="statement-filters-title">
                <div className={styles.sectionHeading}>
                  <h2 className={styles.sectionTitle} id="statement-filters-title">
                    Filters
                  </h2>
                  <button
                    type="button"
                    aria-expanded={filtersOpen}
                    aria-controls="statement-filters"
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    {filtersOpen
                      ? 'Hide Filters'
                      : activeFilters > 0
                        ? `Show Filters (${activeFilters} On)`
                        : 'Show Filters'}
                  </button>
                </div>
                {filtersOpen && (
                  <div id="statement-filters" className={styles.group}>
                    <div className={styles.group}>
                      <span className={styles.groupLabel}>Wallet</span>
                      <div className={styles.choices} aria-label="Filter By Wallet">
                        {(['any', ...WALLET_FAMILIES] as const).map((wallet) => (
                          <button
                            key={wallet}
                            type="button"
                            className={`${styles.choice} ${draft.wallet === wallet ? styles.choiceActive : ''}`}
                            aria-pressed={draft.wallet === wallet}
                            onClick={() => setDraft((d) => ({ ...d, wallet }))}
                          >
                            {wallet === 'any' ? 'Any' : WALLET_WORD[wallet]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className={styles.group}>
                      <span className={styles.groupLabel}>Direction</span>
                      <div className={styles.choices} aria-label="Filter By Direction">
                        {(['any', ...ENTRY_DIRECTIONS] as const).map((direction) => (
                          <button
                            key={direction}
                            type="button"
                            className={`${styles.choice} ${draft.direction === direction ? styles.choiceActive : ''}`}
                            aria-pressed={draft.direction === direction}
                            onClick={() => setDraft((d) => ({ ...d, direction }))}
                          >
                            {direction === 'any' ? 'Any' : DIRECTION_WORD[direction]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className={styles.group}>
                      <span className={styles.groupLabel}>State</span>
                      <div className={styles.choices} aria-label="Filter By State">
                        {(['any', ...ENTRY_STATES] as const).map((state) => (
                          <button
                            key={state}
                            type="button"
                            className={`${styles.choice} ${draft.state === state ? styles.choiceActive : ''}`}
                            aria-pressed={draft.state === state}
                            onClick={() => setDraft((d) => ({ ...d, state }))}
                          >
                            {state === 'any' ? 'Any' : STATE_WORD[state]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Entry Type</span>
                      <input
                        type="search"
                        value={draft.operation}
                        maxLength={64}
                        onChange={(event) =>
                          setDraft((d) => ({ ...d, operation: event.target.value }))
                        }
                        placeholder="For Example Agent Wallet Send"
                        aria-label="Filter By Entry Type"
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Counterparty</span>
                      <input
                        type="search"
                        value={draft.counterparty}
                        maxLength={64}
                        onChange={(event) =>
                          setDraft((d) => ({ ...d, counterparty: event.target.value }))
                        }
                        placeholder="Name Or Member ID"
                        aria-label="Filter By Counterparty"
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Exact Reference</span>
                      <input
                        type="search"
                        value={draft.reference}
                        maxLength={128}
                        onChange={(event) =>
                          setDraft((d) => ({ ...d, reference: event.target.value }))
                        }
                        placeholder="Reference, Operation Or Ledger ID"
                        aria-label="Filter By Exact Reference"
                      />
                    </label>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenId(null);
                          setFilters(draft);
                        }}
                      >
                        Apply Filters
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenId(null);
                          setDraft(EMPTY_STATEMENT_FILTERS);
                          setFilters(EMPTY_STATEMENT_FILTERS);
                        }}
                      >
                        Clear Filters
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {ready && list.totalsStatus !== 'ready' ? (
                <div className={styles.totals} aria-label="Statement Totals">
                  <div className={styles.totalsWide}>
                    <span className={styles.totalLabel}>Totals</span>
                    <strong
                      className={`${styles.totalsWord} ${list.totalsStatus === 'unavailable' ? styles.warn : ''}`}
                      role="status"
                    >
                      {list.totalsStatus === 'unavailable'
                        ? 'Unavailable For This Range'
                        : 'Calculating'}
                    </strong>
                  </div>
                </div>
              ) : (
                <div className={styles.totals} aria-label="Statement Totals">
                  <div className={styles.totalCell}>
                    <span className={styles.totalLabel}>In</span>
                    <strong className={`${styles.totalValue} ${list.totals ? styles.amtIn : ''}`}>
                      {list.totals
                        ? `${isZero(list.totals.in) ? '' : '+'}${chips(list.totals.in)}`
                        : '-'}
                    </strong>
                  </div>
                  <div className={styles.totalCell}>
                    <span className={styles.totalLabel}>Out</span>
                    <strong className={`${styles.totalValue} ${list.totals ? styles.amtOut : ''}`}>
                      {list.totals
                        ? `${isZero(list.totals.out) ? '' : '-'}${chips(list.totals.out)}`
                        : '-'}
                    </strong>
                  </div>
                  <div className={styles.totalCell}>
                    <span className={styles.totalLabel}>Managed</span>
                    <strong className={styles.totalValue}>
                      {list.totals ? chips(list.totals.managed) : '-'}
                    </strong>
                  </div>
                  <div className={styles.totalCell}>
                    <span className={styles.totalLabel}>Entries</span>
                    <strong className={styles.totalValue}>
                      {list.totals ? list.totals.count.toLocaleString('en-US') : '-'}
                    </strong>
                  </div>
                </div>
              )}

              <section className={styles.section} aria-labelledby="statement-export-title">
                <div className={styles.sectionHeading}>
                  <h2 className={styles.sectionTitle} id="statement-export-title">
                    Export
                  </h2>
                  {(exportView.status === 'idle' ||
                    exportView.status === 'too_large' ||
                    exportView.status === 'error' ||
                    exportView.status === 'preparing') && (
                    <button
                      type="button"
                      onClick={() => void statement.prepareExport()}
                      disabled={
                        !ready ||
                        !isOnline ||
                        exportView.status === 'preparing' ||
                        list.rows.length === 0
                      }
                    >
                      {exportView.status === 'preparing'
                        ? 'Preparing Export'
                        : exportView.status === 'error'
                          ? 'Try Export Again'
                          : 'Export CSV'}
                    </button>
                  )}
                  {exportView.status === 'expired' && (
                    <button
                      type="button"
                      onClick={() => void statement.prepareExport()}
                      disabled={!ready || !isOnline}
                    >
                      Prepare Again
                    </button>
                  )}
                </div>
                <p
                  className={`${styles.statusLine} ${exportView.problem ? styles.warn : ''}`}
                  role="status"
                >
                  {exportView.status === 'preparing'
                    ? 'Preparing Every Entry In This Range On The Server.'
                    : exportView.status === 'ready' || exportView.status === 'downloading'
                      ? exportView.problem
                        ? PROBLEM_WORD[exportView.problem]
                        : `${(exportView.totalRows ?? 0).toLocaleString('en-US')} ${exportView.totalRows === 1 ? 'Entry' : 'Entries'} Ready. Expires At ${exportView.expiresAt ? recordedAt(exportView.expiresAt) : ''}.${exportView.downloaded ? ' Downloaded.' : ''}`
                      : exportView.problem
                        ? PROBLEM_WORD[exportView.problem]
                        : `Exports The Whole Range As A CSV File, Up To ${STATEMENT_EXPORT_MAX_ROWS.toLocaleString('en-US')} Entries.`}
                </p>
                {(exportView.status === 'ready' || exportView.status === 'downloading') && (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      onClick={() => void statement.downloadExport(filename)}
                      disabled={exportView.status === 'downloading' || !isOnline}
                    >
                      {exportView.status === 'downloading' ? 'Downloading' : 'Download CSV'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void statement.cancelExport()}
                      disabled={exportView.status === 'downloading'}
                    >
                      Cancel Export
                    </button>
                  </div>
                )}
              </section>

              <section className={styles.section} aria-labelledby="statement-entries-title">
                <div className={styles.sectionHeading}>
                  <h2 className={styles.sectionTitle} id="statement-entries-title">
                    Entries
                  </h2>
                  <span className={styles.sectionMeta}>Newest First</span>
                </div>
                <div className={styles.list} aria-busy={list.status === 'loading'}>
                  {(list.status === 'loading' || list.status === 'idle') && (
                    <p className={styles.empty}>Loading Statement...</p>
                  )}
                  {list.status === 'error' && (
                    <p className={`${styles.empty} ${styles.warn}`} role="alert">
                      {PROBLEM_WORD[list.problem ?? 'unavailable']}{' '}
                      <button type="button" className={styles.retryWord} onClick={statement.reload}>
                        Retry
                      </button>
                    </p>
                  )}
                  {ready && list.rows.length === 0 && (
                    <p className={styles.empty}>
                      {activeFilters > 0
                        ? 'No Entries Match These Filters.'
                        : 'No Entries In This Range.'}
                    </p>
                  )}
                  {ready &&
                    list.rows.map((entry) => {
                      const rowKey = `${entry.source}:${entry.id}`;
                      const open = openId === rowKey;
                      const factsId = `statement-entry-${entry.source}-${entry.id}`;
                      return (
                        <div key={rowKey} className={styles.entry}>
                          <button
                            type="button"
                            className={styles.entryMain}
                            aria-expanded={open}
                            aria-controls={factsId}
                            onClick={() => setOpenId(open ? null : rowKey)}
                          >
                            <span className={styles.rowInfo}>
                              <span className={styles.rowName}>
                                {entry.direction === 'managed'
                                  ? 'Transfer '
                                  : entry.direction === 'out'
                                    ? 'To '
                                    : 'From '}
                                {counterpartyWord(entry)}
                              </span>
                              <span className={styles.rowSub}>
                                {enumToTitleCase(entry.kind)} &middot; {WALLET_WORD[entry.wallet]}{' '}
                                &middot; {STATE_WORD[entry.state]} &middot; {recordedAt(entry.at)}
                              </span>
                            </span>
                            <span
                              className={`${styles.rowAmount} ${entry.direction === 'in' ? styles.amtIn : entry.direction === 'out' ? styles.amtOut : ''}`}
                            >
                              {signed(entry.direction)}
                              {chips(entry.amount)}
                            </span>
                          </button>
                          <div className={styles.entryRef}>
                            <span className={styles.refShort}>
                              Ref {entry.reference.id.slice(0, 8).toUpperCase()}
                            </span>
                            <button
                              type="button"
                              className={styles.copyWord}
                              onClick={() => void copy(rowKey, entry.reference.id)}
                              aria-label="Copy Reference"
                            >
                              {copiedId === rowKey ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                          {open && (
                            <dl className={styles.facts} id={factsId}>
                              <div>
                                <dt className={styles.fieldLabel}>Entry</dt>
                                <dd>{enumToTitleCase(entry.kind)}</dd>
                              </div>
                              <div>
                                <dt className={styles.fieldLabel}>Wallet</dt>
                                <dd>{WALLET_WORD[entry.wallet]}</dd>
                              </div>
                              <div>
                                <dt className={styles.fieldLabel}>From</dt>
                                <dd>{partyWord(entry.from.label, entry.from.type)}</dd>
                              </div>
                              <div>
                                <dt className={styles.fieldLabel}>To</dt>
                                <dd>{partyWord(entry.to.label, entry.to.type)}</dd>
                              </div>
                              <div>
                                <dt className={styles.fieldLabel}>State</dt>
                                <dd>{STATE_WORD[entry.state]}</dd>
                              </div>
                              <div>
                                <dt className={styles.fieldLabel}>Recorded</dt>
                                <dd>{recordedAt(entry.at, true)}</dd>
                              </div>
                              <div>
                                <dt className={styles.fieldLabel}>Source</dt>
                                <dd>
                                  {entry.source === 'receipt'
                                    ? 'Cashier Receipt'
                                    : 'Ledger Movement'}
                                </dd>
                              </div>
                              {entry.balance_after !== null && (
                                <div>
                                  <dt className={styles.fieldLabel}>Balance After</dt>
                                  <dd>{chips(entry.balance_after)}</dd>
                                </div>
                              )}
                              {entry.notes && (
                                <div>
                                  <dt className={styles.fieldLabel}>Notes</dt>
                                  <dd>{titleCase(entry.notes)}</dd>
                                </div>
                              )}
                              {referenceFacts(entry).map(([label, value]) => (
                                <div key={label}>
                                  <dt className={styles.fieldLabel}>{label}</dt>
                                  <dd>
                                    <code className={styles.refValue} data-reference="">
                                      {value}
                                    </code>
                                  </dd>
                                </div>
                              ))}
                              <div>
                                <dt className={styles.fieldLabel}>Receipt</dt>
                                <dd>
                                  <button
                                    type="button"
                                    className={styles.copyWord}
                                    onClick={() =>
                                      void copy(`${rowKey}:receipt`, receiptText(entry))
                                    }
                                  >
                                    {copiedId === `${rowKey}:receipt` ? 'Copied' : 'Copy Receipt'}
                                  </button>
                                </dd>
                              </div>
                            </dl>
                          )}
                        </div>
                      );
                    })}
                  {ready && list.moreProblem && (
                    <p className={`${styles.empty} ${styles.warn}`} role="alert">
                      {PROBLEM_WORD[list.moreProblem]}{' '}
                      <button
                        type="button"
                        className={styles.retryWord}
                        onClick={() =>
                          list.moreProblem === 'changed'
                            ? statement.reload()
                            : void statement.loadMore()
                        }
                      >
                        {list.moreProblem === 'changed' ? 'Reload' : 'Retry'}
                      </button>
                    </p>
                  )}
                  {ready && list.hasMore && !list.moreProblem && (
                    <button
                      type="button"
                      className={styles.loadMore}
                      onClick={() => void statement.loadMore()}
                      disabled={list.loadingMore || !isOnline}
                    >
                      {list.loadingMore ? 'Loading More' : 'Load More'}
                    </button>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </SpadeConsole>
    </div>
  );
}
