/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB AND UNION DIAMOND COSTS - the operator's commerce console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), Phase 7. One page for a club
 * or a union: the operating trial, its exact local end, the time left and what
 * happens when it ends; the paid rights, their next renewal date and the
 * diamonds a renewal will take; the published diamond prices; a server quote
 * with every step of the arithmetic printed (gross, credit, net, the exact
 * period); one confirmed order; the receipt; and the receipts already on file.
 * A union owner also keeps its sponsorship budgets here.
 *
 * NOTHING IS DECIDED HERE. Every amount on this page came from the server;
 * the browser sends a selection and an order key. A green state appears only
 * after the authoritative receipt. Prices carry no comparison claim.
 *
 * ORDER KEYS (R2 3.3). One key per quote, minted when the quote arrives and
 * kept for the life of the page. A retry of the SAME quote sends the SAME key
 * and reads the same receipt ("Original Charge: N; Charged On This Retry: 0",
 * never "free"). A new quote gets a new key. While an outcome is unknown (the
 * connection dropped mid purchase) the page will not start another order: it
 * re-reads the receipts on file and offers only a retry of that same order,
 * because a new quote after an unseen commit would buy the NEXT period.
 *
 * SCOPE SWITCHES. The console is keyed by scope, so moving between clubs or
 * unions mounts a fresh console: no quote, key, receipt or late response from
 * the previous scope can land on the next one.
 *
 * THE PICTURE (#ClubArenaConsole): spade consoles, rows printed on the glass,
 * two plates or none. Nothing is drawn.
 *
 * CATALOG, TERMS, WRITTEN QUOTES AND REVIEWS (20260924182605). While the
 * catalog is not published, the page lists no prices and quotes nothing. The
 * Operating Service Terms version in effect is named wherever an owner
 * accepts it (the confirm step and the free month start). A quote may say the
 * owner never had a free month; the confirm step then offers it beside the
 * purchase and never blocks the purchase. Above 2,500 members a club asks for
 * a written quote; an offer is bought through the same order as any capacity.
 * An owner whose free month ended (or was inherited already ended) can ask
 * platform staff for a review.
 *
 * SETTLED EARNINGS (20260924183657). The owner's settled Diamond Spins
 * earnings beside the operating diamonds paid for this scope, as a comparison
 * only: it never says which diamonds paid.
 *
 * Routes: /clubs/:clubId/diamond-costs (finance access in the operations
 * registry) and /unions/:unionId/diamond-costs.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { LoadingState } from '../../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../../components/console/SpadeConsole';
import ClubCommerceService, {
  REFUND_REASONS,
  ceilingSentence,
  isRefusal,
  listPrice,
  owedReasonWords,
  refundReasonWord,
  refusalCopy,
  type BalanceBreakdown,
  type Catalog,
  type CatalogProduct,
  type Entitlement,
  type Policy,
  type PurchaseKind,
  type Quote,
  type QuoteLine,
  type Receipt,
  type ReceiptRight,
  type RefundReason,
  type RefundRequest,
  type Refusal,
  type RenewalChange,
  type ScopeKind,
  type ScopeStatus,
  type Sponsorship,
  type EarningsCoverage,
  type TrialReview,
  type WrittenQuote,
} from '../../services/ClubCommerceService';
import { isUUID, resolveClubUUIDStrict } from '../../utils/clubIdResolver';
import { titleCase } from '../../utils/titleCase';
import { reportError } from '../../utils/errorReporter';
import { uuid } from '../../utils/uuid';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useAuthUser } from '../../hooks/useAuthUser';
import styles from '../diamondGames.module.css';
import own from './ClubDiamondCostsPage.module.css';

const BUY_DIAMONDS = '/marketplace?tab=diamonds';
const RECEIPTS_SHOWN = 10;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const diamonds = (n: number | null | undefined) => `${Number(n ?? 0).toLocaleString()} Diamonds`;
const orderRef = (id: string | null | undefined) =>
  String(id ?? '')
    .slice(0, 8)
    .toUpperCase() || 'Pending';

