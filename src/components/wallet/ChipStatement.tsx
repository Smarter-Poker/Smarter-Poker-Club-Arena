/**
 * CHIP STATEMENT - a player can audit their own chips (phase 7, roadmap 9.5).
 *
 * "A standard nobody outside the team can check is half a standard, and this
 *  is also the cheapest support tool on the platform: 'where did my chips go'
 *  answers itself. Same for a club operator and their treasury."
 *
 * One RPC, fn_ca_chip_statement_page, answers three things and this renders them:
 *
 *   1. THE BALANCE NOW, per club and in total (scope=player), or the club's
 *      treasury (scope=club_treasury).
 *   2. THE LEGS, both directions, newest first, from this account's point of
 *      view: what came in, what went out, from or to what. The surface this
 *      replaces on the wallet page asked chip_ledger only for legs where the
 *      player was `performed_by` or `to_entity_id`, so every chip that LEFT
 *      the player - buy-ins, entries, rebuys - was invisible.
 *   3. THE AUDIT. The platform reads every wallet against the journal nightly
 *      (fn_ca_ledger_replay -> ca_account_snapshots). This shows that reading
 *      and the arithmetic since it: balance at reading + in - out = expected,
 *      against the balance now. The three numbers are the same three the
 *      platform's own control uses; the player is not shown a friendlier
 *      version of the truth.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). The RPC binds scope=player to
 * auth.uid() and has no horse branch; this component has none either.
 *
 * Mobile first: one column at 375px, the audit line wraps, every tap target
 * is 44px.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TournamentPaymentStatus from '../tournament/TournamentPaymentStatus';
import { SpadeConsole } from '../console/SpadeConsole';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useCashoutScope, useCashoutScopeKey } from '../../hooks/useCashoutScope';
import { supabase } from '../../lib/supabase';
import { isAuthzError } from '../../utils/clubDashboard';
import { reportError } from '../../utils/errorReporter';
import { compactChips } from '../../utils/format';
import { titleCase } from '../../utils/titleCase';
import './ChipStatement.css';

export type StatementScope = 'player' | 'club_treasury';

export interface StatementLeg {
  id: string;
  at: string;
  direction: 'in' | 'out';
  amount: number;
  category: string;
  description: string | null;
  counterparty_type: string | null;
  counterparty_label: string | null;
  counterparty_id: string | null;
  club_id: string | null;
  table_id: string | null;
  tournament_id: string | null;
  hand_id: string | null;
  settlement_id: string | null;
}

export interface StatementAudit {
  status: 'reconciles' | 'does_not_reconcile' | 'no_reading_yet' | 'no_balance';
  detail?: string;
  read_at?: string;
  balance_at_reading?: number;
  reading_is_baseline?: boolean;
  cumulative_unexplained_at_reading?: number;
  in_since?: number;
  out_since?: number;
  legs_since?: number;
  expected_now?: number;
  balance_now?: number;
  unexplained?: number | null;
}

export interface Statement {
  scope: StatementScope;
  entity_id: string;
  account: string;
  club_filter: string | null;
  balance_now: number;
  balance_exists: boolean;
  clubs: { club_id: string; club_name: string; balance: number }[];
  legs: StatementLeg[];
  has_more: boolean;
  next_before: string | null;
  next_cursor: StatementCursor | null;
  audit: StatementAudit;
  generated_at: string;
  ms: number;
}

export interface StatementCursor {
  at: string;
  id: string;
  direction: 'in' | 'out';
  account: string;
  club_filter: string | null;
}

/** The live journal vocabulary, in the player's words. Unknown categories are
 *  shown as they are, never hidden: a leg with a name nobody mapped is still a
 *  leg. */
const CATEGORY_LABEL: Record<string, string> = {
  buyin: 'Table Buy-In',
  addon: 'Add-On',
  rebuy: 'Rebuy',
  table_cashout: 'Table Cash-Out',
  settlement: 'Table Settlement',
  tournament_buyin: 'Tournament Entry',
  tournament_prize: 'Tournament Prize',
  bounty: 'Bounty',
  spin_entry: 'Spin Entry',
  spin_prize: 'Spin Prize',
  rake: 'Rake',
  rakeback: 'Rakeback',
  bbj_contribution: 'Jackpot Contribution',
  bbj_payout: 'Jackpot Payout',
  promo: 'Promo Chips',
  refund: 'Refund',
  overlay: 'Overlay',
  adjustment: 'Adjustment',
  correction: 'Correction',
  horse_funding: 'Table Funding',
  player_funding: 'Chips From The Club',
  transfer: 'Transfer',
  cashout: 'Cash-Out',
  deposit: 'Deposit',
  mint: 'Chips Issued',
};

