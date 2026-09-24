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
 * Routes: /clubs/:clubId/diamond-costs (finance access in the operations
 * registry) and /unions/:unionId/diamond-costs.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { LoadingState } from '../../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../../components/console/SpadeConsole';
import ClubCommerceService, {
  isRefusal,
  listPrice,
  refusalCopy,
  type Catalog,
  type CatalogProduct,
  type Entitlement,
  type PurchaseKind,
  type Quote,
  type Receipt,
  type Refusal,
  type RenewalChange,
  type ScopeKind,
  type ScopeStatus,
  type Sponsorship,
} from '../../services/ClubCommerceService';
import { isUUID, resolveClubUUIDStrict } from '../../utils/clubIdResolver';
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
      </div>
      <p className="sc-copy">
        Confirming Charges Your Diamonds Once. If The Connection Drops, Retrying Sends The Same
        Order Key And Never Charges Twice. Refunds Follow The Displayed Policy And Return To The
        Original Payer.
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
 * an active sponsorship chooses a covered club and a club capacity, quotes it
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
  const product = capacities.find((p) => p.sku === sku) ?? null;
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
    if (!club || !product) return toast.error('Choose A Club And A Capacity First');
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
            {capacities.map((p) => {
              const tooSmall = p.capacity !== null && club.roster_count > p.capacity;
              const current = club.capacity?.sku === p.sku;
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
          A Sponsored Order Is Charged To You Once And Pays For That Club Capacity; The Club Owner
          Is Never Charged For The Same Period. Its Receipt Is Listed Below.
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
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptsFailed, setReceiptsFailed] = useState(false);
  const [showAllReceipts, setShowAllReceipts] = useState(false);
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
        const [s, c, r, cc] = await Promise.all([
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
        ]);
        if (!isMountedRef.current || seq !== loadSeq.current) return;
        if (isRefusal(s)) {
          setError(refusalCopy(s.error, 'This Page Could Not Be Read'));
          return;
        }
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
    setSelectedSku(null);
    setRenewOn(false);
    setRenewMax('');
    setSponsorshipId(null);
  };

  const getQuote = () => {
    if (order.outcomeUnknown) return toast.error('Check Your Last Order Before Starting A New One');
    if (!scopeId || !selected) return toast.error('Choose A Service First');
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
  const accessPill = trialActive ? 'Free Month' : paidActive ? 'Paid' : 'No Access';
  const accessInk: ConsoleInk = trialActive ? 'blue' : paidActive ? 'green' : 'gold';
  const trialEnd = trial ? Date.parse(trial.trial_end) : NaN;
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
  const shownReceipts = showAllReceipts ? listedReceipts : listedReceipts.slice(0, RECEIPTS_SHOWN);
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
                    : 'Paid Operating Access Does Not Start On Its Own. Authorize A Service Under Paid Access To Continue Without Interruption.'
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
                  : 'Choose A Service Under Diamond Prices To Keep Operating.'
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
                  meta="Starts Now. The Exact End Time Is Shown Here Once It Begins."
                  value={busy ? 'Starting' : 'Start'}
                  ink="green"
                  disabled={busy}
                  onClick={() => void activate()}
                />
              ) : null}
            </>
          )}
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
          {balance !== null ? (
            <Row label="Available Diamonds" value={balance.toLocaleString()} ink="silver" />
          ) : null}
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
                  ? 'Paid By Your Union Sponsor; Renews Through A New Sponsored Order.'
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
                        meta={`At ${timeWord(r.due_at)}. ${renewalNote(e)}`}
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
                          meta="Optional. You Can Cancel Any Time Before The Due Time."
                          value={busy ? 'Saving' : 'Authorize'}
                          ink="green"
                          disabled={busy}
                          onClick={() => authorizeRenewal(e)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
                {e.kind === 'trial_operating' && trialActive ? (
                  <>
                    {r?.state === 'authorized' ? (
                      <Row
                        label="First Paid Period"
                        value={`Up To ${diamonds(r.max_diamonds)}`}
                        ink="green"
                        wrap
                        meta={`${authorizedService(r)}. Charged Once At ${when(r.due_at)}, Only If The Published Price Is At Or Below This Ceiling.`}
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
                          meta="Your Diamonds Are Not Touched Until The Free Month Ends."
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
        pill={catalog ? (catalogWord(catalog.catalog_version) ?? undefined) : undefined}
        pillInk="muted"
        plates={
          canBuy
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
        foot={canBuy ? 'plates' : 'foot'}
      >
        <div className={styles.rows}>
          {!status.checkout_enabled ? (
            <Row
              label="Checkout Paused"
              value="Paused"
              ink="gold"
              meta="Prices Can Be Reviewed. Orders Resume When Checkout Reopens."
            />
          ) : null}
          {products.length === 0 ? <Row label="No Services Listed" value="" /> : null}
          {products.map((p) => {
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
                hint="Charged Once When The Period Ends, Only If The Published Price Is At Or Below This Ceiling."
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
      </SpadeConsole>

      <QuoteConsole
        order={order}
        sectionId="diamond-costs-quote"
        eyebrow="Quote"
        skewMs={skewMs}
        busy={busy}
        canRequote={Boolean(selected)}
        onRequote={getQuote}
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
      />

      <ReceiptConsole order={order} sectionId="diamond-costs-receipt" />

      {order.recovering ? <LoadingState message="Checking Your Order" /> : null}

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
        />
      ) : null}

      <SpadeConsole
        eyebrow="Records"
        title="Receipts"
        pill={
          receiptsFailed
            ? 'Not Read'
            : listedReceipts.length > 0
              ? `${listedReceipts.length.toLocaleString()} On File`
              : 'None'
        }
        pillInk={receiptsFailed ? 'gold' : 'muted'}
        foot="foot"
      >
        <div className={styles.rows}>
          {receiptsFailed ? (
            <ChoiceRow
              label="Receipts Could Not Be Read"
              meta="Your Orders Are Safe On File. Read Them Again."
              value="Retry"
              ink="gold"
              disabled={busy || locked}
              onClick={() => void reloadReceipts()}
            />
          ) : null}
          {!receiptsFailed && listedReceipts.length === 0 ? (
            <Row label="No Receipts On File" value="" />
          ) : null}
          {shownReceipts.map((r) => (
            <div key={r.purchase_id}>
              <Row
                label={`${r.kind === 'renewal' ? 'Renewal' : r.kind === 'upgrade' ? 'Upgrade' : 'Order'} ${orderRef(r.purchase_id)}`}
                value={diamonds(r.original_total_diamonds)}
                wrap
                meta={receiptFor(r)}
              />
              {(r.lines ?? []).map((l) => (
                <Row
                  key={`${r.purchase_id}:${l.index}`}
                  label={l.title}
                  value={diamonds(l.net)}
                  ink="muted"
                  wrap
                  meta={`${when(l.starts_at)} To ${when(l.ends_at)}`}
                />
              ))}
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
          {listedReceipts.length > RECEIPTS_SHOWN ? (
            <ChoiceRow
              label={showAllReceipts ? 'Show Fewer Receipts' : 'Show All Receipts'}
              meta={`${listedReceipts.length.toLocaleString()} Receipts On File`}
              value={showAllReceipts ? 'Fewer' : 'All'}
              ink="blue"
              pressed={showAllReceipts}
              onClick={() => setShowAllReceipts((v) => !v)}
            />
          ) : null}
        </div>
        <p className="sc-copy">
          A Receipt Is Permanent Transaction Evidence. Your Wallet Balance Is Read Separately And
          May Have Changed Since.
        </p>
      </SpadeConsole>
    </div>
  );
}
