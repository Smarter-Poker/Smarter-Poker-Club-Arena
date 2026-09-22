/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB AND UNION DIAMOND COSTS - the operator's commerce console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), Phase 7. One page for a club
 * or a union: the operating trial and its exact local end, the paid rights
 * and their renewal authorizations, the published diamond prices, a server
 * quote with every step of the arithmetic printed (gross, credit, net, the
 * exact period), one confirmed order, the receipt, and the receipts already
 * on file. A union owner also keeps its sponsorship budgets here.
 *
 * NOTHING IS DECIDED HERE. Every amount on this page came from the server;
 * the browser sends a selection and an order key. A green state appears only
 * after the authoritative receipt. A retry uses the SAME order key, and a
 * replayed receipt reads "Original Charge: N; Charged On This Retry: 0",
 * never "free". Prices carry no comparison claim until one is verified.
 *
 * THE PICTURE (#ClubArenaConsole): spade consoles, rows printed on the glass,
 * plates for the two actions. Nothing is drawn.
 *
 * Routes: /clubs/:clubId/diamond-costs (finance access in the operations
 * registry) and /unions/:unionId/diamond-costs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { ErrorState, LoadingState } from '../../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../../components/console/SpadeConsole';
import ClubCommerceService, {
  refusalCopy,
  type Catalog,
  type CatalogProduct,
  type Entitlement,
  type Quote,
  type Receipt,
  type Refusal,
  type ScopeKind,
  type ScopeStatus,
} from '../../services/ClubCommerceService';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { uuid } from '../../utils/uuid';
import { useIsMounted } from '../../hooks/useIsMounted';
import styles from '../diamondGames.module.css';

const diamonds = (n: number | null | undefined) => `${Number(n ?? 0).toLocaleString()} Diamonds`;
const nominal = (n: number | null | undefined) => `$${(Number(n ?? 0) / 100).toFixed(2)}`;

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

function periodWord(p: CatalogProduct): string {
  if (p.term_kind === 'period') return `${Math.round((p.term_hours ?? 0) / 24)} Days`;
  if (p.term_kind === 'report_interval') return `${p.report_days ?? 0} Day Interval`;
  return 'Permanent';
}

function priceWord(p: CatalogProduct): string {
  if (!p.price) return 'No Published Price';
  const base = `${p.price.diamonds.toLocaleString()} Diamonds`;
  if (p.price.price_rule === 'per_unit') return `${base} Per Covered Club`;
  if (p.price.price_rule === 'per_unit_capped')
    return `${base} Per Covered Club, Up To ${(p.price.cap_diamonds ?? 0).toLocaleString()}`;
  return base;
}

function Row({
  label,
  value,
  ink = 'silver',
  meta,
}: {
  label: string;
  value: string;
  ink?: ConsoleInk;
  meta?: string;
}) {
  return (
    <div className={styles.row}>
      <span className={`sc-label sc-ink--blue ${styles.rowLabel}`}>
        {label}
        {meta ? <span className={`${styles.rowMeta} sc-ink--muted`}>{meta}</span> : null}
      </span>
      <span className={`${styles.rowValue} sc-ink--${ink}`}>{value}</span>
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
  return (
    <button
      type="button"
      className={styles.rowButton}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
    >
      <span className={`sc-label sc-ink--silver ${styles.rowLabel}`}>
        {label}
        <span className={`${styles.rowMeta} sc-ink--muted`}>{meta}</span>
      </span>
      <span className={`${styles.rowValue} sc-ink--${ink}`}>{value}</span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
  mode = 'numeric',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  mode?: 'decimal' | 'numeric' | 'text';
}) {
  return (
    <label className={styles.field}>
      <span className="sc-label sc-ink--blue">{label}</span>
      <input
        className={styles.fieldInput}
        inputMode={mode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span className="sc-copy sc-ink--muted">{hint}</span> : null}
    </label>
  );
}

function entitlementTitle(e: Entitlement, catalog: Catalog | null): string {
  if (e.kind === 'trial_operating') return 'Free Operating Month';
  const p = catalog?.products.find((x) => x.sku === e.sku);
  if (p) return e.quantity > 1 ? `${p.title} For ${e.quantity} Covered Clubs` : p.title;
  return e.sku ?? e.kind;
}

export default function ClubDiamondCostsPage({ scopeKind }: { scopeKind: ScopeKind }) {
  const params = useParams<{ clubId?: string; unionId?: string }>();
  const routeId = scopeKind === 'club' ? params.clubId : params.unionId;
  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [scopeId, setScopeId] = useState<string | null>(null);
  const [status, setStatus] = useState<ScopeStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [purchaseKind, setPurchaseKind] = useState<'purchase' | 'upgrade'>('purchase');
  const [renewOn, setRenewOn] = useState(false);
  const [renewMax, setRenewMax] = useState('');
  const [sponsorshipId, setSponsorshipId] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [recovering, setRecovering] = useState(false);
  /* ONE ORDER KEY PER QUOTE, kept for the life of this page. A retry after a
     timeout sends the same key and reads the same receipt (R2 3.3). */
  const orderKeys = useRef<Map<string, string>>(new Map());

  const [renewSku, setRenewSku] = useState('');
  const [renewAuthMax, setRenewAuthMax] = useState('');
  const [budget, setBudget] = useState('');
  const [perClub, setPerClub] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (id: string) => {
      try {
        const [s, c, r] = await Promise.all([
          ClubCommerceService.scopeStatus(scopeKind, id),
          ClubCommerceService.catalog(scopeKind),
          ClubCommerceService.receipts(scopeKind, id),
        ]);
        if (!isMountedRef.current) return;
        if (!s.success) {
          setError(refusalCopy(s.error, 'This Page Could Not Be Read'));
          return;
        }
        setStatus(s);
        setCatalog(c);
        setReceipts(r);
        setError(null);
      } catch (e) {
        reportError(e, 'ClubDiamondCostsPage.load');
        if (isMountedRef.current) setError('The Diamond Costs Could Not Be Read');
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    },
    [isMountedRef, scopeKind]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!routeId) return;
      const id = scopeKind === 'club' ? await resolveClubUUID(routeId) : routeId;
      if (cancelled) return;
      if (!id) {
        setError('This Club Was Not Found');
        setLoading(false);
        return;
      }
      setScopeId(id);
      await load(id);
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, scopeKind, load]);

  const products = useMemo(
    () => (catalog?.products ?? []).filter((p) => p.scope_kind === scopeKind),
    [catalog, scopeKind]
  );
  const isOwner = status?.role === 'owner';
  const trial = status?.trial ?? null;
  const rights = status?.entitlements ?? [];
  const activeCapacity = rights.find((e) => e.kind === 'capacity' && e.active) ?? null;
  const selected = products.find((p) => p.sku === selectedSku) ?? null;

  const chooseProduct = (p: CatalogProduct) => {
    setSelectedSku(p.sku);
    setQuote(null);
    setReceipt(null);
    setPurchaseKind(
      p.kind === 'capacity' && activeCapacity && activeCapacity.sku !== p.sku
        ? 'upgrade'
        : 'purchase'
    );
  };

  const getQuote = async () => {
    if (!scopeId || !selected) return toast.error('Choose A Service First');
    const qty = selected.quantity_unit === 'covered_club' ? Number(quantity) : 1;
    if (!Number.isInteger(qty) || qty < 1)
      return toast.error('Enter A Whole Number Of Covered Clubs');
    const max = renewOn ? Number(renewMax) : null;
    if (renewOn && (!Number.isInteger(max) || (max ?? -1) < 0))
      return toast.error('Set A Whole Number Maximum For Renewals');
    setQuoting(true);
    setReceipt(null);
    try {
      const q = await ClubCommerceService.quote(
        scopeKind,
        scopeId,
        [{ sku: selected.sku, quantity: qty }],
        {
          sponsorshipId,
          renewalMaxDiamonds: max,
          purchaseKind,
        }
      );
      if (!isMountedRef.current) return;
      if (!q.success) {
        setQuote(null);
        toast.error(refusalCopy((q as Refusal).error, 'The Quote Was Refused'));
        return;
      }
      const quoteRow = q as Quote;
      if (!orderKeys.current.has(quoteRow.quote_id))
        orderKeys.current.set(quoteRow.quote_id, uuid());
      setQuote(quoteRow);
    } catch (e) {
      reportError(e, 'ClubDiamondCostsPage.quote');
      toast.error('The Quote Could Not Be Read');
    } finally {
      if (isMountedRef.current) setQuoting(false);
    }
  };

  const confirm = async () => {
    if (!quote || !scopeId) return;
    const key = orderKeys.current.get(quote.quote_id);
    if (!key) return toast.error('This Quote Needs A Fresh Order Key. Get A New Quote');
    setPaying(true);
    try {
      const r = await ClubCommerceService.purchase(quote.quote_id, key, quote.purchase_kind);
      if (!isMountedRef.current) return;
      if (!r.success) {
        const code = (r as Refusal).error;
        toast.error(refusalCopy(code, 'The Order Was Refused'));
        if ((r as Refusal).requote) setQuote(null);
        return;
      }
      setReceipt(r as Receipt);
      setQuote(null);
      toast.success(
        (r as Receipt).is_replay
          ? 'This Order Was Already Completed. No New Charge'
          : `Paid ${Number((r as Receipt).charged_this_attempt).toLocaleString()} Diamonds`
      );
      await load(scopeId);
    } catch (e) {
      /* An unknown outcome is not a second attempt with a new key. Read what
         is on file for this scope; the same key is kept for the retry. */
      reportError(e, 'ClubDiamondCostsPage.purchase');
      setRecovering(true);
      try {
        const onFile = await ClubCommerceService.receipts(scopeKind, scopeId);
        if (!isMountedRef.current) return;
        setReceipts(onFile);
        const found = onFile.find((x) => x.quote_id === quote.quote_id);
        if (found) {
          setReceipt({ ...found, is_replay: true, charged_this_attempt: 0 });
          setQuote(null);
          toast.info('Your Order Was Found On File. No New Charge');
          await load(scopeId);
        } else {
          toast.error('The Order Outcome Is Unknown. Retry Sends The Same Order Key');
        }
      } finally {
        if (isMountedRef.current) setRecovering(false);
      }
    } finally {
      if (isMountedRef.current) setPaying(false);
    }
  };

  const activate = async () => {
    if (!scopeId) return;
    setBusy(true);
    try {
      const r = await ClubCommerceService.activateTrial(scopeKind, scopeId);
      if (!isMountedRef.current) return;
      if (!r.success) return toast.error(refusalCopy(r.error, 'The Trial Could Not Start'));
      toast.success(
        r.replay ? 'Your Free Month Is Already Running' : 'Your Free Operating Month Has Started'
      );
      await load(scopeId);
    } catch (e) {
      reportError(e, 'ClubDiamondCostsPage.activate');
      toast.error('The Trial Could Not Start');
    } finally {
      if (isMountedRef.current) setBusy(false);
    }
  };

  const setRenewal = async (
    e: Entitlement,
    enabled: boolean,
    max: number | null,
    sku: string | null
  ) => {
    if (!scopeId) return;
    setBusy(true);
    try {
      const r = await ClubCommerceService.setRenewal(e.id, enabled, max, sku, null);
      if (!isMountedRef.current) return;
      if (!r.success) return toast.error(refusalCopy(r.error, 'The Renewal Could Not Be Changed'));
      toast.success(
        enabled ? 'Renewal Authorized' : 'Renewal Cancelled. Current Paid Access Is Unchanged'
      );
      await load(scopeId);
    } catch (err) {
      reportError(err, 'ClubDiamondCostsPage.setRenewal');
      toast.error('The Renewal Could Not Be Changed');
    } finally {
      if (isMountedRef.current) setBusy(false);
    }
  };

  const saveSponsorship = async (revokeId?: string) => {
    if (!scopeId) return;
    const total = Number(budget);
    if (!revokeId && (!Number.isInteger(total) || total <= 0))
      return toast.error('Enter A Whole Number Budget In Diamonds');
    const per = perClub.trim() === '' ? null : Number(perClub);
    if (!revokeId && per !== null && (!Number.isInteger(per) || per <= 0))
      return toast.error('The Per Club Allowance Must Be A Whole Number');
    setBusy(true);
    try {
      const r = await ClubCommerceService.setSponsorship(
        scopeId,
        revokeId
          ? { sponsorshipId: revokeId, revoke: true }
          : { totalBudget: total, perClubBudget: per }
      );
      if (!isMountedRef.current) return;
      if (!r.success)
        return toast.error(refusalCopy(r.error, 'The Sponsorship Could Not Be Saved'));
      toast.success(
        revokeId ? 'Sponsorship Revoked For Future Purchases' : 'Sponsorship Budget Recorded'
      );
      setBudget('');
      setPerClub('');
      await load(scopeId);
    } catch (e) {
      reportError(e, 'ClubDiamondCostsPage.sponsorship');
      toast.error('The Sponsorship Could Not Be Saved');
    } finally {
      if (isMountedRef.current) setBusy(false);
    }
  };

  if (loading && !status) return <LoadingState message="Reading Diamond Costs" />;
  if (error || !status) {
    return (
      <div className={styles.page}>
        <ErrorState
          message={error ?? 'The Diamond Costs Could Not Be Read'}
          onRetry={() => scopeId && void load(scopeId)}
        />
      </div>
    );
  }

  const scopeWord = scopeKind === 'union' ? 'Union' : 'Club';
  const backPath =
    scopeKind === 'club' ? `/clubs/${routeId}/operations` : `/unions/${routeId}/operations`;
  const trialActive = Boolean(trial?.active);
  const accessPill = trialActive
    ? 'Free Month'
    : activeCapacity
      ? 'Paid'
      : rights.some((r) => r.active)
        ? 'Paid'
        : 'No Access';
  const accessInk: ConsoleInk = trialActive ? 'blue' : activeCapacity ? 'green' : 'gold';
  const orderKey = quote ? orderKeys.current.get(quote.quote_id) : undefined;

  return (
    <div className={styles.page}>
      <button type="button" className={styles.back} onClick={() => navigate(backPath)}>
        ‹ Operations
      </button>

      <SpadeConsole
        eyebrow={`${scopeWord} Operations`}
        title="Club And Union Diamond Costs"
        titleId="diamond-costs-title"
        pill={accessPill}
        pillInk={accessInk}
        plates={
          !trial && isOwner
            ? {
                primary: {
                  label: busy ? 'Starting' : 'Start Free Month',
                  ink: 'white',
                  onClick: () => void activate(),
                  disabled: busy,
                },
              }
            : undefined
        }
        foot={!trial && isOwner ? 'plates' : 'foot'}
      >
        <div className={styles.rows}>
          <Row
            label="Your Role"
            value={status.role === 'owner' ? 'Owner And Payer' : 'Read Only'}
            ink="silver"
          />
          {trial ? (
            <Row
              label={trialActive ? 'Trial Ends' : 'Trial Ended'}
              value={when(trial.trial_end)}
              ink={trialActive ? 'blue' : 'muted'}
              meta="All Included Operating Software, No Service Fees. Chip Funding, Prizes And Player Purchases Are Unchanged."
            />
          ) : (
            <Row
              label="Free Operating Month"
              value="Not Started"
              ink="gold"
              meta="Thirty Days Of Every Included Operating Service, Fee Free."
            />
          )}
          {scopeKind === 'club' ? (
            <Row
              label="Approved Members"
              value={(status.roster_count ?? 0).toLocaleString()}
              meta="Each Approved Account Counted Once"
            />
          ) : (
            <Row
              label="Covered Clubs"
              value={(status.covered_club_count ?? 0).toLocaleString()}
              meta="Affiliated Clubs In This Union"
            />
          )}
          {status.balance !== null ? (
            <Row
              label="Available Diamonds"
              value={Number(status.balance).toLocaleString()}
              ink="silver"
            />
          ) : null}
        </div>
        <p className="sc-copy">
          One Diamond Has A Nominal Catalog Value Of One Cent. Operating Access Expires With Its
          Period; Purchased Diamonds Do Not.
        </p>
      </SpadeConsole>

      <SpadeConsole eyebrow="Rights" title="Paid Access" foot="foot">
        <div className={styles.rows}>
          {rights.length === 0 ? <Row label="No Rights On File" value="" /> : null}
          {rights.map((e) => {
            const period = e.ends_at
              ? `${when(e.starts_at)} To ${when(e.ends_at)}`
              : `From ${when(e.starts_at)}`;
            const state = e.active ? 'Active' : e.scheduled ? 'Scheduled' : 'Expired';
            const r = e.renewal;
            const renewWord = !r
              ? 'No Renewal'
              : r.state === 'authorized'
                ? `Renews At Up To ${r.max_diamonds.toLocaleString()}`
                : r.state === 'needs_attention'
                  ? 'Renewal Not Completed'
                  : r.state === 'completed'
                    ? 'Renewed'
                    : 'Renewal Cancelled';
            return (
              <div key={e.id}>
                <Row
                  label={entitlementTitle(e, catalog)}
                  value={state}
                  ink={e.active ? 'green' : e.scheduled ? 'blue' : 'muted'}
                  meta={`${period}. ${e.source === 'trial' ? 'No Charge.' : e.source === 'sponsor' ? 'Paid By Your Union Sponsor.' : `Paid ${e.net_paid.toLocaleString()} Diamonds.`} ${renewWord}.`}
                />
                {isOwner && e.source === 'purchase' && e.ends_at && (e.active || e.scheduled) ? (
                  r && r.state === 'authorized' ? (
                    <ChoiceRow
                      label="Cancel Renewal"
                      meta="Stops The Next Charge. Your Current Paid Period Is Unchanged."
                      value="Cancel"
                      ink="red"
                      disabled={busy}
                      onClick={() => void setRenewal(e, false, null, null)}
                    />
                  ) : (
                    <div className={styles.fields}>
                      <Field
                        label="Authorize Renewal Up To (Diamonds)"
                        value={renewAuthMax}
                        onChange={setRenewAuthMax}
                        hint="The Next Period Is Charged At Its Due Time Only If The Published Price Is At Or Below This Ceiling."
                      />
                      <ChoiceRow
                        label="Authorize Renewal"
                        meta="Optional. You Can Cancel Any Time Before The Due Time."
                        value="Authorize"
                        ink="green"
                        disabled={busy}
                        onClick={() => void setRenewal(e, true, Number(renewAuthMax), null)}
                      />
                    </div>
                  )
                ) : null}
                {isOwner && e.kind === 'trial_operating' && trialActive ? (
                  r && r.state === 'authorized' ? (
                    <ChoiceRow
                      label="Cancel Post-Trial Authorization"
                      meta="Nothing Will Be Charged When The Free Month Ends."
                      value="Cancel"
                      ink="red"
                      disabled={busy}
                      onClick={() => void setRenewal(e, false, null, null)}
                    />
                  ) : (
                    <div className={styles.fields}>
                      <label className={styles.field}>
                        <span className="sc-label sc-ink--blue">
                          Service To Start When The Free Month Ends
                        </span>
                        <select
                          className={styles.fieldInput}
                          value={renewSku}
                          onChange={(ev) => setRenewSku(ev.target.value)}
                        >
                          <option value="">Choose A Service</option>
                          {products
                            .filter((p) => p.supported && p.price && p.term_kind === 'period')
                            .map((p) => (
                              <option key={p.sku} value={p.sku}>
                                {p.title}: {priceWord(p)}
                              </option>
                            ))}
                        </select>
                      </label>
                      <Field
                        label="Authorize Up To (Diamonds)"
                        value={renewAuthMax}
                        onChange={setRenewAuthMax}
                        hint="Charged Once, At The Trial End, Only If The Published Price Is At Or Below This Ceiling. Nothing Is Charged Before Then."
                      />
                      <ChoiceRow
                        label="Authorize First Paid Period"
                        meta="Your Diamonds Are Not Touched Until The Free Month Ends."
                        value="Authorize"
                        ink="green"
                        disabled={busy || !renewSku}
                        onClick={() => void setRenewal(e, true, Number(renewAuthMax), renewSku)}
                      />
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="Catalog"
        title="Diamond Prices"
        pill={catalog ? catalog.catalog_version.replace('catalog:', 'V ') : undefined}
        pillInk="muted"
        plates={
          isOwner
            ? {
                primary: {
                  label: quoting ? 'Quoting' : 'Get A Quote',
                  ink: 'white',
                  onClick: () => void getQuote(),
                  disabled: quoting || !selected || !status.checkout_enabled,
                },
              }
            : undefined
        }
        foot={isOwner ? 'plates' : 'foot'}
      >
        <div className={styles.rows}>
          {products.map((p) => (
            <ChoiceRow
              key={p.sku}
              label={p.title}
              meta={`${periodWord(p)}. ${p.included_note}${p.supported ? '' : ' Not Yet Available.'}`}
              value={p.supported ? priceWord(p) : 'Not Yet Available'}
              ink={selectedSku === p.sku ? 'blue' : p.supported ? 'silver' : 'muted'}
              pressed={selectedSku === p.sku}
              disabled={!p.supported || !isOwner}
              onClick={() => chooseProduct(p)}
            />
          ))}
        </div>
        {selected && selected.quantity_unit === 'covered_club' ? (
          <div className={styles.fields}>
            <Field
              label="Covered Clubs"
              value={quantity}
              onChange={setQuantity}
              hint="Name The Clubs This Purchase Covers; Affiliation Alone Never Charges."
            />
          </div>
        ) : null}
        {selected && !trialActive ? (
          <div className={styles.fields}>
            <ChoiceRow
              label="Renew Automatically"
              meta="Optional. Authorizes The Next Period In Diamonds At Or Below Your Ceiling."
              value={renewOn ? 'On' : 'Off'}
              ink={renewOn ? 'green' : 'muted'}
              onClick={() => setRenewOn((v) => !v)}
            />
            {renewOn ? (
              <Field label="Renewal Ceiling (Diamonds)" value={renewMax} onChange={setRenewMax} />
            ) : null}
          </div>
        ) : null}
        {scopeKind === 'club' && (status.sponsorships ?? []).length > 0 ? (
          <div className={styles.rows}>
            {status.sponsorships.map((s) => (
              <ChoiceRow
                key={s.id}
                label="Pay With Union Sponsorship"
                meta={`${(s.remaining ?? 0).toLocaleString()} Diamonds Remaining. Only The Sponsor Can Confirm A Sponsored Order.`}
                value={sponsorshipId === s.id ? 'Selected' : 'Select'}
                ink={sponsorshipId === s.id ? 'blue' : 'silver'}
                onClick={() => setSponsorshipId((v) => (v === s.id ? null : s.id))}
              />
            ))}
          </div>
        ) : null}
        <p className="sc-copy">
          Prices Are Whole Diamonds Per Stated Term. No Per Hand, Per Table Hour Or Per Transfer
          Charge. Displayed Club Levels Are Not Purchased Capacity.
        </p>
      </SpadeConsole>

      {quote ? (
        <SpadeConsole
          eyebrow="Quote"
          title="Confirm Your Order"
          pill={`Expires ${new Date(quote.expires_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
          pillInk="gold"
          plates={{
            secondary: { label: 'Discard', onClick: () => setQuote(null), disabled: paying },
            primary: {
              label: paying ? 'Confirming' : `Pay ${quote.net.toLocaleString()}`,
              ink: 'white',
              onClick: () => void confirm(),
              disabled: paying || !orderKey,
            },
          }}
        >
          <div className={styles.rows}>
            {quote.lines.map((l) => (
              <Row
                key={l.index}
                label={l.title}
                value={diamonds(l.net)}
                meta={`${when(l.starts_at)} To ${when(l.ends_at)}. Gross ${l.gross.toLocaleString()}${l.credit ? `, Unused Value Credit ${l.credit.toLocaleString()}` : ''}${l.waiver ? `, Trial Waiver ${l.waiver.toLocaleString()}` : ''}.`}
              />
            ))}
            <Row
              label="Total"
              value={diamonds(quote.net)}
              ink="gold"
              meta={`Nominal ${nominal(quote.nominal_cents)}. Payer: ${quote.sponsorship_id ? 'Union Sponsor' : 'You'}.`}
            />
            <Row
              label="Available"
              value={Number(quote.available_balance).toLocaleString()}
              ink={quote.available_balance >= quote.net ? 'green' : 'red'}
              meta={
                quote.available_balance >= quote.net
                  ? 'Enough Available Diamonds'
                  : `${(quote.net - quote.available_balance).toLocaleString()} More Diamonds Needed`
              }
            />
            {quote.renewal_max_diamonds !== null ? (
              <Row
                label="Renewal"
                value={`Up To ${quote.renewal_max_diamonds.toLocaleString()}`}
                ink="blue"
                meta="Authorized For The Following Period"
              />
            ) : null}
          </div>
          <p className="sc-copy">
            Confirming Charges Your Diamonds Once. If The Connection Drops, Retrying Sends The Same
            Order Key And Never Charges Twice. Refunds Follow The Displayed Policy And Return To The
            Original Payer.
          </p>
        </SpadeConsole>
      ) : null}

      {receipt ? (
        <SpadeConsole
          eyebrow="Receipt"
          title="Order Complete"
          pill={receipt.is_replay ? 'On File' : 'Paid'}
          pillInk="green"
          foot="foot"
        >
          <div className={styles.rows}>
            <Row
              label="Original Charge"
              value={diamonds(receipt.original_total_diamonds)}
              ink="gold"
            />
            <Row
              label="Charged On This Attempt"
              value={diamonds(receipt.charged_this_attempt)}
              ink={receipt.charged_this_attempt ? 'green' : 'muted'}
            />
            {receipt.trial_waiver ? (
              <Row label="Trial Waiver" value={diamonds(receipt.trial_waiver)} ink="blue" />
            ) : null}
            <Row
              label="Order"
              value={receipt.purchase_id.slice(0, 8).toUpperCase()}
              meta={`Committed ${when(receipt.committed_at)}. Catalog ${receipt.catalog_version.replace('catalog:', 'V ')}.`}
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
      ) : null}

      {recovering ? <LoadingState message="Checking Your Order" /> : null}

      {scopeKind === 'union' && isOwner ? (
        <SpadeConsole
          eyebrow="Sponsorship"
          title="Sponsor Your Clubs"
          plates={{
            primary: {
              label: busy ? 'Saving' : 'Record Budget',
              ink: 'white',
              onClick: () => void saveSponsorship(),
              disabled: busy,
            },
          }}
        >
          <div className={styles.rows}>
            {(status.sponsorships ?? []).map((s) => (
              <div key={s.id}>
                <Row
                  label={s.club_id ? 'One Club' : 'Any Covered Club'}
                  value={`${(s.committed ?? 0).toLocaleString()} Of ${(s.total_budget ?? 0).toLocaleString()}`}
                  ink={s.state === 'active' ? 'green' : 'muted'}
                  meta={`${s.state === 'active' ? 'Active' : 'Revoked'}. ${s.per_club_budget ? `Up To ${s.per_club_budget.toLocaleString()} Per Club. ` : ''}Committed Charges Never Exceed The Budget.`}
                />
                {s.state === 'active' ? (
                  <ChoiceRow
                    label="Revoke Future Spending"
                    meta="Already Paid Club Rights Stay In Place."
                    value="Revoke"
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
              hint="Your Own Diamonds, Spent Only By You, For Covered Clubs' Capacity And Services."
            />
            <Field
              label="Per Club Allowance (Diamonds, Optional)"
              value={perClub}
              onChange={setPerClub}
            />
          </div>
          <p className="sc-copy">
            Sponsoring Pays For A Club Once; The Club Owner Is Never Charged For The Same Right.
            Refunds Return To You As The Original Payer.
          </p>
        </SpadeConsole>
      ) : null}

      <SpadeConsole eyebrow="Records" title="Receipts" foot="foot">
        <div className={styles.rows}>
          {receipts.length === 0 ? <Row label="No Receipts On File" value="" /> : null}
          {receipts.map((r) => (
            <Row
              key={r.purchase_id}
              label={`${r.kind === 'renewal' ? 'Renewal' : r.kind === 'upgrade' ? 'Upgrade' : 'Order'} ${r.purchase_id.slice(0, 8).toUpperCase()}`}
              value={diamonds(r.original_total_diamonds)}
              ink="silver"
              meta={`${when(r.committed_at)}. ${r.lines.map((l) => l.title).join(', ')}.${(r.refunds ?? []).length ? ` Refunds: ${r.refunds!.map((f) => `${f.gross.toLocaleString()} Gross, ${f.debt_settled.toLocaleString()} To Debt, ${f.net_increase.toLocaleString()} To Balance`).join('; ')}.` : ''}`}
            />
          ))}
        </div>
        <p className="sc-copy">
          A Receipt Is Permanent Transaction Evidence. Your Wallet Balance Is Read Separately And
          May Have Changed Since.
        </p>
      </SpadeConsole>
    </div>
  );
}
