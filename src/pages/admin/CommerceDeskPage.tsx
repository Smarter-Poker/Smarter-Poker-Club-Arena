/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COMMERCE DESK - platform staff decide refunds and run the diamond catalog
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), sections 4.4, 6.4 and 7.3.
 * Seven jobs, one tab each:
 *
 *   Refund Queue         every request by state, with the policy figures the
 *                        request door computed, and Approve / Decline. The
 *                        server refuses staff deciding their own request; the
 *                        desk says so before anyone presses anything.
 *   Catalog              the price in effect per product, draft / validate /
 *                        publish / retire (now or later), Supported, and the
 *                        checkout and catalog visibility switches.
 *   Comparison Evidence  record a competitor's observed price, and verify one a
 *                        colleague recorded (the server refuses the recorder).
 *   Admission            what the recorded shadow decisions say enforcement
 *                        would refuse, per door and per club, read before
 *                        anyone switches enforcement on (20260924102056).
 *   Written Quotes       an owner asks for more than 2,500 members; staff offer
 *                        a capacity and whole diamond price valid for 1 to 30
 *                        days, or decline with a note (20260924182605).
 *   Free Month Reviews   an owner whose later club inherited an ended free
 *                        month asks for its own; staff approve (a fresh 30 day
 *                        free month for that one scope) or decline with a note.
 *   Metrics              the operating measures of R2 7.5 (20260924183529):
 *                        net paid diamonds kept apart from proposed quotes,
 *                        free month waivers, refunds, retries and replays.
 *
 * PLATFORM STAFF ONLY. The route sits behind PlatformStaffGuard and every door
 * checks fn_is_platform_admin() again, so the guard is a courtesy and the
 * doors are the lock. It is an internal tool (Dan 2026-09-14: internal pages
 * need no painted chassis) and is held to the copy laws and the schema
 * colours: Title Case, no em dashes, no hover, whole diamonds.
 *
 * WHAT STAFF READ. fn_ca_commerce_catalog gives the one price in effect per
 * product and the two switches; fn_ca_commerce_price_versions gives every
 * version of every product (draft, validated, published, retired), and
 * fn_ca_commerce_comparison_list every piece of evidence with who recorded
 * and who verified it. Both are staff-only reads (migration 20260924102040).
 * The catalog and the versions are read together so the price in effect and
 * its history never disagree on screen, and every action re-reads both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { LoadingState } from '../../components/common/EmptyState';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
import { titleCase } from '../../utils/titleCase';
import CommerceDeskService, {
  ADMISSION_ACTION_LABEL,
  ADMISSION_DOOR_LABEL,
  ADMISSION_REASON_LABEL,
  CommerceDeskTransportError,
  PRICE_RULE_LABEL,
  PRICE_STATUS_LABEL,
  REFUND_BASIS_LABEL,
  REFUND_REASON_LABEL,
  REFUND_STATES,
  REFUND_STATE_LABEL,
  deskRefusalCopy,
  isRefusal,
  lookupDeskNames,
  lookupHandles,
  lookupScopeNames,
  nextPriceStep,
  priceRulesFor,
  refundReasonWords,
  admissionWords,
  type AdmissionReport,
  type DeskCatalog,
  type DeskCatalogProduct,
  type DeskEvidence,
  type DeskNames,
  type DeskPriceVersion,
  type PriceRule,
  type PriceStatus,
  type RefundRequest,
  type RefundState,
  TRIAL_REVIEW_STATE_LABEL,
  WRITTEN_QUOTE_LIMITS,
  WRITTEN_QUOTE_STATE_LABEL,
  type CommerceMetrics,
  type ScopeKind,
  type TrialReview,
  type TrialReviewState,
  type WrittenQuote,
  type WrittenQuoteState,
} from '../../services/CommerceDeskService';
import s from './CommerceDeskPage.module.css';

/* ── Formatting ─────────────────────────────────────────────────────────── */

const whole = (n: number | null | undefined) => Math.trunc(Number(n ?? 0)).toLocaleString();
const diamonds = (n: number | null | undefined) => `${whole(n)} Diamonds`;