const COUNTERPARTY_LABEL: Record<string, string> = {
  table_stack: 'A Table',
  prize_liability: 'A Prize Pool',
  player_wallet: 'A Player',
  club_treasury: 'The Club',
  union_wallet: 'The Union',
  union_bank: 'The Union Bank',
  bbj_pool: 'The Jackpot',
  spin_reserve: 'The Spin Reserve',
  promo_wallet: 'A Promo Wallet',
  agent_wallet: 'An Agent',
  settlement_suspense: 'Settlement',
  system_mint: 'The Mint',
  system_burn: 'The Mint',
};

export function categoryLabel(category: string): string {
  return (
    CATEGORY_LABEL[category] || category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * chip_ledger.from_label / to_label usually name the STORAGE the chips moved
 * through (`clubs.chip_treasury`, `bbj_pools.main_balance`), not a phrase for
 * a person. Those paths are given their account name here; a path this map
 * does not know is left off rather than printed, because a table and column
 * name is never copy (financial-admin-deep.spec.ts, RAW_ENUM_IN_COPY). A
 * label that is already words ("Tournament Entry Ticket") is shown as words.
 */
const COUNTERPARTY_ACCOUNT_LABEL: Record<string, string> = {
  'clubs.chip_treasury': 'Club Treasury',
  'clubs.promo_balance': 'Club Promo Wallet',
  'union_wallets.chip_balance': 'Union Bank',
  'union_wallets.rake_wallet': 'Union Rake Wallet',
  'union_wallets.promo_wallet': 'Union Promo Wallet',
  'bbj_pools.main_balance': 'Jackpot Main Pool',
  'bbj_pools.backup_balance': 'Jackpot Backup Pool',
  'bbj_pools.promo_balance': 'Jackpot Promo Pool',
  'spin_bonus_pools.balance': 'Spin Pool',
  'tournaments.prize_pool': 'Prize Pool',
  'tournaments.prize_pool+total_rake': 'Prize Pool And Rake',
};

const STORAGE_PATH = /^[a-z][a-z0-9_]*\.[a-z0-9_+]+$/;

export function counterpartyDetail(label: string | null): string | null {
  const raw = (label || '').trim();
  if (!raw) return null;
  if (COUNTERPARTY_ACCOUNT_LABEL[raw]) return COUNTERPARTY_ACCOUNT_LABEL[raw];
  if (STORAGE_PATH.test(raw) || raw.includes('_')) return null;
  return titleCase(raw);
}

export function counterpartyLabel(leg: StatementLeg): string {
  const type = leg.counterparty_type || '';
  const base =
    COUNTERPARTY_LABEL[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const detail = counterpartyDetail(leg.counterparty_label);
  if (!base) return detail || 'Unknown';
  return detail && detail !== base ? `${base} (${detail})` : base;
}

/** The canonical response keeps exact chip cents. The forward-facing console
 * follows the whole/compact chip law without calling a real sub-chip amount
 * zero. */
function statementChips(n: number | null | undefined): string {
  const value = Number(n ?? 0);
  if (Number.isFinite(value) && value !== 0 && Math.abs(value) < 1) {
    return value < 0 ? 'Under 1 Chip Owed' : 'Under 1 Chip';
  }
  return compactChips(value);
}

const signedStatementChips = (direction: StatementLeg['direction'], n: number): string => {
  if (n > 0 && n < 1) return `Under 1 Chip ${direction === 'in' ? 'In' : 'Out'}`;
  return `${direction === 'in' ? '+' : '-'}${compactChips(n)}`;
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function nullableTextValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  return textValue(value, label);
}

function finiteValue(value: unknown, label: string, minimum?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (minimum !== undefined && value < minimum)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestampValue(value: unknown, label: string): string {
  const timestamp = textValue(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid`);
  return timestamp;
}

function timestampMicros(timestamp: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    timestamp
  );
  if (!match) throw new Error('Statement timestamp is invalid');
  const atSecond = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(atSecond)) throw new Error('Statement timestamp is invalid');
  return BigInt(atSecond) * 1_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function nullableIdentity(value: unknown, label: string): string | null {
  if (value === null) return null;
  return textValue(value, label);
}

function parseCursor(
  raw: unknown,
  expectedAccount: string,
  expectedClub: string | null
): StatementCursor {
  const cursor = objectValue(raw, 'Statement cursor');
  const direction = cursor.direction;
  if (direction !== 'in' && direction !== 'out') {
    throw new Error('Statement cursor direction is invalid');
  }
  const parsed: StatementCursor = {
    at: timestampValue(cursor.at, 'Statement cursor timestamp'),
    id: textValue(cursor.id, 'Statement cursor identity'),
    direction,
    account: textValue(cursor.account, 'Statement cursor account'),
    club_filter: nullableIdentity(cursor.club_filter, 'Statement cursor club'),
  };
  if (parsed.account !== expectedAccount || parsed.club_filter !== expectedClub) {
    throw new Error('Statement cursor does not match this account and view');
  }
  return parsed;
}

function rowComesAfterCursor(leg: StatementLeg, cursor: StatementCursor): boolean {
  const legAt = timestampMicros(leg.at);
  const cursorAt = timestampMicros(cursor.at);
  if (legAt !== cursorAt) return legAt < cursorAt;
  if (leg.id !== cursor.id) return leg.id < cursor.id;
  return leg.direction > cursor.direction;
}

function rowsAreOrdered(previous: StatementLeg, current: StatementLeg): boolean {
  const previousAt = timestampMicros(previous.at);
  const currentAt = timestampMicros(current.at);
  if (previousAt !== currentAt) return previousAt > currentAt;
  if (previous.id !== current.id) return previous.id > current.id;
  return previous.direction < current.direction;
}

interface StatementPageExpectation {
  scope: StatementScope;
  clubId: string | null;
  userId: string;
  requestedCursor: StatementCursor | null;
  pageSize: number;
  seenRows?: ReadonlySet<string>;
}

/** Treat an RPC success as untrusted input. A statement is only paintable when
 * its account, view, arithmetic, row order and continuation all belong to the
 * exact read that requested it. */
function parseStatementPage(raw: unknown, expected: StatementPageExpectation): Statement {
  const page = objectValue(raw, 'Statement response');
  const expectedEntity = expected.scope === 'player' ? expected.userId : expected.clubId;
  if (!expectedEntity) throw new Error('Statement account identity is missing');
  const expectedClub = expected.clubId ?? null;
  const expectedAccount =
    expected.scope === 'player'
      ? `player_wallet:${expected.userId}:club_members.chip_balance`
      : `club_treasury:${expectedEntity}:clubs.chip_treasury`;
  if (
    page.scope !== expected.scope ||
    page.entity_id !== expectedEntity ||
    page.account !== expectedAccount ||
    page.club_filter !== expectedClub
  ) {
    throw new Error('Statement response does not match this account and view');
  }
  if (typeof page.balance_exists !== 'boolean' || typeof page.has_more !== 'boolean') {
    throw new Error('Statement response shape is invalid');
  }
  const balanceNow = finiteValue(page.balance_now, 'Statement balance');
  if (!Array.isArray(page.clubs) || !Array.isArray(page.legs)) {
    throw new Error('Statement response arrays are invalid');
  }
  if (page.legs.length > expected.pageSize) throw new Error('Statement page is oversized');

  const clubIds = new Set<string>();
  const clubs = page.clubs.map((rawClub) => {
    const club = objectValue(rawClub, 'Statement club');
    const clubId = textValue(club.club_id, 'Statement club identity');
    if (clubIds.has(clubId)) throw new Error('Statement club is duplicated');
    clubIds.add(clubId);
    return {
      club_id: clubId,
      club_name: textValue(club.club_name, 'Statement club name'),
      balance: finiteValue(club.balance, 'Statement club balance'),
    };
  });

  const identities = new Set(expected.seenRows ?? []);
  const legs = page.legs.map((rawLeg) => {
    const leg = objectValue(rawLeg, 'Statement row');
    const direction = leg.direction;
    if (direction !== 'in' && direction !== 'out')
      throw new Error('Statement direction is invalid');
    const parsed: StatementLeg = {
      id: textValue(leg.id, 'Statement row identity'),
      at: timestampValue(leg.at, 'Statement row timestamp'),
      direction,
      amount: finiteValue(leg.amount, 'Statement row amount', 0),
      category: textValue(leg.category, 'Statement row category'),
      description: nullableTextValue(leg.description, 'Statement row description'),
      counterparty_type: nullableTextValue(leg.counterparty_type, 'Statement counterparty type'),
      counterparty_label: nullableTextValue(leg.counterparty_label, 'Statement counterparty label'),
      counterparty_id: nullableIdentity(leg.counterparty_id, 'Statement counterparty identity'),
      club_id: nullableIdentity(leg.club_id, 'Statement row club'),
      table_id: nullableIdentity(leg.table_id, 'Statement table identity'),
      tournament_id: nullableIdentity(leg.tournament_id, 'Statement tournament identity'),
      hand_id: nullableIdentity(leg.hand_id, 'Statement hand identity'),
      settlement_id: nullableIdentity(leg.settlement_id, 'Statement settlement identity'),
    };
    if (expectedClub && parsed.club_id !== expectedClub) {
      throw new Error('Statement row does not match this club');
    }
    const identity = `${parsed.id}:${parsed.direction}`;
    if (identities.has(identity)) throw new Error('Statement row is duplicated');
    identities.add(identity);
    if (expected.requestedCursor && !rowComesAfterCursor(parsed, expected.requestedCursor)) {
      throw new Error('Statement page does not continue from its requested cursor');
    }
    return parsed;
  });
  for (let index = 1; index < legs.length; index += 1) {
    if (!rowsAreOrdered(legs[index - 1], legs[index])) {
      throw new Error('Statement rows are out of order');
    }
  }

  const nextBefore =
    page.next_before === null ? null : timestampValue(page.next_before, 'Statement continuation');
  const nextCursor =
    page.next_cursor === null ? null : parseCursor(page.next_cursor, expectedAccount, expectedClub);
  if (page.has_more) {
    const last = legs[legs.length - 1];
    if (
      !last ||
      !nextCursor ||
      nextCursor.at !== last.at ||
      nextCursor.id !== last.id ||
      nextCursor.direction !== last.direction ||
      nextBefore !== last.at
    ) {
      throw new Error('Statement continuation does not match the last row');
    }
  } else if (nextCursor !== null) {
    throw new Error('Statement continuation is inconsistent');
  }

  const rawAudit = objectValue(page.audit, 'Statement audit');
  const status = rawAudit.status;
  if (
    status !== 'reconciles' &&
    status !== 'does_not_reconcile' &&
    status !== 'no_reading_yet' &&
    status !== 'no_balance'
  ) {
    throw new Error('Statement audit status is invalid');
  }
  const audit: StatementAudit = { status };
  if (rawAudit.detail !== undefined)
    audit.detail = textValue(rawAudit.detail, 'Statement audit detail');
  if (rawAudit.read_at !== undefined)
    audit.read_at = timestampValue(rawAudit.read_at, 'Statement audit reading');
  if (rawAudit.reading_is_baseline !== undefined) {
    if (typeof rawAudit.reading_is_baseline !== 'boolean')
      throw new Error('Statement audit baseline is invalid');
    audit.reading_is_baseline = rawAudit.reading_is_baseline;
  }
  const auditNumbers = [
    'balance_at_reading',
    'cumulative_unexplained_at_reading',
    'in_since',
    'out_since',
    'expected_now',
    'balance_now',
  ] as const;
  for (const key of auditNumbers) {
    if (rawAudit[key] !== undefined)
      audit[key] = finiteValue(rawAudit[key], `Statement audit ${key}`);
  }
  if (rawAudit.legs_since !== undefined) {
    const count = finiteValue(rawAudit.legs_since, 'Statement audit movement count', 0);
    if (!Number.isSafeInteger(count)) throw new Error('Statement audit movement count is invalid');
    audit.legs_since = count;
  }
  if (rawAudit.unexplained !== undefined) {
    audit.unexplained =
      rawAudit.unexplained === null
        ? null
        : finiteValue(rawAudit.unexplained, 'Statement audit difference');
  }
  if (audit.balance_now !== undefined && audit.balance_now !== balanceNow) {
    throw new Error('Statement audit balance does not match the statement');
  }
  if (status === 'no_reading_yet') {
    if (audit.balance_now !== balanceNow) throw new Error('Statement audit balance is missing');
  } else if (
    !audit.read_at ||
    audit.balance_at_reading === undefined ||
    audit.in_since === undefined ||
    audit.out_since === undefined ||
    audit.legs_since === undefined ||
    audit.expected_now === undefined ||
    audit.balance_now === undefined ||
    (status !== 'no_balance' && audit.unexplained === undefined)
  ) {
    throw new Error('Statement audit is incomplete');
  }

  return {
    scope: expected.scope,
    entity_id: expectedEntity,
    account: expectedAccount,
    club_filter: expectedClub,
    balance_now: balanceNow,
    balance_exists: page.balance_exists,
    clubs,
    legs,
    has_more: page.has_more,
    next_before: nextBefore,
    next_cursor: nextCursor,
    audit,
    generated_at: timestampValue(page.generated_at, 'Statement generation time'),
    ms: finiteValue(page.ms, 'Statement duration', 0),
  };
}

interface Props {
  scope: StatementScope;
  /** Required for club_treasury; optional club filter for a player. */
  clubId?: string | null;
  pageSize?: number;
  title?: string;
}

interface BoundProps extends Props {
  actorId: string;
  viewKey: string;
}

function ChipStatementRows({ scope, clubId, pageSize = 50, title, actorId, viewKey }: BoundProps) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [legs, setLegs] = useState<StatementLeg[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const requestSequence = useRef(0);
  const loadingMoreRef = useRef(false);
  const isScopeCurrent = useCashoutScope(actorId, viewKey);

  const load = useCallback(
    async (cursor: StatementCursor | null, seenRows: ReadonlySet<string> = new Set()) => {
      const { data, error: rpcError } = await supabase.rpc('fn_ca_chip_statement_page', {
        p_scope: scope,
        p_club_id: clubId || null,
        p_cursor: cursor,
        p_limit: pageSize,
      });
      if (rpcError) throw rpcError;
      return parseStatementPage(data, {
        scope,
        clubId: clubId ?? null,
        userId: actorId,
        requestedCursor: cursor,
        pageSize,
        seenRows,
      });
    },
    [scope, clubId, pageSize, actorId]
  );

  const loadFirst = useCallback(async () => {
    const request = ++requestSequence.current;
    const current = () => requestSequence.current === request && isScopeCurrent();
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    setDenied(false);
    setStatement(null);
    setLegs([]);
    if (!isScopeCurrent()) {
      setLoading(false);
      setError('The Statement Account Could Not Be Verified');
      return;
    }
    try {
      const s = await load(null);
      if (!current()) return;
      setStatement(s);
      setLegs(s.legs || []);
    } catch (e) {
      if (!current()) return;
      if (isAuthzError(e)) {
        setDenied(true);
      } else {
        // A discarded error read as "no movements", which on a statement is
        // the one answer that must never be guessed.
        reportError(e, 'ChipStatement.load');
        setError('The Statement Could Not Be Loaded');
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [load, isScopeCurrent]);

  const loadMore = useCallback(async () => {
    if (!statement?.has_more || !statement.next_cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const cursor = statement.next_cursor;
    const seenRows = new Set(legs.map((leg) => `${leg.id}:${leg.direction}`));
    const request = ++requestSequence.current;
    const current = () => requestSequence.current === request && isScopeCurrent();
    setLoadingMore(true);
    setMoreError(null);
    try {
      const s = await load(cursor, seenRows);
      if (!current()) return;
      setStatement((prev) =>
        prev ? { ...prev, has_more: s.has_more, next_cursor: s.next_cursor } : s
      );
      setLegs((prev) => [...prev, ...(s.legs || [])]);
    } catch (e) {
      if (!current()) return;
      reportError(e, 'ChipStatement.loadMore');
      setMoreError('More Of The Statement Could Not Be Loaded');
    } finally {
      if (current()) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [statement, legs, load, isScopeCurrent]);

  useEffect(() => {
    const sequence = requestSequence;
    if (scope === 'club_treasury' && !clubId) {
      ++requestSequence.current;
      setLoading(false);
      setStatement(null);
      setLegs([]);
      setDenied(false);
      setError('Choose A Club To View Its Treasury Statement');
      return;
    }
    void loadFirst();
    return () => {
      ++sequence.current;
      loadingMoreRef.current = false;
    };
  }, [loadFirst, scope, clubId]);

  const audit = statement?.audit;
  const auditTone = useMemo(() => {
    if (!audit) return 'neutral';
    if (audit.status === 'reconciles') return 'good';
    if (audit.status === 'does_not_reconcile') return 'bad';
    return 'neutral';
  }, [audit]);

  const heading = titleCase(
    title || (scope === 'player' ? 'Your Chip Statement' : 'Treasury Statement')
  );
  const canRetry = scope === 'player' || Boolean(clubId);

  if (loading) {
    return (
      <SpadeConsole
        className="chip-statement"
        family="riveted"
        eyebrow="Club Arena"
        title={heading}
        pill="Loading"
        pillInk="blue"
        foot="foot"
        aria-busy="true"
      >
        <div className="chip-statement__empty">Loading Your Statement...</div>
      </SpadeConsole>
    );
  }
  if (denied) {
    return (
      <SpadeConsole
        className="chip-statement"
        family="riveted"
        eyebrow="Club Arena"
        title={heading}
        pill="Restricted"
        pillInk="red"
        foot="foot"
      >
        <div className="chip-statement__empty">
          This Statement Is Available To Club Owners, Admins And Super Agents.
        </div>
      </SpadeConsole>
    );
  }
  if (error || !statement) {
    return (
      <SpadeConsole
        className="chip-statement"
        family="riveted"
        eyebrow="Club Arena"
        title={heading}
        pill="Unavailable"
        pillInk="red"
        foot="foot"
      >
        <div className="chip-statement__empty" role="alert">
          <div>{error || 'The Statement Could Not Be Loaded'}</div>
          {canRetry && (
            <button type="button" className="chip-statement__btn" onClick={() => loadFirst()}>
              Try Again
            </button>
          )}
        </div>
      </SpadeConsole>
    );
  }

  return (
    <>
      <SpadeConsole
        className="chip-statement"
        family="riveted"
        eyebrow="Club Arena"
        title={heading}
        pill={auditTone === 'good' ? 'Reconciled' : auditTone === 'bad' ? 'Review' : 'Statement'}
        pillInk={auditTone === 'good' ? 'green' : auditTone === 'bad' ? 'red' : 'blue'}
        foot="foot"
        data-scope={scope}
      >
        <header className="chip-statement__header">
          <div className="chip-statement__balance">
            <span className="chip-statement__balance-label">Balance Now</span>
            <span className="chip-statement__balance-value">
              {statementChips(statement.balance_now)}
            </span>
          </div>
        </header>

        {scope === 'player' && statement.clubs.length > 1 && (
          <ul className="chip-statement__clubs" aria-label="Balance By Club">
            {statement.clubs.map((c) => (
              <li key={c.club_id} className="chip-statement__club">
                <span>{titleCase(c.club_name)}</span>
                <span>{statementChips(c.balance)}</span>
              </li>
            ))}
          </ul>
        )}

        {audit && (
          <div
            className={`chip-statement__audit chip-statement__audit--${auditTone}`}
            role="status"
          >
            {audit.status === 'reconciles' && (
              <>
                <strong>Reconciles.</strong> Read At {when(audit.read_at || '')} As{' '}
                {statementChips(audit.balance_at_reading)}, Plus {statementChips(audit.in_since)}{' '}
                In, Minus {statementChips(audit.out_since)} Out (
                {audit.legs_since?.toLocaleString()} Movements) Equals{' '}
                {statementChips(audit.expected_now)}, Which Is Your Balance.
              </>
            )}
            {audit.status === 'does_not_reconcile' && (
              <>
                <strong>Does Not Reconcile.</strong> Read At {when(audit.read_at || '')} As{' '}
                {statementChips(audit.balance_at_reading)}, Plus {statementChips(audit.in_since)}{' '}
                In, Minus {statementChips(audit.out_since)} Out Should Be{' '}
                {statementChips(audit.expected_now)}; The Balance Is{' '}
                {statementChips(audit.balance_now)}. Difference {statementChips(audit.unexplained)}.
                The Platform Makes This Same Comparison Every Night And Files It When It Fails.
              </>
            )}
            {audit.status === 'no_reading_yet' && (
              <>
                <strong>No Reading Yet.</strong> This Wallet Has Not Yet Been Read By The Nightly
                Ledger Check. The Movements Below Are Complete; The Comparison Arrives After The
                Next 06:40 UTC Reading.
              </>
            )}
            {audit.status === 'no_balance' && (
              <>
                <strong>No Balance.</strong> There Is No Wallet Row To Compare The Journal Against.
              </>
            )}
          </div>
        )}

        {legs.length === 0 ? (
          <div className="chip-statement__empty">No Chip Movements Yet.</div>
        ) : (
          <ol className="chip-statement__legs" aria-label="Chip Movements">
            {legs.map((leg) => (
              <li
                key={`${leg.id}:${leg.direction}`}
                className={`chip-statement__leg chip-statement__leg--${leg.direction}`}
              >
                <div className="chip-statement__leg-main">
                  <span className="chip-statement__leg-category">
                    {categoryLabel(leg.category)}
                  </span>
                  <span
                    className={`chip-statement__leg-amount chip-statement__leg-amount--${leg.direction}`}
                  >
                    {signedStatementChips(leg.direction, leg.amount)}
                  </span>
                </div>
                <div className="chip-statement__leg-meta">
                  <span>
                    {leg.direction === 'in' ? 'From ' : 'To '}
                    {counterpartyLabel(leg)}
                  </span>
                  <time dateTime={leg.at}>{when(leg.at)}</time>
                </div>
              </li>
            ))}
          </ol>
        )}

        {statement.has_more && (
          <button
            type="button"
            className="chip-statement__btn chip-statement__more"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading...' : 'Load Earlier Movements'}
          </button>
        )}

        {moreError && (
          <div className="chip-statement__more-error sc-ink--red" role="alert">
            {moreError}
          </div>
        )}

        <footer className="chip-statement__footer">
          Generated {when(statement.generated_at)} From The Chip Journal. Every Line Is A Journal
          Leg; Nothing Is Summarised Away.
          {scope === 'player' && (
            <>
              {' '}
              The Balance Is Your Wallet Only: Chips Sitting On A Table Or In A Tournament Are Not
              In It Until They Come Back, And Promo Chips Are A Separate Wallet.
            </>
          )}
        </footer>
      </SpadeConsole>
      {scope === 'player' && <TournamentPaymentStatus clubId={clubId ?? null} />}
    </>
  );
}

export default function ChipStatement({ scope, clubId, pageSize = 50, title }: Props) {
  const { user, isHydrating } = useAuthUser();
  const limit = Number.isFinite(pageSize) ? Math.min(200, Math.max(1, Math.trunc(pageSize))) : 50;
  const heading = titleCase(
    title || (scope === 'player' ? 'Your Chip Statement' : 'Treasury Statement')
  );
  const viewIdentity = JSON.stringify(['chip-statement', scope, clubId ?? null, limit]);
  const scopeKey = useCashoutScopeKey(user?.id, viewIdentity);

  if (!user?.id) {
    return (
      <SpadeConsole
        className="chip-statement"
        family="riveted"
        eyebrow="Club Arena"
        title={heading}
        pill={isHydrating ? 'Loading' : 'Unavailable'}
        pillInk={isHydrating ? 'blue' : 'red'}
        foot="foot"
        aria-busy={isHydrating || undefined}
      >
        <div className="chip-statement__empty" role={isHydrating ? 'status' : 'alert'}>
          {isHydrating ? 'Loading Your Statement...' : 'Sign In To View This Statement.'}
        </div>
      </SpadeConsole>
    );
  }

  if (scope === 'club_treasury' && !clubId) {
    return (
      <SpadeConsole
        className="chip-statement"
        family="riveted"
        eyebrow="Club Arena"
        title={heading}
        pill="Unavailable"
        pillInk="red"
        foot="foot"
      >
        <div className="chip-statement__empty" role="alert">
          Choose A Club To View Its Treasury Statement.
        </div>
      </SpadeConsole>
    );
  }

  return (
    <ChipStatementRows
      key={scopeKey}
      scope={scope}
      clubId={clubId}
      pageSize={limit}
      title={title}
      actorId={user.id}
      viewKey={viewIdentity}
    />
  );
}
