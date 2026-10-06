/**
 * UNION STATEMENTS
 * ============================================================================
 * The union lead's side of the weekly square-up.
 *
 * Until this page existed the statements could only be read from the club that
 * received one. That is a structural blind spot, not merely a missing screen:
 * a per-club view can never show you the club you FORGOT to bill. So this
 * board is built around the club list, not the invoice list. Every club in the
 * union appears for the period, and a club with no statement appears as
 * "no statement" rather than quietly not appearing at all.
 *
 * Data: ca_union_statement_board, gated server-side on ca_can_oversee_union
 * (union owner, union admin, or platform admin). The client gate below is
 * cosmetic; the RPC raises 42501 on its own.
 *
 * Issuing goes through /api/club-arena/union-invoice, the same route the
 * Monday Open Claw job calls. Everything downstream is idempotent - one
 * statement per club per period, and message_sent stops a delivery happening
 * twice - so the button here is a safety net for a Monday that did not fire,
 * not a second billing path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUnionRouteId } from '../hooks/useUnionRouteId';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { isAuthzError } from '../utils/clubDashboard';
import { reportError } from '../utils/errorReporter';
import { downloadCsv, csvEscape } from '../utils/downloadCsv';
import { useToast } from '../components/common/Toast';
import styles from './UnionStatementsPage.module.css';
import UnionAccountingRunStatus from '../components/agent/UnionAccountingRunStatus';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { useIsMounted } from '../hooks/useIsMounted';
import { titleCase } from '../utils/titleCase';
import { compactChips } from '../utils/format';
import {
  parseUnionStatementBoard,
  type UnionStatementBoard as Board,
  type UnionStatementClub as BoardClub,
} from '../utils/unionStatementBoard';
import { parseUnionInsurancePnl, type UnionInsurancePnl } from '../utils/unionInsurancePnl';
import {
  parseUnionPresettlementReceipt,
  parseUnionStatementPaidReceipt,
} from '../utils/unionStatementMutations';

interface BoardSnapshot {
  scope: string;
  board: Board;
}

interface InsuranceSnapshot {
  scope: string;
  value: UnionInsurancePnl;
}

interface RequestState {
  scope: string;
  loading: boolean;
  error: string | null;
}

interface StatementIssueReceipt {
  issued: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseStatementIssueReceipt(
  value: unknown,
  expectedUnionId: string,
  expectedPeriodEnd: string | null
): StatementIssueReceipt {
  if (!isRecord(value) || value.success !== true) {
    throw new Error('Statement issue response did not declare literal success');
  }

  const issued = value.issued;
  const invoices = value.invoices;
  const hasIssued = Object.prototype.hasOwnProperty.call(value, 'issued');
  const hasInvoices = Object.prototype.hasOwnProperty.call(value, 'invoices');
  if (!hasIssued && !hasInvoices) {
    throw new Error('Statement issue response omitted its issued count');
  }
  if (
    (hasIssued && (!Number.isSafeInteger(issued) || Number(issued) < 0)) ||
    (hasInvoices && (!Number.isSafeInteger(invoices) || Number(invoices) < 0)) ||
    (hasIssued && hasInvoices && issued !== invoices)
  ) {
    throw new Error('Statement issue response carried an invalid issued count');
  }

  const receiptUnion = value.union_id ?? value.unionId;
  if (receiptUnion !== undefined && receiptUnion !== expectedUnionId) {
    throw new Error('Statement issue response belonged to another union');
  }

  const receiptPeriodEnd = value.period_end ?? value.periodEnd;
  if (
    receiptPeriodEnd !== undefined &&
    (typeof receiptPeriodEnd !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(receiptPeriodEnd) ||
      (expectedPeriodEnd !== null &&
        receiptPeriodEnd.slice(0, 10) !== expectedPeriodEnd.slice(0, 10)))
  ) {
    throw new Error('Statement issue response belonged to another period');
  }

  return { issued: Number(hasIssued ? issued : invoices) };
}

function money(n: number | null | undefined): string {
  const value = Number(n ?? 0);
  if (Number.isFinite(value) && value !== 0 && Math.abs(value) < 1) {
    return value < 0 ? 'Under 1 Owed' : 'Under 1';
  }
  return compactChips(value);
}

function compactInt(n: number | null | undefined): string {
  return Number(n || 0).toLocaleString('en-US');
}

function boardToCsv(rows: BoardClub[]): string {
  const esc = csvEscape;
  const head = [
    'club_name',
    'club_code',
    'status',
    'amount',
    'direction',
    'delivered',
    'due_at',
    'paid_total',
    'outstanding',
    'rake_generated',
    'rakeback_due',
    'union_fee_kept',
    'players_won',
    'eco_amount',
    'presettled',
  ];
  const lines = rows.map((r) =>
    [
      r.club_name,
      r.club_code,
      r.status,
      r.amount,
      r.direction,
      r.message_sent,
      r.due_at,
      r.paid_total,
      r.outstanding,
      r.rake_generated,
      r.rakeback_due,
      r.union_fee_kept,
      r.players_won,
      r.eco_amount,
      r.presettled,
    ]
      .map(esc)
      .join(',')
  );
  return [head.join(','), ...lines].join('\n');
}

export default function UnionStatementsPage() {
  const navigate = useNavigate();
  const { unionId, unionRef } = useUnionRouteId();
  const { user, isHydrating } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  /* A route can go A -> B -> A while an A request is still running. The
     monotonically increasing identity makes the returning A a different
     scope, so neither reads nor writes from the first visit can land. */
  const routeScopeKey = `${user?.id ?? 'signed-out'}:${unionRef ?? 'no-route'}:${unionId ?? 'unresolved'}`;
  const lastRouteScopeRef = useRef(routeScopeKey);
  const routeVersionRef = useRef(0);
  if (lastRouteScopeRef.current !== routeScopeKey) {
    lastRouteScopeRef.current = routeScopeKey;
    routeVersionRef.current += 1;
  }
  const routeIdentity = `${routeVersionRef.current}:${routeScopeKey}`;
  const activeRouteRef = useRef(routeIdentity);
  activeRouteRef.current = routeIdentity;

  const [periodSelection, setPeriodSelection] = useState<{
    owner: string;
    value: string | null;
  }>({ owner: routeIdentity, value: null });
  const period = periodSelection.owner === routeIdentity ? periodSelection.value : null;
  const boardScopeKey = `${routeIdentity}:${period ?? 'latest'}`;
  const lastBoardScopeRef = useRef(boardScopeKey);
  const boardScopeVersionRef = useRef(0);
  if (lastBoardScopeRef.current !== boardScopeKey) {
    lastBoardScopeRef.current = boardScopeKey;
    boardScopeVersionRef.current += 1;
  }
  const scopeIdentity = `${boardScopeVersionRef.current}:${boardScopeKey}`;
  const activeScopeRef = useRef(scopeIdentity);
  activeScopeRef.current = scopeIdentity;

  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [insuranceSnapshot, setInsuranceSnapshot] = useState<InsuranceSnapshot | null>(null);
  const [requestState, setRequestState] = useState<RequestState>({
    scope: scopeIdentity,
    loading: true,
    error: null,
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [issuingScope, setIssuingScope] = useState<string | null>(null);
  const [confirmIssue, setConfirmIssue] = useState(false);
  // Recording a payment that arrived DURING a period, so the next statement
  // asks for less. union_presettlements has existed for months and never held
  // a row, because nothing could put one there.
  const [payingClub, setPayingClub] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payingScope, setPayingScope] = useState<string | null>(null);
  // Switching period, and issuing, can both leave two reads in flight. Without
  // a version the older one may land last and show the wrong week's money.
  const requestVersionRef = useRef(0);
  const issueInFlightRef = useRef<string | null>(null);
  const paymentInFlightRef = useRef<string | null>(null);
  const settlementInFlightRef = useRef<{ scope: string; invoiceId: string } | null>(null);
  const [settlingAction, setSettlingAction] = useState<{
    scope: string;
    invoiceId: string;
  } | null>(null);

  const board = snapshot?.scope === scopeIdentity ? snapshot.board : null;
  const insurancePnl = insuranceSnapshot?.scope === routeIdentity ? insuranceSnapshot.value : null;
  const stateForScope: RequestState =
    requestState.scope === scopeIdentity
      ? requestState
      : { scope: scopeIdentity, loading: true, error: null };
  const { loading, error } = stateForScope;
  const issuing = issuingScope === scopeIdentity;
  const payBusy = payingScope === scopeIdentity;
  const settlingId = settlingAction?.scope === scopeIdentity ? settlingAction.invoiceId : null;

  useEffect(() => {
    setExpanded(null);
    setConfirmIssue(false);
    setPayingClub(null);
    setPayAmount('');
    setRequestState({ scope: scopeIdentity, loading: true, error: null });
  }, [scopeIdentity]);

  useEffect(() => {
    if (isHydrating || !user?.id || !unionId) return;
    let cancelled = false;
    const requestRoute = routeIdentity;
    const isCurrent = () =>
      !cancelled && isMounted.current && activeRouteRef.current === requestRoute;
    void (async () => {
      try {
        const { data, error: insError } = await supabase.rpc('ca_union_insurance_pnl', {
          p_union_id: unionId,
          p_days: 14,
        });
        if (!isCurrent()) return;
        if (insError) {
          if (!isAuthzError(insError)) reportError(insError, 'UnionStatementsPage.insurance_pnl');
          setInsuranceSnapshot((current) => (current?.scope === requestRoute ? null : current));
        } else {
          try {
            const parsed = parseUnionInsurancePnl(data, unionId, 14);
            setInsuranceSnapshot({ scope: requestRoute, value: parsed });
          } catch (shapeError) {
            reportError(shapeError, 'UnionStatementsPage.insurance_shape', { unionId });
            setInsuranceSnapshot((current) => (current?.scope === requestRoute ? null : current));
          }
        }
      } catch (caught) {
        reportError(caught, 'UnionStatementsPage.insurance_pnl');
        if (isCurrent()) {
          setInsuranceSnapshot((current) => (current?.scope === requestRoute ? null : current));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isHydrating, isMounted, routeIdentity, unionId, user?.id]);

  const load = useCallback(async () => {
    const requestScope = scopeIdentity;
    const requestId = ++requestVersionRef.current;
    const isCurrent = () =>
      isMounted.current &&
      activeScopeRef.current === requestScope &&
      requestVersionRef.current === requestId;

    if (isHydrating) return;
    if (!user?.id) {
      setRequestState({ scope: requestScope, loading: false, error: null });
      return;
    }
    if (!unionId) {
      setRequestState({
        scope: requestScope,
        loading: false,
        error: 'No Union Selected.',
      });
      return;
    }
    // Raised on every load, not just the first: tapping a period chip used to
    // leave the previous period's totals and rows on screen with no spinner,
    // which reads as the new period's money.
    setRequestState({ scope: requestScope, loading: true, error: null });
    try {
      const { data, error: rpcError } = await supabase.rpc('ca_union_statement_board', {
        p_union_id: unionId,
        p_period_end: period,
        p_history: 12,
      });
      if (!isCurrent()) return;
      if (rpcError) {
        const message = isAuthzError(rpcError)
          ? 'You Need To Be A Union Owner Or Admin To See Statements.'
          : 'Could Not Load Statements.';
        if (isAuthzError(rpcError)) {
          // The server owns this permission decision. The client only says it.
        } else {
          reportError(rpcError, 'UnionStatementsPage.board_rpc');
        }
        setSnapshot((current) => (current?.scope === requestScope ? null : current));
        setRequestState({ scope: requestScope, loading: false, error: message });
      } else {
        try {
          const parsed = parseUnionStatementBoard(data, unionId, period);
          setSnapshot({ scope: requestScope, board: parsed });
          setRequestState({ scope: requestScope, loading: false, error: null });
          setExpanded(null);
        } catch (shapeError) {
          reportError(shapeError, 'UnionStatementsPage.board_shape');
          setSnapshot((current) => (current?.scope === requestScope ? null : current));
          setRequestState({
            scope: requestScope,
            loading: false,
            error: 'Could Not Load Statements.',
          });
        }
      }
    } catch (caught) {
      reportError(caught, 'UnionStatementsPage.board_rpc');
      if (isCurrent()) {
        setSnapshot((current) => (current?.scope === requestScope ? null : current));
        setRequestState({
          scope: requestScope,
          loading: false,
          error: 'Could Not Load Statements.',
        });
      }
    } finally {
      if (isCurrent()) {
        setRequestState((current) =>
          current.scope === requestScope ? { ...current, loading: false } : current
        );
      }
    }
  }, [isHydrating, isMounted, period, scopeIdentity, unionId, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const issue = useCallback(async () => {
    if (!unionId || !board || board.union_id !== unionId) return;
    const actionScope = scopeIdentity;
    const expectedPeriodEnd = period === null ? board.period_end : null;
    if (issueInFlightRef.current === actionScope) return;
    issueInFlightRef.current = actionScope;
    const isCurrent = () => isMounted.current && activeScopeRef.current === actionScope;
    setIssuingScope(actionScope);
    setConfirmIssue(false);
    try {
      const { data: sess, error: sessionError } = await supabase.auth.getSession();
      if (!isCurrent()) return;
      if (sessionError) {
        reportError(sessionError, 'UnionStatementsPage.issue_session');
        toast.error('Your Session Could Not Be Verified. Please Sign In Again.');
        return;
      }
      const token = sess?.session?.access_token;
      if (!token) {
        toast.error('Your Session Expired. Please Sign In Again.');
        return;
      }
      const res = await fetch('/api/club-arena/union-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'issue', unionId }),
      });
      const json: unknown = await res.json();
      if (!isCurrent()) return;
      if (!res.ok) {
        toast.error(
          isRecord(json) && typeof json.error === 'string'
            ? json.error
            : 'Could Not Issue Statements'
        );
        return;
      }
      let receipt: StatementIssueReceipt;
      try {
        receipt = parseStatementIssueReceipt(json, unionId, expectedPeriodEnd);
      } catch (receiptError) {
        reportError(receiptError, 'UnionStatementsPage.issue_receipt', {
          unionId,
          periodEnd: expectedPeriodEnd,
        });
        toast.error('Statement Delivery Receipt Could Not Be Verified. Review The Board.');
        return;
      }
      // A period that was already issued comes back with nothing new. That is
      // the idempotency working, not a failure, so the two are said apart.
      const n = receipt.issued;
      toast.success(
        n > 0
          ? `Issued And Delivered ${n} Statements`
          : 'Every Club For This Period Already Has A Statement'
      );
      if (period !== null) {
        setPeriodSelection({ owner: routeIdentity, value: null });
      } else {
        await load();
      }
    } catch (e) {
      reportError(e, 'UnionStatementsPage.issue');
      if (isCurrent()) toast.error('Could Not Issue Statements');
    } finally {
      if (issueInFlightRef.current === actionScope) issueInFlightRef.current = null;
      if (isCurrent()) setIssuingScope(null);
    }
  }, [board, isMounted, load, period, routeIdentity, scopeIdentity, toast, unionId]);

  // Recording that a statement was settled. This moves NO chips: the weekly
  // square-up is the bookkeeping record of what was owed for a period, paid
  // between people out of band, and the RPC deliberately leaves the chip
  // transfer columns alone so the two can never be confused.
  const recordPayment = useCallback(
    async (clubId: string) => {
      if (!unionId) return;
      const actionScope = scopeIdentity;
      if (paymentInFlightRef.current === actionScope) return;
      const amount = Number(payAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        toast.error('Enter An Amount Greater Than Zero');
        return;
      }
      if (
        !Number.isSafeInteger(Math.round(amount * 100)) ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001
      ) {
        toast.error('Enter An Amount In Whole Chip Cents');
        return;
      }
      paymentInFlightRef.current = actionScope;
      const isCurrent = () => isMounted.current && activeScopeRef.current === actionScope;
      setPayingScope(actionScope);
      try {
        const { data, error: rpcError } = await supabase.rpc('fn_union_record_presettlement', {
          p_union_id: unionId,
          p_club_id: clubId,
          p_amount: amount,
          p_method: null,
          p_reference: null,
          p_note: 'Recorded on the statement board',
        });
        if (!isCurrent()) return;
        if (rpcError) {
          toast.error(
            isAuthzError(rpcError)
              ? 'Only A Union Owner Or Admin Can Record A Payment'
              : 'Could Not Record The Payment'
          );
          if (!isAuthzError(rpcError)) reportError(rpcError, 'UnionStatementsPage.presettle');
          return;
        }
        let receipt;
        try {
          receipt = parseUnionPresettlementReceipt(data, amount);
        } catch (receiptError) {
          reportError(receiptError, 'UnionStatementsPage.presettlement_receipt', {
            unionId,
            clubId,
          });
          toast.error('Payment Receipt Could Not Be Verified. Review The Refreshed Board.');
          setPayingClub(null);
          setPayAmount('');
          await load();
          return;
        }
        if (!receipt.success) {
          toast.error(receipt.error);
          return;
        }
        toast.success(`Recorded ${money(receipt.amount)}`);
        setPayingClub(null);
        setPayAmount('');
        await load();
      } catch (e) {
        reportError(e, 'UnionStatementsPage.presettle');
        if (isCurrent()) toast.error('Could Not Record The Payment');
      } finally {
        if (paymentInFlightRef.current === actionScope) paymentInFlightRef.current = null;
        if (isCurrent()) setPayingScope(null);
      }
    },
    [isMounted, load, payAmount, scopeIdentity, toast, unionId]
  );

  const setPaid = useCallback(
    async (invoiceId: string, paid: boolean) => {
      if (!invoiceId) return;
      const actionScope = scopeIdentity;
      if (settlementInFlightRef.current?.scope === actionScope) return;
      settlementInFlightRef.current = { scope: actionScope, invoiceId };
      const isCurrent = () => isMounted.current && activeScopeRef.current === actionScope;
      setSettlingAction({ scope: actionScope, invoiceId });
      try {
        const { data, error: rpcError } = await supabase.rpc('ca_union_set_statement_paid', {
          p_invoice_id: invoiceId,
          p_paid: paid,
          p_amount: null,
          p_note: null,
        });
        if (!isCurrent()) return;
        if (rpcError) {
          toast.error(
            isAuthzError(rpcError)
              ? 'Only A Union Owner Or Admin Can Settle A Statement'
              : 'Could Not Update The Statement'
          );
          if (!isAuthzError(rpcError)) reportError(rpcError, 'UnionStatementsPage.set_paid');
          return;
        }
        let receipt;
        try {
          receipt = parseUnionStatementPaidReceipt(data, invoiceId, paid);
        } catch (receiptError) {
          reportError(receiptError, 'UnionStatementsPage.set_paid_receipt', {
            invoiceId,
            paid,
          });
          toast.error('Statement Receipt Could Not Be Verified. Review The Refreshed Board.');
          await load();
          return;
        }
        if (!receipt.success) {
          toast.error(receipt.error);
          return;
        }
        toast.success(
          !paid
            ? 'Statement Reopened'
            : receipt.already_settled
              ? 'This Statement Was Already Settled'
              : 'Statement Marked Paid'
        );
        await load();
      } catch (e) {
        reportError(e, 'UnionStatementsPage.set_paid');
        if (isCurrent()) toast.error('Could Not Update The Statement');
      } finally {
        if (
          settlementInFlightRef.current?.scope === actionScope &&
          settlementInFlightRef.current.invoiceId === invoiceId
        ) {
          settlementInFlightRef.current = null;
        }
        if (isCurrent()) setSettlingAction(null);
      }
    },
    [isMounted, load, scopeIdentity, toast]
  );

  const exportCsv = useCallback(() => {
    if (!board?.clubs?.length) return;
    downloadCsv(`union_statements_${board.period_end || 'latest'}.csv`, boardToCsv(board.clubs));
  }, [board]);

  const totals = board?.totals;

  const periodLabel = useMemo(() => {
    if (!board) return '';
    if (board.period_start && board.period_end) {
      return `${board.period_start} To ${board.period_end}`;
    }
    return board.period_end || 'No Statements Issued Yet';
  }, [board]);

  if (isHydrating) {
    return (
      <div className={styles.page}>
        <div className={styles.stateFrame}>
          <SpadeConsole
            eyebrow="Union Finance"
            title="Loading Statements"
            pill="Loading"
            pillInk="gold"
            crest="flat"
            family="spade"
            foot="foot"
          >
            <p className={`sc-copy ${styles.stateBody}`}>Preparing The Statement Board.</p>
          </SpadeConsole>
        </div>
      </div>
    );
  }
  if (!user) {
    return (
      <div className={styles.page}>
        <div className={styles.stateFrame}>
          <SpadeConsole
            eyebrow="Union Finance"
            title="Sign In Required"
            pill="Locked"
            pillInk="red"
            crest="spade"
            family="spade"
            foot="foot"
          >
            <p className={`sc-copy ${styles.stateBody}`}>Sign In To View Statements.</p>
          </SpadeConsole>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <CasinoSurfaceHeader
        crest="flat"
        family="riveted"
        eyebrow="Union Network / Finance"
        title="Union Statements"
        description="Audit Every Member Club For The Selected Period, Including Issued, Delivered, Paid, Outstanding, And Missing Statements."
        artPath="assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp"
        status="STATEMENT BOARD // AUTHORITATIVE"
        metrics={[
          { label: 'Clubs', value: totals?.clubs || 0 },
          { label: 'Issued', value: totals?.issued || 0, tone: 'live' },
          { label: 'Missing', value: totals?.missing || 0, tone: 'attention' },
        ]}
        plates={{
          secondary: {
            label: 'Back',
            onClick: () => navigate(-1),
            'aria-label': 'Go Back',
          },
          primary: {
            label: 'Export CSV',
            onClick: exportCsv,
            disabled: !board?.clubs?.length,
            'aria-label': 'Export As CSV',
            ink: 'white',
          },
        }}
      />

      {!loading && unionId && board?.union_id === unionId && board?.period_end && (
        <div className={styles.accountingStatus}>
          <UnionAccountingRunStatus
            key={`${scopeIdentity}:${board.period_end}`}
            unionId={unionId}
            periodEnd={board.period_end}
          />
        </div>
      )}

      <div className={styles.consoleBand}>
        <SpadeConsole
          eyebrow="Union Finance"
          title={confirmIssue ? 'Confirm Statement Delivery' : 'Issue Statements'}
          pill={issuing ? 'Issuing' : confirmIssue ? 'Confirm' : 'Ready'}
          pillInk={issuing || confirmIssue ? 'gold' : 'blue'}
          crest="flat"
          family="shark"
          foot="plates"
          plates={{
            primary: {
              label: confirmIssue
                ? issuing
                  ? 'Issuing'
                  : 'Yes, Issue And Deliver'
                : 'Issue Statements For The Closed Week',
              onClick: confirmIssue
                ? () => {
                    void issue();
                  }
                : () => setConfirmIssue(true),
              disabled: issuing || !unionId || !board || board.union_id !== unionId,
              ink: 'white',
            },
          }}
        >
          <p className={`sc-copy ${styles.actionNote}`}>
            The Monday Job Already Does This. Issuing Again Only Fills In Clubs That Have No
            Statement For The Period. Nothing Is Billed Or Delivered Twice.
          </p>
          {confirmIssue && (
            <button
              type="button"
              className={styles.cancelAction}
              onClick={() => setConfirmIssue(false)}
              disabled={issuing}
            >
              Cancel
            </button>
          )}
        </SpadeConsole>
      </div>

      <div className={styles.consoleBand}>
        <SpadeConsole
          eyebrow="Union Ledger"
          title="Statement Board"
          pill={loading ? 'Loading' : error ? 'Offline' : 'Ready'}
          pillInk={loading ? 'gold' : error ? 'red' : 'green'}
          crest="spade"
          family="spade"
          foot="foot"
          aria-busy={loading}
        >
          <div className={styles.periodBar}>
            <div className={`sc-label sc-ink--blue ${styles.periodLabel}`}>{periodLabel}</div>
            {board?.union_name && (
              <div className={`sc-ink--silver ${styles.unionName}`}>
                {titleCase(board.union_name)}
              </div>
            )}
          </div>

          {board && (board.history?.length ?? 0) > 1 && (
            <div className={styles.periodChips} role="tablist" aria-label="Statement Period">
              {(board.history || []).map((h) => (
                <button
                  key={h.period_end}
                  type="button"
                  role="tab"
                  aria-selected={board.period_end === h.period_end}
                  className={`${styles.chip} ${board.period_end === h.period_end ? styles.active : ''}`}
                  onClick={() => setPeriodSelection({ owner: routeIdentity, value: h.period_end })}
                >
                  {h.period_end}
                </button>
              ))}
            </div>
          )}

          {totals && (
            <dl className={styles.summary} aria-label="Statement Totals">
              <div className={styles.tile}>
                <dt className={styles.tileLabel}>Clubs Owe</dt>
                <dd className={styles.tileValue}>{money(totals.clubs_owe)}</dd>
              </div>
              <div className={styles.tile}>
                <dt className={styles.tileLabel}>Union Owes</dt>
                <dd className={styles.tileValue}>{money(totals.union_owes)}</dd>
              </div>
              <div className={styles.tile}>
                <dt className={styles.tileLabel}>Still Outstanding</dt>
                <dd className={styles.tileValue}>{money(totals.outstanding)}</dd>
              </div>
              <div className={styles.tile}>
                <dt className={styles.tileLabel}>ECO</dt>
                <dd
                  className={`${styles.tileValue} ${totals.eco_amount < 0 ? styles.neg : styles.pos}`}
                >
                  {money(totals.eco_amount)}
                </dd>
              </div>
            </dl>
          )}

          {totals && (
            <div className={styles.statusStrip} aria-label="Statement Status">
              <span>
                {compactInt(totals.issued)} Of {compactInt(totals.clubs)} Issued
              </span>
              <span>{compactInt(totals.delivered)} Delivered</span>
              <span>{compactInt(totals.paid)} Paid</span>
              <span>{money(totals.collected)} Collected</span>
              <span>{money(totals.rake_generated)} Rake</span>
              {totals.missing > 0 && (
                <span className={styles.warn}>{compactInt(totals.missing)} With No Statement</span>
              )}
            </div>
          )}

          {/* INSURANCE P&L 2026-08-27 (Dan): the union bank's live insurance
              line - last 14 days, straight from the settled-contract ledger. */}
          {insurancePnl && (
            <div className={styles.statusStrip} aria-label="Insurance Profit And Loss">
              <span>Insurance Last 14 Days</span>
              <span
                className={insurancePnl.totals.net < 0 ? styles.neg : styles.pos}
                title="Premiums Collected Minus Payouts Paid, Settled To The Union Insurance Wallet"
              >
                {money(insurancePnl.totals.net)} Net
              </span>
              <span>{money(insurancePnl.totals.premiums)} Premiums In</span>
              <span>{money(insurancePnl.totals.payouts)} Payouts Out</span>
              <span>{compactInt(insurancePnl.totals.contracts)} Contracts</span>
            </div>
          )}

          <div className={styles.list}>
            {loading && !board && !error && (
              <div className={styles.state}>Loading Statement Board.</div>
            )}

            {error && (
              <div className={`${styles.state} ${styles.error}`} role="alert">
                <p>{error}</p>
                <button type="button" className={styles.linkBtn} onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}

            {!loading && !error && board && (board.clubs?.length ?? 0) === 0 && (
              <div className={styles.state}>No Clubs In This Union.</div>
            )}

            {!error &&
              (board?.clubs || []).map((c) => {
                const open = expanded === c.club_id;
                const pillClass =
                  c.status === 'missing'
                    ? styles.pillMissing
                    : c.status === 'paid'
                      ? styles.pillPaid
                      : c.overdue
                        ? styles.pillOverdue
                        : styles.pillOpen;
                return (
                  <div className={styles.clubRow} key={c.club_id}>
                    <button
                      type="button"
                      className={styles.clubMain}
                      onClick={() => setExpanded(open ? null : c.club_id)}
                      aria-expanded={open}
                      aria-label={`${titleCase(c.club_name)} Statement Details`}
                    >
                      <div className={styles.clubText}>
                        <div className={styles.clubName}>{titleCase(c.club_name)}</div>
                        <div className={styles.clubMeta}>
                          <span className={`${styles.pill} ${pillClass}`}>
                            {c.status === 'missing'
                              ? 'No Statement'
                              : c.overdue
                                ? 'Overdue'
                                : titleCase(c.status)}
                          </span>
                          {c.status !== 'missing' && (
                            <span
                              className={c.message_sent ? styles.deliveredYes : styles.deliveredNo}
                            >
                              {c.message_sent ? 'Delivered' : 'Not Delivered'}
                            </span>
                          )}
                          {c.due_at && <span>Due {String(c.due_at).slice(0, 10)}</span>}
                        </div>
                      </div>
                      <div className={styles.clubAmount}>
                        <div
                          className={`${styles.amountValue} ${c.amount < 0 ? styles.neg : styles.pos}`}
                        >
                          {c.status === 'missing' ? '--' : money(c.amount)}
                        </div>
                        <div className={styles.amountLabel}>
                          {c.status === 'missing'
                            ? 'Not Billed'
                            : c.direction === 'union owes club'
                              ? 'Union Owes'
                              : 'Club Owes'}
                        </div>
                      </div>
                    </button>

                    {open && (
                      <div className={styles.breakdown}>
                        {c.status === 'missing' ? (
                          <div className={styles.state}>
                            This Club Has No Statement For The Period. Issuing Will Create One.
                          </div>
                        ) : (
                          [
                            ['Rake Generated', c.rake_generated],
                            ['Club Rakeback (90%)', c.rakeback_due],
                            ['Union Fee Kept (10%)', c.union_fee_kept],
                            ['Player Win/Loss', c.players_won],
                            ['ECO Adjustment', c.eco_amount],
                            ['Payments Received', c.presettled],
                          ].map(([label, value]) => (
                            <div className={styles.breakdownLine} key={String(label)}>
                              <span>{String(label)}</span>
                              <span>{money(Number(value || 0))}</span>
                            </div>
                          ))
                        )}
                        {c.paid_total > 0 && c.status !== 'paid' && (
                          <div className={styles.breakdownLine}>
                            <span>Part Paid</span>
                            <span>
                              {money(c.paid_total)} Of {money(Math.abs(c.amount))}
                            </span>
                          </div>
                        )}

                        {payingClub === c.club_id && (
                          <div className={styles.payRow}>
                            <input
                              className={styles.payInput}
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="0.01"
                              value={payAmount}
                              onChange={(e) => setPayAmount(e.target.value)}
                              placeholder="Amount Received"
                              aria-label={`Payment Received From ${titleCase(c.club_name)}`}
                            />
                            <button
                              type="button"
                              className={styles.payBtn}
                              onClick={() => {
                                void recordPayment(c.club_id);
                              }}
                              disabled={payBusy}
                            >
                              {payBusy ? 'Saving...' : 'Record'}
                            </button>
                          </div>
                        )}

                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() => navigate(`/clubs/${c.club_id}/data`)}
                          >
                            Open Club Data
                          </button>
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() =>
                              setPayingClub((cur) => (cur === c.club_id ? null : c.club_id))
                            }
                          >
                            {payingClub === c.club_id ? 'Cancel Payment' : 'Record A Payment'}
                          </button>
                          {c.invoice_id && c.status !== 'cancelled' && (
                            <button
                              type="button"
                              className={c.status === 'paid' ? styles.linkBtnMuted : styles.linkBtn}
                              onClick={() => {
                                void setPaid(c.invoice_id as string, c.status !== 'paid');
                              }}
                              disabled={settlingId === c.invoice_id}
                            >
                              {settlingId === c.invoice_id
                                ? 'Saving...'
                                : c.status === 'paid'
                                  ? 'Reopen'
                                  : 'Mark Paid'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>

          {board && (
            <div className={styles.footNote}>
              Marking A Statement Paid Records That It Was Settled. It Moves No Chips.
              {board.generated_at && !Number.isNaN(Date.parse(board.generated_at))
                ? ` Read ${new Date(board.generated_at).toLocaleTimeString()}.`
                : ''}
              {totals && totals.missing > 0
                ? ' A Club Shown As "No Statement" Was Never Billed For This Period.'
                : ''}
            </div>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}