function when(iso: string | null | undefined): string {
  if (!iso) return 'Not Set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not Set';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function day(iso: string | null | undefined): string {
  if (!iso) return 'Not Set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not Set';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The first eight characters of an id, printed in the `code` style. */
const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : 'None');

function priceText(rule: PriceRule, amount: number, cap: number | null): string {
  if (rule === 'per_unit') return `${diamonds(amount)} Per Covered Club`;
  if (rule === 'per_unit_capped')
    return `${diamonds(amount)} Per Covered Club, Up To ${whole(cap)}`;
  return diamonds(amount);
}

function termText(p: DeskCatalogProduct): string {
  if (p.term_kind === 'permanent') return 'Permanent';
  if (p.term_kind === 'report_interval') {
    const d = p.report_days ?? 0;
    return `${whole(d)} ${d === 1 ? 'Day' : 'Days'} Of Reporting`;
  }
  const h = p.term_hours ?? 0;
  if (h % 24 === 0) {
    const d = h / 24;
    return `${whole(d)} ${d === 1 ? 'Day' : 'Days'}`;
  }
  return `${whole(h)} ${h === 1 ? 'Hour' : 'Hours'}`;
}

const yesNo = (b: boolean | null | undefined) => (b ? 'Yes' : 'No');

/** A datetime-local value in this browser's zone, for the minimum attribute. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDateValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A transport failure's own sentence, or the refusal's copy. */
function failureText(e: unknown, fallback: string): string {
  if (e instanceof CommerceDeskTransportError) return e.message;
  return fallback;
}

/** The service already reported a transport failure; report anything else once. */
function reportUnexpected(e: unknown, where: string): void {
  if (!(e instanceof CommerceDeskTransportError)) reportError(e, where);
}

/* ── Small pieces ───────────────────────────────────────────────────────── */

/** A label and its value. `prose` puts a sentence on its own full-width line. */
function Row({
  label,
  value,
  tone,
  prose = false,
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  prose?: boolean;
}) {
  return (
    <div className={prose ? `${s.row} ${s.rowProse}` : s.row}>
      <span className={s.rowLabel}>{label}</span>
      <span className={`${s.rowValue} ${tone ? s[`ink_${tone}`] : ''}`}>{value}</span>
    </div>
  );
}

type Tone = 'blue' | 'silver' | 'green' | 'gold' | 'red' | 'muted';

const STATE_TONE: Record<RefundState, Tone> = {
  requested: 'blue',
  approved: 'green',
  owed: 'gold',
  refunded: 'green',
  declined: 'muted',
  failed: 'red',
};

const PRICE_TONE: Record<PriceStatus, Tone> = {
  draft: 'muted',
  validated: 'blue',
  published: 'green',
  retired: 'muted',
};

function Code({ children }: { children: string }) {
  return <span className={s.code}>{children}</span>;
}

/** Now, or a moment later. Returns the ISO instant, null for now, or an error. */
type WhenChoice = { mode: 'now' | 'later'; local: string };

function resolveWhen(c: WhenChoice): { iso: string | null } | { error: string } {
  if (c.mode === 'now') return { iso: null };
  if (!c.local) return { error: 'Pick The Date And Time' };
  const d = new Date(c.local);
  if (Number.isNaN(d.getTime())) return { error: 'Pick The Date And Time' };
  if (d.getTime() <= Date.now()) return { error: 'Pick A Time In The Future, Or Choose Now' };
  return { iso: d.toISOString() };
}

function WhenPicker({
  value,
  onChange,
  nowLabel,
  laterLabel,
  idPrefix,
}: {
  value: WhenChoice;
  onChange: (v: WhenChoice) => void;
  nowLabel: string;
  laterLabel: string;
  idPrefix: string;
}) {
  return (
    <div className={s.whenPicker} role="radiogroup" aria-label={`${nowLabel} Or ${laterLabel}`}>
      <button
        type="button"
        role="radio"
        aria-checked={value.mode === 'now'}
        className={`${s.chip} ${value.mode === 'now' ? s.chipOn : ''}`}
        onClick={() => onChange({ ...value, mode: 'now' })}
      >
        {nowLabel}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value.mode === 'later'}
        className={`${s.chip} ${value.mode === 'later' ? s.chipOn : ''}`}
        onClick={() =>
          onChange({
            mode: 'later',
            local: value.local || localInputValue(new Date(Date.now() + 24 * 3_600_000)),
          })
        }
      >
        {laterLabel}
      </button>
      {value.mode === 'later' && (
        <input
          id={`${idPrefix}-when`}
          aria-label="Date And Time"
          className={s.input}
          type="datetime-local"
          min={localInputValue(new Date())}
          value={value.local}
          onChange={(e) => onChange({ mode: 'later', local: e.target.value })}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE PAGE
   ═══════════════════════════════════════════════════════════════════════════ */

type TabKey = 'refunds' | 'written' | 'reviews' | 'catalog' | 'evidence' | 'admission' | 'metrics';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'refunds', label: 'Refund Queue' },
  { key: 'written', label: 'Written Quotes' },
  { key: 'reviews', label: 'Free Month Reviews' },
  { key: 'catalog', label: 'Catalog' },
  { key: 'evidence', label: 'Comparison Evidence' },
  { key: 'admission', label: 'Admission' },
  { key: 'metrics', label: 'Metrics' },
];
const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

export default function CommerceDeskPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: TabKey = tabParam && TAB_KEYS.has(tabParam) ? (tabParam as TabKey) : 'refunds';
  const setTab = (next: TabKey) => {
    const p = new URLSearchParams(params);
    if (next === 'refunds') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  const { user } = useAuthUser();
  const me = user?.id ?? null;
  const isMounted = useIsMounted();

  /* Seven tabs scroll sideways on a phone; a deep link to a later one
     (?tab=metrics) must not open with the current tab off screen. */
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const strip = tabsRef.current;
    const on = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !on) return;
    const left = on.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + on.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = Math.max(0, left + on.offsetWidth - strip.clientWidth);
  }, [tab]);

  /* The catalog and every price version are shared by the Catalog and
     Evidence tabs, and are read together so a product's price in effect and
     its history never disagree on screen. */
  const [catalog, setCatalog] = useState<DeskCatalog | null>(null);
  const [versions, setVersions] = useState<DeskPriceVersion[] | null>(null);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogSeq = useRef(0);
  const loadCatalog = useCallback(async () => {
    const seq = ++catalogSeq.current;
    setCatalogError(null);
    try {
      const [c, v] = await Promise.all([
        CommerceDeskService.catalog(),
        CommerceDeskService.priceVersions(null),
      ]);
      if (!isMounted.current || seq !== catalogSeq.current) return;
      setCatalog(c);
      if (isRefusal(v)) {
        setVersions([]);
        setCatalogError(deskRefusalCopy(v.error, 'The Price Versions Could Not Be Read'));
        return;
      }
      const list = Array.isArray(v.price_versions) ? v.price_versions : [];
      setVersions(list);
      const h = await lookupHandles(list.flatMap((x) => [x.created_by, x.published_by]));
      if (!isMounted.current || seq !== catalogSeq.current) return;
      setHandles((prev) => ({ ...prev, ...h }));
    } catch (e) {
      if (!isMounted.current || seq !== catalogSeq.current) return;
      reportUnexpected(e, 'CommerceDeskPage.loadCatalog');
      setCatalogError(failureText(e, 'The Catalog Could Not Be Read'));
    }
  }, [isMounted]);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const [evidence, setEvidence] = useState<DeskEvidence[] | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const evidenceSeq = useRef(0);
  const loadEvidence = useCallback(async () => {
    const seq = ++evidenceSeq.current;
    setEvidenceError(null);
    try {
      const res = await CommerceDeskService.comparisonList(null);
      if (!isMounted.current || seq !== evidenceSeq.current) return;
      if (isRefusal(res)) {
        setEvidence([]);
        setEvidenceError(deskRefusalCopy(res.error, 'The Evidence Could Not Be Read'));
        return;
      }
      const list = Array.isArray(res.evidence) ? res.evidence : [];
      setEvidence(list);
      /* The list names people by username; staff read the poker handle
         (alias first), the same name the rest of the desk prints. */
      const h = await lookupHandles(list.flatMap((x) => [x.recorded_by, x.verified_by]));
      if (!isMounted.current || seq !== evidenceSeq.current) return;
      setHandles((prev) => ({ ...prev, ...h }));
    } catch (e) {
      if (!isMounted.current || seq !== evidenceSeq.current) return;
      reportUnexpected(e, 'CommerceDeskPage.loadEvidence');
      setEvidence([]);
      setEvidenceError(failureText(e, 'The Evidence Could Not Be Read'));
    }
  }, [isMounted]);
  useEffect(() => {
    if (tab === 'evidence' && evidence === null) void loadEvidence();
  }, [tab, evidence, loadEvidence]);

  return (
    <main className={s.page} aria-labelledby="commerce-desk-title">
      <header className={s.head}>
        <p className={s.eyebrow}>Platform Staff</p>
        <h1 id="commerce-desk-title" className={s.title}>
          Commerce Desk
        </h1>
        <p className={s.lede}>
          Club And Union Diamond Refunds, Written Quotes, Free Month Reviews, Catalog Prices,
          Comparison Evidence, Admission And Metrics. Every Change Here Is Checked Again By The
          Server And Recorded With Your Name.
        </p>
      </header>

      <nav ref={tabsRef} className={s.tabs} aria-label="Commerce Desk Sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`${s.tab} ${tab === t.key ? s.tabOn : ''}`}
            aria-current={tab === t.key ? 'page' : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'refunds' && <RefundQueue me={me} />}
      {tab === 'catalog' && (
        <CatalogPanel
          catalog={catalog}
          versions={versions}
          handles={handles}
          catalogError={catalogError}
          reload={loadCatalog}
          setCatalog={setCatalog}
        />
      )}
      {tab === 'evidence' && (
        <EvidencePanel
          me={me}
          handles={handles}
          catalog={catalog}
          versions={versions}
          catalogError={catalogError}
          reloadCatalog={loadCatalog}
          evidence={evidence}
          evidenceError={evidenceError}
          reloadEvidence={loadEvidence}
        />
      )}
      {tab === 'admission' && <AdmissionPanel />}
      {tab === 'written' && <WrittenQuotesPanel />}
      {tab === 'reviews' && <TrialReviewsPanel me={me} />}
      {tab === 'metrics' && <MetricsPanel />}
    </main>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. REFUND QUEUE
   ═══════════════════════════════════════════════════════════════════════════ */

type QueueFilter = RefundState | 'all';

function RefundQueue({ me }: { me: string | null }) {
  const isMounted = useIsMounted();
  const [filter, setFilter] = useState<QueueFilter>('requested');
  const [requests, setRequests] = useState<RefundRequest[] | null>(null);
  const [names, setNames] = useState<DeskNames>({ people: {}, clubs: {}, unions: {} });
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (which: QueueFilter) => {
      const mine = ++seq.current;
      setRequests(null);
      setError(null);
      try {
        const res = await CommerceDeskService.refundQueue(which === 'all' ? null : which);
        if (!isMounted.current || mine !== seq.current) return;
        if (isRefusal(res)) {
          setError(deskRefusalCopy(res.error, 'The Refund Queue Could Not Be Read'));
          setRequests([]);
          return;
        }
        const list = Array.isArray(res.requests) ? res.requests : [];
        setRequests(list);
        const n = await lookupDeskNames(list);
        if (!isMounted.current || mine !== seq.current) return;
        setNames(n);
      } catch (e) {
        if (!isMounted.current || mine !== seq.current) return;
        reportUnexpected(e, 'CommerceDeskPage.RefundQueue.load');
        setError(failureText(e, 'The Refund Queue Could Not Be Read'));
        setRequests([]);
      }
    },
    [isMounted]
  );

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const replace = useCallback((r: RefundRequest) => {
    setRequests((prev) => (prev ?? []).map((x) => (x.request_id === r.request_id ? r : x)));
  }, []);

  const filters: Array<{ key: QueueFilter; label: string }> = [
    ...REFUND_STATES.map((k) => ({ key: k as QueueFilter, label: REFUND_STATE_LABEL[k] })),
    { key: 'all', label: 'All' },
  ];

  return (
    <section className={s.section} aria-labelledby="desk-refunds-title">
      <div className={s.sectionHead}>
        <h2 id="desk-refunds-title" className={s.sectionTitle}>
          Refund Queue
        </h2>
        <button type="button" className={s.link} onClick={() => void load(filter)}>
          Refresh
        </button>
      </div>
      <p className={s.copy}>
        Owners Ask, Staff Decide, And The Commerce Consumer Returns An Approved Refund To The
        Original Payer. Oldest Requests Are First.
      </p>
      <div className={s.chips} role="radiogroup" aria-label="Refund State">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            role="radio"
            aria-checked={filter === f.key}
            className={`${s.chip} ${filter === f.key ? s.chipOn : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p className={s.alert} role="alert">
          {error}
        </p>
      )}
      {requests === null && <LoadingState message="Reading The Refund Queue" />}
      {requests !== null && requests.length === 0 && !error && (
        <p className={s.empty}>
          {filter === 'all'
            ? 'No Refund Requests Yet'
            : `No ${REFUND_STATE_LABEL[filter]} Refund Requests`}
        </p>
      )}
      {requests && requests.length > 0 && (
        <div className={s.cardGrid}>
          {requests.map((r) => (
            <RefundCard key={r.request_id} r={r} me={me} names={names} onDecided={replace} />
          ))}
        </div>
      )}
    </section>
  );
}

function scopeTitle(scopeKind: ScopeKind, scopeId: string, names: DeskNames): React.ReactNode {
  const name = scopeKind === 'club' ? names.clubs[scopeId] : names.unions[scopeId];
  const kind = scopeKind === 'club' ? 'Club' : 'Union';
  return name ? (
    `${titleCase(name)} (${kind})`
  ) : (
    <>
      {kind} <Code>{shortId(scopeId)}</Code>
    </>
  );
}

/** The same name as plain text, for an accessible label or a dialog. */
function scopeText(scopeKind: ScopeKind, scopeId: string, names: DeskNames): string {
  const name = scopeKind === 'club' ? names.clubs[scopeId] : names.unions[scopeId];
  const kind = scopeKind === 'club' ? 'Club' : 'Union';
  return name ? `${titleCase(name)} (${kind})` : `${kind} ${shortId(scopeId).toUpperCase()}`;
}

function scopeName(r: RefundRequest, names: DeskNames): React.ReactNode {
  return scopeTitle(r.scope_kind, r.scope_id, names);
}

/** A handle that is an identifier (snake_case) prints as one, never lower case. */
const SNAKE_HANDLE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/;
function handleText(handle: string): React.ReactNode {
  return SNAKE_HANDLE.test(handle) ? <Code>{handle}</Code> : titleCase(handle);
}

function personName(id: string, names: DeskNames): React.ReactNode {
  const n = names.people[id];
  return n ? handleText(n) : <Code>{shortId(id)}</Code>;
}

function RefundCard({
  r,
  me,
  names,
  onDecided,
}: {
  r: RefundRequest;
  me: string | null;
  names: DeskNames;
  onDecided: (r: RefundRequest) => void;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const d = r.policy_detail ?? {};
  const refundable = Number(d.refundable ?? r.policy_amount);
  const own = !!me && (me === r.requested_by || me === r.payer_id);
  const open = r.state === 'requested';
  const payer = names.people[r.payer_id]
    ? titleCase(names.people[r.payer_id].replace(/_/g, ' '))
    : 'The Payer';

  const decide = async (approve: boolean) => {
    if (inFlight.current) return;
    setProblem(null);
    let amt: number | null = null;
    if (approve) {
      const raw = amount.trim().replace(/,/g, '');
      if (raw) {
        if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
          setProblem(deskRefusalCopy('amount_required'));
          return;
        }
        amt = Number(raw);
        if (amt > refundable) {
          setProblem(`${deskRefusalCopy('exceeds_refundable')}. Up To ${diamonds(refundable)}`);
          return;
        }
      }
      const pay = amt ?? r.policy_amount;
      const ok = await confirmDialog({
        title: 'Approve Refund',
        message: `Approve A Refund Of ${diamonds(pay)} To ${payer}? The Commerce Consumer Returns It To Their Diamond Balance.`,
        confirmText: 'Approve',
      });
      if (!ok) return;
    } else if (note.trim().length < 5) {
      setProblem(deskRefusalCopy('note_required'));
      return;
    }
    inFlight.current = true;
    setBusy(approve ? 'approve' : 'decline');
    try {
      const res = await CommerceDeskService.decideRefund(
        r.request_id,
        approve,
        amt,
        note.trim() ? note.trim() : null
      );
      if (!isMounted.current) return;
      if (isRefusal(res)) {
        const extra =
          res.error === 'exceeds_refundable' && typeof res.refundable === 'number'
            ? `. Up To ${diamonds(res.refundable)}`
            : '';
        setProblem(`${deskRefusalCopy(res.error)}${extra}`);
        const current = (res as { request?: RefundRequest }).request;
        if (current) onDecided(current);
        return;
      }
      onDecided(res.request);
      toast.success(
        approve
          ? `Refund Approved: ${diamonds(res.request.approved_amount)}`
          : 'Refund Request Declined'
      );
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.RefundCard.decide');
      setProblem(failureText(e, 'The Decision Could Not Be Saved'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(null);
    }
  };

  const basis = REFUND_BASIS_LABEL[r.policy_basis] ?? titleCase(String(r.policy_basis));
  const reason = REFUND_REASON_LABEL[r.reason_code] ?? titleCase(String(r.reason_code));

  return (
    <article className={s.card} aria-labelledby={`refund-${r.request_id}`}>
      <div className={s.cardHead}>
        <h3 id={`refund-${r.request_id}`} className={s.cardTitle}>
          {diamonds(r.approved_amount ?? r.policy_amount)} For {scopeName(r, names)}
        </h3>
        <span className={`${s.pill} ${s[`ink_${STATE_TONE[r.state]}`]}`}>
          {REFUND_STATE_LABEL[r.state] ?? titleCase(r.state)}
        </span>
      </div>

      <Row label="Requested" value={when(r.created_at)} />
      <Row label="Payer" value={personName(r.payer_id, names)} />
      {r.requested_by !== r.payer_id && (
        <Row label="Requested By" value={personName(r.requested_by, names)} />
      )}
      <Row
        label="Purchase Line"
        value={
          <>
            Purchase <Code>{shortId(r.purchase_id)}</Code>, Line {whole(r.line_index + 1)}
          </>
        }
      />
      <Row label="Reason" value={reason} />
      {r.details && <Row label="Details" value={titleCase(r.details)} prose />}

      <p className={s.subhead}>Refund Policy Version {whole(r.policy_version)}</p>
      <Row label="Basis" value={basis} />
      <Row label="Policy Amount" value={diamonds(r.policy_amount)} tone="silver" />
      {d.line_net !== undefined && <Row label="Line Paid" value={diamonds(d.line_net)} />}
      <Row label="Refundable At Request" value={diamonds(refundable)} />
      {d.unused_days !== undefined && (
        <Row
          label="Unused Whole Days"
          value={`${whole(d.unused_days)} Of ${whole(Math.round(Number(d.period_days ?? 0)))}`}
        />
      )}
      <Row label="Purchased" value={when(d.purchased_at)} />
      <Row label="Right Dates" value={`${day(d.right_starts_at)} To ${day(d.right_ends_at)}`} />
      <Row label="Right Started" value={yesNo(d.right_started)} />
      {d.right_state && <Row label="Right State" value={titleCase(d.right_state)} />}
      <Row label="Sponsored" value={yesNo(d.sponsored)} />

      {!open && (
        <>
          <p className={s.subhead}>Decision</p>
          {r.approved_amount !== null && (
            <Row label="Approved Amount" value={diamonds(r.approved_amount)} tone="silver" />
          )}
          <Row label="Decided" value={when(r.decided_at)} />
          {r.decision_note && <Row label="Note" value={titleCase(r.decision_note)} prose />}
          {r.state === 'owed' && (
            <Row label="Owed Because" value={refundReasonWords(r.owed_reason)} tone="gold" />
          )}
          {r.state === 'failed' && (
            <Row label="Failed Because" value={refundReasonWords(r.last_error)} tone="red" />
          )}
          {r.attempts > 0 && <Row label="Attempts" value={whole(r.attempts)} />}
          {r.executed_at && <Row label="Returned" value={when(r.executed_at)} tone="green" />}
        </>
      )}

      {open && own && <p className={s.notice}>{deskRefusalCopy('cannot_decide_own_request')}.</p>}

      {open && !own && (
        <div className={s.decide}>
          <label className={s.field}>
            <span className={s.fieldLabel}>Amount To Approve</span>
            <input
              className={s.input}
              inputMode="numeric"
              value={amount}
              placeholder={`${whole(r.policy_amount)} (Policy Amount)`}
              onChange={(e) => setAmount(e.target.value)}
              aria-describedby={`refund-${r.request_id}-amount-hint`}
            />
            <span id={`refund-${r.request_id}-amount-hint`} className={s.hint}>
              Leave Empty For The Policy Amount. Up To {diamonds(refundable)}.
            </span>
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>Note To The Payer</span>
            <textarea
              className={s.textarea}
              rows={2}
              maxLength={2000}
              value={note}
              placeholder="Required To Decline, At Least 5 Characters"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {problem && (
            <p className={s.alert} role="alert">
              {problem}
            </p>
          )}
          <div className={s.actions}>
            <button
              type="button"
              className={s.danger}
              disabled={busy !== null}
              onClick={() => void decide(false)}
            >
              {busy === 'decline' ? 'Declining' : 'Decline'}
            </button>
            <button
              type="button"
              className={s.primary}
              disabled={busy !== null}
              onClick={() => void decide(true)}
            >
              {busy === 'approve' ? 'Approving' : 'Approve'}
            </button>
          </div>
        </div>
      )}
      {!(open && !own) && problem && (
        <p className={s.alert} role="alert">
          {problem}
        </p>
      )}
    </article>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. CATALOG
   ═══════════════════════════════════════════════════════════════════════════ */

function CatalogPanel({
  catalog,
  versions,
  handles,
  catalogError,
  reload,
  setCatalog,
}: {
  catalog: DeskCatalog | null;
  versions: DeskPriceVersion[] | null;
  handles: Record<string, string>;
  catalogError: string | null;
  reload: () => Promise<void>;
  setCatalog: (c: DeskCatalog) => void;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);

  const flip = async (which: 'checkout' | 'catalog') => {
    if (!catalog || inFlight.current) return;
    const next = which === 'checkout' ? !catalog.checkout_enabled : !catalog.catalog_visible;
    const label = which === 'checkout' ? 'Checkout' : 'The Catalog';
    const ok = await confirmDialog({
      title: which === 'checkout' ? 'Checkout' : 'Catalog Visibility',
      message:
        which === 'checkout'
          ? next
            ? 'Turn Checkout On? Owners Can Buy At Published Prices Again.'
            : 'Turn Checkout Off? No Owner Can Start A New Purchase Until It Is Back On.'
          : next
            ? 'Show The Catalog To Owners Again?'
            : 'Hide The Catalog From Owners? Rights Already Bought Are Not Affected.',
      confirmText: next ? 'Turn On' : 'Turn Off',
      variant: next ? 'default' : 'danger',
    });
    if (!ok) return;
    inFlight.current = true;
    setBusy(which);
    try {
      const res = await CommerceDeskService.setSettings({
        checkoutEnabled: which === 'checkout' ? next : null,
        catalogVisible: which === 'catalog' ? next : null,
      });
      if (!isMounted.current) return;
      if (isRefusal(res)) {
        toast.error(deskRefusalCopy(res.error));
        return;
      }
      setCatalog({
        ...catalog,
        checkout_enabled: res.checkout_enabled,
        catalog_visible: res.catalog_visible,
      });
      toast.success(`${label} Is ${next ? 'On' : 'Off'}`);
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.flipSetting');
      toast.error(failureText(e, 'The Setting Could Not Be Changed'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(null);
    }
  };

  if (catalogError && !catalog) {
    return (
      <section className={s.section}>
        <p className={s.alert} role="alert">
          {catalogError}
        </p>
        <button type="button" className={s.action} onClick={() => void reload()}>
          Try Again
        </button>
      </section>
    );
  }
  if (!catalog || versions === null) return <LoadingState message="Reading The Catalog" />;

  const club = catalog.products.filter((p) => p.scope_kind === 'club');
  const union = catalog.products.filter((p) => p.scope_kind === 'union');

  return (
    <>
      <section className={s.section} aria-labelledby="desk-settings-title">
        <div className={s.sectionHead}>
          <h2 id="desk-settings-title" className={s.sectionTitle}>
            Settings
          </h2>
          <button type="button" className={s.link} onClick={() => void reload()}>
            Refresh
          </button>
        </div>
        {catalogError && (
          <p className={s.alert} role="alert">
            {catalogError}
          </p>
        )}
        <div className={s.toggleRow}>
          <div>
            <p className={s.rowLabel}>Checkout</p>
            <p className={s.hint}>Owners Can Start New Purchases</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={catalog.checkout_enabled}
            className={`${s.switch} ${catalog.checkout_enabled ? s.switchOn : ''}`}
            disabled={busy !== null}
            onClick={() => void flip('checkout')}
          >
            {catalog.checkout_enabled ? 'On' : 'Off'}
          </button>
        </div>
        <div className={s.toggleRow}>
          <div>
            <p className={s.rowLabel}>Catalog Visible</p>
            <p className={s.hint}>Owners See Prices On Diamond Costs</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={catalog.catalog_visible}
            className={`${s.switch} ${catalog.catalog_visible ? s.switchOn : ''}`}
            disabled={busy !== null}
            onClick={() => void flip('catalog')}
          >
            {catalog.catalog_visible ? 'On' : 'Off'}
          </button>
        </div>
        <Row label="Catalog Version" value={<Code>{catalog.catalog_version}</Code>} prose />
        <p className={s.copy}>
          Each Product Lists Every Price Version, Newest First, With The Step Its Status Is Ready
          For: A Draft Is Validated, A Validated Price Is Published, A Published Price Is Retired.
        </p>
      </section>

      {[
        { title: 'Club Products', list: club },
        { title: 'Union Products', list: union },
      ].map((g) =>
        g.list.length ? (
          <section key={g.title} className={s.section} aria-label={g.title}>
            <h2 className={s.sectionTitle}>{g.title}</h2>
            <div className={s.cardGrid}>
              {g.list.map((p) => (
                <ProductCard
                  key={p.sku}
                  p={p}
                  versions={versions.filter((v) => v.sku === p.sku)}
                  handles={handles}
                  reload={reload}
                />
              ))}
            </div>
          </section>
        ) : null
      )}
    </>
  );
}

function ProductCard({
  p,
  versions,
  handles,
  reload,
}: {
  p: DeskCatalogProduct;
  versions: DeskPriceVersion[];
  handles: Record<string, string>;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const toggleSupport = async () => {
    if (inFlight.current) return;
    const next = !p.supported;
    const ok = await confirmDialog({
      title: next ? 'Mark Supported' : 'Mark Unsupported',
      message: next
        ? `Offer ${titleCase(p.title)} To Owners? It Needs A Published Price To Be Bought.`
        : `Stop Offering ${titleCase(p.title)}? Open Quotes For It Are Withdrawn. Rights Already Bought Are Not Affected.`,
      confirmText: next ? 'Mark Supported' : 'Mark Unsupported',
      variant: next ? 'default' : 'danger',
    });
    if (!ok) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await CommerceDeskService.setProductSupport(p.sku, next);
      if (!isMounted.current) return;
      if (isRefusal(res)) {
        toast.error(deskRefusalCopy(res.error));
        return;
      }
      const withdrawn = Number(res.quotes_withdrawn ?? 0);
      toast.success(
        next
          ? 'Product Marked Supported'
          : `Product Marked Unsupported. ${
              withdrawn === 0
                ? 'No Open Quotes Were Withdrawn'
                : `${whole(withdrawn)} Open ${withdrawn === 1 ? 'Quote Was' : 'Quotes Were'} Withdrawn`
            }`
      );
      await reload();
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.toggleSupport');
      toast.error(failureText(e, 'Support Could Not Be Changed'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(false);
    }
  };

  return (
    <article className={s.card} aria-labelledby={`product-${p.sku}`}>
      <div className={s.cardHead}>
        <h3 id={`product-${p.sku}`} className={s.cardTitle}>
          {titleCase(p.title)}
        </h3>
        <span className={`${s.pill} ${p.supported ? s.ink_green : s.ink_muted}`}>
          {p.supported ? 'Supported' : 'Unsupported'}
        </span>
      </div>
      <Row label="Product" value={<Code>{p.sku}</Code>} />
      <Row label="Term" value={termText(p)} />
      <Row
        label="Counted"
        value={p.quantity_unit === 'covered_club' ? 'Per Covered Club' : 'Flat'}
      />
      {p.capacity !== null && <Row label="Capacity" value={`${whole(p.capacity)} Members`} />}
      <Row
        label="Price In Effect"
        value={
          p.price
            ? `${priceText(p.price.price_rule, p.price.diamonds, p.price.cap_diamonds)}, Version ${whole(p.price.version)}`
            : 'None'
        }
        tone={p.price ? 'silver' : 'muted'}
      />

      <p className={s.subhead}>Price Versions</p>
      {versions.length === 0 && <p className={s.empty}>No Price Versions Yet</p>}
      {versions.map((v) => (
        <VersionLine key={v.price_version_id} v={v} product={p} handles={handles} reload={reload} />
      ))}

      {drafting ? (
        <DraftForm
          p={p}
          onDone={(created) => {
            setDrafting(false);
            if (created) void reload();
          }}
        />
      ) : (
        <div className={s.actions}>
          <button
            type="button"
            className={s.action}
            disabled={busy}
            onClick={() => void toggleSupport()}
          >
            {p.supported ? 'Mark Unsupported' : 'Mark Supported'}
          </button>
          <button type="button" className={s.action} onClick={() => setDrafting(true)}>
            Draft New Price
          </button>
        </div>
      )}
    </article>
  );
}

function statusWords(v: DeskPriceVersion): string {
  if (v.status !== 'published') return PRICE_STATUS_LABEL[v.status];
  if (v.in_effect) return v.effective_to ? 'In Effect, Retiring' : 'In Effect';
  const from = v.effective_from ? Date.parse(v.effective_from) : NaN;
  if (Number.isFinite(from) && from > Date.now()) return 'Published, Scheduled';
  return 'Published, Ended';
}

function VersionLine({
  v,
  product,
  handles,
  reload,
}: {
  v: DeskPriceVersion;
  product: DeskCatalogProduct;
  handles: Record<string, string>;
  reload: () => Promise<void>;
}) {
  const by = (id: string | null) => (id && handles[id] ? handleText(handles[id]) : null);
  const drafter = by(v.created_by);
  const publisher = by(v.published_by);
  return (
    <div className={s.version}>
      <div className={s.row}>
        <span className={s.rowLabel}>
          Version {whole(v.version)} <Code>{shortId(v.price_version_id)}</Code>
        </span>
        <span
          className={`${s.rowValue} ${s[`ink_${v.in_effect ? 'green' : PRICE_TONE[v.status]}`]}`}
        >
          {statusWords(v)}
        </span>
      </div>
      <Row label="Price" value={priceText(v.price_rule, v.diamonds, v.cap_diamonds)} />
      {v.effective_from && (
        <Row
          label={
            v.in_effect || Date.parse(v.effective_from) <= Date.now() ? 'Since' : 'Takes Effect'
          }
          value={when(v.effective_from)}
        />
      )}
      {v.effective_to && (
        <Row
          label={Date.parse(v.effective_to) > Date.now() ? 'Retires' : 'Ended'}
          value={when(v.effective_to)}
          tone={Date.parse(v.effective_to) > Date.now() ? 'gold' : undefined}
        />
      )}
      <Row
        label="Drafted"
        value={
          <>
            {when(v.created_at)}
            {drafter && <>, By {drafter}</>}
          </>
        }
      />
      {v.published_at && (
        <Row
          label="Published"
          value={
            <>
              {when(v.published_at)}
              {publisher && <>, By {publisher}</>}
            </>
          }
        />
      )}
      <Row label="Comparison Verified" value={yesNo(v.comparison_verified)} />
      <Row label="Price Authority" value={titleCase(v.price_authority)} prose />
      <VersionActions v={v} product={product} reload={reload} />
    </div>
  );
}

/** The step a version's status is ready for, with the time picker. */
function VersionActions({
  v,
  product,
  reload,
}: {
  v: DeskPriceVersion;
  product: DeskCatalogProduct;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<'publish' | 'retire' | null>(null);
  const [whenChoice, setWhenChoice] = useState<WhenChoice>({ mode: 'now', local: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const title = titleCase(product.title);
  const step = nextPriceStep(v.status);
  const retireWord = v.status === 'published' ? 'Retire' : 'Withdraw';

  const run = async (kind: 'validate' | 'publish' | 'retire') => {
    if (inFlight.current) return;
    setProblem(null);
    let at: string | null = null;
    if (kind !== 'validate') {
      /* A draft or validated version is withdrawn outright; only a publication
         and the retirement of a published price take a time. */
      const timed = kind === 'publish' || v.status === 'published';
      if (timed) {
        const r = resolveWhen(whenChoice);
        if ('error' in r) {
          setProblem(r.error);
          return;
        }
        at = r.iso;
      }
      const whenWords = at ? `On ${when(at)}` : 'Now';
      const ok = await confirmDialog({
        title: kind === 'publish' ? 'Publish Price' : `${retireWord} Price`,
        message:
          kind === 'publish'
            ? `Publish Version ${whole(v.version)} Of ${title} ${whenWords}? Owners Whose Renewal Rises Are Told Before It Takes Effect.`
            : `${retireWord} Version ${whole(v.version)} Of ${title} ${whenWords}? Purchases Already Made Keep Their Price.`,
        confirmText: kind === 'publish' ? 'Publish' : retireWord,
        variant: kind === 'retire' ? 'danger' : 'default',
      });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy(kind);
    try {
      if (kind === 'validate') {
        const res = await CommerceDeskService.validatePrice(v.price_version_id);
        if (!isMounted.current) return;
        if (isRefusal(res)) return setProblem(deskRefusalCopy(res.error));
        toast.success(`Version ${whole(v.version)} Validated. Publish It Next`);
      } else if (kind === 'publish') {
        const res = await CommerceDeskService.publishPrice(v.price_version_id, at);
        if (!isMounted.current) return;
        if (isRefusal(res)) return setProblem(deskRefusalCopy(res.error));
        const notices = Number(res.price_change_notices ?? 0);
        toast.success(
          notices > 0
            ? `Price Published. ${whole(notices)} ${notices === 1 ? 'Payer Was' : 'Payers Were'} Told Of The Rise`
            : 'Price Published'
        );
      } else {
        const res = await CommerceDeskService.retirePrice(v.price_version_id, at);
        if (!isMounted.current) return;
        if (isRefusal(res)) return setProblem(deskRefusalCopy(res.error));
        toast.success(
          res.status === 'retired'
            ? `Version ${whole(v.version)} ${v.status === 'published' ? 'Retired' : 'Withdrawn'}`
            : 'Price Retirement Scheduled'
        );
      }
      setPicking(null);
      await reload();
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, `CommerceDeskPage.VersionActions.${kind}`);
      setProblem(failureText(e, 'That Change Could Not Be Saved'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(null);
    }
  };

  if (step === null) return null;

  return (
    <div className={s.versionActions}>
      {picking && (
        <WhenPicker
          value={whenChoice}
          onChange={setWhenChoice}
          nowLabel={picking === 'publish' ? 'Publish Now' : `${retireWord} Now`}
          laterLabel="At A Later Time"
          idPrefix={`${picking}-${v.price_version_id}`}
        />
      )}
      {problem && (
        <p className={s.alert} role="alert">
          {problem}
        </p>
      )}
      <div className={s.actions}>
        {picking === null ? (
          <>
            {step !== 'retire' && (
              <button
                type="button"
                className={s.dangerQuiet}
                disabled={busy !== null}
                onClick={() => void run('retire')}
              >
                {busy === 'retire' ? 'Withdrawing' : 'Withdraw'}
              </button>
            )}
            {step === 'validate' && (
              <button
                type="button"
                className={s.primary}
                disabled={busy !== null}
                onClick={() => void run('validate')}
              >
                {busy === 'validate' ? 'Validating' : 'Validate'}
              </button>
            )}
            {step === 'publish' && (
              <button
                type="button"
                className={s.primary}
                disabled={busy !== null}
                onClick={() => setPicking('publish')}
              >
                Publish
              </button>
            )}
            {step === 'retire' && (
              <button
                type="button"
                className={s.dangerQuiet}
                disabled={busy !== null}
                onClick={() => setPicking('retire')}
              >
                Retire
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className={s.action}
              disabled={busy !== null}
              onClick={() => {
                setPicking(null);
                setProblem(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={picking === 'retire' ? s.danger : s.primary}
              disabled={busy !== null}
              onClick={() => void run(picking)}
            >
              {busy === picking
                ? picking === 'publish'
                  ? 'Publishing'
                  : `${retireWord === 'Retire' ? 'Retiring' : 'Withdrawing'}`
                : picking === 'publish'
                  ? 'Confirm Publish'
                  : `Confirm ${retireWord}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function DraftForm({
  p,
  onDone,
}: {
  p: DeskCatalogProduct;
  /** true when a draft was saved (the page re-reads the versions). */
  onDone: (created: boolean) => void;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const rules = priceRulesFor(p.quantity_unit);
  const [rule, setRule] = useState<PriceRule>(
    p.price?.price_rule && rules.includes(p.price.price_rule) ? p.price.price_rule : rules[0]
  );
  const [amount, setAmount] = useState('');
  const [cap, setCap] = useState('');
  const [authority, setAuthority] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (inFlight.current) return;
    setProblem(null);
    const raw = amount.trim().replace(/,/g, '');
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      setProblem(deskRefusalCopy('zero_price_not_allowed'));
      return;
    }
    let capN: number | null = null;
    if (rule === 'per_unit_capped') {
      const c = cap.trim().replace(/,/g, '');
      if (!/^\d+$/.test(c) || Number(c) <= 0) {
        setProblem(deskRefusalCopy('cap_required'));
        return;
      }
      capN = Number(c);
      if (capN < Number(raw)) {
        setProblem(deskRefusalCopy('cap_below_unit_price'));
        return;
      }
    }
    if (authority.trim().length < 10) {
      setProblem('Name The Price Authority In At Least 10 Characters');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await CommerceDeskService.draftPrice(
        p.sku,
        Number(raw),
        rule,
        capN,
        authority.trim()
      );
      if (!isMounted.current) return;
      if (isRefusal(res)) {
        setProblem(deskRefusalCopy(res.error));
        return;
      }
      toast.success(`Version ${whole(res.version)} Drafted. Validate It Next`);
      onDone(true);
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.DraftForm.submit');
      setProblem(failureText(e, 'The Draft Could Not Be Saved'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(false);
    }
  };

  const id = `draft-${p.sku}`;
  return (
    <form
      className={s.form}
      aria-label={`Draft A New Price For ${titleCase(p.title)}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className={s.subhead}>Draft New Price</p>
      <label className={s.field} htmlFor={`${id}-rule`}>
        <span className={s.fieldLabel}>Price Rule</span>
        <select
          id={`${id}-rule`}
          className={s.input}
          value={rule}
          onChange={(e) => setRule(e.target.value as PriceRule)}
        >
          {rules.map((r) => (
            <option key={r} value={r}>
              {PRICE_RULE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      <label className={s.field} htmlFor={`${id}-amount`}>
        <span className={s.fieldLabel}>
          {rule === 'flat' ? 'Diamonds' : 'Diamonds Per Covered Club'}
        </span>
        <input
          id={`${id}-amount`}
          className={s.input}
          inputMode="numeric"
          value={amount}
          placeholder={p.price ? `In Effect: ${whole(p.price.diamonds)}` : 'Whole Diamonds'}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      {rule === 'per_unit_capped' && (
        <label className={s.field} htmlFor={`${id}-cap`}>
          <span className={s.fieldLabel}>Cap In Diamonds</span>
          <input
            id={`${id}-cap`}
            className={s.input}
            inputMode="numeric"
            value={cap}
            placeholder="Most A Union Pays In One Period"
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
      )}
      <label className={s.field} htmlFor={`${id}-authority`}>
        <span className={s.fieldLabel}>Price Authority</span>
        <textarea
          id={`${id}-authority`}
          className={s.textarea}
          rows={2}
          value={authority}
          placeholder="The Decision Or Document That Sets This Price"
          onChange={(e) => setAuthority(e.target.value)}
        />
      </label>
      {problem && (
        <p className={s.alert} role="alert">
          {problem}
        </p>
      )}
      <div className={s.actions}>
        <button type="button" className={s.action} disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="submit" className={s.primary} disabled={busy}>
          {busy ? 'Saving Draft' : 'Save Draft'}
        </button>
      </div>
    </form>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. COMPARISON EVIDENCE
   ═══════════════════════════════════════════════════════════════════════════ */

/** Versions evidence can name or verify for a product: not retired, newest first. */
function versionChoicesFor(sku: string, versions: DeskPriceVersion[], verifiable = false) {
  return versions
    .filter(
      (v) =>
        v.sku === sku &&
        (verifiable ? v.status === 'validated' || v.status === 'published' : v.status !== 'retired')
    )
    .map((v) => ({
      id: v.price_version_id,
      label: `Version ${whole(v.version)}, ${v.in_effect ? 'In Effect' : PRICE_STATUS_LABEL[v.status]}`,
    }));
}

function EvidencePanel({
  me,
  handles,
  catalog,
  versions,
  catalogError,
  reloadCatalog,
  evidence,
  evidenceError,
  reloadEvidence,
}: {
  me: string | null;
  handles: Record<string, string>;
  catalog: DeskCatalog | null;
  versions: DeskPriceVersion[] | null;
  catalogError: string | null;
  reloadCatalog: () => Promise<void>;
  evidence: DeskEvidence[] | null;
  evidenceError: string | null;
  reloadEvidence: () => Promise<void>;
}) {
  const [filter, setFilter] = useState('');

  if (catalogError && !catalog) {
    return (
      <section className={s.section}>
        <p className={s.alert} role="alert">
          {catalogError}
        </p>
        <button type="button" className={s.action} onClick={() => void reloadCatalog()}>
          Try Again
        </button>
      </section>
    );
  }
  if (!catalog || versions === null) return <LoadingState message="Reading The Catalog" />;

  const products = catalog.products;
  const shown = (evidence ?? []).filter((x) => !filter || x.sku === filter);
  const groups = products
    .map((p) => ({ p, rows: shown.filter((x) => x.sku === p.sku) }))
    .filter((g) => g.rows.length > 0);
  const refresh = async () => {
    await Promise.all([reloadEvidence(), reloadCatalog()]);
  };

  return (
    <>
      <RecordEvidenceForm products={products} versions={versions} onRecorded={reloadEvidence} />

      <section className={s.section} aria-labelledby="desk-ev-list">
        <div className={s.sectionHead}>
          <h2 id="desk-ev-list" className={s.sectionTitle}>
            Recorded Evidence
          </h2>
          <button type="button" className={s.link} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <p className={s.copy}>
          A Price Shows Comparison Verified Only When A Second Staff Member Verifies Evidence For
          It. The Staff Member Who Recorded Evidence Cannot Verify It.
        </p>
        <label className={s.field} htmlFor="ev-filter">
          <span className={s.fieldLabel}>Product</span>
          <select
            id="ev-filter"
            className={s.input}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">All Products</option>
            {products.map((p) => (
              <option key={p.sku} value={p.sku}>
                {titleCase(p.title)}
                {p.scope_kind === 'union' ? ' (Union)' : ''}
              </option>
            ))}
          </select>
        </label>
        {evidenceError && (
          <p className={s.alert} role="alert">
            {evidenceError}
          </p>
        )}
        {evidence === null && <LoadingState message="Reading The Evidence" />}
        {evidence !== null && groups.length === 0 && !evidenceError && (
          <p className={s.empty}>No Evidence Recorded Yet</p>
        )}
      </section>

      {groups.map((g) => (
        <section key={g.p.sku} className={s.section} aria-label={titleCase(g.p.title)}>
          <h2 className={s.sectionTitle}>{titleCase(g.p.title)}</h2>
          <div className={s.cardGrid}>
            {g.rows.map((x) => (
              <EvidenceCard
                key={x.evidence_id}
                x={x}
                me={me}
                handles={handles}
                versions={versions}
                onVerified={refresh}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function RecordEvidenceForm({
  products,
  versions,
  onRecorded,
}: {
  products: DeskCatalogProduct[];
  versions: DeskPriceVersion[];
  onRecorded: () => Promise<void>;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const [sku, setSku] = useState(products[0]?.sku ?? '');
  const product = products.find((p) => p.sku === sku) ?? null;
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState('');
  const [observed, setObserved] = useState(localDateValue(new Date()));
  const [conversion, setConversion] = useState('');
  const choices = useMemo(() => versionChoicesFor(sku, versions), [sku, versions]);
  const [versionId, setVersionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!sku && products.length) setSku(products[0].sku);
  }, [products, sku]);
  useEffect(() => {
    setVersionId(choices[0]?.id ?? '');
  }, [choices]);

  const record = async () => {
    if (inFlight.current || !product) return;
    setProblem(null);
    const name = sourceName.trim();
    const url = sourceUrl.trim();
    const p = Number(price.trim().replace(/,/g, ''));
    const u = unit.trim();
    const note = conversion.trim();
    if (name.length < 2 || name.length > 120)
      return setProblem(deskRefusalCopy('source_name_required'));
    if (!/^https:\/\/\S{4,}$/.test(url) || url.length > 1000)
      return setProblem(deskRefusalCopy('invalid_source_url'));
    if (!Number.isFinite(p) || p <= 0) return setProblem(deskRefusalCopy('invalid_observed_price'));
    if (u.length < 2 || u.length > 120)
      return setProblem(deskRefusalCopy('observed_unit_required'));
    const at = new Date(`${observed}T00:00:00`);
    if (!observed || Number.isNaN(at.getTime()) || at.getTime() > Date.now())
      return setProblem(deskRefusalCopy('invalid_observed_at'));
    if (note.length < 10 || note.length > 2000)
      return setProblem(deskRefusalCopy('conversion_note_required'));

    inFlight.current = true;
    setBusy(true);
    try {
      const res = await CommerceDeskService.recordComparison({
        sku: product.sku,
        sourceName: name,
        sourceUrl: url,
        observedPrice: p,
        observedUnit: u,
        observedAt: at.toISOString(),
        conversionNote: note,
        priceVersionId: versionId || null,
      });
      if (!isMounted.current) return;
      if (isRefusal(res)) return setProblem(deskRefusalCopy(res.error));
      toast.success('Evidence Recorded. A Second Staff Member Verifies It');
      setSourceName('');
      setSourceUrl('');
      setPrice('');
      setUnit('');
      setConversion('');
      await onRecorded();
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.Evidence.record');
      setProblem(failureText(e, 'The Evidence Could Not Be Recorded'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(false);
    }
  };

  return (
    <section className={s.section} aria-labelledby="desk-record-title">
      <h2 id="desk-record-title" className={s.sectionTitle}>
        Record Competitor Evidence
      </h2>
      <p className={s.copy}>
        Nothing Is Marked Automatically. Record What A Competitor Charges, And A Colleague Verifies
        It Against A Validated Or Published Price.
      </p>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void record();
        }}
      >
        <label className={s.field} htmlFor="ev-sku">
          <span className={s.fieldLabel}>Product</span>
          <select
            id="ev-sku"
            className={s.input}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
          >
            {products.map((p) => (
              <option key={p.sku} value={p.sku}>
                {titleCase(p.title)}
                {p.scope_kind === 'union' ? ' (Union)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className={s.field} htmlFor="ev-version">
          <span className={s.fieldLabel}>Price Version It Supports</span>
          <select
            id="ev-version"
            className={s.input}
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
          >
            {choices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
            <option value="">None Yet</option>
          </select>
        </label>
        <label className={s.field} htmlFor="ev-source">
          <span className={s.fieldLabel}>Source Name</span>
          <input
            id="ev-source"
            className={s.input}
            maxLength={120}
            value={sourceName}
            placeholder="Competitor Or Publication"
            onChange={(e) => setSourceName(e.target.value)}
          />
        </label>
        <label className={s.field} htmlFor="ev-url">
          <span className={s.fieldLabel}>Source Link</span>
          <input
            id="ev-url"
            className={s.input}
            type="url"
            inputMode="url"
            maxLength={1000}
            value={sourceUrl}
            placeholder="Https Address Of The Page"
            onChange={(e) => setSourceUrl(e.target.value)}
          />
        </label>
        <div className={s.pair}>
          <label className={s.field} htmlFor="ev-price">
            <span className={s.fieldLabel}>Observed Price</span>
            <input
              id="ev-price"
              className={s.input}
              inputMode="decimal"
              value={price}
              placeholder="As Listed"
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
          <label className={s.field} htmlFor="ev-date">
            <span className={s.fieldLabel}>Observed On</span>
            <input
              id="ev-date"
              className={s.input}
              type="date"
              max={localDateValue(new Date())}
              value={observed}
              onChange={(e) => setObserved(e.target.value)}
            />
          </label>
        </div>
        <label className={s.field} htmlFor="ev-unit">
          <span className={s.fieldLabel}>What That Price Buys</span>
          <input
            id="ev-unit"
            className={s.input}
            maxLength={120}
            value={unit}
            placeholder="For Example, One Club For 30 Days"
            onChange={(e) => setUnit(e.target.value)}
          />
        </label>
        <label className={s.field} htmlFor="ev-note">
          <span className={s.fieldLabel}>Conversion Note</span>
          <textarea
            id="ev-note"
            className={s.textarea}
            rows={3}
            maxLength={2000}
            value={conversion}
            placeholder="How The Observed Price Converts To Diamonds"
            onChange={(e) => setConversion(e.target.value)}
          />
        </label>
        {problem && (
          <p className={s.alert} role="alert">
            {problem}
          </p>
        )}
        <div className={s.actions}>
          <button type="submit" className={s.primary} disabled={busy || !product}>
            {busy ? 'Recording' : 'Record Evidence'}
          </button>
        </div>
      </form>
    </section>
  );
}

function EvidenceCard({
  x,
  me,
  handles,
  versions,
  onVerified,
}: {
  x: DeskEvidence;
  me: string | null;
  handles: Record<string, string>;
  versions: DeskPriceVersion[];
  onVerified: () => Promise<void>;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choices = useMemo(() => versionChoicesFor(x.sku, versions, true), [x.sku, versions]);
  const inEffect = versions.find((v) => v.sku === x.sku && v.in_effect)?.price_version_id;
  const [target, setTarget] = useState(
    choices.some((c) => c.id === x.price_version_id)
      ? (x.price_version_id as string)
      : (inEffect ?? choices[0]?.id ?? '')
  );
  const mine = !!me && me === x.recorded_by;
  const named = versions.find((v) => v.price_version_id === x.price_version_id);
  const person = (name: string | null, id: string | null) => {
    const handle = (id && handles[id]) || name;
    return handle ? handleText(handle) : id ? <Code>{shortId(id)}</Code> : 'Unknown';
  };

  const verify = async () => {
    if (inFlight.current) return;
    setProblem(null);
    if (!target) return setProblem(deskRefusalCopy('price_version_not_current'));
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await CommerceDeskService.verifyComparison(x.evidence_id, target);
      if (!isMounted.current) return;
      if (isRefusal(res)) return setProblem(deskRefusalCopy(res.error));
      toast.success(res.is_replay ? 'Evidence Was Already Verified' : 'Comparison Verified');
      await onVerified();
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.Evidence.verify');
      setProblem(failureText(e, 'The Evidence Could Not Be Verified'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(false);
    }
  };

  return (
    <article className={s.card} aria-labelledby={`ev-${x.evidence_id}`}>
      <div className={s.cardHead}>
        <h3 id={`ev-${x.evidence_id}`} className={s.cardTitle}>
          {titleCase(x.source_name)}
        </h3>
        <span className={`${s.pill} ${x.verified ? s.ink_green : s.ink_blue}`}>
          {x.verified ? 'Verified' : 'Awaiting Verification'}
        </span>
      </div>
      <Row label="Source Link" value={<span className={s.url}>{x.source_url}</span>} prose />
      <Row
        label="Observed"
        value={`${Number(x.observed_price).toLocaleString()} For ${titleCase(x.observed_unit)}`}
      />
      <Row label="Observed On" value={day(x.observed_at)} />
      <Row label="Conversion Note" value={titleCase(x.conversion_note)} prose />
      <Row
        label="Supports"
        value={
          named
            ? `Version ${whole(named.version)}`
            : x.price_version_id
              ? 'A Retired Version'
              : 'None Yet'
        }
      />
      <Row
        label="Recorded"
        value={
          <>
            {when(x.recorded_at)}, By {person(x.recorded_by_name, x.recorded_by)}
          </>
        }
      />
      {x.verified ? (
        <Row
          label="Verified"
          value={
            <>
              {when(x.verified_at)}, By {person(x.verified_by_name, x.verified_by)}
            </>
          }
          tone="green"
        />
      ) : mine ? (
        <p className={s.notice}>{deskRefusalCopy('second_staff_member_required')}.</p>
      ) : (
        <div className={s.decide}>
          {choices.length > 0 ? (
            <label className={s.field} htmlFor={`ev-${x.evidence_id}-target`}>
              <span className={s.fieldLabel}>Verify Against</span>
              <select
                id={`ev-${x.evidence_id}-target`}
                className={s.input}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className={s.hint}>
              This Product Has No Validated Or Published Price To Verify Against Yet.
            </p>
          )}
          {problem && (
            <p className={s.alert} role="alert">
              {problem}
            </p>
          )}
          <div className={s.actions}>
            <button
              type="button"
              className={s.primary}
              disabled={busy || choices.length === 0}
              onClick={() => void verify()}
            >
              {busy ? 'Verifying' : 'Verify'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. ADMISSION (the shadow report)
   ═══════════════════════════════════════════════════════════════════════════ */

const ADMISSION_WINDOWS = [7, 30, 90] as const;

function AdmissionPanel() {
  const isMounted = useIsMounted();
  const [days, setDays] = useState<(typeof ADMISSION_WINDOWS)[number]>(30);
  const [report, setReport] = useState<AdmissionReport | null>(null);
  const [names, setNames] = useState<DeskNames>({ people: {}, clubs: {}, unions: {} });
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (window: number) => {
      const mine = ++seq.current;
      setReport(null);
      setError(null);
      try {
        const res = await CommerceDeskService.admissionReport(window);
        if (!isMounted.current || mine !== seq.current) return;
        if (isRefusal(res)) {
          setError(deskRefusalCopy(res.error, 'The Admission Report Could Not Be Read'));
          return;
        }
        const rep: AdmissionReport = {
          ...res,
          doors: Array.isArray(res.doors) ? res.doors : [],
          scopes: Array.isArray(res.scopes) ? res.scopes : [],
        };
        setReport(rep);
        // Names only; the report itself is ids and counts.
        const n = await lookupScopeNames(rep.scopes);
        if (!isMounted.current || mine !== seq.current) return;
        setNames(n);
      } catch (e) {
        if (!isMounted.current || mine !== seq.current) return;
        reportUnexpected(e, 'CommerceDeskPage.AdmissionPanel.load');
        setError(failureText(e, 'The Admission Report Could Not Be Read'));
      }
    },
    [isMounted]
  );

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const totals = useMemo(() => {
    const doors = report?.doors ?? [];
    return {
      decisions: doors.reduce((a, d) => a + Number(d.decisions || 0), 0),
      wouldDeny: doors.reduce((a, d) => a + Number(d.would_deny || 0), 0),
      refused: doors.reduce((a, d) => a + Number(d.refused || 0), 0),
    };
  }, [report]);

  return (
    <>
      <section className={s.section} aria-labelledby="desk-admission-title">
        <div className={s.sectionHead}>
          <h2 id="desk-admission-title" className={s.sectionTitle}>
            Admission
          </h2>
          <button type="button" className={s.link} onClick={() => void load(days)}>
            Refresh
          </button>
        </div>
        <p className={s.copy}>
          Every New Member, New Table, New Tournament And Insurance Offer Asks Whether The Club Has
          Operating Access. In Shadow Nothing Is Refused: The Answer Is Recorded So You Can See What
          Enforcement Would Refuse Before It Is Switched On. Existing Members, Running Games And
          Payouts Are Never Checked.
        </p>
        <div className={s.chips} role="radiogroup" aria-label="Report Window">
          {ADMISSION_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={days === w}
              className={`${s.chip} ${days === w ? s.chipOn : ''}`}
              onClick={() => setDays(w)}
            >
              Last {w} Days
            </button>
          ))}
        </div>
        {error && (
          <p className={s.alert} role="alert">
            {error}
          </p>
        )}
        {!error && report === null && <LoadingState message="Reading The Admission Report" />}
        {report && (
          <>
            <Row
              label="Enforcement"
              value={
                report.enforced
                  ? `On Since ${when(report.enforced_from)}`
                  : report.enforced_from
                    ? `Scheduled For ${when(report.enforced_from)}`
                    : 'Off. Admission Runs In Shadow'
              }
              tone={report.enforced ? 'gold' : 'blue'}
            />
            <Row label="Decisions Recorded" value={whole(totals.decisions)} />
            <Row
              label="Would Be Refused"
              value={whole(totals.wouldDeny)}
              tone={totals.wouldDeny ? 'gold' : 'green'}
            />
            <Row
              label="Refused"
              value={whole(totals.refused)}
              tone={totals.refused ? 'red' : 'muted'}
            />
          </>
        )}
      </section>

      {report && (
        <section className={s.section} aria-labelledby="desk-admission-doors">
          <h2 id="desk-admission-doors" className={s.sectionTitle}>
            By Door
          </h2>
          {report.doors.length === 0 ? (
            <p className={s.empty}>No Admission Decisions In The Last {whole(report.days)} Days</p>
          ) : (
            <div className={s.cardGrid}>
              {report.doors.map((d) => (
                <article
                  key={`${d.action}:${d.door}`}
                  className={s.card}
                  aria-label={admissionWords(ADMISSION_DOOR_LABEL, d.door)}
                >
                  <div className={s.cardHead}>
                    <h3 className={s.cardTitle}>{admissionWords(ADMISSION_DOOR_LABEL, d.door)}</h3>
                    <span className={`${s.pill} ${s[d.would_deny ? 'ink_gold' : 'ink_green']}`}>
                      {d.would_deny ? `${whole(d.would_deny)} Would Refuse` : 'All Allowed'}
                    </span>
                  </div>
                  <Row label="Checks" value={admissionWords(ADMISSION_ACTION_LABEL, d.action)} />
                  <Row label="Decisions" value={whole(d.decisions)} />
                  <Row label="Would Be Refused" value={whole(d.would_deny)} />
                  <Row label="Clubs Or Unions Affected" value={whole(d.scopes_would_deny)} />
                  {d.refused > 0 && <Row label="Refused" value={whole(d.refused)} tone="red" />}
                  {d.undecided > 0 && (
                    <Row label="Decision Unavailable" value={whole(d.undecided)} tone="muted" />
                  )}
                  <Row label="Last Decision" value={when(d.last_at)} />
                  <Row label="Door" value={<Code>{d.door}</Code>} />
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {report && (
        <section className={s.section} aria-labelledby="desk-admission-scopes">
          <h2 id="desk-admission-scopes" className={s.sectionTitle}>
            Clubs And Unions Enforcement Would Refuse
          </h2>
          {report.scopes.length === 0 ? (
            <p className={s.empty}>None In The Last {whole(report.days)} Days</p>
          ) : (
            <div className={s.cardGrid}>
              {report.scopes.map((x) => {
                const name =
                  x.scope_kind === 'club' ? names.clubs[x.scope_id] : names.unions[x.scope_id];
                const kind = x.scope_kind === 'club' ? 'Club' : 'Union';
                return (
                  <article
                    key={`${x.scope_kind}:${x.scope_id}`}
                    className={s.card}
                    aria-label={name ? titleCase(name) : `${kind} ${shortId(x.scope_id)}`}
                  >
                    <div className={s.cardHead}>
                      <h3 className={s.cardTitle}>
                        {name ? (
                          `${titleCase(name)} (${kind})`
                        ) : (
                          <>
                            {kind} <Code>{shortId(x.scope_id)}</Code>
                          </>
                        )}
                      </h3>
                      <span className={`${s.pill} ${s.ink_gold}`}>
                        {whole(x.would_deny)} Would Refuse
                      </span>
                    </div>
                    <Row
                      label="Why"
                      value={(x.reasons ?? [])
                        .map((r) => admissionWords(ADMISSION_REASON_LABEL, r))
                        .join(', ')}
                      prose
                    />
                    {x.refused > 0 && <Row label="Refused" value={whole(x.refused)} tone="red" />}
                    <Row label="Last Decision" value={when(x.last_at)} />
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. WRITTEN QUOTES (above 2,500 members, 20260924182605)
   ═══════════════════════════════════════════════════════════════════════════ */

const WRITTEN_TONE: Record<WrittenQuoteState, Tone> = {
  requested: 'blue',
  offered: 'gold',
  accepted: 'green',
  expired: 'muted',
  declined: 'muted',
  withdrawn: 'muted',
};

const REVIEW_TONE: Record<TrialReviewState, Tone> = {
  requested: 'blue',
  approved: 'green',
  declined: 'muted',
};

const EMPTY_NAMES: DeskNames = { people: {}, clubs: {}, unions: {} };

/** A whole number typed with or without thousands separators, or null. */
function parseWhole(raw: string): number | null {
  const t = raw.trim().replace(/,/g, '');
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

const EM_DASH = String.fromCharCode(0x2014);

/** A staff note the server will accept, or the reason it would not. */
function noteProblem(note: string): string | null {
  if (note.length > WRITTEN_QUOTE_LIMITS.maxNote) return deskRefusalCopy('note_too_long');
  if (note.includes(EM_DASH)) return 'A Note Cannot Contain An Em Dash. Use A Comma Or A Full Stop';
  return null;
}

/** A person's handle from the lookup, or their short id. */
function handleOf(id: string | null, names: DeskNames): React.ReactNode {
  if (!id) return 'Unknown';
  return personName(id, names);
}

/** Club names and poker handles for a queue. Best effort, never blocking. */
async function lookupQueueNames(
  scopes: ReadonlyArray<{ scope_kind: ScopeKind; scope_id: string }>,
  people: ReadonlyArray<string | null>
): Promise<DeskNames> {
  const [n, h] = await Promise.all([lookupScopeNames(scopes), lookupHandles(people)]);
  return { ...n, people: h };
}

function WrittenQuotesPanel() {
  const isMounted = useIsMounted();
  const [list, setList] = useState<WrittenQuote[] | null>(null);
  const [names, setNames] = useState<DeskNames>(EMPTY_NAMES);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setList(null);
    setError(null);
    try {
      const res = await CommerceDeskService.writtenQuotes();
      if (!isMounted.current || mine !== seq.current) return;
      if (isRefusal(res)) {
        setError(deskRefusalCopy(res.error, 'The Written Quotes Could Not Be Read'));
        setList([]);
        return;
      }
      const rows = Array.isArray(res.written_quotes) ? res.written_quotes : [];
      setList(rows);
      const n = await lookupQueueNames(
        rows,
        rows.flatMap((w) => [w.requested_by, w.decided_by])
      );
      if (!isMounted.current || mine !== seq.current) return;
      setNames(n);
    } catch (e) {
      if (!isMounted.current || mine !== seq.current) return;
      reportUnexpected(e, 'CommerceDeskPage.WrittenQuotes.load');
      setError(failureText(e, 'The Written Quotes Could Not Be Read'));
      setList([]);
    }
  }, [isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = useCallback((w: WrittenQuote) => {
    setList((prev) => (prev ?? []).map((x) => (x.written_quote_id === w.written_quote_id ? w : x)));
  }, []);

  // Open requests first (the server's order too), then newest first.
  const ordered = useMemo(
    () =>
      [...(list ?? [])].sort(
        (a, b) =>
          Number(b.state === 'requested') - Number(a.state === 'requested') ||
          String(b.created_at).localeCompare(String(a.created_at))
      ),
    [list]
  );
  const open = ordered.filter((w) => w.state === 'requested').length;

  return (
    <section className={s.section} aria-labelledby="desk-written-title">
      <div className={s.sectionHead}>
        <h2 id="desk-written-title" className={s.sectionTitle}>
          Written Quotes
        </h2>
        <button type="button" className={s.link} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className={s.copy}>
        Above 2,500 Approved Members A Club Owner Asks For A Written Quote. Offer A Tested Capacity
        And A Whole Diamond Price For 30 Days, Valid For 1 To 30 Days, Or Decline With A Note. The
        Offer Is A Private Product For That Club Only, And The Owner Is Told Either Way.
      </p>
      {list && !error && (
        <Row label="Awaiting An Answer" value={whole(open)} tone={open ? 'gold' : 'muted'} />
      )}
      {error && (
        <p className={s.alert} role="alert">
          {error}
        </p>
      )}
      {list === null && <LoadingState message="Reading Written Quotes" />}
      {list !== null && list.length === 0 && !error && (
        <p className={s.empty}>No Written Quote Requests Yet</p>
      )}
      {ordered.length > 0 && (
        <div className={s.cardGrid}>
          {ordered.map((w) => (
            <WrittenQuoteCard key={w.written_quote_id} w={w} names={names} onChanged={replace} />
          ))}
        </div>
      )}
    </section>
  );
}

function WrittenQuoteCard({
  w,
  names,
  onChanged,
}: {
  w: WrittenQuote;
  names: DeskNames;
  onChanged: (w: WrittenQuote) => void;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<'offer' | 'decline' | null>(null);
  const [capacity, setCapacity] = useState(
    /* Printed as the owner asked it, grouped; parseWhole reads the commas. */
    w.requested_capacity == null ? '' : Number(w.requested_capacity).toLocaleString('en-US')
  );
  const [price, setPrice] = useState('');
  const [days, setDays] = useState(String(WRITTEN_QUOTE_LIMITS.defaultValidDays));
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const open = w.state === 'requested';
  const where = scopeText(w.scope_kind, w.scope_id, names);
  const idp = `wq-${w.written_quote_id}`;

  const settle = (res: { written_quote?: WrittenQuote } | null | undefined) => {
    if (res?.written_quote) onChanged(res.written_quote);
  };

  const offer = async () => {
    if (inFlight.current) return;
    setProblem(null);
    const cap = parseWhole(capacity);
    if (
      cap === null ||
      cap <= WRITTEN_QUOTE_LIMITS.minCapacityExclusive ||
      cap > WRITTEN_QUOTE_LIMITS.maxCapacity
    )
      return setProblem(deskRefusalCopy('written_quote_capacity_out_of_range'));
    const dia = parseWhole(price);
    if (dia === null || dia <= 0 || dia > WRITTEN_QUOTE_LIMITS.maxDiamonds)
      return setProblem(
        `Enter A Whole Diamond Price From 1 To ${whole(WRITTEN_QUOTE_LIMITS.maxDiamonds)}`
      );
    const valid = parseWhole(days);
    if (
      valid === null ||
      valid < WRITTEN_QUOTE_LIMITS.minValidDays ||
      valid > WRITTEN_QUOTE_LIMITS.maxValidDays
    )
      return setProblem(deskRefusalCopy('written_quote_validity_out_of_range'));
    const text = note.trim();
    const bad = noteProblem(text);
    if (bad) return setProblem(bad);
    const ok = await confirmDialog({
      title: 'Offer Written Quote',
      message: `Offer ${where} Up To ${whole(cap)} Approved Members For ${diamonds(dia)} For 30 Days, Valid For ${whole(valid)} ${valid === 1 ? 'Day' : 'Days'}? The Owner Is Told Now.`,
      confirmText: 'Offer',
    });
    if (!ok) return;
    inFlight.current = true;
    setBusy('offer');
    try {
      const res = await CommerceDeskService.offerWrittenQuote(
        w.written_quote_id,
        cap,
        dia,
        valid,
        text || null
      );
      if (!isMounted.current) return;
      if (isRefusal(res)) {
        setProblem(deskRefusalCopy(res.error));
        settle(res as { written_quote?: WrittenQuote });
        return;
      }
      settle(res);
      toast.success(`Written Quote Offered: ${diamonds(dia)}`);
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.WrittenQuote.offer');
      setProblem(failureText(e, 'The Offer Could Not Be Saved'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(null);
    }
  };

  const decline = async () => {
    if (inFlight.current) return;
    setProblem(null);
    const text = note.trim();
    if (!text) return setProblem(deskRefusalCopy('note_required'));
    const bad = noteProblem(text);
    if (bad) return setProblem(bad);
    const ok = await confirmDialog({
      title: 'Decline Written Quote',
      message: `Decline The Request From ${where} For ${whole(w.requested_capacity)} Members? The Owner Reads Your Note.`,
      confirmText: 'Decline',
      variant: 'danger',
    });
    if (!ok) return;
    inFlight.current = true;
    setBusy('decline');
    try {
      const res = await CommerceDeskService.declineWrittenQuote(w.written_quote_id, text);
      if (!isMounted.current) return;
      if (isRefusal(res)) {
        setProblem(deskRefusalCopy(res.error));
        settle(res as { written_quote?: WrittenQuote });
        return;
      }
      settle(res);
      toast.success('Written Quote Declined');
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.WrittenQuote.decline');
      setProblem(failureText(e, 'The Decline Could Not Be Saved'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(null);
    }
  };

  const priced = w.offered_diamonds !== null && w.offered_capacity !== null;

  return (
    <article className={s.card} aria-labelledby={idp}>
      <div className={s.cardHead}>
        <h3 id={idp} className={s.cardTitle}>
          {whole(w.requested_capacity)} Members For {scopeTitle(w.scope_kind, w.scope_id, names)}
        </h3>
        <span className={`${s.pill} ${s[`ink_${WRITTEN_TONE[w.state] ?? 'muted'}`]}`}>
          {WRITTEN_QUOTE_STATE_LABEL[w.state] ?? titleCase(String(w.state))}
        </span>
      </div>
      <Row label="Requested" value={when(w.created_at)} />
      <Row label="Requested By" value={handleOf(w.requested_by, names)} />
      <Row label="Capacity Asked" value={`${whole(w.requested_capacity)} Approved Members`} />
      {w.request_note && <Row label="Owner's Note" value={titleCase(w.request_note)} prose />}

      {!open && (
        <>
          <p className={s.subhead}>Answer</p>
          {priced && (
            <>
              <Row
                label="Offered Capacity"
                value={`${whole(w.offered_capacity)} Approved Members`}
              />
              <Row
                label="Price"
                value={`${diamonds(w.offered_diamonds)} For 30 Days`}
                tone="silver"
              />
              <Row
                label={w.state === 'expired' ? 'Expired' : 'Valid Until'}
                value={when(w.valid_until)}
                tone={w.state === 'expired' ? 'muted' : undefined}
              />
            </>
          )}
          <Row
            label={
              w.state === 'withdrawn'
                ? 'Withdrawn By The Owner'
                : w.state === 'declined'
                  ? 'Declined'
                  : 'Offered'
            }
            value={when(w.decided_at)}
          />
          {w.state !== 'withdrawn' && w.decided_by && (
            <Row label="Answered By" value={handleOf(w.decided_by, names)} />
          )}
          {w.state === 'accepted' && (
            <Row label="Bought" value="The Club Holds This Capacity" tone="green" />
          )}
          {w.staff_note && <Row label="Staff Note" value={titleCase(w.staff_note)} prose />}
          {w.sku && <Row label="Private Product" value={<Code>{w.sku}</Code>} prose />}
        </>
      )}

      {open && (
        <div className={s.decide}>
          <div className={s.pair}>
            <label className={s.field} htmlFor={`${idp}-capacity`}>
              <span className={s.fieldLabel}>Capacity To Offer</span>
              <input
                id={`${idp}-capacity`}
                className={s.input}
                inputMode="numeric"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </label>
            <label className={s.field} htmlFor={`${idp}-price`}>
              <span className={s.fieldLabel}>Diamonds For 30 Days</span>
              <input
                id={`${idp}-price`}
                className={s.input}
                inputMode="numeric"
                value={price}
                placeholder="Whole Diamonds"
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
          </div>
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor={`${idp}-days`}>
              Valid For (Days)
            </label>
            <input
              id={`${idp}-days`}
              className={s.input}
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-describedby={`${idp}-days-hint`}
            />
            <span id={`${idp}-days-hint`} className={s.hint}>
              1 To 30 Days. The Owner Can Buy The Offer Until Then.
            </span>
          </div>
          <label className={s.field} htmlFor={`${idp}-note`}>
            <span className={s.fieldLabel}>Note To The Owner</span>
            <textarea
              id={`${idp}-note`}
              className={s.textarea}
              rows={2}
              maxLength={WRITTEN_QUOTE_LIMITS.maxNote}
              value={note}
              placeholder="Optional With An Offer, Required To Decline"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {problem && (
            <p className={s.alert} role="alert">
              {problem}
            </p>
          )}
          <div className={s.actions}>
            <button
              type="button"
              className={s.danger}
              disabled={busy !== null}
              onClick={() => void decline()}
            >
              {busy === 'decline' ? 'Declining' : 'Decline'}
            </button>
            <button
              type="button"
              className={s.primary}
              disabled={busy !== null}
              onClick={() => void offer()}
            >
              {busy === 'offer' ? 'Offering' : 'Offer'}
            </button>
          </div>
        </div>
      )}
      {!open && problem && (
        <p className={s.alert} role="alert">
          {problem}
        </p>
      )}
    </article>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. FREE MONTH REVIEWS (20260924182605)
   ═══════════════════════════════════════════════════════════════════════════ */

function TrialReviewsPanel({ me }: { me: string | null }) {
  const isMounted = useIsMounted();
  const [list, setList] = useState<TrialReview[] | null>(null);
  const [names, setNames] = useState<DeskNames>(EMPTY_NAMES);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setList(null);
    setError(null);
    try {
      const res = await CommerceDeskService.trialReviews();
      if (!isMounted.current || mine !== seq.current) return;
      if (isRefusal(res)) {
        setError(deskRefusalCopy(res.error, 'The Free Month Reviews Could Not Be Read'));
        setList([]);
        return;
      }
      const rows = Array.isArray(res.reviews) ? res.reviews : [];
      setList(rows);
      const n = await lookupQueueNames(
        rows,
        rows.flatMap((r) => [r.operator_id, r.requested_by, r.decided_by])
      );
      if (!isMounted.current || mine !== seq.current) return;
      setNames(n);
    } catch (e) {
      if (!isMounted.current || mine !== seq.current) return;
      reportUnexpected(e, 'CommerceDeskPage.TrialReviews.load');
      setError(failureText(e, 'The Free Month Reviews Could Not Be Read'));
      setList([]);
    }
  }, [isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = useCallback((r: TrialReview) => {
    setList((prev) => (prev ?? []).map((x) => (x.review_id === r.review_id ? r : x)));
  }, []);

  const ordered = useMemo(
    () =>
      [...(list ?? [])].sort(
        (a, b) =>
          Number(b.state === 'requested') - Number(a.state === 'requested') ||
          String(b.created_at).localeCompare(String(a.created_at))
      ),
    [list]
  );
  const open = ordered.filter((r) => r.state === 'requested').length;

  return (
    <section className={s.section} aria-labelledby="desk-reviews-title">
      <div className={s.sectionHead}>
        <h2 id="desk-reviews-title" className={s.sectionTitle}>
          Free Month Reviews
        </h2>
        <button type="button" className={s.link} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className={s.copy}>
        Later Clubs Of One Operator Share The End Of The First Free Month That Operator Got. When An
        Owner Says A Club Is A Genuinely New, Independent Operation, Approve A Fresh 30 Day Free
        Month For That One Club Or Union, Or Decline With A Note. Each Club Or Union Is Granted At
        Most Once.
      </p>
      {list && !error && (
        <Row label="Awaiting A Decision" value={whole(open)} tone={open ? 'gold' : 'muted'} />
      )}
      {error && (
        <p className={s.alert} role="alert">
          {error}
        </p>
      )}
      {list === null && <LoadingState message="Reading Free Month Reviews" />}
      {list !== null && list.length === 0 && !error && (
        <p className={s.empty}>No Free Month Reviews Yet</p>
      )}
      {ordered.length > 0 && (
        <div className={s.cardGrid}>
          {ordered.map((r) => (
            <TrialReviewCard key={r.review_id} r={r} me={me} names={names} onDecided={replace} />
          ))}
        </div>
      )}
    </section>
  );
}

function TrialReviewCard({
  r,
  me,
  names,
  onDecided,
}: {
  r: TrialReview;
  me: string | null;
  names: DeskNames;
  onDecided: (r: TrialReview) => void;
}) {
  const toast = useToast();
  const isMounted = useIsMounted();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const open = r.state === 'requested';
  const own = !!me && me === r.operator_id;
  const where = scopeText(r.scope_kind, r.scope_id, names);
  const idp = `review-${r.review_id}`;

  const decide = async (approve: boolean) => {
    if (inFlight.current) return;
    setProblem(null);
    const text = note.trim();
    if (!approve && !text) return setProblem(deskRefusalCopy('note_required'));
    const bad = noteProblem(text);
    if (bad) return setProblem(bad);
    const ok = await confirmDialog(
      approve
        ? {
            title: 'Approve Free Month',
            message: `Grant ${where} A Fresh 30 Day Free Month Starting Now? The Owner Is Told Now And Gets The Usual Reminders.`,
            confirmText: 'Approve',
          }
        : {
            title: 'Decline Free Month',
            message: `Decline The Free Month Review For ${where}? The Owner Reads Your Note.`,
            confirmText: 'Decline',
            variant: 'danger',
          }
    );
    if (!ok) return;
    inFlight.current = true;
    setBusy(approve ? 'approve' : 'decline');
    try {
      const res = await CommerceDeskService.decideTrialReview(r.review_id, approve, text || null);
      if (!isMounted.current) return;
      if (isRefusal(res)) {
        setProblem(deskRefusalCopy(res.error));
        const current = (res as { review?: TrialReview }).review;
        if (current) onDecided(current);
        return;
      }
      onDecided(res.review);
      toast.success(
        approve
          ? `Free Month Approved Until ${when(res.review.granted_trial_end)}`
          : 'Free Month Review Declined'
      );
    } catch (e) {
      if (!isMounted.current) return;
      reportUnexpected(e, 'CommerceDeskPage.TrialReview.decide');
      setProblem(failureText(e, 'The Decision Could Not Be Saved'));
    } finally {
      inFlight.current = false;
      if (isMounted.current) setBusy(null);
    }
  };

  return (
    <article className={s.card} aria-labelledby={idp}>
      <div className={s.cardHead}>
        <h3 id={idp} className={s.cardTitle}>
          Free Month For {scopeTitle(r.scope_kind, r.scope_id, names)}
        </h3>
        <span className={`${s.pill} ${s[`ink_${REVIEW_TONE[r.state] ?? 'muted'}`]}`}>
          {TRIAL_REVIEW_STATE_LABEL[r.state] ?? titleCase(String(r.state))}
        </span>
      </div>
      <Row label="Requested" value={when(r.created_at)} />
      <Row label="Operator" value={handleOf(r.operator_id, names)} />
      {r.requested_by !== r.operator_id && (
        <Row label="Requested By" value={handleOf(r.requested_by, names)} />
      )}
      <Row label="Owner's Statement" value={titleCase(r.statement)} prose />

      {!open && (
        <>
          <p className={s.subhead}>Decision</p>
          <Row
            label={r.state === 'approved' ? 'Approved' : 'Declined'}
            value={when(r.decided_at)}
          />
          {r.decided_by && <Row label="Decided By" value={handleOf(r.decided_by, names)} />}
          {r.state === 'approved' && (
            <Row label="Free Month Ends" value={when(r.granted_trial_end)} tone="green" />
          )}
          {r.staff_note && <Row label="Staff Note" value={titleCase(r.staff_note)} prose />}
        </>
      )}

      {open && own && <p className={s.notice}>{deskRefusalCopy('own_request')}.</p>}

      {open && !own && (
        <div className={s.decide}>
          <label className={s.field} htmlFor={`${idp}-note`}>
            <span className={s.fieldLabel}>Note To The Owner</span>
            <textarea
              id={`${idp}-note`}
              className={s.textarea}
              rows={2}
              maxLength={WRITTEN_QUOTE_LIMITS.maxNote}
              value={note}
              placeholder="Optional To Approve, Required To Decline"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {problem && (
            <p className={s.alert} role="alert">
              {problem}
            </p>
          )}
          <div className={s.actions}>
            <button
              type="button"
              className={s.danger}
              disabled={busy !== null}
              onClick={() => void decide(false)}
            >
              {busy === 'decline' ? 'Declining' : 'Decline'}
            </button>
            <button
              type="button"
              className={s.primary}
              disabled={busy !== null}
              onClick={() => void decide(true)}
            >
              {busy === 'approve' ? 'Approving' : 'Approve'}
            </button>
          </div>
        </div>
      )}
      {!(open && !own) && problem && (
        <p className={s.alert} role="alert">
          {problem}
        </p>
      )}
    </article>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. METRICS (R2 7.5, 20260924183529)
   ═══════════════════════════════════════════════════════════════════════════ */

const METRIC_WINDOWS = [7, 30, 90] as const;

/** An age in whole hours: hours under two days, whole days after. */
function age(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return 'None';
  const h = Math.max(0, Math.trunc(Number(hours)));
  if (h < 48) return `${whole(h)} ${h === 1 ? 'Hour' : 'Hours'}`;
  const d = Math.floor(h / 24);
  return `${whole(d)} Days`;
}

const count = (n: number | null | undefined, one: string, many: string) =>
  `${whole(n)} ${Number(n) === 1 ? one : many}`;

function MetricCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className={s.card} aria-label={title}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{title}</h3>
      </div>
      {children}
    </article>
  );
}

function MetricsPanel() {
  const isMounted = useIsMounted();
  const [days, setDays] = useState<(typeof METRIC_WINDOWS)[number]>(30);
  const [m, setM] = useState<CommerceMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (window: number) => {
      const mine = ++seq.current;
      setM(null);
      setError(null);
      try {
        const res = await CommerceDeskService.metrics(window);
        if (!isMounted.current || mine !== seq.current) return;
        if (isRefusal(res)) {
          setError(deskRefusalCopy(res.error, 'The Metrics Could Not Be Read'));
          return;
        }
        setM(res);
      } catch (e) {
        if (!isMounted.current || mine !== seq.current) return;
        reportUnexpected(e, 'CommerceDeskPage.MetricsPanel.load');
        setError(failureText(e, 'The Metrics Could Not Be Read'));
      }
    },
    [isMounted]
  );

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const p = m?.purchases;
  const rr = m?.refund_requests;
  const sp = m?.sponsorships;
  const used =
    sp && sp.budget_diamonds > 0
      ? `${whole(Math.round((sp.committed_diamonds * 100) / sp.budget_diamonds))}%`
      : 'None';
  const failures = m ? Number(m.postconditions.renewal) + Number(m.postconditions.refund) : 0;

  return (
    <>
      <section className={s.section} aria-labelledby="desk-metrics-title">
        <div className={s.sectionHead}>
          <h2 id="desk-metrics-title" className={s.sectionTitle}>
            Metrics
          </h2>
          <button type="button" className={s.link} onClick={() => void load(days)}>
            Refresh
          </button>
        </div>
        <p className={s.copy}>
          What The Commerce Records Say. Net Paid Diamonds Count Only Receipts That Charged, Kept
          Apart From Proposed Quotes, Free Month Waivers, Refunds, Retries And Replays. Counts Are
          For The Window; Queues And Ages Are As Of Now.
        </p>
        <div className={s.chips} role="radiogroup" aria-label="Metrics Window">
          {METRIC_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={days === w}
              className={`${s.chip} ${days === w ? s.chipOn : ''}`}
              onClick={() => setDays(w)}
            >
              Last {w} Days
            </button>
          ))}
        </div>
        {error && (
          <p className={s.alert} role="alert">
            {error}
          </p>
        )}
        {!error && m === null && <LoadingState message="Reading The Metrics" />}
        {m && p && (
          <>
            <Row label="Net Paid Diamonds" value={diamonds(p.net_paid_diamonds)} tone="silver" />
            <Row label="As Of" value={when(m.as_of)} />
            <Row
              label="Accounting Postcondition Failures"
              value={whole(failures)}
              tone={failures ? 'red' : 'green'}
            />
          </>
        )}
      </section>

      {m && p && rr && sp && (
        <section className={s.section} aria-label="Measures">
          <div className={s.cardGrid}>
            <MetricCard title="Payments">
              <Row label="Receipts Committed" value={whole(p.committed)} />
              <Row label="Receipts That Charged" value={whole(p.paid)} />
              <Row label="Net Paid" value={diamonds(p.net_paid_diamonds)} tone="silver" />
              <Row label="Zero Net Receipts" value={whole(p.zero_net)} />
              <Row
                label="Purchases"
                value={`${whole(p.by_kind.purchase.committed)} For ${diamonds(p.by_kind.purchase.net_paid_diamonds)}`}
              />
              <Row
                label="Upgrades"
                value={`${whole(p.by_kind.upgrade.committed)} For ${diamonds(p.by_kind.upgrade.net_paid_diamonds)}`}
              />
              <Row
                label="Renewals"
                value={`${whole(p.by_kind.renewal.committed)} For ${diamonds(p.by_kind.renewal.net_paid_diamonds)}`}
              />
              <Row label="Paid By Sponsors" value={diamonds(p.sponsored_net_diamonds)} />
              <Row label="Waived On Receipts" value={diamonds(p.trial_waiver_diamonds)} />
            </MetricCard>

            <MetricCard title="Quotes">
              <Row label="Priced" value={whole(m.quotes.priced)} />
              <Row
                label="Proposed, Not Paid"
                value={diamonds(m.quotes.proposed_diamonds)}
                tone="muted"
              />
              <Row label="Bought" value={whole(m.quotes.consumed)} />
              <Row label="Still Open" value={whole(m.quotes.open)} />
              <Row label="Expired" value={whole(m.quotes.expired)} />
              <Row label="Withdrawn" value={whole(m.quotes.withdrawn)} />
            </MetricCard>

            <MetricCard title="Free Months">
              <Row label="Clubs And Unions Granted" value={whole(m.trial_waivers.scopes)} />
              <Row label="Free Months" value={whole(m.trial_waivers.trials)} />
              <Row
                label="Diamonds Charged"
                value={diamonds(m.trial_waivers.net_paid_diamonds)}
                tone="muted"
              />
            </MetricCard>

            <MetricCard title="Refunds">
              <Row label="Refunds Committed" value={whole(m.refunds.committed)} />
              <Row label="Returned" value={diamonds(m.refunds.gross_diamonds)} tone="silver" />
              <Row
                label="Applied To Existing Debt"
                value={diamonds(m.refunds.debt_settled_diamonds)}
              />
              <Row
                label="Added To Available Balance"
                value={diamonds(m.refunds.added_to_balance_diamonds)}
              />
              <Row
                label="Awaiting A Decision"
                value={whole(rr.awaiting_decision)}
                tone={rr.awaiting_decision ? 'gold' : undefined}
              />
              <Row
                label="Oldest Awaiting A Decision"
                value={age(rr.oldest_awaiting_decision_hours)}
              />
              <Row
                label="Approved, Not Yet Returned"
                value={`${whole(rr.awaiting_execution)} For ${diamonds(rr.awaiting_execution_diamonds)}`}
                tone={rr.awaiting_execution ? 'gold' : undefined}
              />
              <Row
                label="Oldest Not Yet Returned"
                value={age(rr.oldest_awaiting_execution_hours)}
              />
              {REFUND_STATES.map((k) => (
                <Row
                  key={k}
                  label={`${REFUND_STATE_LABEL[k]} Requests`}
                  value={whole(rr.by_state?.[k])}
                />
              ))}
            </MetricCard>

            <MetricCard title="Renewals">
              <Row label="Authorized" value={whole(m.renewals.authorized)} />
              <Row
                label="Due Now"
                value={whole(m.renewals.due_now)}
                tone={m.renewals.due_now ? 'gold' : undefined}
              />
              <Row label="Oldest Overdue" value={age(m.renewals.oldest_overdue_hours)} />
              <Row
                label="Needing Attention"
                value={whole(m.renewals.needs_attention)}
                tone={m.renewals.needs_attention ? 'gold' : undefined}
              />
              <Row label="Renewed In The Window" value={whole(m.renewals.renewed)} />
              <Row label="Not Completed In The Window" value={whole(m.renewals.not_completed)} />
            </MetricCard>

            <MetricCard title="Sponsorships">
              <Row label="Active" value={whole(sp.active)} />
              <Row label="Budget" value={diamonds(sp.budget_diamonds)} />
              <Row label="Committed" value={diamonds(sp.committed_diamonds)} tone="silver" />
              <Row label="Used" value={used} />
            </MetricCard>

            <MetricCard title="Notices">
              <Row
                label="Due, Not Delivered"
                value={whole(m.notices.undelivered_due)}
                tone={m.notices.undelivered_due ? 'gold' : undefined}
              />
              <Row label="Oldest Undelivered" value={age(m.notices.oldest_undelivered_hours)} />
              <Row label="Scheduled" value={whole(m.notices.scheduled)} />
              <Row label="Suppressed In The Window" value={whole(m.notices.suppressed)} />
            </MetricCard>

            <MetricCard title="Replays, Retries And Failures">
              <Row
                label="Refund Executions Answered As Replays"
                value={whole(m.duplicates.refund_execution_replays)}
              />
              <Row
                label="Renewal Debits Refused As Repeats"
                value={whole(m.duplicates.renewal_debit_reference_reused)}
              />
              <Row
                label="Purchase Replays"
                value={
                  m.duplicates.purchase_replays_recorded
                    ? 'Recorded'
                    : 'Answered From The Receipt, Not Recorded'
                }
                tone="muted"
              />
              <Row
                label="Refund Execution Retries"
                value={whole(m.retries.refund_execution_retries)}
              />
              <Row label="Renewal Claim Retries" value={whole(m.retries.renewal_claim_retries)} />
              <Row
                label="Renewal Postcondition Failures"
                value={count(m.postconditions.renewal, 'Failure', 'Failures')}
                tone={m.postconditions.renewal ? 'red' : undefined}
              />
              <Row
                label="Refund Postcondition Failures"
                value={count(m.postconditions.refund, 'Failure', 'Failures')}
                tone={m.postconditions.refund ? 'red' : undefined}
              />
              <Row
                label="Owner Purchase Failures"
                value={
                  m.postconditions.purchase_failures_recorded
                    ? 'Recorded'
                    : 'Rolled Back Whole, Not Recorded'
                }
                tone="muted"
              />
            </MetricCard>
          </div>
        </section>
      )}
    </>
  );
}
