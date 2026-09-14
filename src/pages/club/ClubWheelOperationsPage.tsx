/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL - the operator's console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * What a union owner (or a standalone club's owner) needs to run the wheel and
 * nothing else: turn it on and off, set the spin price, set the exposure
 * allowance (the most the host accepts being ahead of what the wheel has taken
 * in), the diamond seed the prize float starts from, the per-player caps, and
 * READ the numbers that say whether the wheel is doing what the odds table
 * promises - realised return against the 80 percent spec as a z-score, the
 * lock rate, the exposure headroom, and the invariant (paid <= taken in +
 * allowance) that the arithmetic makes impossible to break and
 * fn_wheel_metrics re-derives anyway. AMENDED 2026-09-10: nothing is minted
 * any more. The diamonds a spin takes in are the host owner's, and every chip
 * the wheel pays leaves the host's promo wallet, which is why that wallet and
 * the owner's diamonds are the two figures at the top of this page.
 *
 * THE FREE SPIN (2026-09-09) has its own console here: the switch and the
 * budget and window post to fn_wheel_set_welcome_spin, the count and what the
 * window has paid come from fn_wheel_welcome_state. It pays out of the
 * owner's own balance, so it never touches the promo wallet, the exposure or
 * the invariant printed above it.
 *
 * Every control posts a patch to fn_wheel_set_config, which decides who may:
 * fn_wheel_can_operate (union owner, co-owner or admin through
 * fn_union_can_manage_wallets; a standalone club's owner, co_owner or admin;
 * platform management). The page shows a refusal, it never pre-empts one.
 *
 * THE PICTURE (#ClubArenaConsole). Four consoles: the readings, the realised
 * return by window, the controls (fields printed on engraved lines, Close /
 * Open on the steel, Save on the blue glass) and the lifetime pool. Nothing is
 * drawn.
 *
 * Route: /clubs/:clubId/wheel-operations, finance access in the operations
 * registry. The player's page is /clubs/:clubId/wheel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import DiamondSpinsOwnerTerms from '../../components/games/DiamondSpinsOwnerTerms';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { ErrorState, LoadingState } from '../../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../../components/console/SpadeConsole';
import DiamondWheelService, {
  type WheelConfigPatch,
  type WheelWelcomePatch,
  type WheelWelcomeState,
  type WheelMetrics,
} from '../../services/DiamondWheelService';
import DiamondGamesService from '../../services/DiamondGamesService';
import { compactChips } from '../../utils/format';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import DiamondGamesMoney from '../../components/club/DiamondGamesMoney';
import { uuid } from '../../utils/uuid';
import { useIsMounted } from '../../hooks/useIsMounted';
import styles from '../diamondGames.module.css';

const chips = (n: number | null | undefined) => compactChips(Number(n ?? 0));
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? 'N/A' : `${Math.round(n * 100)}%`;

interface Draft {
  spin_price_diamonds: string;
  exposure_allowance_chips: string;
  diamond_seed: string;
  max_spins_per_player_per_day: string;
  min_seconds_between_spins: string;
  purchased_only: boolean;
  allow_fixture_accounts: boolean;
  welcome_budget_chips: string;
  welcome_budget_period_days: string;
}

function draftFrom(m: WheelMetrics | null): Draft {
  const c = m?.config;
  return {
    spin_price_diamonds: String(c?.spin_price_diamonds ?? 100),
    exposure_allowance_chips: String(c?.exposure_allowance_chips ?? 500),
    diamond_seed: String(c?.diamond_seed ?? 2500),
    max_spins_per_player_per_day: String(c?.max_spins_per_player_per_day ?? 200),
    min_seconds_between_spins: String(c?.min_seconds_between_spins ?? 3),
    purchased_only: c?.purchased_only ?? true,
    allow_fixture_accounts: c?.allow_fixture_accounts ?? false,
    welcome_budget_chips: String(c?.welcome_budget_chips ?? 0),
    welcome_budget_period_days: String(c?.welcome_budget_period_days ?? 30),
  };
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
  mode?: 'decimal' | 'numeric';
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

/** A switch: the row IS the control, its state is its printed value. */
function Toggle({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={styles.rowButton} onClick={onToggle} aria-pressed={on}>
      <span className={`sc-label sc-ink--silver ${styles.rowLabel}`}>
        {label}
        <span className={`${styles.rowMeta} sc-ink--muted`}>{hint}</span>
      </span>
      <span className={`${styles.rowValue} sc-ink--${on ? 'green' : 'muted'}`}>
        {on ? 'On' : 'Off'}
      </span>
    </button>
  );
}

export default function ClubWheelOperationsPage() {
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<WheelMetrics | null>(null);
  const [welcome, setWelcome] = useState<WheelWelcomeState | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fundChips, setFundChips] = useState('');
  const [funding, setFunding] = useState(false);
  /**
   * ONE KEY PER INTENT, HELD ACROSS A FAILURE (2026-09-11). The server spends a
   * funding key once and answers a second press under the same key with
   * replayed = true, having moved nothing. So a press whose reply was lost has
   * to be retried under the SAME key: mint on a new amount, keep on a thrown
   * request, clear only once the server has actually answered.
   */
  const fundKeyRef = useRef<{ amount: number; key: string } | null>(null);

  const load = useCallback(async () => {
    if (!routeClubId) return;
    setLoading(true);
    setError(null);
    try {
      const uuid = await resolveClubUUID(routeClubId);
      if (!isMountedRef.current) return;
      setClubUuid(uuid);
      const [m, f] = await Promise.all([
        DiamondWheelService.metrics(uuid),
        DiamondWheelService.welcomeState(uuid).catch((err) => {
          reportError(err, 'ClubWheelOperationsPage.welcome');
          return null;
        }),
      ]);
      if (!isMountedRef.current) return;
      if (!m.ok) {
        setError(m.error || 'The Wheel Readings Could Not Be Loaded');
        return;
      }
      setMetrics(m);
      setWelcome(f);
      setDraft(draftFrom(m));
    } catch (err) {
      reportError(err, 'ClubWheelOperationsPage.load');
      if (isMountedRef.current) setError('The Wheel Readings Could Not Be Loaded');
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [routeClubId, isMountedRef]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (patch: WheelConfigPatch, done: string) => {
      if (!clubUuid) return;
      setSaving(true);
      try {
        const res = await DiamondWheelService.setConfig(clubUuid, patch);
        if (!isMountedRef.current) return;
        if (!res.ok) {
          toast.error(res.error || 'That Change Was Refused');
          return;
        }
        toast.success(done);
        await load();
      } catch (err) {
        reportError(err, 'ClubWheelOperationsPage.apply');
        if (isMountedRef.current) toast.error('That Change Did Not Go Through');
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    },
    [clubUuid, isMountedRef, toast, load]
  );

  const applyWelcome = useCallback(
    async (patch: WheelWelcomePatch, done: string) => {
      if (!clubUuid) return;
      setSaving(true);
      try {
        const res = await DiamondWheelService.setWelcomeSpin(clubUuid, patch);
        if (!isMountedRef.current) return;
        if (!res.ok) {
          toast.error(res.error || 'That Change Was Refused');
          return;
        }
        toast.success(done);
        await load();
      } catch (err) {
        reportError(err, 'ClubWheelOperationsPage.applyWelcome');
        if (isMountedRef.current) toast.error('That Change Did Not Go Through');
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    },
    [clubUuid, isMountedRef, toast, load]
  );

  /** Bank into promo wallet. The server decides who may; this only asks. */
  const moveIntoPromo = useCallback(
    async (amount: number) => {
      if (!clubUuid) return;
      if (!Number.isFinite(amount) || amount <= 0)
        return toast.error('Enter How Many Chips To Move');
      const held = fundKeyRef.current;
      const intent = held && held.amount === amount ? held : { amount, key: uuid() };
      fundKeyRef.current = intent;
      setFunding(true);
      try {
        const res = await DiamondGamesService.fundPromo(clubUuid, amount, intent.key);
        // The server answered, so this intent is closed either way: a refusal
        // moved nothing, and a success must never be sent a second time.
        fundKeyRef.current = null;
        if (!isMountedRef.current) return;
        if (!res.ok) {
          toast.error(res.error ?? 'Those Chips Could Not Be Moved');
        } else {
          toast.success(
            res.replayed ? 'Those Chips Were Already Moved' : 'The Promo Wallet Is Funded'
          );
          setFundChips('');
          await load();
        }
      } catch (err) {
        // No answer came back, so nobody knows whether the chips moved. The key
        // is deliberately kept: the next press is the same intent, not a new one,
        // and the server will either carry it out or report it as a replay.
        //
        // The first cut of this said the chips had not moved, which is a claim
        // nobody here is in a position to make, printed over numbers that were
        // never rechecked. The console rereads and lets the wallet answer.
        reportError(err, 'ClubWheelOperationsPage.fundPromo', { clubId: clubUuid });
        if (!isMountedRef.current) return;
        toast.error('No Answer Came Back. The Numbers Below Are Rechecked');
        await load();
      } finally {
        if (isMountedRef.current) setFunding(false);
      }
    },
    [clubUuid, isMountedRef, toast, load]
  );

  const saveWelcomeBudget = () => {
    const budget = Number(draft.welcome_budget_chips);
    if (!Number.isFinite(budget) || budget < 0)
      return toast.error('The Welcome Budget Must Be Zero Or More Chips');
    const days = Number(draft.welcome_budget_period_days);
    if (!Number.isInteger(days) || days < 0)
      return toast.error('The Window Must Be A Whole Number Of Days, Or Zero');
    void applyWelcome(
      { welcome_budget_chips: budget, welcome_budget_period_days: days },
      'The Welcome Budget Is Saved'
    );
  };

  const saveNumbers = () => {
    const price = Number(draft.spin_price_diamonds);
    const allowance = Number(draft.exposure_allowance_chips);
    const seed = Number(draft.diamond_seed);
    const cap = Number(draft.max_spins_per_player_per_day);
    const gap = Number(draft.min_seconds_between_spins);
    if (!Number.isInteger(price) || price <= 0)
      return toast.error('The Spin Price Must Be A Whole Number Of Diamonds');
    if (!Number.isFinite(allowance) || allowance < 0)
      return toast.error('The Exposure Allowance Must Be Zero Or More');
    if (!Number.isInteger(seed) || seed < 0)
      return toast.error('The Diamond Seed Must Be A Whole Number Of Diamonds');
    if (!Number.isInteger(cap) || cap <= 0)
      return toast.error('The Daily Cap Must Be A Whole Number Of Spins');
    if (!Number.isInteger(gap) || gap < 0)
      return toast.error('The Pause Between Spins Must Be Zero Or More Seconds');
    void apply(
      {
        spin_price_diamonds: price,
        exposure_allowance_chips: Math.round(allowance * 100) / 100,
        diamond_seed: seed,
        max_spins_per_player_per_day: cap,
        min_seconds_between_spins: gap,
        purchased_only: draft.purchased_only,
        allow_fixture_accounts: draft.allow_fixture_accounts,
      },
      'Wheel Settings Saved'
    );
  };

  if (loading) return <LoadingState message="Reading The Wheel" />;
  if (error) {
    return (
      <div className={styles.page}>
        <ErrorState message={error} onRetry={() => void load()} />
      </div>
    );
  }

  const cfg = metrics?.config;
  const pool = metrics?.pool;
  const enabled = Boolean(cfg?.enabled);
  const promoDry = (metrics?.promo_chips ?? 0) <= 0;
  const welcomeOn = Boolean(cfg?.welcome_spin_enabled);
  /* The window the budget is spent against, said in words rather than a number
     an operator has to interpret. Zero is a lifetime budget, not a zero-day one. */
  const windowWord =
    (welcome?.budget_period_days ?? 0) > 0
      ? `Chips From The Promo Wallet, In The Last ${welcome?.budget_period_days} Days`
      : 'Chips From The Promo Wallet, All Time';
  const hostWord = metrics?.host_kind === 'union' ? 'Union' : 'Club';
  const set = (key: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <div className={styles.page}>
      <button
        type="button"
        className={styles.back}
        onClick={() => navigate(`/clubs/${routeClubId}/operations`)}
      >
        ‹ Operations
      </button>

      <DiamondSpinsOwnerTerms clubId={clubUuid} />

      <SpadeConsole
        eyebrow="Operations"
        title="Diamond Wheel"
        titleId="wheel-ops-title"
        pill={enabled ? 'Open' : 'Closed'}
        pillInk={enabled ? 'green' : 'red'}
        foot="foot"
        aria-labelledby="wheel-ops-title"
      >
        <div className={styles.rows}>
          <Row
            label="Cover"
            value={chips(metrics?.cover_chips)}
            ink={(metrics?.cover_chips ?? 0) <= 0 ? 'red' : 'silver'}
            meta={`${chips(metrics?.promo_chips)} Promo Plus ${chips(metrics?.bank_chips)} Bank`}
          />
          <Row
            label={`${hostWord} Promo Wallet`}
            value={chips(metrics?.promo_chips)}
            ink={(metrics?.promo_chips ?? 0) <= 0 ? 'gold' : 'silver'}
            meta={
              (metrics?.promo_chips ?? 0) <= 0
                ? `Empty, So The ${hostWord} Bank Is Paying The Prizes`
                : 'Every Chip Prize Is Paid From Here First'
            }
          />
          <Row
            label={`${hostWord} Bank`}
            value={chips(metrics?.bank_chips)}
            ink={(metrics?.bank_chips ?? 0) <= 0 ? 'red' : 'blue'}
            meta="Behind The Promo Wallet, And Only When It Runs Dry"
          />
          <Row
            label="Owner Diamonds"
            value={compactChips(metrics?.owner_diamonds ?? 0)}
            ink="blue"
            meta="Where The Diamonds Taken In Land, And Where Diamond Prizes Come From"
          />
          <Row
            label="Exposure"
            value={chips(metrics?.exposure_chips)}
            ink={(metrics?.exposure_chips ?? 0) > 0 ? 'gold' : 'silver'}
            meta={`Room ${chips(metrics?.exposure_headroom_chips)}`}
          />
          <Row
            label="House Take"
            value={chips(metrics?.house_take_lifetime_chips)}
            ink="gold"
            meta="Chips"
          />
          <Row
            label="Lock Rate"
            value={pct(metrics?.lock_rate)}
            meta="Spins With A Tier Off The Table"
          />
          <Row
            label="Invariant"
            value={metrics?.invariant_ok === false ? 'Broken' : 'Holds'}
            ink={metrics?.invariant_ok === false ? 'red' : 'green'}
            meta="Paid Against Taken In"
          />
        </div>
        <p className="sc-copy">
          Paid Never Exceeds What Was Taken In Plus The Allowance, And Every Chip Leaves The Promo
          Wallet Before The Bank; The Per-Spin Gate Makes That Arithmetic, And The Metrics Re-Derive
          It. A Locked Tier Is One The Cover Could Not Pay On That Spin.
        </p>
      </SpadeConsole>

      {/* THE FLOAT, AND WHERE TO PUT IT (Dan 2026-09-10). The bank backs the
          promo wallet on its own, so the games never stop; this is how an
          operator moves the float to where it is meant to sit, without leaving
          the console they are already reading. */}
      <SpadeConsole
        eyebrow="Cover"
        title="The Promo Wallet"
        pill={promoDry ? 'On The Bank' : 'Funded'}
        pillInk={promoDry ? 'gold' : 'green'}
        plates={{
          secondary: {
            label: 'Move 100',
            onClick: () => void moveIntoPromo(100),
            disabled: funding,
          },
          primary: {
            label: funding ? 'Moving' : 'Move The Amount',
            ink: 'white',
            onClick: () => void moveIntoPromo(Number(fundChips)),
            disabled: funding,
          },
        }}
      >
        <p className="sc-copy">
          Every Chip Prize Leaves The Promo Wallet First. When It Runs Dry The {hostWord} Bank Pays
          The Rest, So The Games Never Stop; The Journal Names Which Wallet Paid Which Part. Keep
          The Float Here And The Bank Stays A Backstop Rather Than A Habit.
        </p>
        <div className={`${styles.rows} ${styles.rowsCompact}`}>
          <Row
            label="Cover"
            value={chips(metrics?.cover_chips)}
            ink={(metrics?.cover_chips ?? 0) <= 0 ? 'red' : 'silver'}
            meta="What A Prize May Draw On"
          />
          <Row
            label="Promo Wallet"
            value={chips(metrics?.promo_chips)}
            ink={promoDry ? 'gold' : 'green'}
            meta={promoDry ? 'Empty: The Bank Is Carrying The Games' : 'Paid First'}
          />
          <Row
            label={`${hostWord} Bank`}
            value={chips(metrics?.bank_chips)}
            ink={(metrics?.bank_chips ?? 0) <= 0 ? 'red' : 'blue'}
            meta="The Backstop"
          />
        </div>
        <div className={styles.fields}>
          <Field
            label="Move Into The Promo Wallet (Chips)"
            mode="decimal"
            value={fundChips}
            onChange={setFundChips}
            hint="Taken From The Bank, Which Is The Same Money In A Different Pocket."
          />
        </div>
      </SpadeConsole>

      <SpadeConsole eyebrow="Settled Play" title="Game Activity" foot="foot">
        <div className={styles.rows}>
          <div className={`${styles.grid4} ${styles.grid4Head}`}>
            <span className="sc-label sc-ink--blue">Window</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Spins</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Chips Paid</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Review</span>
          </div>
          {(metrics?.windows ?? []).map((w) => (
            <div key={w.window} className={styles.grid4}>
              <span className={`${styles.cell} ${w.drift ? 'sc-ink--red' : 'sc-ink--silver'}`}>
                {w.window.toUpperCase()}
                <span className={`${styles.rowMeta} sc-ink--muted`}>
                  In {chips(w.intake_chips)}, Out {chips(w.paid_chips)}
                  {w.constrained ? `, ${compactChips(w.constrained)} Locked` : ''}
                </span>
              </span>
              <span className={`${styles.cell} ${styles.cellRight} sc-ink--silver`}>
                {compactChips(w.spins)}
              </span>
              <span
                className={`${styles.cell} ${styles.cellRight} ${w.drift ? 'sc-ink--red' : 'sc-ink--silver'}`}
              >
                {chips(w.paid_chips)}
              </span>
              <span
                className={`${styles.cell} ${styles.cellRight} ${w.drift ? 'sc-ink--red' : 'sc-ink--muted'}`}
              >
                {w.drift ? 'Review' : 'Clear'}
              </span>
            </div>
          ))}
        </div>
        <p className="sc-copy">
          Review Highlights Activity That Needs An Operator Check. Intake And Paid Chips Come From
          The Settled Game Records.
        </p>
      </SpadeConsole>

      <SpadeConsole
        eyebrow={`The Wheel Is ${enabled ? 'Open' : 'Closed'}`}
        title="Controls"
        plates={{
          secondary: {
            label: enabled ? 'Close The Wheel' : 'Open The Wheel',
            ink: enabled ? 'red' : 'gold',
            disabled: saving,
            onClick: () =>
              void apply(
                { enabled: !enabled },
                enabled ? 'The Wheel Is Closed' : 'The Wheel Is Open'
              ),
          },
          primary: {
            label: saving ? 'Saving' : 'Save Settings',
            ink: 'white',
            onClick: saveNumbers,
            disabled: saving,
          },
        }}
      >
        <p className="sc-copy">
          {enabled
            ? 'Closing It Refuses The Next Spin At Once.'
            : 'Nobody Can Spin Until You Open It.'}
        </p>
        <div className={styles.fields}>
          <Field
            label="Spin Price (Diamonds)"
            value={draft.spin_price_diamonds}
            onChange={set('spin_price_diamonds')}
            hint="A Multiple Of 100. Prizes Scale With It."
          />
          <Field
            label="Exposure Allowance (Chips)"
            mode="decimal"
            value={draft.exposure_allowance_chips}
            onChange={set('exposure_allowance_chips')}
            hint="The Most The Wheel May Pay Beyond What It Has Taken In."
          />
          <Field
            label="Diamond Seed (Diamonds)"
            value={draft.diamond_seed}
            onChange={set('diamond_seed')}
            hint="The Float The Diamond Prizes Start From, So No Tier Opens Locked."
          />
          <Field
            label="Spins Per Player Per Day"
            value={draft.max_spins_per_player_per_day}
            onChange={set('max_spins_per_player_per_day')}
          />
          <Field
            label="Seconds Between Spins"
            value={draft.min_seconds_between_spins}
            onChange={set('min_seconds_between_spins')}
          />
          <Toggle
            label="Purchased Diamonds Only"
            hint="Promotional And Earned Diamonds Cannot Be Spun Into Chips."
            on={draft.purchased_only}
            onToggle={() => setDraft((d) => ({ ...d, purchased_only: !d.purchased_only }))}
          />
          <Toggle
            label="Allow Certification Accounts"
            hint="For Burn-In Only. Their Spins Are Kept Out Of The Fairness Statistics."
            on={draft.allow_fixture_accounts}
            onToggle={() =>
              setDraft((d) => ({ ...d, allow_fixture_accounts: !d.allow_fixture_accounts }))
            }
          />
        </div>
      </SpadeConsole>

      <SpadeConsole
        eyebrow="On The Club"
        title="The Welcome Spin"
        pill={welcomeOn ? 'On' : 'Off'}
        pillInk={welcomeOn ? 'green' : 'red'}
        plates={{
          secondary: {
            label: welcomeOn ? 'Turn It Off' : 'Turn It On',
            ink: welcomeOn ? 'red' : 'gold',
            disabled: saving,
            onClick: () =>
              void applyWelcome(
                { welcome_spin_enabled: !welcomeOn },
                welcomeOn ? 'The Welcome Spin Is Off' : 'The Welcome Spin Is On'
              ),
          },
          primary: {
            label: saving ? 'Saving' : 'Save The Budget',
            ink: 'white',
            onClick: saveWelcomeBudget,
            disabled: saving,
          },
        }}
      >
        <p className="sc-copy">
          Every New Member May Take One Spin On The Real Wheel, Once, On The Club. You Take No
          Diamonds In For It, And Whatever It Pays Comes Out Of The Promo Wallet. The Budget Is The
          Most The Welcome Spins May Cost You Inside The Window, And The Window Slides: Spend Older
          Than It Stops Counting, So The Budget Comes Back On Its Own. A Welcome Spin Is The Whole
          Wheel Or It Is Not Offered, So When What Is Left Can No Longer Cover The Top Prize The
          Offer Closes Rather Than Handing A New Member A Wheel With Its Best Tiers Locked.
          {enabled ? '' : ' The Wheel Is Closed, So The Welcome Spin Is Closed With It.'}
        </p>
        <div className={`${styles.rows} ${styles.rowsCompact}`}>
          <Row
            label="Welcome Spins Given"
            value={compactChips(welcome?.welcome_spins ?? 0)}
            meta={`Each One Is A ${compactChips(welcome?.spin_price_diamonds ?? 0)} Diamond Spin You Did Not Charge For`}
          />
          <Row
            label="Budget Spent"
            value={`${compactChips(welcome?.budget_paid_chips ?? 0)} Of ${compactChips(welcome?.budget_chips ?? 0)}`}
            ink={welcome?.reason === 'pot_empty' || welcome?.reason === 'unfunded' ? 'red' : 'blue'}
            meta={
              welcome?.reason === 'unfunded'
                ? 'Set A Budget And The Welcome Spin Opens'
                : welcome?.reason === 'pot_empty'
                  ? 'What Is Left Cannot Cover The Top Prize, So The Offer Is Closed'
                  : windowWord
            }
          />
          <Row
            label="Top Prize"
            value={compactChips(welcome?.top_prize_chips ?? 0)}
            meta="What The Window Must Be Able To Cover Before A Spin Is Offered"
          />
          <Row
            label="Given Away, All Time"
            value={compactChips(welcome?.lifetime_chips_paid ?? 0)}
            meta="Across Every Window, Since The Welcome Spin Opened"
          />
        </div>
        <div className={styles.fields}>
          <Field
            label="Welcome Budget (Chips)"
            mode="decimal"
            value={draft.welcome_budget_chips}
            onChange={set('welcome_budget_chips')}
            hint="Zero Closes The Welcome Spin Without Turning It Off."
          />
          <Field
            label="Budget Window (Days)"
            value={draft.welcome_budget_period_days}
            onChange={set('welcome_budget_period_days')}
            hint="The Budget Is Spent Per Window And Comes Back As Spend Ages Out. Zero Means It Never Turns."
          />
        </div>
      </SpadeConsole>

      <DiamondGamesMoney clubId={clubUuid} />

      <SpadeConsole
        eyebrow="Lifetime"
        title="The Pool"
        plates={{
          secondary: {
            label: 'Games Console',
            onClick: () => navigate(`/clubs/${routeClubId}/diamond-games-operations`),
          },
          primary: {
            label: 'Players Wheel',
            ink: 'white',
            onClick: () => navigate(`/clubs/${routeClubId}/wheel`),
          },
        }}
      >
        <div className={`${styles.rows} ${styles.rowsCompact}`}>
          <Row label="Spins" value={compactChips(pool?.spins ?? 0)} />
          <Row
            label="Diamonds Taken In"
            value={compactChips(pool?.intake_diamonds ?? 0)}
            ink="blue"
          />
          <Row
            label="Chips Taken In"
            value={chips(metrics?.intake_chips)}
            meta="At The Bridge Rate"
          />
          <Row
            label="Chips Paid To Players"
            value={chips(pool?.chips_paid)}
            ink="gold"
            meta="Out Of The Promo Wallet"
          />
          <Row
            label="Diamond Prize Float"
            value={compactChips(Math.floor(pool?.diamond_float ?? 0))}
            ink="blue"
          />
          <Row label="Diamonds Paid As Prizes" value={compactChips(pool?.diamonds_paid ?? 0)} />
        </div>
      </SpadeConsole>
    </div>
  );
}