/** Exact local date and time, in the viewer's zone, with the zone named. */
function when(iso: string | null | undefined): string {
  if (!iso) return 'Not Set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not Set';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** The local calendar date alone ("Oct 5, 2026"), for a row's value. */
function dateWord(iso: string | null | undefined): string {
  if (!iso) return 'Not Set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not Set';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The local time with its zone ("6:04 PM PDT"), for the meta under a date. */
function timeWord(iso: string | null | undefined): string {
  if (!iso) return 'Not Set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not Set';
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/**
 * The publication date of a catalog version. fn_ca_commerce_catalog_version
 * answers 'catalog:' + the latest published_at as YYYYMMDD"T"HH24MISS in UTC
 * + ':' + a hash; only the date is for reading. Null when the version carries
 * no timestamp ('catalog:none:...'), so the caller prints nothing rather than
 * the hash.
 */
function catalogWord(version: string | null | undefined): string | null {
  const m = /^catalog:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?::|$)/.exec(
    String(version ?? '')
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(at) ? dateWord(new Date(at).toISOString()) : null;
}

/** "12 Days", "5 Hours", "Under 1 Hour": how long until a moment. */
function timeLeftWord(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'No Time';
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    return `${days.toLocaleString()} ${days === 1 ? 'Day' : 'Days'}`;
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    return `${hours.toLocaleString()} ${hours === 1 ? 'Hour' : 'Hours'}`;
  }
  return 'Under 1 Hour';
}

/** m:ss for the quote countdown. */
function clockWord(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? `0${s}` : s}`;
}

/** A whole, non-negative number typed by the operator ("1,500" allowed). */
function parseWhole(raw: string): number | null {
  const clean = raw.replace(/[,\s]/g, '');
  if (!/^\d{1,10}$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}

function termWord(hours: number | null | undefined): string {
  const days = Math.round(Number(hours ?? 0) / 24);
  return `${days.toLocaleString()} ${days === 1 ? 'Day' : 'Days'}`;
}

/** " Text." from a catalog note that may be empty or already end a sentence. */
function sentence(text: string | null | undefined): string {
  const t = String(text ?? '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? ` ${t}` : ` ${t}.`;
}

function periodWord(p: CatalogProduct): string {
  if (p.term_kind === 'period') return `${termWord(p.term_hours)} Of Access`;
  if (p.term_kind === 'report_interval') return `${p.report_days ?? 0} Day Reporting Interval`;
  return 'One Time Asset';
}

function priceWord(p: CatalogProduct): string {
  if (!p.price) return 'No Published Price';
  const base = diamonds(p.price.diamonds);
  if (p.price.price_rule === 'per_unit') return `${base} Per Covered Club`;
  if (p.price.price_rule === 'per_unit_capped')
    return `${base} Per Covered Club, Up To ${Number(p.price.cap_diamonds ?? 0).toLocaleString()}`;
  return base;
}

function Row({
  label,
  value,
  ink = 'silver',
  meta,
  wrap = false,
}: {
  label: string;
  value: string;
  ink?: ConsoleInk;
  meta?: string;
  /** Let a long label or value wrap inside the row (375px). */
  wrap?: boolean;
}) {
  /* The meta is the row's third grid item and spans both columns, so a wide
     value never squeezes the note into the label's half of the glass. */
  return (
    <div className={`${styles.row} ${own.rowWithMeta}`}>
      <span className={`sc-label sc-ink--blue ${styles.rowLabel} ${wrap ? own.wrapLabel : ''}`}>
        {label}
      </span>
      <span className={`${styles.rowValue} sc-ink--${ink} ${wrap ? own.wrapValue : ''}`}>
        {value}
      </span>
      {meta ? (
        <span className={`${styles.rowMeta} ${own.metaFull} sc-ink--muted`}>{meta}</span>
      ) : null}
    </div>
  );
}

function ChoiceRow({
  label,
  meta,
  value,
  ink,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  meta: string;
  value: string;
  ink: ConsoleInk;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  const metaId = useId();
  return (
    <button
      type="button"
      className={`${styles.rowButton} ${own.rowWithMeta}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={`${label}: ${value}`}
      aria-describedby={metaId}
    >
      <span className={`sc-label sc-ink--silver ${styles.rowLabel} ${own.wrapLabel}`}>{label}</span>
      <span className={`${styles.rowValue} sc-ink--${ink} ${own.wrapValue}`}>{value}</span>
      <span id={metaId} className={`${styles.rowMeta} ${own.metaFull} sc-ink--muted`}>
        {meta}
      </span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  mode = 'numeric',
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  mode?: 'decimal' | 'numeric' | 'text';
  disabled?: boolean;
}) {
  const hintId = useId();
  return (
    <label className={styles.field}>
      <span className="sc-label sc-ink--blue">{label}</span>
      <input
        className={styles.fieldInput}
        inputMode={mode}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <span id={hintId} className="sc-copy sc-ink--muted">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function entitlementTitle(e: Entitlement, catalog: Catalog | null): string {
  if (e.kind === 'trial_operating') return 'Free Operating Month';
  const p = catalog?.products.find((x) => x.sku === e.sku);
  if (p) return e.quantity > 1 ? `${p.title} For ${e.quantity} Covered Clubs` : p.title;
  return e.sku ?? e.kind;
}

/** "Refunds Follow Refund Policy Version 1." with the version the server has in effect. */
function refundPolicyLine(version: number | null | undefined): string {
  return typeof version === 'number' && version > 0
    ? `Refunds Follow Refund Policy Version ${version}.`
    : 'Refunds Follow The Current Refund Policy.';
}

/** What an owner accepts by confirming or by starting the free month. */
function serviceTermsLine(version: number | null | undefined): string {
  return typeof version === 'number' && version > 0
    ? `You Accept Operating Service Terms Version ${version}.`
    : 'You Accept The Operating Service Terms In Effect.';
}

/** The largest capacity sold from the catalog; above it, a written quote. */
const WRITTEN_QUOTE_FLOOR = 2500;
const REVIEW_MIN = 20;
const REVIEW_MAX = 2000;

/** A note someone typed, printed in Title Case with its closing stop trimmed. */
function noteWords(text: string | null | undefined): string {
  return titleCase(String(text ?? '').trim()).replace(/[.\s]+$/, '');
}

/** The current version of one policy kind, or null when it was not read. */
function currentPolicy(policies: Policy[] | null, kind: Policy['kind']): Policy | null {
  const ofKind = (policies ?? []).filter((p) => p.kind === kind);
  return ofKind.find((p) => p.current) ?? ofKind.sort((a, b) => b.version - a.version)[0] ?? null;
}

/**
 * The truth about operating access while admission is wired in shadow
 * (20260924102056). Until staff set admission_enforced_from and it passes,
 * every owner action proceeds, so nothing on this page may say "No Access".
 */
type AccessTruth = {
  /** The announced date, when there is one. */
  enforcedFrom: number | null;
  /** True only once that date has passed. */
  enforced: boolean;
};

function accessTruth(status: ScopeStatus, serverNow: number): AccessTruth {
  const from = status.admission_enforced_from ? Date.parse(status.admission_enforced_from) : NaN;
  if (!Number.isFinite(from)) return { enforcedFrom: null, enforced: false };
  return { enforcedFrom: from, enforced: from <= serverNow };
}

/** What of one receipt line can still be returned, from the server's rights. */
function refundableFor(r: Receipt, index: number): number {
  const right = (r.rights ?? []).find((x) => x.line_index === index);
  if (right && typeof right.refundable === 'number') return Math.max(0, right.refundable);
  const line = (r.lines ?? []).find((l) => l.index === index);
  const refunded = (r.refunds ?? [])
    .filter((f) => f.line_index === index)
    .reduce((n, f) => n + Number(f.gross ?? 0), 0);
  return Math.max(0, Number(line?.net ?? 0) - refunded);
}

const OPEN_REFUND_STATES = new Set(['requested', 'approved', 'owed']);

/** How the policy reached its amount, in words, never with a decimal. */
function basisWord(q: RefundRequest): string {
  if (q.policy_basis === 'error_full') return 'Full Refund Of A Purchase Made In Error';
  const unused = Math.floor(Number(q.policy_detail?.unused_days ?? 0));
  const period = Math.round(Number(q.policy_detail?.period_days ?? 0));
  const days = `${unused.toLocaleString()} Unused Whole ${unused === 1 ? 'Day' : 'Days'}`;
  return period > 0 ? `${days} Of ${period.toLocaleString()}, Pro Rata` : `${days}, Pro Rata`;
}

/** A refund request's state as its payer reads it: the value, its ink and the note. */
function refundStateView(q: RefundRequest): { value: string; ink: ConsoleInk; meta: string } {
  const approved = q.approved_amount ?? q.policy_amount;
  const reason = refundReasonWord(q.reason_code);
  switch (q.state) {
    case 'requested':
      return {
        value: 'Requested',
        ink: 'blue',
        meta: `${reason}. ${diamonds(q.policy_amount)} Under Refund Policy Version ${q.policy_version}: ${basisWord(q)}. With Platform Staff For A Decision. Asked ${when(q.created_at)}.`,
      };
    case 'approved':
      return {
        value: 'Approved',
        ink: 'green',
        meta: `${reason}. ${diamonds(approved)} Approved ${when(q.decided_at)}. Being Returned To Your Diamond Balance.`,
      };
    case 'owed':
      return {
        value: 'Owed',
        ink: 'gold',
        meta: `${reason}. ${diamonds(approved)} Approved And Owed To You. Not Added Yet: ${owedReasonWords(q.owed_reason)}. It Is Paid As Soon As Your Balance Can Receive It.`,
      };
    case 'refunded':
      return {
        value: 'Refunded',
        ink: 'green',
        meta: `${reason}. ${diamonds(approved)} Returned To Your Diamond Balance ${when(q.executed_at)}.`,
      };
    case 'declined': {
      const note = titleCase(String(q.decision_note ?? '').trim()).replace(/[.\s]+$/, '');
      return {
        value: 'Declined',
        ink: 'red',
        meta: `${reason}. ${note ? `Note From Platform Staff: ${note}.` : 'Declined By Platform Staff.'} Declined ${when(q.decided_at)}.`,
      };
    }
    case 'failed':
    default:
      return {
        value: 'Failed',
        ink: 'red',
        meta: `${reason}. The Approved Refund Could Not Be Completed: ${owedReasonWords(q.last_error)}. Platform Staff Can See This Request.`,
      };
  }
}

function RefundStateRow({ request }: { request: RefundRequest }) {
  const v = refundStateView(request);
  return <Row label="Refund Request" value={v.value} ink={v.ink} wrap meta={v.meta} />;
}

/**
 * The reader's wallet in the server's own figures (scope_status
 * balance_breakdown). Available, reserved and pending are distinct and are
 * never added together; owed is the part of pending that is waiting on the
 * wallet. Without a breakdown (an older server) the single balance prints.
 */
function BalanceRows({
  breakdown,
  balance,
}: {
  breakdown: BalanceBreakdown | null | undefined;
  balance: number | null;
}) {
  if (breakdown) {
    const pending = Number(breakdown.pending_refunds ?? 0);
    const owed = Number(breakdown.owed_refunds ?? 0);
    return (
      <>
        <Row
          label="Available Diamonds"
          value={Number(breakdown.available ?? 0).toLocaleString()}
          ink="silver"
          wrap
          meta="Spendable Now. Every Charge On This Page Comes From Here."
        />
        <Row
          label="Reserved (Diamond Arena)"
          value={Number(breakdown.reserved ?? 0).toLocaleString()}
          ink="muted"
          wrap
          meta="Held For Your Open Diamond Arena Purchases. Shown Apart From Available And Never Added To It."
        />
        <Row
          label="Pending Refunds"
          value={pending.toLocaleString()}
          ink={pending > 0 ? 'blue' : 'muted'}
          wrap
          meta="Requested, Approved Or Owed To You, And Not Yet In Your Balance."
        />
        <Row
          label="Owed Refunds"
          value={owed.toLocaleString()}
          ink={owed > 0 ? 'gold' : 'muted'}
          wrap
          meta="Approved Refunds Waiting Until Your Balance Can Receive Them. Part Of Pending Refunds."
        />
      </>
    );
  }
  if (balance === null) return null;
  return <Row label="Available Diamonds" value={balance.toLocaleString()} ink="silver" />;
}

/* ══ One order: quote, key, confirm, recover ═══════════════════════════════
   Shared by the scope's own catalog and by a sponsor buying for a covered
   club, so both keep the same rules: ONE ORDER KEY PER QUOTE (minted when the
   quote arrives, reused on every retry of that quote, never reused for
   another); a synchronous guard against a double tap; and an unknown outcome
   that re-reads the receipts on file and, until it knows, offers only a retry
   of that same order. */

type OrderOptions = {
  /** Where to report errors from. */
  where: string;
  /** The receipts to search when an outcome is unknown. */
  readReceipts: () => Promise<Receipt[]>;
  /** Refresh whatever the order changed (status, balance, receipts). */
  onSettled: () => Promise<void>;
  /** A refusal the caller explains itself; return true when handled. */
  onRefusal?: (refusal: Refusal, quote: Quote) => boolean;
};

function useCommerceOrder(opts: OrderOptions) {
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [receiptFoundOnFile, setReceiptFoundOnFile] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const orderKeys = useRef(new Map<string, string>());
  /* Bumped whenever the quote inputs change, so a quote requested for the
     old selection is discarded when it arrives. */
  const inputsVersion = useRef(0);
  /* Synchronous double-submit guards: state updates land a render late. */
  const quotingRef = useRef(false);
  const payingRef = useRef(false);

  /** Any change to what is being quoted retires the quote on screen. */
  const editInputs = () => {
    inputsVersion.current += 1;
    setQuote(null);
  };

  const requestQuote = async (run: () => Promise<Quote | Refusal>) => {
    if (quotingRef.current || payingRef.current) return;
    if (outcomeUnknown) return toast.error('Check Your Last Order Before Starting A New One');
    const version = inputsVersion.current;
    quotingRef.current = true;
    setQuoting(true);
    setReceipt(null);
    try {
      const q = await run();
      if (!isMountedRef.current || version !== inputsVersion.current) return;
      if (isRefusal(q)) {
        setQuote(null);
        if (q.error === 'roster_exceeds_capacity' && typeof q.roster_count === 'number')
          toast.error(`${q.roster_count.toLocaleString()} Approved Members Exceed That Capacity`);
        else toast.error(refusalCopy(q.error, 'The Quote Was Refused'));
        return;
      }
      if (!orderKeys.current.has(q.quote_id)) orderKeys.current.set(q.quote_id, uuid());
      setQuote({ ...q, lines: Array.isArray(q.lines) ? q.lines : [] });
    } catch (e) {
      reportError(e, `${opts.where}.quote`);
      if (isMountedRef.current) toast.error('The Quote Could Not Be Read');
    } finally {
      quotingRef.current = false;
      if (isMountedRef.current) setQuoting(false);
    }
  };

  /**
   * The outcome of a purchase is unknown (the connection dropped). Read the
   * receipts on file; a receipt for this quote means it committed, once.
   * Otherwise the quote stays on screen with its SAME key for a retry.
   */
  const recover = async (q: Quote) => {
    setRecovering(true);
    try {
      const onFile = await opts.readReceipts();
      if (!isMountedRef.current) return;
      const found = onFile.find((x) => x.quote_id === q.quote_id);
      if (found) {
        setReceipt(found);
        setReceiptFoundOnFile(true);
        setQuote(null);
        setOutcomeUnknown(false);
        toast.info('Your Order Was Found On File. It Was Charged Once');
        await opts.onSettled();
      } else {
        setOutcomeUnknown(true);
        toast.error('The Order Outcome Is Unknown. Retry Uses The Same Order Key');
      }
    } catch (e) {
      reportError(e, `${opts.where}.recover`);
      if (!isMountedRef.current) return;
      setOutcomeUnknown(true);
      toast.error('Your Order Could Not Be Checked. Retry Uses The Same Order Key');
    } finally {
      if (isMountedRef.current) setRecovering(false);
    }
  };

  const confirm = async () => {
    const q = quote;
    if (!q || payingRef.current) return;
    const key = orderKeys.current.get(q.quote_id);
    if (!key) return toast.error('This Quote Needs A Fresh Order Key. Get A New Quote');
    payingRef.current = true;
    setPaying(true);
    try {
      const r = await ClubCommerceService.purchase(q.quote_id, key, q.purchase_kind);
      if (!isMountedRef.current) return;
      /* Any answer from the server, refusal or receipt, is a known outcome. */
      setOutcomeUnknown(false);
      if (isRefusal(r)) {
        if (opts.onRefusal?.(r, q)) return;
        if (r.error === 'insufficient_diamonds') {
          const have = Number(r.balance);
          const short = Number.isFinite(have) ? q.net - have : NaN;
          toast.error(
            short > 0
              ? `Not Enough Available Diamonds. ${short.toLocaleString()} More Needed`
              : refusalCopy(r.error)
          );
        } else {
          toast.error(refusalCopy(r.error, 'The Order Was Refused'));
        }
        if (r.requote) {
          setQuote(null);
          await opts.onSettled();
        }
        return;
      }
      setReceipt(r);
      setReceiptFoundOnFile(false);
      setQuote(null);
      toast.success(
        r.is_replay
          ? 'This Order Was Already Completed. No New Charge'
          : `Paid ${Number(r.charged_this_attempt ?? 0).toLocaleString()} Diamonds`
      );
      await opts.onSettled();
    } catch (e) {
      /* An unknown outcome is never a second attempt with a new key. */
      reportError(e, `${opts.where}.purchase`);
      if (isMountedRef.current) await recover(q);
    } finally {
      payingRef.current = false;
      if (isMountedRef.current) setPaying(false);
    }
  };

  return {
    quote,
    quoting,
    paying,
    outcomeUnknown,
    receipt,
    receiptFoundOnFile,
    recovering,
    /** Inputs are frozen while an order is in flight or its outcome unknown. */
    locked: paying || outcomeUnknown || recovering,
    hasKey: (quoteId: string) => orderKeys.current.has(quoteId),
    editInputs,
    discard: () => setQuote(null),
    clearReceipt: () => setReceipt(null),
    requestQuote,
    recover,
    confirm,
  };
}

type CommerceOrder = ReturnType<typeof useCommerceOrder>;

/** What the quote offers instead of Pay while the paying scope is in its trial. */
type TrialAction = {
  plate: string;
  onClick?: () => void;
  disabled: boolean;
  rowLabel: string;
  note: string;
};

/** The confirm step for one order: every line, the total, the payer. */
function QuoteConsole({
  order,
  sectionId,
  eyebrow,
  forClub,
  skewMs,
  busy,
  canRequote,
  onRequote,
  trialAction,
  onGetDiamonds,
  notice,
  refundPolicyVersion,
  serviceTermsVersion,
  freeMonth = null,
}: {
  order: CommerceOrder;
  sectionId: string;
  eyebrow: string;
  /** The club a sponsored order is for, printed as its own row. */
  forClub?: string;
  skewMs: number;
  busy: boolean;
  canRequote: boolean;
  onRequote: () => void;
  trialAction: TrialAction | null;
  onGetDiamonds: () => void;
  /** A consequence of this order the caller knows and the quote does not. */
  notice?: { label: string; value: string; ink: ConsoleInk; meta: string } | null;
  /** The refund policy version in effect, from fn_ca_commerce_policies. */
  refundPolicyVersion: number | null;
  /** The Operating Service Terms version the payer accepts by confirming. */
  serviceTermsVersion: number | null;
  /** The owner's own free month door, offered when the quote says they never
      had one. Never a reason to refuse the purchase. */
  freeMonth?: { busy: boolean; onStart: () => void } | null;
}) {
  const quote = order.quote;
  const quoteId = quote?.quote_id ?? null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  /* Focus follows the confirm step, so a keyboard or screen reader user lands
     on what just appeared instead of the button they left. */
  useEffect(() => {
    if (!quoteId) return;
    const raf = requestAnimationFrame(() => document.getElementById(sectionId)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [quoteId, sectionId]);
  if (!quote) return null;

  const { paying, recovering, outcomeUnknown, quoting } = order;
  const expiresAt = Date.parse(quote.expires_at);
  const left = Number.isFinite(expiresAt) ? expiresAt - (nowMs + skewMs) : Number.POSITIVE_INFINITY;
  const expired = left <= 0;
  const short = Math.max(0, quote.net - Number(quote.available_balance ?? 0));
  const trialBlocks = trialAction !== null && quote.trial_active && quote.net > 0;
  const freeMonthOffered =
    quote.free_month_available === true && !quote.sponsorship_id && !outcomeUnknown;
  const titleId = `${sectionId}-title`;

  const secondary = outcomeUnknown
    ? {
        label: recovering ? 'Checking' : 'Check Again',
        onClick: () => void order.recover(quote),
        disabled: paying || recovering,
      }
    : { label: 'Discard', onClick: order.discard, disabled: paying || busy };
  let primary: { label: string; ink: ConsoleInk; onClick: () => void; disabled: boolean };
  if (outcomeUnknown) {
    primary = {
      label: paying ? 'Retrying' : 'Retry Same Order',
      ink: 'white',
      onClick: () => void order.confirm(),
      disabled: paying || recovering,
    };
  } else if (expired) {
    primary = {
      label: quoting ? 'Quoting' : 'Get A New Quote',
      ink: 'white',
      onClick: onRequote,
      disabled: quoting || !canRequote,
    };
  } else if (trialBlocks && trialAction) {
    primary = {
      label: trialAction.plate,
      ink: trialAction.onClick ? 'white' : 'muted',
      onClick: trialAction.onClick ?? (() => undefined),
      disabled: trialAction.disabled || !trialAction.onClick,
    };
  } else if (short > 0) {
    primary = { label: 'Get Diamonds', ink: 'gold', onClick: onGetDiamonds, disabled: paying };
  } else {
    primary = {
      label: paying
        ? 'Confirming'
        : quote.net === 0
          ? 'Confirm, No Charge'
          : `Pay ${diamonds(quote.net)}`,
      ink: 'white',
      onClick: () => void order.confirm(),
      disabled: paying || recovering || !order.hasKey(quote.quote_id),
    };
  }

  return (
    <SpadeConsole
      id={sectionId}
      tabIndex={-1}
      aria-labelledby={titleId}
      eyebrow={eyebrow}
      title="Confirm Your Order"
      titleId={titleId}
      pill={expired ? 'Expired' : `Expires In ${clockWord(left)}`}
      pillInk={expired || left <= 10_000 ? 'red' : 'gold'}
      plates={{ secondary, primary }}
    >
      <div className={styles.rows}>
        {forClub ? (
          <Row
            label="For Club"
            value={forClub}
            ink="silver"
            wrap
            meta="Paid From Your Union Sponsorship"
          />
        ) : null}
        {quote.lines.map((l) => {
          const starts =
            quote.purchase_kind === 'upgrade'
              ? 'Upgrade Starts Now'
              : quote.trial_active
                ? 'Starts When The Free Month Ends'
                : 'Period';
          const qty = l.quantity > 1 ? ` For ${l.quantity.toLocaleString()} Covered Clubs` : '';
          return (
            <Row
              key={l.index}
              label={`${l.title}${qty}`}
              value={diamonds(l.net)}
              wrap
              meta={`${termWord(l.term_hours)} Of Access. ${starts}: ${when(l.starts_at)} To ${when(l.ends_at)}. List ${Number(l.gross).toLocaleString()}${l.credit ? `, Unused Value Credit ${Number(l.credit).toLocaleString()}` : ''}${l.waiver ? `, Trial Waiver ${Number(l.waiver).toLocaleString()}` : ''}.`}
            />
          );
        })}
        <Row
          label="Total"
          value={diamonds(quote.net)}
          ink="gold"
          wrap
          meta={`Paid In Diamonds Only. Payer: ${quote.sponsorship_id ? 'Union Sponsor' : 'You'}.`}
        />
        {notice ? (
          <Row label={notice.label} value={notice.value} ink={notice.ink} wrap meta={notice.meta} />
        ) : null}
        <Row
          label={quote.sponsorship_id ? 'Sponsor Available' : 'Available'}
          value={Number(quote.available_balance ?? 0).toLocaleString()}
          ink={short > 0 ? 'red' : 'green'}
          wrap
          meta={
            short > 0
              ? `${short.toLocaleString()} More Diamonds Needed. Add Diamonds, Then Get A New Quote Here.`
              : 'Enough Available Diamonds'
          }
        />
        {quote.renewal_max_diamonds != null ? (
          <Row
            label="Renewal"
            value={`Up To ${diamonds(quote.renewal_max_diamonds)}`}
            ink="blue"
            wrap
            meta="Authorized For The Following Period. Cancel Any Time Before It Is Due."
          />
        ) : null}
        {trialBlocks && trialAction && !outcomeUnknown ? (
          <Row
            label={trialAction.rowLabel}
            value="Not Yet"
            ink="blue"
            wrap
            meta={trialAction.note}
          />
        ) : null}
        {outcomeUnknown ? (
          <Row
            label="Outcome Unknown"
            value="Checking"
            ink="gold"
            wrap
            meta="The Connection Dropped Before The Answer. Retrying Sends The Same Order Key, So This Order Is Charged At Most Once."
          />
        ) : null}
        {freeMonthOffered && freeMonth ? (
          <>
            <Row
              label="Free Month Available"
              value="Not Started"
              ink="blue"
              wrap
              meta="You Have Never Had A Free Month. It Runs Every Included Operating Service For 30 Days With No Service Fee. Paying Now Is Still Your Choice."
            />
            <ChoiceRow
              label="Start Free Month"
              meta={`Starts Now Instead Of This Order, Which Is Discarded Uncharged. ${serviceTermsLine(serviceTermsVersion)}`}
              value={freeMonth.busy ? 'Starting' : 'Start'}
              ink="green"
              disabled={freeMonth.busy || paying || recovering}
              onClick={freeMonth.onStart}
            />
          </>
        ) : null}
        <Row
          label="Operating Service Terms"
          value={serviceTermsVersion ? `Version ${serviceTermsVersion}` : 'In Effect'}
          ink="blue"
          wrap
          meta={`By Confirming, ${serviceTermsLine(serviceTermsVersion)}`}
        />
      </div>
      <p className="sc-copy">
        Confirming Charges Your Diamonds Once. If The Connection Drops, Retrying Sends The Same
        Order Key And Never Charges Twice. {refundPolicyLine(refundPolicyVersion)} A Refund Returns
        To The Original Payer.
      </p>
    </SpadeConsole>
  );
}

/** The authoritative receipt for the order just placed (or found on file). */
function ReceiptConsole({
  order,
  sectionId,
  forClub,
}: {
  order: CommerceOrder;
  sectionId: string;
  forClub?: string;
}) {
  const receipt = order.receipt;
  const receiptId = receipt?.purchase_id ?? null;
  useEffect(() => {
    if (!receiptId) return;
    const raf = requestAnimationFrame(() => document.getElementById(sectionId)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [receiptId, sectionId]);
  if (!receipt) return null;
  const titleId = `${sectionId}-title`;
  return (
    <SpadeConsole
      id={sectionId}
      tabIndex={-1}
      aria-labelledby={titleId}
      eyebrow="Receipt"
      title="Order Complete"
      titleId={titleId}
      pill={receipt.is_replay ? 'On File' : 'Paid'}
      pillInk="green"
      foot="foot"
    >
      <div className={styles.rows}>
        {forClub ? <Row label="For Club" value={forClub} wrap /> : null}
        <Row label="Original Charge" value={diamonds(receipt.original_total_diamonds)} ink="gold" />
        {order.receiptFoundOnFile ? (
          <Row
            label="Charged For This Order"
            value={diamonds(receipt.original_total_diamonds)}
            ink="green"
            wrap
            meta="Found On File After The Connection Dropped. Charged Once."
          />
        ) : (
          <Row
            label={receipt.is_replay ? 'Charged On This Retry' : 'Charged Now'}
            value={diamonds(receipt.charged_this_attempt)}
            ink={receipt.charged_this_attempt ? 'green' : 'muted'}
          />
        )}
        {receipt.trial_waiver ? (
          <Row label="Trial Waiver" value={diamonds(receipt.trial_waiver)} ink="blue" />
        ) : null}
        {(receipt.lines ?? []).map((l) => (
          <Row
            key={l.index}
            label={l.title}
            value={diamonds(l.net)}
            wrap
            meta={`${when(l.starts_at)} To ${when(l.ends_at)}`}
          />
        ))}
        <Row
          label="Order"
          value={orderRef(receipt.purchase_id)}
          wrap
          meta={`Committed ${when(receipt.committed_at)}.${
            catalogWord(receipt.catalog_version)
              ? ` Prices Published ${catalogWord(receipt.catalog_version)}.`
              : ''
          }`}
        />
        {typeof receipt.balance_after === 'number' ? (
          <Row
            label="Balance After"
            value={receipt.balance_after.toLocaleString()}
            meta={`Observed ${when(receipt.balance_observed_at)}`}
          />
        ) : null}
      </div>
    </SpadeConsole>
  );
}

/* ══ Refund requests (20260924102040) ═════════════════════════════════════
   The payer of a paid line asks; platform staff decide; the engine's
   commerce consumer returns the diamonds. The page computes nothing: the
   policy amount and its basis come back with the request.

   ONE REQUEST KEY PER OPEN ATTEMPT, by the order key's rules: the key is
   minted when the console opens (it is keyed per opening, so a new opening
   mounts a new key), every send from that opening carries it, and an unknown
   outcome re-reads the receipts and then offers only a retry with the same
   key, which the server answers with the one request it recorded. */

type RefundTarget = { receipt: Receipt; line: QuoteLine; opened: number };

function RefundRequestConsole({
  target,
  forName,
  refundPolicy,
  readReceipts,
  onSettled,
  onClose,
}: {
  target: RefundTarget;
  /** The club a sponsored purchase was for, when the page knows its name. */
  forName?: string;
  refundPolicy: Policy | null;
  readReceipts: () => Promise<Receipt[]>;
  onSettled: () => Promise<void>;
  onClose: () => void;
}) {
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const sectionId = 'diamond-costs-refund';
  const titleId = `${sectionId}-title`;
  const detailsId = useId();
  /* Minted once per opening of this console, never on a render. */
  const keyRef = useRef<string>('');
  if (!keyRef.current) keyRef.current = uuid();
  const sendingRef = useRef(false);
  const [reason, setReason] = useState<RefundReason | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [result, setResult] = useState<RefundRequest | null>(null);
  const [foundOnFile, setFoundOnFile] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const { receipt, line } = target;
  const refundable = refundableFor(receipt, line.index);
  const locked = sending || unknown || recovering;
  const resultId = result?.request_id ?? null;

  useEffect(() => {
    const raf = requestAnimationFrame(() => document.getElementById(sectionId)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [resultId]);

  /** The outcome is unknown: a request for this line on file means it was recorded. */
  const recover = async (sent: RefundReason) => {
    setRecovering(true);
    try {
      const onFile = await readReceipts();
      if (!isMountedRef.current) return;
      const found = (
        onFile.find((x) => x.purchase_id === receipt.purchase_id)?.refund_requests ?? []
      )
        .filter(
          (q) =>
            q.line_index === line.index && q.reason_code === sent && OPEN_REFUND_STATES.has(q.state)
        )
        .pop();
      if (found) {
        setResult(found);
        setFoundOnFile(true);
        setUnknown(false);
        toast.info('Your Refund Request Was Found On File. It Was Recorded Once');
        await onSettled();
      } else {
        setUnknown(true);
        toast.error('The Request Outcome Is Unknown. Retry Uses The Same Request Key');
      }
    } catch (e) {
      reportError(e, 'ClubDiamondCostsPage.refundRecover');
      if (!isMountedRef.current) return;
      setUnknown(true);
      toast.error('Your Request Could Not Be Checked. Retry Uses The Same Request Key');
    } finally {
      if (isMountedRef.current) setRecovering(false);
    }
  };

  const send = async () => {
    if (!reason || sendingRef.current) return;
    const note = details.trim();
    if (note.length > 2000) return toast.error(refusalCopy('details_too_long'));
    sendingRef.current = true;
    setSending(true);
    setRefused(null);
    try {
      const r = await ClubCommerceService.refundRequest(
        receipt.purchase_id,
        line.index,
        reason,
        keyRef.current,
        note || null
      );
      if (!isMountedRef.current) return;
      /* Any answer from the server is a known outcome. */
      setUnknown(false);
      if (isRefusal(r)) {
        const open = r.request as RefundRequest | undefined;
        if (r.error === 'request_already_open' && open && typeof open === 'object') {
          setResult(open);
          toast.info(refusalCopy(r.error));
          await onSettled();
          return;
        }
        let copy = refusalCopy(r.error, 'The Refund Request Was Refused');
        if (r.error === 'error_window_passed' && typeof r.purchased_at === 'string')
          copy += `. Purchased ${when(r.purchased_at)}`;
        setRefused(copy);
        toast.error(copy);
        return;
      }
      setResult(r.request);
      setFoundOnFile(false);
      toast.success(
        r.is_replay
          ? 'This Refund Request Was Already Received'
          : 'Refund Request Sent To Platform Staff'
      );
      await onSettled();
    } catch (e) {
      /* An unknown outcome is never a second request with a new key. */
      reportError(e, 'ClubDiamondCostsPage.refundRequest');
      if (isMountedRef.current) await recover(reason);
    } finally {
      sendingRef.current = false;
      if (isMountedRef.current) setSending(false);
    }
  };

  const policyVersion = result?.policy_version ?? refundPolicy?.version ?? null;
  const orderLine = `Order ${orderRef(receipt.purchase_id)}, Paid ${when(receipt.committed_at)}.${
    forName ? ` For ${forName}.` : ''
  }`;

  if (result) {
    const v = refundStateView(result);
    return (
      <SpadeConsole
        id={sectionId}
        tabIndex={-1}
        aria-labelledby={titleId}
        eyebrow="Refund"
        title="Refund Request"
        titleId={titleId}
        pill={v.value}
        pillInk={v.ink}
        foot="foot"
      >
        <div className={styles.rows}>
          <Row label={titleCase(line.title)} value={diamonds(line.net)} wrap meta={orderLine} />
          <RefundStateRow request={result} />
          <Row
            label="Policy Amount"
            value={diamonds(result.policy_amount)}
            ink="gold"
            wrap
            meta={`Refund Policy Version ${result.policy_version}. ${basisWord(result)}. Computed By The Server When You Asked.`}
          />
          {foundOnFile ? (
            <Row
              label="Found On File"
              value="Recorded Once"
              ink="green"
              wrap
              meta="The Connection Dropped Before The Answer. The Request Was Found On File And Was Recorded Once."
            />
          ) : null}
          <ChoiceRow
            label="Done"
            meta="Its State Stays On This Receipt Until The Refund Is Complete."
            value="Close"
            ink="blue"
            onClick={onClose}
          />
        </div>
        <p className="sc-copy">
          Platform Staff Review Every Request. An Approved Refund Returns To You As The Original
          Payer, And You Are Told At Each Step.
        </p>
      </SpadeConsole>
    );
  }

  return (
    <SpadeConsole
      id={sectionId}
      tabIndex={-1}
      aria-labelledby={titleId}
      eyebrow="Refund"
      title="Request A Refund"
      titleId={titleId}
      pill={unknown ? 'Unknown' : policyVersion ? `Version ${policyVersion}` : 'Policy'}
      pillInk={unknown ? 'gold' : 'blue'}
      plates={{
        secondary: unknown
          ? {
              label: recovering ? 'Checking' : 'Check Again',
              onClick: () => {
                if (reason) void recover(reason);
              },
              disabled: sending || recovering,
            }
          : { label: 'Close', onClick: onClose, disabled: sending },
        primary: unknown
          ? {
              label: sending ? 'Retrying' : 'Retry Same Request',
              ink: 'white',
              onClick: () => void send(),
              disabled: sending || recovering,
            }
          : {
              label: sending ? 'Sending' : 'Send Request',
              ink: 'white',
              onClick: () => void send(),
              disabled: sending || !reason,
            },
      }}
    >
      <div className={styles.rows}>
        <Row
          label={titleCase(line.title)}
          value={diamonds(line.net)}
          wrap
          meta={`${orderLine} Up To ${diamonds(refundable)} Can Still Be Returned.`}
        />
        {REFUND_REASONS.map((r) => (
          <ChoiceRow
            key={r.code}
            label={r.label}
            meta={r.note}
            value={reason === r.code ? 'Selected' : 'Choose'}
            ink={reason === r.code ? 'blue' : 'silver'}
            pressed={reason === r.code}
            disabled={locked}
            onClick={() => {
              setRefused(null);
              setReason(r.code);
            }}
          />
        ))}
      </div>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span className="sc-label sc-ink--blue">Details (Optional)</span>
          <textarea
            className={`${styles.fieldInput} ${own.detailsInput}`}
            value={details}
            maxLength={2000}
            rows={3}
            disabled={locked}
            aria-describedby={detailsId}
            onChange={(e) => setDetails(e.target.value)}
          />
          <span id={detailsId} className="sc-copy sc-ink--muted">
            Up To 2,000 Characters. Platform Staff Read Them With Your Request.
          </span>
        </label>
      </div>
      <div className={styles.rows}>
        <Row
          label="Refund Policy"
          value={policyVersion ? `Version ${policyVersion}` : 'Current'}
          ink="blue"
          wrap
          meta="Platform Staff Review Every Request. The Amount Under This Policy Is Computed By The Server When You Send It, And Shown Here."
        />
        {refused ? (
          <Row label="Not Sent" value="Refused" ink="red" wrap meta={`${refused}.`} />
        ) : null}
        {unknown ? (
          <Row
            label="Outcome Unknown"
            value="Checking"
            ink="gold"
            wrap
            meta="The Connection Dropped Before The Answer. Retrying Sends The Same Request Key, So Only One Request Is Recorded."
          />
        ) : null}
      </div>
    </SpadeConsole>
  );
}

/**
 * Every receipt on file, each line with its refund requests and, for the
 * payer, the way to ask for a refund. Shared by the owner's page and by a
 * former owner who can no longer read the scope but still reads what they
 * paid (fn_ca_commerce_receipts keeps it readable to the payer).
 */
function ReceiptsConsole({
  receipts,
  failed,
  retryDisabled,
  onRetry,
  describe,
  viewerId,
  requestsFor,
  refundPolicyVersion,
  refundOpenFor,
  onRequestRefund,
}: {
  receipts: Receipt[];
  failed: boolean;
  retryDisabled: boolean;
  onRetry: () => void;
  describe: (r: Receipt) => string;
  viewerId: string | null;
  requestsFor: (r: Receipt, lineIndex: number) => RefundRequest[];
  refundPolicyVersion: number | null;
  /** The purchase line whose request console is open, as "purchase:line". */
  refundOpenFor: string | null;
  onRequestRefund: (r: Receipt, line: QuoteLine) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? receipts : receipts.slice(0, RECEIPTS_SHOWN);
  return (
    <SpadeConsole
      eyebrow="Records"
      title="Receipts"
      pill={
        failed
          ? 'Not Read'
          : receipts.length > 0
            ? `${receipts.length.toLocaleString()} On File`
            : 'None'
      }
      pillInk={failed ? 'gold' : 'muted'}
      foot="foot"
    >
      <div className={styles.rows}>
        {failed ? (
          <ChoiceRow
            label="Receipts Could Not Be Read"
            meta="Your Orders Are Safe On File. Read Them Again."
            value="Retry"
            ink="gold"
            disabled={retryDisabled}
            onClick={onRetry}
          />
        ) : null}
        {!failed && receipts.length === 0 ? <Row label="No Receipts On File" value="" /> : null}
        {shown.map((r) => (
          <div key={r.purchase_id}>
            <Row
              label={`${r.kind === 'renewal' ? 'Renewal' : r.kind === 'upgrade' ? 'Upgrade' : 'Order'} ${orderRef(r.purchase_id)}`}
              value={diamonds(r.original_total_diamonds)}
              wrap
              meta={describe(r)}
            />
            {(r.lines ?? []).map((l) => {
              const requests = requestsFor(r, l.index);
              const open = requests.some((q) => OPEN_REFUND_STATES.has(q.state));
              const lineKey = `${r.purchase_id}:${l.index}`;
              const canAsk =
                viewerId !== null &&
                r.payer_id === viewerId &&
                Number(l.net) > 0 &&
                refundableFor(r, l.index) > 0 &&
                !open;
              return (
                <div key={lineKey}>
                  <Row
                    label={titleCase(l.title)}
                    value={diamonds(l.net)}
                    ink="muted"
                    wrap
                    meta={`${when(l.starts_at)} To ${when(l.ends_at)}`}
                  />
                  {requests.map((q) => (
                    <RefundStateRow key={q.request_id} request={q} />
                  ))}
                  {canAsk ? (
                    <ChoiceRow
                      label="Request A Refund"
                      meta={`For ${titleCase(l.title)}. Up To ${diamonds(refundableFor(r, l.index))} Can Still Be Returned. ${refundPolicyLine(refundPolicyVersion)}`}
                      value={refundOpenFor === lineKey ? 'Open' : 'Request'}
                      ink="blue"
                      pressed={refundOpenFor === lineKey}
                      disabled={refundOpenFor === lineKey}
                      onClick={() => onRequestRefund(r, l)}
                    />
                  ) : null}
                </div>
              );
            })}
            {(r.refunds ?? []).map((f) => (
              <Row
                key={f.id}
                label="Refund"
                value={diamonds(f.gross)}
                ink="green"
                wrap
                meta={`Applied To Existing Debt: ${Number(f.debt_settled).toLocaleString()}; Added To Available Balance: ${Number(f.net_increase).toLocaleString()}. ${when(f.created_at)}.`}
              />
            ))}
          </div>
        ))}
        {receipts.length > RECEIPTS_SHOWN ? (
          <ChoiceRow
            label={showAll ? 'Show Fewer Receipts' : 'Show All Receipts'}
            meta={`${receipts.length.toLocaleString()} Receipts On File`}
            value={showAll ? 'Fewer' : 'All'}
            ink="blue"
            pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
          />
        ) : null}
      </div>
      <p className="sc-copy">
        A Receipt Is Permanent Transaction Evidence. Your Wallet Balance Is Read Separately And May
        Have Changed Since. {refundPolicyLine(refundPolicyVersion)}
      </p>
    </SpadeConsole>
  );
}

/**
 * The refund policy in effect, the renewal terms a renewal accepts, and the
 * Operating Service Terms every purchase and free month accepts (their text
 * opens on request, it is long).
 */
function PolicyConsole({
  refund,
  terms,
  service = null,
}: {
  refund: Policy | null;
  terms: Policy | null;
  service?: Policy | null;
}) {
  const [serviceOpen, setServiceOpen] = useState(false);
  if (!refund && !terms && !service) return null;
  return (
    <SpadeConsole
      eyebrow="Policies"
      title={refund ? titleCase(refund.title) : 'Refund Policy'}
      pill={refund ? `Version ${refund.version}` : undefined}
      pillInk="blue"
      foot="foot"
    >
      {refund ? <p className="sc-copy">{titleCase(refund.body)}</p> : null}
      <div className={styles.rows}>
        {refund ? (
          <Row
            label="In Effect Since"
            value={dateWord(refund.effective_from)}
            ink="silver"
            wrap
            meta="A Policy Version Is Never Edited. A Change Is Published As A New Version, And Each Request Records The Version It Was Made Under."
          />
        ) : null}
        {terms ? (
          <Row
            label={titleCase(terms.title)}
            value={`Version ${terms.version}`}
            ink="blue"
            wrap
            meta={titleCase(terms.body)}
          />
        ) : null}
        {service ? (
          <ChoiceRow
            label={`Operating Service Terms, Version ${service.version}`}
            meta={`In Effect Since ${dateWord(service.effective_from)}. Every Purchase And Free Month Records The Version Accepted.`}
            value={serviceOpen ? 'Hide' : 'Read'}
            ink="blue"
            pressed={serviceOpen}
            onClick={() => setServiceOpen((v) => !v)}
          />
        ) : null}
      </div>
      {service && serviceOpen ? <p className="sc-copy">{titleCase(service.body)}</p> : null}
    </SpadeConsole>
  );
}

/** A sponsorship the viewer pays for, active and in its effective window. */
function sponsorshipIsEffective(s: Sponsorship, serverNow: number): boolean {
  if (s.state !== 'active') return false;
  const from = s.effective_from ? Date.parse(s.effective_from) : NaN;
  const to = s.effective_to ? Date.parse(s.effective_to) : NaN;
  if (Number.isFinite(from) && from > serverNow) return false;
  if (Number.isFinite(to) && to <= serverNow) return false;
  return true;
}

/**
 * BUY FOR A COVERED CLUB (union page, sponsor only). The union owner who pays
 * an active sponsorship chooses a covered club and a club capacity (or the
 * club insurance module, when the catalog says the platform offers it: R2
 * 5.2, accepted by the same sponsored quote and purchase doors), quotes it
 * as a sponsored club order (fn_ca_commerce_quote('club', club, lines,
 * sponsorship, NULL, 'purchase')) and confirms it with the same order key
 * rules as every other order. A club still in its free month cannot be
 * charged (trial_active_authorize_instead), so it is shown as such instead of
 * being offered for sale.
 */
function SponsorBuyConsole({
  status,
  clubProducts,
  sponsorships,
  checkoutEnabled,
  skewMs,
  onSettled,
  receipts,
  receiptsKnown,
  refundPolicyVersion,
  serviceTermsVersion,
  pricesPublished,
}: {
  status: ScopeStatus;
  clubProducts: CatalogProduct[];
  /** The viewer's own active sponsorships of this union. */
  sponsorships: Sponsorship[];
  checkoutEnabled: boolean;
  skewMs: number;
  onSettled: () => Promise<void>;
  /** Every receipt the viewer paid or placed (fn_ca_commerce_receipts(NULL, NULL)). */
  receipts: Receipt[];
  /** False when the receipts could not be read, so a club's sponsored spend is unknown. */
  receiptsKnown: boolean;
  refundPolicyVersion: number | null;
  serviceTermsVersion: number | null;
  /** False while the club catalog is read without prices. */
  pricesPublished: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [clubId, setClubId] = useState<string | null>(null);
  const [sku, setSku] = useState<string | null>(null);
  const [pickedSponsorship, setPickedSponsorship] = useState<string | null>(null);
  /* A club the server said is still in its free month, even if the status
     read (taken earlier) did not yet say so. */
  const [inTrial, setInTrial] = useState<ReadonlySet<string>>(() => new Set());
  const [nowMs] = useState(() => Date.now());

  const order = useCommerceOrder({
    where: 'ClubDiamondCostsPage.sponsor',
    readReceipts: () => ClubCommerceService.receipts(null, null),
    onSettled,
    onRefusal: (r) => {
      if (r.error !== 'trial_active_authorize_instead') return false;
      const id = clubId;
      if (id) setInTrial((prev) => new Set(prev).add(id));
      order.discard();
      toast.info('This Club Is Still In Its Free Month. Nothing Was Charged');
      return true;
    },
  });

  const clubs = status.covered_clubs ?? [];
  const club = clubs.find((c) => c.club_id === clubId) ?? null;
  const clubTrial = club !== null && (club.trial_active || inTrial.has(club.club_id));
  const capacities = clubProducts.filter((p) => p.kind === 'capacity' && p.scope_kind === 'club');
  /* The club insurance module, only when the platform says the capability it
     sells is available now (fn_ca_commerce_catalog platform_available). */
  const insurance = clubProducts.filter(
    (p) =>
      p.kind === 'club_insurance_module' &&
      p.scope_kind === 'club' &&
      p.supported &&
      p.platform_available === true
  );
  const offerings = [...capacities, ...insurance];
  const product = offerings.find((p) => p.sku === sku) ?? null;
  const serverNow = nowMs + skewMs;
  const eligible = club
    ? sponsorships.filter(
        (s) => (!s.club_id || s.club_id === club.club_id) && sponsorshipIsEffective(s, serverNow)
      )
    : [];
  const sponsorshipId =
    eligible.length === 1
      ? eligible[0].id
      : eligible.some((s) => s.id === pickedSponsorship)
        ? pickedSponsorship
        : null;
  const locked = order.locked;

  /**
   * What one sponsorship can still pay for this club, by the checks
   * fn_ca_commerce_purchase_impl makes before it charges a sponsored order:
   *   committed + net <= total_budget, and, when a per club budget is set,
   *   SUM(net) of this sponsorship's purchases for this club + net <= per_club_budget.
   * That sum counts every purchase's net as charged (a refund lowers the
   * sponsorship's committed, not the purchase's net), so it is summed here
   * from the receipts' original totals, never net of refunds. Every such
   * purchase is paid by the sponsor, so the viewer's own receipts hold all of
   * them. Null means it cannot be known: the receipts were not read, or one
   * of them does not say which sponsorship paid it.
   */
  const allowanceFor = (s: Sponsorship, forClub: string): number | null => {
    const total = Math.max(0, Number(s.total_budget ?? 0) - Number(s.committed ?? 0));
    if (s.per_club_budget == null) return total;
    if (!receiptsKnown) return null;
    const paidForClub = receipts.filter((r) => r.scope_id === forClub && r.payer_id === s.payer_id);
    if (paidForClub.some((r) => !('sponsorship_id' in r))) return null;
    const spent = paidForClub
      .filter((r) => r.sponsorship_id === s.id)
      .reduce((n, r) => n + Number(r.original_total_diamonds ?? 0), 0);
    return Math.max(0, Math.min(total, Number(s.per_club_budget) - spent));
  };
  const chosenSponsorship = eligible.find((s) => s.id === sponsorshipId) ?? null;
  /* With no sponsorship chosen yet, a capacity is on offer if ANY eligible
     sponsorship can pay for it; choosing one then applies its own limit. */
  const allowances = club
    ? (chosenSponsorship ? [chosenSponsorship] : eligible).map((s) => allowanceFor(s, club.club_id))
    : [];
  const allowanceKnown = allowances.length > 0 && allowances.every((a) => a !== null);
  const allowance = allowanceKnown ? Math.max(...(allowances as number[])) : null;
  const overAllowance = (p: CatalogProduct): boolean => {
    const price = listPrice(p, 1);
    return allowance === null || price === null || price > allowance;
  };

  const chooseClub = (id: string) => {
    order.editInputs();
    order.clearReceipt();
    setClubId(id);
    setSku(null);
    setPickedSponsorship(null);
  };

  const clear = () => {
    order.editInputs();
    setClubId(null);
    setSku(null);
    setPickedSponsorship(null);
  };

  const getQuote = () => {
    if (!club || !product) return toast.error('Choose A Club And A Service First');
    if (clubTrial)
      return toast.info('This Club Is Still In Its Free Month. Nothing Can Be Charged');
    if (!sponsorshipId) return toast.error('Choose The Sponsorship To Pay With');
    if (overAllowance(product)) return toast.error(refusalCopy('sponsorship_club_budget_exceeded'));
    if (!checkoutEnabled) return toast.error(refusalCopy('checkout_disabled'));
    const forClub = club.club_id;
    void order.requestQuote(() =>
      ClubCommerceService.quote('club', forClub, [{ sku: product.sku, quantity: 1 }], {
        sponsorshipId,
        renewalMaxDiamonds: null,
        purchaseKind: 'purchase',
      })
    );
  };

  return (
    <>
      <SpadeConsole
        eyebrow="Sponsorship"
        title="Buy For A Covered Club"
        pill={clubs.length === 1 ? '1 Club' : `${clubs.length.toLocaleString()} Clubs`}
        pillInk={clubs.length > 0 ? 'blue' : 'muted'}
        plates={{
          secondary: {
            label: 'Clear',
            onClick: clear,
            disabled: !clubId || order.quoting || locked,
          },
          primary: {
            label: order.quoting ? 'Quoting' : 'Get A Quote',
            ink: 'white',
            onClick: getQuote,
            disabled:
              order.quoting ||
              locked ||
              !club ||
              !product ||
              clubTrial ||
              !sponsorshipId ||
              overAllowance(product) ||
              !checkoutEnabled,
          },
        }}
      >
        <div className={styles.rows}>
          {clubs.length === 0 ? <Row label="No Covered Clubs" value="" /> : null}
          {clubs.map((c) => {
            const cap = c.capacity?.capacity ?? null;
            const over = cap !== null && c.roster_count > cap;
            const trial = c.trial_active || inTrial.has(c.club_id);
            const chosen = c.club_id === clubId;
            return (
              <ChoiceRow
                key={c.club_id}
                label={c.name || 'Unnamed Club'}
                meta={`${Number(c.roster_count ?? 0).toLocaleString()} Approved Members. ${
                  c.capacity && cap !== null
                    ? `Paid Capacity Up To ${cap.toLocaleString()} Through ${when(c.capacity.ends_at)}${c.capacity.source === 'sponsor' ? ', Sponsored' : ''}.`
                    : 'No Paid Capacity.'
                }${trial ? ' In Its Free Month; Nothing Can Be Charged Until It Ends.' : ''}${over ? ' Roster Exceeds Current Capacity.' : ''}`}
                value={
                  chosen
                    ? 'Selected'
                    : over
                      ? 'Over Capacity'
                      : trial
                        ? 'Free Month'
                        : cap !== null
                          ? `${cap.toLocaleString()} Members`
                          : 'No Capacity'
                }
                ink={chosen ? 'blue' : over ? 'red' : trial ? 'muted' : 'silver'}
                pressed={chosen}
                disabled={locked}
                onClick={() => chooseClub(c.club_id)}
              />
            );
          })}
        </div>
        {club && clubTrial ? (
          <div className={styles.rows}>
            <Row
              label="Club In Its Free Month"
              value="Not Yet"
              ink="blue"
              wrap
              meta="Sponsored Capacity Can Be Bought Once Its Free Month Ends. Nothing Is Charged Before Then."
            />
          </div>
        ) : null}
        {club && !clubTrial ? (
          <div className={styles.rows}>
            {!pricesPublished ? (
              <Row
                label="Diamond Prices Are Not Published Yet"
                value="Not Yet"
                ink="gold"
                wrap
                meta="Nothing Can Be Quoted Until Prices Are Published."
              />
            ) : null}
            {offerings.map((p) => {
              const isCapacity = p.kind === 'capacity';
              const tooSmall = isCapacity && p.capacity !== null && club.roster_count > p.capacity;
              const current = isCapacity && club.capacity?.sku === p.sku;
              /* Never offered when the sponsorship cannot pay for it: the
                 purchase would be refused (sponsorship_budget_exceeded or
                 sponsorship_club_budget_exceeded). */
              const overBudget = eligible.length > 0 && overAllowance(p);
              const note = !p.supported
                ? ' Not Yet Available.'
                : tooSmall
                  ? ` Smaller Than Its ${Number(club.roster_count).toLocaleString()} Approved Members.`
                  : overBudget && allowance === null
                    ? ' Its Sponsored Allowance Could Not Be Read. Retry The Receipts Below.'
                    : overBudget
                      ? ` Above The ${diamonds(allowance)} Left In This Club's Sponsored Allowance.`
                      : !isCapacity
                        ? ` ${sentence(p.included_note).trim() || 'Insurance Software Access For This Club.'} Starts Now, Or After Any Insurance Period Already Paid.`
                        : current
                          ? ' Its Current Capacity; Buying It Again Adds The Next Period.'
                          : club.capacity
                            ? ' Starts When Its Current Paid Period Ends.'
                            : ' Starts Now.';
              const offered = p.supported && !tooSmall && !overBudget;
              return (
                <ChoiceRow
                  key={p.sku}
                  label={p.title}
                  meta={`${periodWord(p)}.${note}`}
                  value={p.supported ? priceWord(p) : 'Not Yet Available'}
                  ink={sku === p.sku ? 'blue' : offered ? 'silver' : 'muted'}
                  pressed={sku === p.sku}
                  disabled={!p.supported || !p.price || tooSmall || overBudget || locked}
                  onClick={() => {
                    order.editInputs();
                    order.clearReceipt();
                    setSku(p.sku);
                  }}
                />
              );
            })}
            {eligible.length === 0 ? (
              <Row
                label="No Sponsorship Covers This Club"
                value="None"
                ink="gold"
                wrap
                meta="Record A Budget For Any Covered Club, Or One For This Club, Above."
              />
            ) : null}
            {eligible.length > 1
              ? eligible.map((s) => (
                  <ChoiceRow
                    key={s.id}
                    label={s.club_id ? 'Pay With This Club Budget' : 'Pay With Any Club Budget'}
                    meta={
                      allowanceFor(s, club.club_id) === null
                        ? 'Its Allowance For This Club Could Not Be Read.'
                        : `${diamonds(allowanceFor(s, club.club_id))} Left For This Club${s.per_club_budget ? `, Of ${diamonds(s.per_club_budget)} Per Club` : ''}.`
                    }
                    value={sponsorshipId === s.id ? 'Selected' : 'Select'}
                    ink={sponsorshipId === s.id ? 'blue' : 'silver'}
                    pressed={sponsorshipId === s.id}
                    disabled={locked}
                    onClick={() => {
                      order.editInputs();
                      setPickedSponsorship(s.id);
                    }}
                  />
                ))
              : null}
            {eligible.length === 1 ? (
              <Row
                label="Paid From"
                value={allowance === null ? 'Unknown' : `${diamonds(allowance)} Left`}
                ink={allowance === null ? 'gold' : 'silver'}
                wrap
                meta={`${eligible[0].club_id ? 'The Budget For This Club' : 'Your Budget For Any Covered Club'}: ${diamonds(Math.max(0, Number(eligible[0].total_budget ?? 0) - Number(eligible[0].committed ?? 0)))} Of ${diamonds(eligible[0].total_budget)} Uncommitted${eligible[0].per_club_budget ? `, Up To ${diamonds(eligible[0].per_club_budget)} Per Club` : ''}.${allowance === null ? ' What This Club Has Already Used Could Not Be Read; Retry The Receipts Below.' : ''}`}
              />
            ) : null}
          </div>
        ) : null}
        <p className="sc-copy">
          A Sponsored Order Is Charged To You Once And Pays For That Club's Capacity Or Insurance
          Module; The Club Owner Is Never Charged For The Same Period. Its Receipt Is Listed Below.
        </p>
      </SpadeConsole>

      <QuoteConsole
        order={order}
        sectionId="diamond-costs-sponsor-quote"
        eyebrow="Sponsored Quote"
        forClub={club?.name}
        skewMs={skewMs}
        busy={false}
        canRequote={Boolean(club && product && sponsorshipId && !clubTrial)}
        onRequote={getQuote}
        trialAction={{
          plate: 'After Its Free Month',
          disabled: true,
          rowLabel: 'Club In Its Free Month',
          note: `Nothing Can Be Charged Before ${when(order.quote?.trial_end)}. Buy Its Capacity Once The Free Month Ends.`,
        }}
        onGetDiamonds={() => navigate(BUY_DIAMONDS)}
        refundPolicyVersion={refundPolicyVersion}
        serviceTermsVersion={serviceTermsVersion}
      />
      <ReceiptConsole
        order={order}
        sectionId="diamond-costs-sponsor-receipt"
        forClub={club?.name}
      />
      {order.recovering ? <LoadingState message="Checking Your Order" /> : null}
    </>
  );
}

/* ══ Written quotes above 2,500 members (20260924182605) ══════════════════
   The owner asks with the capacity they need; platform staff offer a
   capacity and a price for this club alone, or decline with a note. An offer
   is a private capacity product, bought through the page's one order flow
   (quote, order key, confirm), so nothing here charges anything. Clubs only. */

function writtenQuoteView(w: WrittenQuote): {
  label: string;
  value: string;
  ink: ConsoleInk;
  meta: string;
} {
  const cap = Number(w.offered_capacity ?? w.requested_capacity ?? 0).toLocaleString();
  const staff = w.staff_note ? ` Note From Platform Staff: ${noteWords(w.staff_note)}.` : '';
  switch (w.state) {
    case 'requested':
      return {
        label: `Up To ${Number(w.requested_capacity).toLocaleString()} Members`,
        value: 'Requested',
        ink: 'blue',
        meta: `Asked ${when(w.created_at)}.${w.request_note ? ` Your Note: ${noteWords(w.request_note)}.` : ''} Platform Staff Reply With A Capacity And A Price, Or A Note.`,
      };
    case 'offered':
      return {
        label: `Up To ${cap} Approved Members`,
        value: diamonds(w.offered_diamonds),
        ink: 'gold',
        meta: `Written Quote For 30 Days Of Access, For This Club Only. Valid Until ${when(w.valid_until)}.${staff} You Asked For ${Number(w.requested_capacity).toLocaleString()}.`,
      };
    case 'accepted':
      return {
        label: `Up To ${cap} Approved Members`,
        value: 'Bought',
        ink: 'green',
        meta: `Bought At ${diamonds(w.offered_diamonds)} For 30 Days. It Renews And Upgrades Like Any Capacity.`,
      };
    case 'expired':
      return {
        label: `Up To ${cap} Approved Members`,
        value: 'Expired',
        ink: 'muted',
        meta: `The Offer Of ${diamonds(w.offered_diamonds)} Was Valid Until ${when(w.valid_until)}. Ask Again For A New Written Quote.`,
      };
    case 'declined':
      return {
        label: `Up To ${cap} Members`,
        value: 'Declined',
        ink: 'red',
        meta: `${staff.trim() || 'Declined By Platform Staff.'} Declined ${when(w.decided_at)}.`,
      };
    case 'withdrawn':
    default:
      return {
        label: `Up To ${cap} Members`,
        value: 'Withdrawn',
        ink: 'muted',
        meta: `You Withdrew This Request ${when(w.decided_at)}.`,
      };
  }
}

function WrittenQuotesConsole({
  quotes,
  isOwner,
  busy,
  buyDisabled,
  buyingId,
  onRequest,
  onWithdraw,
  onBuy,
}: {
  quotes: WrittenQuote[];
  isOwner: boolean;
  busy: boolean;
  /** True while an order is in flight, checkout is paused or prices are hidden. */
  buyDisabled: boolean;
  /** The offer whose quote is on the confirm step. */
  buyingId: string | null;
  onRequest: (capacity: number, note: string | null) => Promise<boolean>;
  onWithdraw: (w: WrittenQuote) => void;
  onBuy: (w: WrittenQuote) => void;
}) {
  const toast = useToast();
  const noteId = useId();
  const [capacity, setCapacity] = useState('');
  const [note, setNote] = useState('');
  const open = quotes.find((w) => w.state === 'requested') ?? null;
  const offered = quotes.filter((w) => w.state === 'offered').length;
  const asking = isOwner && !open;
  const wanted = parseWhole(capacity);
  const valid = wanted !== null && wanted > WRITTEN_QUOTE_FLOOR && wanted <= 1_000_000;

  const send = async () => {
    if (!valid || wanted === null)
      return toast.error(refusalCopy('written_quote_capacity_out_of_range'));
    const text = note.trim();
    if (text.length > 2000) return toast.error(refusalCopy('note_too_long'));
    if (await onRequest(wanted, text || null)) {
      setCapacity('');
      setNote('');
    }
  };

  return (
    <SpadeConsole
      eyebrow="Above 2,500 Members"
      title="Written Quotes"
      pill={open ? 'Requested' : offered > 0 ? `${offered.toLocaleString()} Offered` : 'Ask'}
      pillInk={open ? 'blue' : offered > 0 ? 'gold' : 'muted'}
      plates={
        asking
          ? {
              secondary: {
                label: 'Clear',
                onClick: () => {
                  setCapacity('');
                  setNote('');
                },
                disabled: busy || (capacity === '' && note === ''),
              },
              primary: {
                label: busy ? 'Sending' : 'Ask For A Quote',
                ink: 'white',
                onClick: () => void send(),
                disabled: busy || !valid,
              },
            }
          : undefined
      }
      foot={asking ? 'plates' : 'foot'}
    >
      <div className={styles.rows}>
        {quotes.length === 0 ? <Row label="No Written Quotes Yet" value="" /> : null}
        {quotes.map((w) => {
          const v = writtenQuoteView(w);
          return (
            <div key={w.written_quote_id}>
              <Row label={v.label} value={v.value} ink={v.ink} wrap meta={v.meta} />
              {w.state === 'offered' && isOwner ? (
                <ChoiceRow
                  label="Buy This Written Quote"
                  meta="Priced Through The Normal Order: You See The Exact Charge And Period Before Paying."
                  value={buyingId === w.written_quote_id ? 'Quoted' : 'Buy'}
                  ink="blue"
                  pressed={buyingId === w.written_quote_id}
                  disabled={buyDisabled || busy}
                  onClick={() => onBuy(w)}
                />
              ) : null}
              {w.state === 'requested' && isOwner ? (
                <ChoiceRow
                  label="Withdraw Request"
                  meta="Platform Staff Stop Working On It. You Can Ask Again Afterwards."
                  value={busy ? 'Saving' : 'Withdraw'}
                  ink="red"
                  disabled={busy}
                  onClick={() => onWithdraw(w)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {asking ? (
        <div className={styles.fields}>
          <Field
            label="Members Needed (More Than 2,500)"
            value={capacity}
            onChange={setCapacity}
            disabled={busy}
            hint="Approved Members, Each Counted Once, Up To 1,000,000."
          />
          <label className={styles.field}>
            <span className="sc-label sc-ink--blue">Note (Optional)</span>
            <textarea
              className={`${styles.fieldInput} ${own.detailsInput}`}
              value={note}
              maxLength={2000}
              rows={3}
              disabled={busy}
              aria-describedby={noteId}
              onChange={(e) => setNote(e.target.value)}
            />
            <span id={noteId} className="sc-copy sc-ink--muted">
              Up To 2,000 Characters. What Platform Staff Should Know About Your Club.
            </span>
          </label>
        </div>
      ) : null}
      <p className="sc-copy">
        Above 2,500 Members There Is No List Price. Platform Staff Offer A Capacity And A Price In
        Writing For This Club Alone, And You Buy It Through The Same Order As Any Capacity.
      </p>
    </SpadeConsole>
  );
}

/* ══ Free month review (20260924182605, R2 2.4) ═══════════════════════════
   A later club or union of the same operator shares the first free month's
   end, so one enrolled after it ended has no free days. A genuinely new,
   independent operation asks platform staff for a review with a statement;
   staff approve (a fresh 30 days for this one scope) or decline with a note. */

function reviewView(r: TrialReview): { value: string; ink: ConsoleInk; meta: string } {
  const asked = `Asked ${when(r.created_at)}. Your Statement: ${noteWords(r.statement)}.`;
  const staff = r.staff_note ? ` Note From Platform Staff: ${noteWords(r.staff_note)}.` : '';
  if (r.state === 'approved')
    return {
      value: 'Approved',
      ink: 'green',
      meta: `${asked}${staff} Your Free Month For This Scope Ends ${when(r.granted_trial_end)}.`,
    };
  if (r.state === 'declined')
    return {
      value: 'Declined',
      ink: 'red',
      meta: `${asked}${staff || ' Declined By Platform Staff.'} Declined ${when(r.decided_at)}.`,
    };
  return { value: 'Requested', ink: 'blue', meta: `${asked} With Platform Staff For A Decision.` };
}

function TrialReviewConsole({
  reviews,
  endedAt,
  canAsk,
  busy,
  onRequest,
}: {
  reviews: TrialReview[];
  /** When this scope's free month ended, if it has. */
  endedAt: string | null;
  canAsk: boolean;
  busy: boolean;
  onRequest: (statement: string) => Promise<boolean>;
}) {
  const statementId = useId();
  const [statement, setStatement] = useState('');
  const length = statement.trim().length;
  const valid = length >= REVIEW_MIN && length <= REVIEW_MAX;
  const latest = reviews[0] ?? null;
  const send = async () => {
    if (valid && (await onRequest(statement.trim()))) setStatement('');
  };
  return (
    <SpadeConsole
      eyebrow="Free Month"
      title="Free Month Review"
      pill={latest ? reviewView(latest).value : canAsk ? 'Available' : 'None'}
      pillInk={latest ? reviewView(latest).ink : 'muted'}
      plates={
        canAsk
          ? {
              secondary: {
                label: 'Clear',
                onClick: () => setStatement(''),
                disabled: busy || statement === '',
              },
              primary: {
                label: busy ? 'Sending' : 'Ask For A Review',
                ink: 'white',
                onClick: () => void send(),
                disabled: busy || !valid,
              },
            }
          : undefined
      }
      foot={canAsk ? 'plates' : 'foot'}
    >
      <div className={styles.rows}>
        {endedAt ? (
          <Row
            label="Free Month Ended"
            value={dateWord(endedAt)}
            ink="muted"
            wrap
            meta="A Later Club Or Union Of The Same Operator Shares The First Free Month's End. A Genuinely New, Independent Operation Can Ask Platform Staff For A Review."
          />
        ) : null}
        {reviews.map((r) => {
          const v = reviewView(r);
          return (
            <Row
              key={r.review_id}
              label="Free Month Review"
              value={v.value}
              ink={v.ink}
              wrap
              meta={v.meta}
            />
          );
        })}
      </div>
      {canAsk ? (
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className="sc-label sc-ink--blue">Why This Is A New Operation</span>
            <textarea
              className={`${styles.fieldInput} ${own.detailsInput}`}
              value={statement}
              maxLength={REVIEW_MAX}
              rows={4}
              disabled={busy}
              aria-describedby={statementId}
              onChange={(e) => setStatement(e.target.value)}
            />
            <span id={statementId} className="sc-copy sc-ink--muted">
              {`${length.toLocaleString()} Of 2,000 Characters, At Least 20. No Documents Are Needed.`}
            </span>
          </label>
        </div>
      ) : null}
    </SpadeConsole>
  );
}

/* ══ Settled earnings (20260924183657, R2 5.3 and 5.5) ════════════════════
   The owner's settled Diamond Spins earnings beside the operating diamonds
   they paid for this scope, in the same window. A comparison only: every
   purchase is still paid from the available balance under the normal
   accounting order, and nothing here says which diamonds paid. */

function EarningsConsole({
  coverage,
  scopeWord,
}: {
  coverage: EarningsCoverage;
  scopeWord: string;
}) {
  const e = coverage.earnings;
  const o = coverage.operating;
  const days = Number(coverage.days ?? 30);
  const earnMeta = [
    `Diamond Spins Daily Settlements Credited To You In The Last ${days} Days, Across Everything You Host`,
    `${Number(e.credited).toLocaleString()} Credited`,
    e.debited ? `${Number(e.debited).toLocaleString()} Debited` : '',
    e.applied_to_debt
      ? `${Number(e.applied_to_debt).toLocaleString()} Settled An Earlier Diamond Debt`
      : '',
  ]
    .filter(Boolean)
    .join(', ');
  const paidMeta = `${Number(o.purchases).toLocaleString()} ${o.purchases === 1 ? 'Purchase' : 'Purchases'} Paid By You In The Same ${days} Days${
    o.refunded ? `, After ${diamonds(o.refunded)} Refunded` : ''
  }.${o.paid_by_others ? ` ${diamonds(o.paid_by_others)} More Paid By Your Union Sponsor.` : ''} All Your Operating Purchases: ${diamonds(o.owner_all_scopes_net_paid)}.`;
  return (
    <SpadeConsole
      eyebrow={`Last ${days} Days`}
      title="Settled Earnings"
      pill="Comparison"
      pillInk="muted"
      foot="foot"
    >
      <p className="sc-copy">Settled Earnings Can Help Cover Operating Purchases.</p>
      <div className={styles.rows}>
        <Row
          label="Settled Earnings"
          value={diamonds(e.net_settled)}
          ink={e.net_settled > 0 ? 'green' : 'muted'}
          wrap
          meta={`${earnMeta}.${e.pending_unsettled > 0 ? ` ${diamonds(e.pending_unsettled)} Not Yet Settled Are Not Counted.` : ''}`}
        />
        <Row
          label={`Operating Purchases For This ${scopeWord}`}
          value={diamonds(o.net_paid)}
          ink="silver"
          wrap
          meta={paidMeta}
        />
      </div>
      <p className="sc-copy sc-ink--muted">
        A Comparison, Not A Record Of Which Diamonds Paid. Every Purchase Is Paid From Your
        Available Balance Under The Normal Accounting Order, And Earnings Already Spent Are Not
        Available Again.
      </p>
    </SpadeConsole>
  );
}

/**
 * The route entry. It resolves nothing itself; it keys the console by scope so
 * a switch between clubs or unions (or a retry after an error) mounts a fresh
 * console with no state, key or in-flight response carried across.
 */
/**
 * Loading, not found and read failures, on the same spade console as the page
 * (#ClubArenaConsole): the message printed on the glass, and the two painted
 * plates, Operations and Try Again. Try Again remounts the console, so it is
 * also the way out of a read that never answers.
 */
function StateConsole({
  scopeKind,
  backPath,
  pill,
  pillInk,
  message,
  onRetry,
}: {
  scopeKind: ScopeKind;
  /** Null when there is no scope to go back to (a route that names none). */
  backPath: string | null;
  pill: string;
  pillInk: ConsoleInk;
  message: string;
  onRetry?: () => void;
}) {
  const navigate = useNavigate();
  const scopeWord = scopeKind === 'union' ? 'Union' : 'Club';
  return (
    <div className={styles.page}>
      <SpadeConsole
        eyebrow={`${scopeWord} Operations`}
        title="Diamond Costs"
        titleId="diamond-costs-title"
        pill={pill}
        pillInk={pillInk}
        aria-busy={pill === 'Reading' ? true : undefined}
        plates={{
          secondary: {
            label: backPath ? 'Operations' : 'Home',
            onClick: () => navigate(backPath ?? '/'),
          },
          primary: {
            label: 'Try Again',
            ink: 'white',
            onClick: () => onRetry?.(),
            disabled: !onRetry,
          },
        }}
      >
        <p className="sc-copy" role={pill === 'Reading' ? 'status' : 'alert'}>
          {message}
        </p>
      </SpadeConsole>
    </div>
  );
}

export default function ClubDiamondCostsPage({ scopeKind }: { scopeKind: ScopeKind }) {
  const params = useParams<{ clubId?: string; unionId?: string }>();
  const routeId = scopeKind === 'club' ? params.clubId : params.unionId;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (!routeId || (scopeKind === 'union' && !isUUID(routeId))) {
    return (
      <StateConsole
        scopeKind={scopeKind}
        backPath={null}
        pill="Not Found"
        pillInk="red"
        message={scopeKind === 'union' ? 'This Union Was Not Found' : 'This Club Was Not Found'}
      />
    );
  }
  return (
    <DiamondCostsConsole
      key={`${scopeKind}:${routeId}:${attempt}`}
      scopeKind={scopeKind}
      routeId={routeId}
      onRetry={retry}
    />
  );
}

function DiamondCostsConsole({
  scopeKind,
  routeId,
  onRetry,
}: {
  scopeKind: ScopeKind;
  routeId: string;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();
  const { user } = useAuthUser();
  const viewerId = user?.id ?? null;

  const [scopeId, setScopeId] = useState<string | null>(null);
  const [status, setStatus] = useState<ScopeStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  /* The club catalog, read on a union page for a sponsor buying club capacity. */
  const [clubCatalog, setClubCatalog] = useState<CatalogProduct[]>([]);
  const [clubCatalogVisible, setClubCatalogVisible] = useState(true);
  /* Read beside the page; null when not read (or not this reader's to read),
     which hides only their own console. */
  const [writtenQuotes, setWrittenQuotes] = useState<WrittenQuote[] | null>(null);
  const [reviews, setReviews] = useState<TrialReview[] | null>(null);
  const [earnings, setEarnings] = useState<EarningsCoverage | null>(null);
  /* The written quote offer being bought through the order flow, if any. */
  const [writtenPick, setWrittenPick] = useState<WrittenQuote | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptsFailed, setReceiptsFailed] = useState(false);
  /* The versioned policy texts; null when they could not be read. */
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  /* scope_status refused this reader (access_denied), but they paid for
     something here: their receipts stay readable, and nothing else is shown. */
  const [formerOwner, setFormerOwner] = useState(false);
  /* The paid line whose refund request console is open. */
  const [refundTarget, setRefundTarget] = useState<RefundTarget | null>(null);
  /* Accepted ceiling sentences returned by set_renewal, per right, for the
     sponsor's renewals (the receipts read does not project the sentence). */
  const [acceptedTexts, setAcceptedTexts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* Server clock minus this device's clock, from the last status read, so a
     wrong phone clock never miscounts the trial or the quote expiry. */
  const [skewMs, setSkewMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [renewOn, setRenewOn] = useState(false);
  const [renewMax, setRenewMax] = useState('');
  const [sponsorshipId, setSponsorshipId] = useState<string | null>(null);

  /* Renewal ceilings typed per right, so one field never fills another. */
  const [renewDrafts, setRenewDrafts] = useState<Record<string, string>>({});
  const [trialSku, setTrialSku] = useState('');
  const [trialQty, setTrialQty] = useState('1');
  const [budget, setBudget] = useState('');
  const [perClub, setPerClub] = useState('');
  const [busy, setBusy] = useState(false);

  /* Only the newest status read may land (a purchase refresh and a renewal
     refresh can overlap). */
  const loadSeq = useRef(0);
  const hasLoaded = useRef(false);
  const busyRef = useRef(false);

  const load = useCallback(
    async (id: string) => {
      const seq = ++loadSeq.current;
      try {
        const quiet = <T,>(where: string, p: Promise<T>): Promise<T | null> =>
          p.catch((e: unknown) => {
            reportError(e, `ClubDiamondCostsPage.${where}`);
            return null;
          });
        const [s, c, r, cc, pol, wq, rv, er] = await Promise.all([
          ClubCommerceService.scopeStatus(scopeKind, id),
          ClubCommerceService.catalog(scopeKind),
          /* Receipts failing must not hide the rest of the page. A union page
             reads every receipt the viewer paid or placed, so a sponsor's
             club orders appear beside the union's own (filtered below). */
          (scopeKind === 'union'
            ? ClubCommerceService.receipts(null, null)
            : ClubCommerceService.receipts(scopeKind, id)
          ).catch((e: unknown) => {
            reportError(e, 'ClubDiamondCostsPage.receipts');
            return null;
          }),
          scopeKind === 'union'
            ? ClubCommerceService.catalog('club').catch((e: unknown) => {
                reportError(e, 'ClubDiamondCostsPage.clubCatalog');
                return null;
              })
            : Promise.resolve(null),
          /* The policy texts are read beside the page; failing hides only them.
             Every kind is read at once, service_terms included. */
          ClubCommerceService.policies().catch((e: unknown) => {
            reportError(e, 'ClubDiamondCostsPage.policies');
            return null;
          }),
          scopeKind === 'club'
            ? quiet('writtenQuotes', ClubCommerceService.writtenQuotes(scopeKind, id))
            : Promise.resolve(null),
          quiet('trialReviews', ClubCommerceService.trialReviews(scopeKind, id)),
          quiet('earnings', ClubCommerceService.earningsCoverage(scopeKind, id, 30)),
        ]);
        if (!isMountedRef.current || seq !== loadSeq.current) return;
        if (isRefusal(s)) {
          /* A former owner (or any payer who lost their role) is refused the
             scope, but fn_ca_commerce_receipts still names what they paid
             here. Show those, read only, instead of an error. */
          const mine = (r ?? []).filter((x) => x.scope_kind === scopeKind && x.scope_id === id);
          if (s.error === 'access_denied' && mine.length > 0) {
            setReceipts(mine);
            setReceiptsFailed(false);
            setPolicies(pol);
            setStatus(null);
            setFormerOwner(true);
            setError(null);
            hasLoaded.current = true;
            return;
          }
          setError(refusalCopy(s.error, 'This Page Could Not Be Read'));
          return;
        }
        setFormerOwner(false);
        setPolicies(pol);
        const serverNow = Date.parse(s.server_time);
        if (Number.isFinite(serverNow)) setSkewMs(serverNow - Date.now());
        setNowMs(Date.now());
        setStatus({
          ...s,
          entitlements: Array.isArray(s.entitlements) ? s.entitlements : [],
          sponsorships: Array.isArray(s.sponsorships) ? s.sponsorships : [],
          covered_clubs: Array.isArray(s.covered_clubs) ? s.covered_clubs : [],
        });
        setClubCatalog(cc && Array.isArray(cc.products) ? cc.products : []);
        setClubCatalogVisible(!cc || cc.catalog_visible !== false);
        setWrittenQuotes(wq);
        setReviews(rv);
        /* An administrator is refused the owner's earnings (owner_required). */
        setEarnings(er && !isRefusal(er) ? er : null);
        setCatalog({ ...c, products: Array.isArray(c.products) ? c.products : [] });
        if (r) {
          setReceipts(r);
          setReceiptsFailed(false);
        } else {
          setReceiptsFailed(true);
        }
        setError(null);
        hasLoaded.current = true;
      } catch (e) {
        reportError(e, 'ClubDiamondCostsPage.load');
        if (!isMountedRef.current || seq !== loadSeq.current) return;
        /* A failed REFRESH keeps what is on screen (a receipt included). */
        if (hasLoaded.current) toast.error('The Page Could Not Be Refreshed');
        else setError('The Diamond Costs Could Not Be Read');
      } finally {
        if (isMountedRef.current && seq === loadSeq.current) setLoading(false);
      }
    },
    [isMountedRef, scopeKind, toast]
  );

  const order = useCommerceOrder({
    where: 'ClubDiamondCostsPage',
    readReceipts: () =>
      scopeKind === 'union'
        ? ClubCommerceService.receipts(null, null)
        : ClubCommerceService.receipts(scopeKind, scopeId),
    onSettled: async () => {
      if (scopeId) await load(scopeId);
    },
  });

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      let id: string;
      try {
        id = scopeKind === 'club' ? await resolveClubUUIDStrict(routeId, ac.signal) : routeId;
      } catch {
        if (ac.signal.aborted || !isMountedRef.current) return;
        setError(scopeKind === 'club' ? 'This Club Was Not Found' : 'This Union Was Not Found');
        setLoading(false);
        return;
      }
      if (ac.signal.aborted || !isMountedRef.current) return;
      setScopeId(id);
      await load(id);
    })();
    return () => ac.abort();
  }, [routeId, scopeKind, load, isMountedRef]);

  /* The trial's time left, recounted every thirty seconds. Each open quote
     keeps its own one second countdown. */
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const products = useMemo(
    () => (catalog?.products ?? []).filter((p) => p.scope_kind === scopeKind),
    [catalog, scopeKind]
  );
  const productOf = (sku: string | null | undefined) =>
    sku ? (products.find((p) => p.sku === sku) ?? null) : null;
  /* The catalog is not published (fn_ca_commerce_catalog catalog_visible
     false): products come without prices and the quote door refuses. Staff
     read prices regardless, so only a catalog with no price at all hides. */
  const pricesHidden = catalog?.catalog_visible === false && products.every((p) => !p.price);
  const serverNow = nowMs + skewMs;
  const isOwner = status?.role === 'owner';
  const trial = status?.trial ?? null;
  const trialActive = Boolean(trial?.active);
  const rights = status?.entitlements ?? [];
  const trialRight =
    rights.find((e) => e.source === 'trial' && e.kind === 'trial_operating') ?? null;
  const activeCapacity = rights.find((e) => e.kind === 'capacity' && e.active) ?? null;
  const roster = status?.roster_count ?? null;
  const balance = typeof status?.balance === 'number' ? status.balance : null;
  const selected = products.find((p) => p.sku === selectedSku) ?? null;
  const periodProducts = products.filter((p) => p.supported && p.price && p.term_kind === 'period');
  /* A club page lists the union sponsorships that cover it. Only the sponsor
     (the union owner who pays) can quote a sponsored order; the club owner
     reads it as information (fn_ca_commerce_quote: sponsor_payer_required). */
  const clubSponsorships = scopeKind === 'club' ? (status?.sponsorships ?? []) : [];
  const mySponsorships = clubSponsorships.filter((s) => viewerId && s.payer_id === viewerId);
  const canBuy = isOwner || mySponsorships.length > 0;
  const locked = order.locked;

  /** Upgrade only to a LARGER capacity; a smaller one starts next period. */
  const kindFor = (p: CatalogProduct): PurchaseKind =>
    p.kind === 'capacity' &&
    activeCapacity !== null &&
    activeCapacity.sku !== p.sku &&
    (p.capacity ?? 0) > (activeCapacity.capacity ?? 0)
      ? 'upgrade'
      : 'purchase';

  const coveredQuantity = (p: CatalogProduct | null, raw: string): number | null => {
    if (!p || p.quantity_unit !== 'covered_club') return 1;
    const n = parseWhole(raw);
    return n !== null && n >= 1 && n <= 500 ? n : null;
  };

  const editInputs = order.editInputs;

  const chooseProduct = (p: CatalogProduct) => {
    editInputs();
    order.clearReceipt();
    setWrittenPick(null);
    setSelectedSku(p.sku);
    if (p.quantity_unit === 'covered_club') {
      const covered = status?.covered_club_count ?? 0;
      setQuantity(String(covered > 0 ? covered : 1));
    } else {
      setQuantity('1');
    }
    setRenewMax('');
    setRenewOn(false);
  };

  const clearChoice = () => {
    editInputs();
    setWrittenPick(null);
    setSelectedSku(null);
    setRenewOn(false);
    setRenewMax('');
    setSponsorshipId(null);
  };

  const getQuote = () => {
    if (order.outcomeUnknown) return toast.error('Check Your Last Order Before Starting A New One');
    if (!scopeId || !selected) return toast.error('Choose A Service First');
    if (pricesHidden) return toast.error(refusalCopy('catalog_not_visible'));
    if (!status?.checkout_enabled) return toast.error(refusalCopy('checkout_disabled'));
    const qty = coveredQuantity(selected, quantity);
    if (qty === null) return toast.error('Enter Between 1 And 500 Covered Clubs');
    if (!isOwner && !sponsorshipId) return toast.error('Choose The Sponsorship To Pay With');
    let max: number | null = null;
    if (renewOn && !sponsorshipId && !trialActive) {
      max = parseWhole(renewMax);
      if (max === null || max < 1)
        return toast.error('Set A Whole Number Renewal Ceiling In Diamonds');
    }
    const id = scopeId;
    const line = { sku: selected.sku, quantity: qty };
    const purchaseKind = kindFor(selected);
    void order.requestQuote(() =>
      ClubCommerceService.quote(scopeKind, id, [line], {
        sponsorshipId,
        renewalMaxDiamonds: max,
        purchaseKind,
      })
    );
  };

  const activate = async () => {
    if (!scopeId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await ClubCommerceService.activateTrial(scopeKind, scopeId);
      if (!isMountedRef.current) return;
      if (isRefusal(r)) return toast.error(refusalCopy(r.error, 'The Trial Could Not Start'));
      toast.success(
        r.replay ? 'Your Free Month Is Already Running' : 'Your Free Operating Month Has Started'
      );
      /* A quote taken before the free month is no longer the order to pay. */
      order.discard();
      await load(scopeId);
    } catch (e) {
      reportError(e, 'ClubDiamondCostsPage.activate');
      if (isMountedRef.current) toast.error('The Trial Could Not Start');
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setBusy(false);
    }
  };

  const authorize = async (
    e: Entitlement,
    max: number,
    sku: string | null,
    qty: number | null
  ): Promise<boolean> => {
    if (!scopeId || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await ClubCommerceService.setRenewal(e.id, true, max, sku, qty);
      if (!isMountedRef.current) return false;
      if (isRefusal(r)) {
        toast.error(refusalCopy(r.error, 'The Renewal Could Not Be Changed'));
        return false;
      }
      toast.success(
        e.source === 'trial'
          ? `First Paid Period Authorized, Up To ${diamonds(r.max_diamonds ?? max)}`
          : `Renewal Authorized, Up To ${diamonds(r.max_diamonds ?? max)}`
      );
      setRenewDrafts((d) => {
        const next = { ...d };
        delete next[e.id];
        return next;
      });
      await load(scopeId);
      return true;
    } catch (err) {
      reportError(err, 'ClubDiamondCostsPage.authorize');
      if (isMountedRef.current) toast.error('The Renewal Could Not Be Changed');
      return false;
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setBusy(false);
    }
  };

  /**
   * Cancel a renewal. A cancel names no product: the right's one mandate is
   * cancelled whatever service it names. An older server looked the mandate
   * up by (entitlement, sku) and refused a trial cancel without a sku
   * (sku_required) while scope_status never projected that sku; against it,
   * fall back to naming each period service of this scope in turn. A service
   * with no mandate answers state 'none' and writes nothing.
   */
  const cancelRenewal = async (e: Entitlement) => {
    if (!scopeId || busyRef.current) return;
    const known = e.renewal?.sku ?? null;
    const fallback: Array<string | null> =
      e.source === 'trial'
        ? known
          ? [known]
          : products.filter((p) => p.term_kind === 'period').map((p) => p.sku)
        : [];
    const candidates: Array<string | null> = [null, ...fallback];
    busyRef.current = true;
    setBusy(true);
    try {
      let outcome: RenewalChange | null = null;
      for (let i = 0; i < candidates.length; i += 1) {
        const sku = candidates[i];
        const r = await ClubCommerceService.setRenewal(e.id, false, null, sku, null);
        if (!isMountedRef.current) return;
        if (isRefusal(r)) {
          if (
            (r.error === 'sku_required' || r.error === 'sku_not_available') &&
            i < candidates.length - 1
          )
            continue;
          toast.error(refusalCopy(r.error, 'The Renewal Could Not Be Cancelled'));
          return;
        }
        if (r.state !== 'none') {
          outcome = r;
          break;
        }
      }
      if (!outcome) toast.info('There Was No Renewal To Cancel');
      else if (outcome.state === 'completed')
        toast.info('This Period Was Already Renewed. Cancel The New Period Instead');
      else
        toast.success(
          e.source === 'trial'
            ? 'Authorization Cancelled. Nothing Will Be Charged When The Free Month Ends'
            : 'Renewal Cancelled. Current Paid Access Is Unchanged'
        );
      await load(scopeId);
    } catch (err) {
      reportError(err, 'ClubDiamondCostsPage.cancelRenewal');
      if (isMountedRef.current) toast.error('The Renewal Could Not Be Cancelled');
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setBusy(false);
    }
  };

  /** Today's price of what a right would renew into, for display only. */
  const renewalPrice = (e: Entitlement): number | null => {
    const sku = e.renewal?.sku ?? e.sku;
    return listPrice(productOf(sku), e.quantity || 1);
  };

  const ceilingCheck = (max: number | null, price: number | null): string | null => {
    if (max === null || max < 1) return 'Enter A Whole Number Ceiling In Diamonds';
    if (price !== null && max < price)
      return `Set A Ceiling Of At Least ${price.toLocaleString()} Diamonds, Today's Price`;
    return null;
  };

  const authorizeRenewal = (e: Entitlement) => {
    const price = renewalPrice(e);
    const max = parseWhole(renewDrafts[e.id] ?? (price !== null ? String(price) : ''));
    const problem = ceilingCheck(max, price);
    if (problem || max === null) return toast.error(problem ?? 'Enter A Ceiling');
    void authorize(e, max, null, null);
  };

  const trialProduct = productOf(trialSku);
  const trialQuantity = coveredQuantity(trialProduct, trialQty);
  const trialPrice = trialProduct ? listPrice(trialProduct, trialQuantity ?? 1) : null;
  const authorizeAfterTrial = (e: Entitlement) => {
    if (!trialProduct) return toast.error('Choose A Service First');
    if (trialQuantity === null) return toast.error('Enter Between 1 And 500 Covered Clubs');
    const max = parseWhole(renewDrafts[e.id] ?? (trialPrice !== null ? String(trialPrice) : ''));
    const problem = ceilingCheck(max, trialPrice);
    if (problem || max === null) return toast.error(problem ?? 'Enter A Ceiling');
    void authorize(e, max, trialProduct.sku, trialQuantity);
  };

  /** From a quote during the free month: authorize exactly that service. */
  const authorizeQuoteAtTrialEnd = async (q: Quote) => {
    if (!trialRight) return toast.error('Your Free Month Could Not Be Found. Refresh The Page');
    if (trialRight.renewal?.state === 'authorized')
      return toast.error('Cancel Your Current Post Trial Authorization First');
    const line = q.lines[0];
    if (!line) return toast.error('Choose A Service First');
    const ok = await authorize(trialRight, q.net, line.sku, line.quantity);
    if (ok && isMountedRef.current) order.discard();
  };

  const saveSponsorship = async (revokeId?: string) => {
    if (!scopeId || busyRef.current) return;
    const total = parseWhole(budget);
    if (!revokeId && (total === null || total <= 0))
      return toast.error('Enter A Whole Number Budget In Diamonds');
    const per = perClub.trim() === '' ? null : parseWhole(perClub);
    if (!revokeId && perClub.trim() !== '' && (per === null || per <= 0))
      return toast.error('The Per Club Allowance Must Be A Whole Number');
    if (!revokeId && per !== null && total !== null && per > total)
      return toast.error('The Per Club Allowance Cannot Exceed The Total Budget');
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await ClubCommerceService.setSponsorship(
        scopeId,
        revokeId
          ? { sponsorshipId: revokeId, revoke: true }
          : { totalBudget: total, perClubBudget: per }
      );
      if (!isMountedRef.current) return;
      if (isRefusal(r))
        return toast.error(refusalCopy(r.error, 'The Sponsorship Could Not Be Saved'));
      toast.success(
        revokeId ? 'Sponsorship Revoked For Future Purchases' : 'Sponsorship Budget Recorded'
      );
      if (!revokeId) {
        setBudget('');
        setPerClub('');
      }
      await load(scopeId);
    } catch (e) {
      reportError(e, 'ClubDiamondCostsPage.sponsorship');
      if (isMountedRef.current) toast.error('The Sponsorship Could Not Be Saved');
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setBusy(false);
    }
  };

  const reloadReceipts = async () => {
    if (!scopeId || busyRef.current) return;
    await load(scopeId);
  };

  /**
   * One owner write that is not an order (a written quote request or
   * withdrawal, a review request): one at a time, a refusal in words, and a
   * refresh after it. Returns true when the server accepted it.
   */
  const ownerWrite = async (
    where: string,
    run: () => Promise<{ success: true } | Refusal>,
    fallback: string,
    done: string
  ): Promise<boolean> => {
    if (!scopeId || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await run();
      if (!isMountedRef.current) return false;
      if (isRefusal(r)) {
        toast.error(refusalCopy(r.error, fallback));
        /* An open request already on file is shown by the refresh. */
        if (/already_(requested|decided)$/.test(r.error)) await load(scopeId);
        return false;
      }
      toast.success(done);
      await load(scopeId);
      return true;
    } catch (e) {
      reportError(e, `ClubDiamondCostsPage.${where}`);
      if (isMountedRef.current) toast.error(fallback);
      return false;
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setBusy(false);
    }
  };

  const requestWritten = (capacity: number, note: string | null) =>
    ownerWrite(
      'writtenQuoteRequest',
      () => ClubCommerceService.requestWrittenQuote(scopeKind, scopeId ?? '', capacity, note),
      'The Written Quote Request Was Not Sent',
      'Written Quote Requested. Platform Staff Will Reply Here'
    );

  const withdrawWritten = (w: WrittenQuote) =>
    void ownerWrite(
      'writtenQuoteWithdraw',
      () => ClubCommerceService.withdrawWrittenQuote(w.written_quote_id),
      'The Request Could Not Be Withdrawn',
      'Written Quote Request Withdrawn'
    );

  const requestReview = (statement: string) =>
    ownerWrite(
      'trialReviewRequest',
      () => ClubCommerceService.requestTrialReview(scopeKind, scopeId ?? '', statement),
      'The Review Request Was Not Sent',
      'Review Requested. Platform Staff Will Reply Here'
    );

  /**
   * Buy a written quote offer: its private capacity product is quoted through
   * the page's one order flow (quote, order key, confirm), exactly like a
   * catalog capacity; a larger capacity than the current one is an upgrade.
   */
  const buyWritten = (w: WrittenQuote) => {
    if (order.outcomeUnknown) return toast.error('Check Your Last Order Before Starting A New One');
    if (!scopeId || !w.sku) return toast.error(refusalCopy('written_quote_not_found'));
    if (pricesHidden) return toast.error(refusalCopy('catalog_not_visible'));
    if (!status?.checkout_enabled) return toast.error(refusalCopy('checkout_disabled'));
    editInputs();
    order.clearReceipt();
    setSelectedSku(null);
    setRenewOn(false);
    setRenewMax('');
    setSponsorshipId(null);
    setWrittenPick(w);
    const id = scopeId;
    const sku = w.sku;
    const purchaseKind: PurchaseKind =
      activeCapacity !== null &&
      activeCapacity.sku !== sku &&
      Number(w.offered_capacity ?? 0) > Number(activeCapacity.capacity ?? 0)
        ? 'upgrade'
        : 'purchase';
    void order.requestQuote(() =>
      ClubCommerceService.quote(scopeKind, id, [{ sku, quantity: 1 }], {
        sponsorshipId: null,
        renewalMaxDiamonds: null,
        purchaseKind,
      })
    );
  };

  /** The receipts a refund request's unknown outcome is checked against. */
  const readScopeReceipts = () =>
    scopeKind === 'union'
      ? ClubCommerceService.receipts(null, null)
      : ClubCommerceService.receipts(scopeKind, scopeId);

  /**
   * A sponsor authorizes or cancels the renewal of a right their sponsorship
   * paid for (fn_ca_commerce_set_renewal's sponsor path, 20260924102040). The
   * renewal is charged to the sponsor within that sponsorship; the club owner
   * can never put the sponsor's diamonds behind it.
   */
  const sponsorRenewal = async (entitlementId: string, enabled: boolean, max: number | null) => {
    if (!scopeId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await ClubCommerceService.setRenewal(entitlementId, enabled, max, null, null);
      if (!isMountedRef.current) return;
      if (isRefusal(r)) {
        toast.error(
          refusalCopy(
            r.error,
            enabled ? 'The Renewal Could Not Be Changed' : 'The Renewal Could Not Be Cancelled'
          )
        );
        return;
      }
      if (enabled) {
        const accepted = r.accepted_ceiling_text;
        if (accepted) setAcceptedTexts((t) => ({ ...t, [entitlementId]: accepted }));
        setRenewDrafts((d) => {
          const next = { ...d };
          delete next[entitlementId];
          return next;
        });
        toast.success(`Sponsored Renewal Authorized, Up To ${diamonds(r.max_diamonds ?? max)}`);
      } else if (r.state === 'none') {
        toast.info('There Was No Renewal To Cancel');
      } else if (r.state === 'completed') {
        toast.info('This Period Was Already Renewed. Cancel The New Period Instead');
      } else {
        toast.success('Sponsored Renewal Cancelled. The Club Keeps Its Current Paid Period');
      }
      await load(scopeId);
    } catch (err) {
      reportError(err, 'ClubDiamondCostsPage.sponsorRenewal');
      if (isMountedRef.current) toast.error('The Renewal Could Not Be Changed');
    } finally {
      busyRef.current = false;
      if (isMountedRef.current) setBusy(false);
    }
  };

  const openRefund = (r: Receipt, line: QuoteLine) =>
    setRefundTarget({ receipt: r, line, opened: Date.now() });

  const refundPolicy = currentPolicy(policies, 'refund');
  const termsPolicy = currentPolicy(policies, 'renewal_terms');
  const ceilingPolicy = currentPolicy(policies, 'renewal_ceiling');
  const servicePolicy = currentPolicy(policies, 'service_terms');
  /* The version an owner accepts: the policy read, else the catalog's word. */
  const serviceTermsVersion = servicePolicy?.version ?? catalog?.service_terms_version ?? null;

  /**
   * Every refund request for one purchase line: the receipt's own, and the
   * scope status's (so a request still shows when the receipts were not
   * read), newest state kept once per request, oldest request first.
   */
  const requestsFor = (r: Receipt, lineIndex: number): RefundRequest[] => {
    const byId = new Map<string, RefundRequest>();
    for (const q of [...(r.refund_requests ?? []), ...(status?.refund_requests ?? [])]) {
      if (q.purchase_id !== r.purchase_id || q.line_index !== lineIndex) continue;
      const had = byId.get(q.request_id);
      if (!had || Date.parse(q.updated_at) >= Date.parse(had.updated_at)) byId.set(q.request_id, q);
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  };

  /** The sentence a payer accepts by authorizing, with its terms version. */
  const acceptanceNote = (product: string, qty: number, max: number | null, sponsored: boolean) => {
    const sentence =
      max !== null && max > 0
        ? ceilingSentence(ceilingPolicy?.body, product, qty, max, sponsored)
        : null;
    if (!sentence) return null;
    return `By Authorizing You Accept: "${titleCase(sentence)}"${
      termsPolicy ? ` Renewal Terms Version ${termsPolicy.version}.` : ''
    }`;
  };

  /** What a payer already accepted, as the server rebuilt it. */
  const acceptedNote = (text: string | null | undefined, termsVersion?: number | null) =>
    text
      ? ` You Accepted: "${titleCase(text)}"${termsVersion ? ` Renewal Terms Version ${termsVersion}.` : ''}`
      : '';

  const refundConsole = refundTarget ? (
    <RefundRequestConsole
      key={`${refundTarget.receipt.purchase_id}:${refundTarget.line.index}:${refundTarget.opened}`}
      target={refundTarget}
      forName={
        refundTarget.receipt.scope_kind === 'club' && scopeKind === 'union'
          ? status?.covered_clubs?.find((c) => c.club_id === refundTarget.receipt.scope_id)?.name
          : undefined
      }
      refundPolicy={refundPolicy}
      readReceipts={readScopeReceipts}
      onSettled={async () => {
        if (scopeId) await load(scopeId);
      }}
      onClose={() => setRefundTarget(null)}
    />
  ) : null;
  const refundOpenFor = refundTarget
    ? `${refundTarget.receipt.purchase_id}:${refundTarget.line.index}`
    : null;

  const backPath =
    scopeKind === 'club' ? `/clubs/${routeId}/operations` : `/unions/${routeId}/operations`;
  if (loading) {
    return (
      <StateConsole
        scopeKind={scopeKind}
        backPath={backPath}
        pill="Reading"
        pillInk="blue"
        message="Reading Diamond Costs"
        onRetry={onRetry}
      />
    );
  }
  if (formerOwner && !error) {
    const word = scopeKind === 'union' ? 'Union' : 'Club';
    return (
      <div className={styles.page}>
        <SpadeConsole
          eyebrow={`${word} Records`}
          title="Diamond Costs"
          titleId="diamond-costs-title"
          pill="Receipts Only"
          pillInk="muted"
          foot="foot"
        >
          <p className="sc-copy">
            You No Longer Manage This {word}. The Receipts For What You Paid Here Stay Available To
            You, And A Refund Still Returns To You As The Original Payer.
          </p>
          <div className={styles.rows}>
            <ChoiceRow
              label="Back To Home"
              meta="Diamond Prices, Rights And Renewals Belong To The Current Owner."
              value="Home"
              ink="blue"
              onClick={() => navigate('/')}
            />
          </div>
        </SpadeConsole>
        <ReceiptsConsole
          receipts={receipts}
          failed={false}
          retryDisabled={busy}
          onRetry={() => void reloadReceipts()}
          describe={(r) => when(r.committed_at)}
          viewerId={viewerId}
          requestsFor={requestsFor}
          refundPolicyVersion={refundPolicy?.version ?? null}
          refundOpenFor={refundOpenFor}
          onRequestRefund={openRefund}
        />
        {refundConsole}
        <PolicyConsole refund={refundPolicy} terms={termsPolicy} service={servicePolicy} />
      </div>
    );
  }
  if (error || !status) {
    return (
      <StateConsole
        scopeKind={scopeKind}
        backPath={backPath}
        pill="Not Read"
        pillInk="red"
        message={error ?? 'The Diamond Costs Could Not Be Read'}
        onRetry={onRetry}
      />
    );
  }

  const scopeWord = scopeKind === 'union' ? 'Union' : 'Club';
  const activeRights = rights.filter((r) => r.active).length;
  const activeSponsorships = (status.sponsorships ?? []).filter((x) => x.state === 'active').length;
  const paidActive = rights.some((r) => r.active && r.source !== 'trial');
  /* Admission is wired in shadow (20260924102056): until an announced date
     passes, no owner action is refused, so "No Access" would be false. */
  const access = accessTruth(status, serverNow);
  const accessPill = trialActive
    ? 'Free Month'
    : paidActive
      ? 'Paid'
      : access.enforced
        ? 'No Access'
        : trial
          ? 'Not Required Yet'
          : 'Not Started';
  const accessInk: ConsoleInk = trialActive
    ? 'blue'
    : paidActive
      ? 'green'
      : access.enforced
        ? 'gold'
        : 'blue';
  /* The one place the page explains operating access. */
  const accessRow = (() => {
    if (access.enforcedFrom === null)
      return {
        value: 'Not Required Yet',
        ink: 'blue' as ConsoleInk,
        meta: 'Paid Operating Access Will Be Required From A Date That Will Be Announced. Until Then, Approving Members, Opening Tables And Creating Tournaments Are Not Limited By It.',
      };
    if (!access.enforced)
      return {
        value: dateWord(new Date(access.enforcedFrom).toISOString()),
        ink: 'gold' as ConsoleInk,
        meta: `Required From ${when(new Date(access.enforcedFrom).toISOString())}. From Then, Approving New Members, Opening New Tables And Creating New Tournaments Need Active Access. Existing Games And Members Are Not Affected.`,
      };
    const since = when(new Date(access.enforcedFrom).toISOString());
    return trialActive || paidActive
      ? {
          value: 'Active',
          ink: 'green' as ConsoleInk,
          meta: `Required Since ${since}. Your ${trialActive ? 'Free Month' : 'Paid Access'} Covers New Members, Tables And Tournaments.`,
        }
      : {
          value: 'Required',
          ink: 'gold' as ConsoleInk,
          meta: `Required Since ${since}. Choose A Service Under Diamond Prices To Approve New Members, Open New Tables Or Create New Tournaments. Existing Games And Members Are Not Affected.`,
        };
  })();
  const trialEnd = trial ? Date.parse(trial.trial_end) : NaN;
  /* This scope's free month is over: it ran out, or it was inherited already
     ended from the operator's first free month (R2 2.4, 2.5). */
  const trialEnded = trial !== null && !trialActive;
  const trialLeft = trialEnd - serverNow;
  const trialAuth = trialRight?.renewal?.state === 'authorized' ? trialRight.renewal : null;
  const nextRenewal =
    rights
      .filter((e) => e.source === 'purchase' && e.renewal?.state === 'authorized')
      .sort((a, b) => Date.parse(a.renewal!.due_at) - Date.parse(b.renewal!.due_at))[0] ?? null;

  /** The meta line under a renewal: ceiling, today's price, and any warning. */
  const renewalNote = (e: Entitlement): string => {
    const r = e.renewal;
    if (!r) return '';
    const price = renewalPrice(e);
    let note = `Ceiling: ${diamonds(r.max_diamonds)}.`;
    if (price !== null) {
      note += ` Today's Price: ${diamonds(price)}.`;
      if (price > r.max_diamonds)
        note += ' That Is Above Your Ceiling, So The Renewal Would Not Complete.';
      else if (balance !== null && balance < price)
        note += ` You Have ${balance.toLocaleString()} Available; Add Diamonds Before Then.`;
    }
    return note;
  };

  /** How a renewal will go at today's price: the row's ink says it first. */
  const renewalInk = (e: Entitlement): ConsoleInk => {
    const r = e.renewal;
    const price = renewalPrice(e);
    if (!r || price === null) return 'blue';
    if (price > r.max_diamonds) return 'red';
    if (balance !== null && balance < price) return 'gold';
    return 'blue';
  };

  /** The service a post trial authorization will buy, named. */
  const authorizedService = (r: { sku?: string | null; quantity?: number } | null): string => {
    const p = productOf(r?.sku ?? null);
    if (!p) return 'Your Authorized Service';
    const qty = Number(r?.quantity ?? 1);
    return qty > 1 ? `${p.title} For ${qty.toLocaleString()} Covered Clubs` : p.title;
  };

  /* An upgrade moves an authorized renewal onto the new right at the SAME
     ceiling (fn_ca_commerce_purchase_impl). Say so before the charge when the
     new service's price is above that ceiling, because that renewal would
     then not complete. */
  const upgradeNotice = (() => {
    const q = order.quote;
    const line = q?.lines[0];
    const mandate = activeCapacity?.renewal;
    if (!q || q.purchase_kind !== 'upgrade' || !line || mandate?.state !== 'authorized')
      return null;
    const price = listPrice(productOf(line.sku), line.quantity || 1);
    if (price === null || price <= mandate.max_diamonds) return null;
    return {
      label: 'Renewal Ceiling',
      value: `Up To ${diamonds(mandate.max_diamonds)}`,
      ink: 'red' as ConsoleInk,
      meta: `Your Authorized Renewal Moves To The Upgrade At This Ceiling. The New Capacity Renews At ${diamonds(price)}, So That Renewal Would Not Complete. Cancel It And Authorize A New Ceiling After The Upgrade.`,
    };
  })();

  /* Union page: the union's own receipts plus the club orders this union's
     sponsorships paid, each named by its club. The receipt names its
     sponsorship when the server projects it; until then a covered club's
     receipt paid by this viewer is listed and labelled as paid by you. */
  const coveredClubs = status.covered_clubs ?? [];
  const clubNames = new Map(coveredClubs.map((c) => [c.club_id, c.name || 'Unnamed Club']));
  const unionSponsorshipIds = new Set(
    scopeKind === 'union' ? status.sponsorships.map((x) => x.id) : []
  );
  const listedReceipts =
    scopeKind === 'union'
      ? receipts.filter((r) => {
          if (r.scope_kind === 'union') return r.scope_id === scopeId;
          if (r.scope_kind !== 'club' || !clubNames.has(r.scope_id)) return false;
          if ('sponsorship_id' in r)
            return Boolean(r.sponsorship_id) && unionSponsorshipIds.has(String(r.sponsorship_id));
          return viewerId !== null && r.payer_id === viewerId;
        })
      : receipts;
  const receiptFor = (r: Receipt): string => {
    const name = r.scope_kind === 'club' ? clubNames.get(r.scope_id) : undefined;
    if (!name) return when(r.committed_at);
    return `${r.sponsorship_id ? 'Sponsored For' : 'Paid By You For'} ${name}. ${when(r.committed_at)}`;
  };
  /* A sponsor's renewable rights: every sponsored club right this viewer's
     sponsorship paid for that is still in its period (receipts rights). */
  const sponsoredRights: Array<{ receipt: Receipt; right: ReceiptRight; line: QuoteLine | null }> =
    scopeKind === 'union' && viewerId
      ? listedReceipts
          .filter((r) => r.scope_kind === 'club' && r.sponsorship_id && r.payer_id === viewerId)
          .flatMap((r) =>
            (r.rights ?? [])
              .filter(
                (x) => x.state === 'effective' && x.ends_at && Date.parse(x.ends_at) > serverNow
              )
              .map((x) => ({
                receipt: r,
                right: x,
                line: (r.lines ?? []).find((l) => l.index === x.line_index) ?? null,
              }))
          )
      : [];
  /* The viewer's own active sponsorships of this union: the payer, and only
     the payer, can buy capacity for a covered club with them. */
  const payerSponsorships =
    scopeKind === 'union' && viewerId
      ? status.sponsorships.filter((x) => x.payer_id === viewerId && x.state === 'active')
      : [];

  return (
    <div className={styles.page}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(backPath)}
        aria-label={`Back To ${scopeWord} Operations`}
      >
        ‹ Operations
      </button>

      <SpadeConsole
        eyebrow={`${scopeWord} Operations`}
        title="Diamond Costs"
        titleId="diamond-costs-title"
        pill={accessPill}
        pillInk={accessInk}
        foot="foot"
      >
        <div className={styles.rows}>
          <Row
            label="Your Role"
            value={
              isOwner
                ? 'Owner And Payer'
                : mySponsorships.length > 0
                  ? 'Union Sponsor'
                  : 'Read Only'
            }
          />
          {trial && trialActive ? (
            <>
              <Row
                label="Free Month Ends"
                value={dateWord(trial.trial_end)}
                ink="blue"
                wrap
                meta={`At ${timeWord(trial.trial_end)}, ${timeLeftWord(trialLeft)} From Now. All Included Operating Software, No Service Fees. Chip Funding, Prizes And Player Purchases Are Unchanged.`}
              />
              <Row
                label="When It Ends"
                value={trialAuth ? `Up To ${diamonds(trialAuth.max_diamonds)}` : 'Nothing Charged'}
                ink={trialAuth ? 'green' : 'gold'}
                wrap
                meta={
                  trialAuth
                    ? `${authorizedService(trialAuth)} Starts Then And Is Charged Once, Only If The Published Price Is At Or Below Your Ceiling.`
                    : access.enforcedFrom !== null
                      ? 'Paid Operating Access Does Not Start On Its Own. Authorize A Service Under Paid Access To Continue Without Interruption.'
                      : 'Paid Operating Access Does Not Start On Its Own. Authorize A Service Under Paid Access If You Want One Then.'
                }
              />
            </>
          ) : trial ? (
            <Row
              label="Free Month Ended"
              value={dateWord(trial.trial_end)}
              ink="muted"
              wrap
              meta={`At ${timeWord(trial.trial_end)}. ${
                paidActive
                  ? 'Paid Operating Access Continues Below.'
                  : access.enforced
                    ? 'Choose A Service Under Diamond Prices To Keep Operating.'
                    : 'Paid Access Is Not Required Yet; See Operating Access.'
              }`}
            />
          ) : (
            <>
              <Row
                label="Free Operating Month"
                value="Not Started"
                ink="gold"
                meta="Thirty Days Of Every Included Operating Service, Fee Free. Nothing Is Charged When It Ends Unless You Authorize It."
              />
              {isOwner ? (
                <ChoiceRow
                  label="Start Free Month"
                  meta={`Starts Now. The Exact End Time Is Shown Here Once It Begins. ${serviceTermsLine(serviceTermsVersion)}`}
                  value={busy ? 'Starting' : 'Start'}
                  ink="green"
                  disabled={busy}
                  onClick={() => void activate()}
                />
              ) : null}
            </>
          )}
          <Row
            label="Operating Access"
            value={accessRow.value}
            ink={accessRow.ink}
            wrap
            meta={accessRow.meta}
          />
          {activeCapacity ? (
            <Row
              label="Current Capacity"
              value={`${Number(activeCapacity.capacity ?? 0).toLocaleString()} Members`}
              ink="green"
              wrap
              meta={`Paid Through ${when(activeCapacity.ends_at)}`}
            />
          ) : null}
          {nextRenewal?.renewal ? (
            <Row
              label="Next Renewal"
              value={dateWord(nextRenewal.renewal.due_at)}
              ink={renewalInk(nextRenewal)}
              wrap
              meta={`At ${timeWord(nextRenewal.renewal.due_at)}. ${entitlementTitle(nextRenewal, catalog)}. ${renewalNote(nextRenewal)}`}
            />
          ) : null}
          {scopeKind === 'club' ? (
            <Row
              label="Approved Members"
              value={Number(roster ?? 0).toLocaleString()}
              meta="Each Approved Account Counted Once"
            />
          ) : (
            <Row
              label="Covered Clubs"
              value={Number(status.covered_club_count ?? 0).toLocaleString()}
              meta="Affiliated Clubs In This Union"
            />
          )}
          <BalanceRows breakdown={status.balance_breakdown} balance={balance} />
        </div>
        <p className="sc-copy">
          One Diamond Has A Nominal Catalog Value Of One Cent. Operating Access Expires With Its
          Period; Purchased Diamonds Do Not.
        </p>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Rights"
        title="Paid Access"
        pill={activeRights > 0 ? `${activeRights.toLocaleString()} Active` : 'None'}
        pillInk={activeRights > 0 ? 'green' : 'muted'}
        foot="foot"
      >
        <div className={styles.rows}>
          {rights.length === 0 ? <Row label="No Rights On File" value="" /> : null}
          {rights.map((e) => {
            const period = e.ends_at
              ? `${when(e.starts_at)} To ${when(e.ends_at)}`
              : `From ${when(e.starts_at)}`;
            const state = e.active ? 'Active' : e.scheduled ? 'Scheduled' : 'Expired';
            const r = e.renewal;
            const source =
              e.source === 'trial'
                ? 'No Charge.'
                : e.source === 'sponsor'
                  ? r?.state === 'authorized'
                    ? 'Paid By Your Union Sponsor, Who Also Authorized Its Renewal.'
                    : 'Paid By Your Union Sponsor. Only The Sponsor Can Authorize Its Renewal.'
                  : `Paid ${diamonds(e.net_paid)}.`;
            const live = e.active || e.scheduled;
            const attention =
              r?.state === 'needs_attention' ? (
                <Row
                  label="Renewal Not Completed"
                  value="Attention"
                  ink="red"
                  wrap
                  meta={`${refusalCopy(r.last_result?.reason, 'The Renewal Did Not Complete')}. Current Paid Access Is Unchanged.`}
                />
              ) : null;
            return (
              <div key={e.id}>
                <Row
                  label={entitlementTitle(e, catalog)}
                  value={state}
                  ink={e.active ? 'green' : e.scheduled ? 'blue' : 'muted'}
                  wrap
                  meta={`${period}. ${source}`}
                />
                {e.source === 'purchase' && e.ends_at && live ? (
                  <>
                    {r?.state === 'authorized' ? (
                      <Row
                        label="Renews"
                        value={dateWord(r.due_at)}
                        ink={renewalInk(e)}
                        wrap
                        meta={`At ${timeWord(r.due_at)}. ${renewalNote(e)}${acceptedNote(r.accepted_ceiling_text, r.terms_version)}`}
                      />
                    ) : r?.state === 'completed' ? (
                      <Row
                        label="Renewed"
                        value="On File"
                        ink="green"
                        meta="The Next Period Carries Its Own Renewal Setting."
                      />
                    ) : (
                      attention
                    )}
                    {isOwner && r?.state === 'authorized' ? (
                      <ChoiceRow
                        label="Cancel Renewal"
                        meta="Stops The Next Charge. Your Current Paid Period Is Unchanged."
                        value={busy ? 'Saving' : 'Cancel'}
                        ink="red"
                        disabled={busy}
                        onClick={() => void cancelRenewal(e)}
                      />
                    ) : null}
                    {isOwner && r?.state !== 'authorized' && r?.state !== 'completed' ? (
                      <div className={styles.fields}>
                        <Field
                          label="Authorize Renewal Up To (Diamonds)"
                          value={
                            renewDrafts[e.id] ??
                            (renewalPrice(e) !== null
                              ? Number(renewalPrice(e)).toLocaleString()
                              : '')
                          }
                          onChange={(v) => setRenewDrafts((d) => ({ ...d, [e.id]: v }))}
                          disabled={busy}
                          hint={`Charged Once At ${when(e.ends_at)}, Only If The Published Price Is At Or Below This Ceiling.`}
                        />
                        <ChoiceRow
                          label="Authorize Renewal"
                          meta={`Optional. You Can Cancel Any Time Before The Due Time.${(() => {
                            const p = productOf(e.sku);
                            const note = acceptanceNote(
                              p ? p.title : entitlementTitle(e, catalog),
                              p ? e.quantity || 1 : 1,
                              parseWhole(renewDrafts[e.id] ?? String(renewalPrice(e) ?? '')),
                              false
                            );
                            return note ? ` ${note}` : '';
                          })()}`}
                          value={busy ? 'Saving' : 'Authorize'}
                          ink="green"
                          disabled={busy}
                          onClick={() => authorizeRenewal(e)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
                {e.source === 'sponsor' && e.ends_at && live && r?.state === 'authorized' ? (
                  <Row
                    label="Renews"
                    value={dateWord(r.due_at)}
                    ink="blue"
                    wrap
                    meta={`At ${timeWord(r.due_at)}. Charged To Your Union Sponsor Within Its Sponsorship, Up To ${diamonds(r.max_diamonds)}. Nothing Is Charged To You.`}
                  />
                ) : null}
                {e.kind === 'trial_operating' && trialActive ? (
                  <>
                    {r?.state === 'authorized' ? (
                      <Row
                        label="First Paid Period"
                        value={`Up To ${diamonds(r.max_diamonds)}`}
                        ink="green"
                        wrap
                        meta={`${authorizedService(r)}. Charged Once At ${when(r.due_at)}, Only If The Published Price Is At Or Below This Ceiling.${acceptedNote(r.accepted_ceiling_text, r.terms_version)}`}
                      />
                    ) : (
                      attention
                    )}
                    {isOwner && r?.state === 'authorized' ? (
                      <ChoiceRow
                        label="Cancel Post Trial Authorization"
                        meta="Nothing Will Be Charged When The Free Month Ends."
                        value={busy ? 'Saving' : 'Cancel'}
                        ink="red"
                        disabled={busy}
                        onClick={() => void cancelRenewal(e)}
                      />
                    ) : null}
                    {isOwner && r?.state !== 'authorized' ? (
                      <div className={styles.fields}>
                        <label className={styles.field}>
                          <span className="sc-label sc-ink--blue">
                            Service To Start When The Free Month Ends
                          </span>
                          <select
                            className={styles.fieldInput}
                            value={trialSku}
                            disabled={busy}
                            onChange={(ev) => {
                              setTrialSku(ev.target.value);
                              const p = productOf(ev.target.value);
                              setTrialQty(
                                p?.quantity_unit === 'covered_club'
                                  ? String(Math.max(1, status.covered_club_count ?? 1))
                                  : '1'
                              );
                              setRenewDrafts((d) => {
                                const next = { ...d };
                                delete next[e.id];
                                return next;
                              });
                            }}
                          >
                            <option value="">Choose A Service</option>
                            {periodProducts.map((p) => {
                              const tooSmall =
                                p.kind === 'capacity' &&
                                p.capacity !== null &&
                                roster !== null &&
                                roster > p.capacity;
                              return (
                                <option key={p.sku} value={p.sku} disabled={tooSmall}>
                                  {p.title}: {priceWord(p)}
                                  {tooSmall ? ' (Smaller Than Your Roster)' : ''}
                                </option>
                              );
                            })}
                          </select>
                        </label>
                        {trialProduct?.quantity_unit === 'covered_club' ? (
                          <Field
                            label="Covered Clubs"
                            value={trialQty}
                            onChange={(v) => {
                              setTrialQty(v);
                              setRenewDrafts((d) => {
                                const next = { ...d };
                                delete next[e.id];
                                return next;
                              });
                            }}
                            disabled={busy}
                          />
                        ) : null}
                        <Field
                          label="Authorize Up To (Diamonds)"
                          value={
                            renewDrafts[e.id] ??
                            (trialPrice !== null ? trialPrice.toLocaleString() : '')
                          }
                          onChange={(v) => setRenewDrafts((d) => ({ ...d, [e.id]: v }))}
                          disabled={busy}
                          hint={`Charged Once, At ${when(trial?.trial_end)}, Only If The Published Price Is At Or Below This Ceiling. Nothing Is Charged Before Then.`}
                        />
                        <ChoiceRow
                          label="Authorize First Paid Period"
                          meta={`Your Diamonds Are Not Touched Until The Free Month Ends.${(() => {
                            const note = trialProduct
                              ? acceptanceNote(
                                  trialProduct.title,
                                  trialQuantity ?? 1,
                                  parseWhole(renewDrafts[e.id] ?? String(trialPrice ?? '')),
                                  false
                                )
                              : null;
                            return note ? ` ${note}` : '';
                          })()}`}
                          value={busy ? 'Saving' : 'Authorize'}
                          ink="green"
                          disabled={busy || !trialProduct}
                          onClick={() => authorizeAfterTrial(e)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Catalog"
        title="Diamond Prices"
        pill={
          pricesHidden
            ? 'Not Published'
            : catalog
              ? (catalogWord(catalog.catalog_version) ?? undefined)
              : undefined
        }
        pillInk={pricesHidden ? 'gold' : 'muted'}
        plates={
          canBuy && !pricesHidden
            ? {
                secondary: {
                  label: 'Clear',
                  onClick: clearChoice,
                  disabled: !selected || order.quoting || locked,
                },
                primary: {
                  label: order.quoting ? 'Quoting' : 'Get A Quote',
                  ink: 'white',
                  onClick: getQuote,
                  disabled: order.quoting || locked || !selected || !status.checkout_enabled,
                },
              }
            : undefined
        }
        foot={canBuy && !pricesHidden ? 'plates' : 'foot'}
      >
        <div className={styles.rows}>
          {pricesHidden ? (
            <Row
              label="Diamond Prices Are Not Published Yet"
              value="Not Yet"
              ink="gold"
              wrap
              meta="Services Are Priced And Quoted Here Once Platform Staff Publish The Catalog. Nothing Can Be Ordered Before Then."
            />
          ) : null}
          {!status.checkout_enabled && !pricesHidden ? (
            <Row
              label="Checkout Paused"
              value="Paused"
              ink="gold"
              meta="Prices Can Be Reviewed. Orders Resume When Checkout Reopens."
            />
          ) : null}
          {!pricesHidden && products.length === 0 ? (
            <Row label="No Services Listed" value="" />
          ) : null}
          {(pricesHidden ? [] : products).map((p) => {
            const tooSmall =
              p.kind === 'capacity' &&
              p.capacity !== null &&
              roster !== null &&
              roster > p.capacity;
            const current = activeCapacity?.sku === p.sku;
            let note = '';
            if (!p.supported) note = ' Not Yet Available.';
            else if (current)
              note = ' Your Current Capacity; Buying It Again Adds The Next Period.';
            else if (tooSmall)
              note = ` Smaller Than Your ${Number(roster).toLocaleString()} Approved Members.`;
            else if (p.kind === 'capacity' && activeCapacity)
              note =
                kindFor(p) === 'upgrade'
                  ? ' Upgrades Now; Unused Value Of Your Current Capacity Is Credited.'
                  : ' Starts When Your Current Paid Period Ends.';
            return (
              <ChoiceRow
                key={p.sku}
                label={p.title}
                meta={`${periodWord(p)}.${sentence(p.included_note)}${note}`}
                value={p.supported ? priceWord(p) : 'Not Yet Available'}
                ink={selectedSku === p.sku ? 'blue' : p.supported && !tooSmall ? 'silver' : 'muted'}
                pressed={selectedSku === p.sku}
                disabled={!p.supported || !p.price || !canBuy || tooSmall || locked}
                onClick={() => chooseProduct(p)}
              />
            );
          })}
          {scopeKind === 'club' ? (
            <Row
              label="Above 2,500 Members: Ask For A Written Quote"
              value=""
              wrap
              meta="Platform Staff Offer A Capacity And A Price For Your Club Alone. Ask Under Written Quotes Below."
            />
          ) : null}
        </div>
        {selected && selected.quantity_unit === 'covered_club' ? (
          <div className={styles.fields}>
            <Field
              label="Covered Clubs"
              value={quantity}
              onChange={(v) => {
                editInputs();
                setQuantity(v);
              }}
              disabled={locked}
              hint={`Your Union Has ${Number(status.covered_club_count ?? 0).toLocaleString()} Affiliated Clubs. Name The Clubs This Purchase Covers; Affiliation Alone Never Charges.`}
            />
          </div>
        ) : null}
        {selected && !trialActive && !sponsorshipId && isOwner ? (
          <div className={styles.fields}>
            <ChoiceRow
              label="Renew Automatically"
              meta="Optional. Authorizes The Next Period In Diamonds At Or Below Your Ceiling."
              value={renewOn ? 'On' : 'Off'}
              ink={renewOn ? 'green' : 'muted'}
              pressed={renewOn}
              disabled={locked}
              onClick={() => {
                editInputs();
                if (!renewOn && renewMax === '') {
                  const price = listPrice(selected, coveredQuantity(selected, quantity) ?? 1);
                  if (price !== null) setRenewMax(price.toLocaleString());
                }
                setRenewOn((v) => !v);
              }}
            />
            {renewOn ? (
              <Field
                label="Renewal Ceiling (Diamonds)"
                value={renewMax}
                onChange={(v) => {
                  editInputs();
                  setRenewMax(v);
                }}
                disabled={locked}
                hint={`Charged Once When The Period Ends, Only If The Published Price Is At Or Below This Ceiling.${(() => {
                  const note = acceptanceNote(
                    selected.title,
                    coveredQuantity(selected, quantity) ?? 1,
                    parseWhole(renewMax),
                    false
                  );
                  return note ? ` ${note}` : '';
                })()}`}
              />
            ) : null}
          </div>
        ) : null}
        {clubSponsorships.length > 0 ? (
          <div className={styles.rows}>
            {clubSponsorships.map((s) =>
              viewerId && s.payer_id === viewerId ? (
                <ChoiceRow
                  key={s.id}
                  label="Pay With Union Sponsorship"
                  meta={`${diamonds(s.remaining)} Remaining${s.per_club_budget ? `, Up To ${diamonds(s.per_club_budget)} Per Club` : ''}. Paid From Your Union Budget.`}
                  value={sponsorshipId === s.id ? 'Selected' : 'Select'}
                  ink={sponsorshipId === s.id ? 'blue' : 'silver'}
                  pressed={sponsorshipId === s.id}
                  disabled={locked}
                  onClick={() => {
                    editInputs();
                    setRenewOn(false);
                    setSponsorshipId((v) => (v === s.id ? null : s.id));
                  }}
                />
              ) : (
                <Row
                  key={s.id}
                  label="Union Sponsorship"
                  value={diamonds(s.remaining)}
                  ink="blue"
                  wrap
                  meta="Your Union Can Pay For Services Here. Only The Union Owner Confirms A Sponsored Order."
                />
              )
            )}
          </div>
        ) : null}
        <p className="sc-copy">
          Prices Are Whole Diamonds Per Stated Term. No Per Hand, Per Table Hour Or Per Transfer
          Charge. Displayed Club Levels Are Not Purchased Capacity.
        </p>
        {scopeKind === 'club' ? (
          <p className="sc-copy">
            Member Capacity Counts Approved Accounts, Each Once. It Is Not A Limit On Tables Or
            Seats Played At Once.
          </p>
        ) : null}
      </SpadeConsole>

      <QuoteConsole
        order={order}
        sectionId="diamond-costs-quote"
        eyebrow="Quote"
        skewMs={skewMs}
        busy={busy}
        canRequote={Boolean(selected || writtenPick)}
        onRequote={writtenPick && !selected ? () => buyWritten(writtenPick) : getQuote}
        trialAction={
          order.quote?.sponsorship_id
            ? {
                plate: 'After The Free Month',
                disabled: true,
                rowLabel: 'Free Month Running',
                note: `Nothing Can Be Charged Before ${when(order.quote.trial_end)}. A Sponsored Order Can Be Placed Once The Free Month Ends.`,
              }
            : {
                plate: busy ? 'Saving' : 'Authorize At Trial End',
                onClick: () => {
                  if (order.quote) void authorizeQuoteAtTrialEnd(order.quote);
                },
                disabled: busy || !isOwner || trialAuth !== null,
                rowLabel: 'Free Month Running',
                note: trialAuth
                  ? 'Nothing Is Charged Before Your Free Month Ends. Cancel Your Current Post Trial Authorization To Choose This Service Instead.'
                  : `Nothing Is Charged Before ${when(order.quote?.trial_end)}. Authorize This Service To Start Then, Charged Once At ${diamonds(order.quote?.net)}.`,
              }
        }
        onGetDiamonds={() => navigate(BUY_DIAMONDS)}
        notice={upgradeNotice}
        refundPolicyVersion={refundPolicy?.version ?? null}
        serviceTermsVersion={serviceTermsVersion}
        freeMonth={isOwner ? { busy, onStart: () => void activate() } : null}
      />

      <ReceiptConsole order={order} sectionId="diamond-costs-receipt" />

      {order.recovering ? <LoadingState message="Checking Your Order" /> : null}

      {scopeKind === 'club' && writtenQuotes !== null ? (
        <WrittenQuotesConsole
          quotes={writtenQuotes}
          isOwner={isOwner}
          busy={busy}
          buyDisabled={order.quoting || locked || pricesHidden || !status.checkout_enabled}
          buyingId={
            order.quote && writtenPick && order.quote.lines.some((l) => l.sku === writtenPick.sku)
              ? writtenPick.written_quote_id
              : null
          }
          onRequest={requestWritten}
          onWithdraw={withdrawWritten}
          onBuy={buyWritten}
        />
      ) : null}

      {reviews !== null && (trialEnded || reviews.length > 0) ? (
        <TrialReviewConsole
          reviews={reviews}
          endedAt={trialEnded && trial ? trial.trial_end : null}
          canAsk={
            isOwner &&
            trialEnded &&
            !reviews.some((r) => r.state === 'requested' || r.state === 'approved')
          }
          busy={busy}
          onRequest={requestReview}
        />
      ) : null}

      {earnings && isOwner ? <EarningsConsole coverage={earnings} scopeWord={scopeWord} /> : null}

      {scopeKind === 'union' && isOwner ? (
        <SpadeConsole
          eyebrow="Sponsorship"
          title="Sponsor Your Clubs"
          pill={activeSponsorships > 0 ? `${activeSponsorships.toLocaleString()} Active` : 'None'}
          pillInk={activeSponsorships > 0 ? 'green' : 'muted'}
          plates={{
            secondary: {
              label: 'Clear',
              onClick: () => {
                setBudget('');
                setPerClub('');
              },
              disabled: busy || (budget === '' && perClub === ''),
            },
            primary: {
              label: busy ? 'Saving' : 'Record Budget',
              ink: 'white',
              onClick: () => void saveSponsorship(),
              disabled: busy,
            },
          }}
        >
          <div className={styles.rows}>
            {status.sponsorships.length === 0 ? <Row label="No Sponsorships Yet" value="" /> : null}
            {status.sponsorships.map((s) => (
              <div key={s.id}>
                <Row
                  label={s.club_id ? 'One Club' : 'Any Covered Club'}
                  value={`${Number(s.committed ?? 0).toLocaleString()} Of ${Number(s.total_budget ?? 0).toLocaleString()}`}
                  ink={s.state === 'active' ? 'green' : 'muted'}
                  wrap
                  meta={`${s.state === 'active' ? 'Active' : 'Revoked'}. ${s.per_club_budget ? `Up To ${diamonds(s.per_club_budget)} Per Club. ` : ''}${s.effective_to ? `Ends ${when(s.effective_to)}. ` : ''}Committed Charges Never Exceed The Budget.`}
                />
                {s.state === 'active' ? (
                  <ChoiceRow
                    label="Revoke Future Spending"
                    meta="Already Paid Club Rights Stay In Place."
                    value={busy ? 'Saving' : 'Revoke'}
                    ink="red"
                    disabled={busy}
                    onClick={() => void saveSponsorship(s.id)}
                  />
                ) : null}
              </div>
            ))}
          </div>
          <div className={styles.fields}>
            <Field
              label="Total Budget (Diamonds)"
              value={budget}
              onChange={setBudget}
              disabled={busy}
              hint="Your Own Diamonds, Spent Only By You, For Covered Clubs' Capacity And Services."
            />
            <Field
              label="Per Club Allowance (Diamonds, Optional)"
              value={perClub}
              onChange={setPerClub}
              disabled={busy}
            />
          </div>
          <p className="sc-copy">
            Sponsoring Pays For A Club Once; The Club Owner Is Never Charged For The Same Right.
            Refunds Return To You As The Original Payer.
          </p>
        </SpadeConsole>
      ) : null}

      {payerSponsorships.length > 0 ? (
        <SponsorBuyConsole
          status={status}
          clubProducts={clubCatalog}
          sponsorships={payerSponsorships}
          checkoutEnabled={status.checkout_enabled}
          skewMs={skewMs}
          onSettled={async () => {
            if (scopeId) await load(scopeId);
          }}
          receipts={receipts}
          receiptsKnown={!receiptsFailed}
          refundPolicyVersion={refundPolicy?.version ?? null}
          serviceTermsVersion={serviceTermsVersion}
          pricesPublished={clubCatalogVisible || clubCatalog.some((p) => p.price)}
        />
      ) : null}

      {sponsoredRights.length > 0 ? (
        <SpadeConsole
          eyebrow="Sponsorship"
          title="Renewals"
          pill={
            sponsoredRights.length === 1
              ? '1 Right'
              : `${sponsoredRights.length.toLocaleString()} Rights`
          }
          pillInk="blue"
          foot="foot"
        >
          <div className={styles.rows}>
            {sponsoredRights.map(({ receipt: sr, right, line }) => {
              const renewal = right.renewal;
              const product =
                clubCatalog.find((p) => p.sku === (renewal?.sku ?? right.sku)) ?? null;
              const qty = renewal?.quantity ?? line?.quantity ?? 1;
              const price = listPrice(product, qty);
              const title = product?.title ?? (line ? titleCase(line.title) : 'Club Service');
              const clubName = clubNames.get(sr.scope_id) ?? 'Covered Club';
              const draft =
                renewDrafts[right.entitlement_id] ?? (price !== null ? price.toLocaleString() : '');
              const typed = parseWhole(draft);
              const accepted = acceptedTexts[right.entitlement_id];
              const inkFor: ConsoleInk =
                renewal && price !== null && price > renewal.max_diamonds ? 'red' : 'blue';
              return (
                <div key={right.entitlement_id}>
                  <Row
                    label={clubName}
                    value={dateWord(right.ends_at)}
                    ink="silver"
                    wrap
                    meta={`${title}. Paid Through ${when(right.ends_at)} From Your Sponsorship, Order ${orderRef(sr.purchase_id)}.`}
                  />
                  {renewal?.state === 'authorized' ? (
                    <>
                      <Row
                        label="Renews"
                        value={dateWord(renewal.due_at)}
                        ink={inkFor}
                        wrap
                        meta={`At ${timeWord(renewal.due_at)}. Ceiling: ${diamonds(renewal.max_diamonds)}.${
                          price !== null ? ` Today's Price: ${diamonds(price)}.` : ''
                        }${
                          price !== null && price > renewal.max_diamonds
                            ? ' That Is Above Your Ceiling, So The Renewal Would Not Complete.'
                            : ''
                        } Charged To You Within The Sponsorship Budget.${acceptedNote(accepted, termsPolicy?.version)}`}
                      />
                      <ChoiceRow
                        label="Cancel Sponsored Renewal"
                        meta="Stops The Next Sponsored Charge. The Club Keeps Its Current Paid Period."
                        value={busy ? 'Saving' : 'Cancel'}
                        ink="red"
                        disabled={busy}
                        onClick={() => void sponsorRenewal(right.entitlement_id, false, null)}
                      />
                    </>
                  ) : renewal?.state === 'completed' ? (
                    <Row
                      label="Renewed"
                      value="On File"
                      ink="green"
                      meta="The Next Period Carries Its Own Renewal Setting."
                    />
                  ) : (
                    <>
                      {renewal?.state === 'needs_attention' ? (
                        <Row
                          label="Renewal Not Completed"
                          value="Attention"
                          ink="red"
                          wrap
                          meta="The Last Sponsored Renewal Did Not Complete. The Club's Current Paid Period Is Unchanged. Authorize Again To Renew."
                        />
                      ) : null}
                      <div className={styles.fields}>
                        <Field
                          label="Authorize Renewal Up To (Diamonds)"
                          value={draft}
                          onChange={(v) =>
                            setRenewDrafts((d) => ({ ...d, [right.entitlement_id]: v }))
                          }
                          disabled={busy}
                          hint={`Charged To You Once At ${when(right.ends_at)}, Within The Sponsorship Budget, Only If The Published Price Is At Or Below This Ceiling.`}
                        />
                        <ChoiceRow
                          label="Authorize Sponsored Renewal"
                          meta={`Optional. Cancel Any Time Before It Is Due.${(() => {
                            const note = acceptanceNote(title, qty, typed, true);
                            return note ? ` ${note}` : '';
                          })()}`}
                          value={busy ? 'Saving' : 'Authorize'}
                          ink="green"
                          disabled={busy}
                          onClick={() => {
                            const problem = ceilingCheck(typed, price);
                            if (problem || typed === null)
                              return toast.error(problem ?? 'Enter A Ceiling');
                            void sponsorRenewal(right.entitlement_id, true, typed);
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <p className="sc-copy">
            A Sponsored Renewal Buys The Next Period Of That Club From Your Diamond Balance Within
            The Same Sponsorship Budget, Only At Or Below Your Ceiling. The Club Owner Is Never
            Charged For It.
          </p>
        </SpadeConsole>
      ) : null}

      <ReceiptsConsole
        receipts={listedReceipts}
        failed={receiptsFailed}
        retryDisabled={busy || locked}
        onRetry={() => void reloadReceipts()}
        describe={receiptFor}
        viewerId={viewerId}
        requestsFor={requestsFor}
        refundPolicyVersion={refundPolicy?.version ?? null}
        refundOpenFor={refundOpenFor}
        onRequestRefund={openRefund}
      />

      {refundConsole}

      <PolicyConsole refund={refundPolicy} terms={termsPolicy} service={servicePolicy} />
    </div>
  );
}
