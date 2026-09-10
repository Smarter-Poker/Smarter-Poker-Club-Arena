/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL - the operator's console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * What a union owner (or a standalone club's owner) needs to run the wheel and
 * nothing else: turn it on and off, set the spin price, set the exposure
 * allowance (the most the host accepts being ahead of what the wheel has minted
 * it), the diamond seed the prize float starts from, the per-player caps, and
 * READ the numbers that say whether the wheel is doing what the odds table
 * promises - realised return against the 80 percent spec as a z-score, the
 * lock rate, the exposure headroom, and the invariant (paid <= minted +
 * allowance) that the arithmetic makes impossible to break and
 * fn_wheel_metrics re-derives anyway.
 *
 * THE FREE SPIN (2026-09-09) has its own console here: the switch and the
 * daily pot post to fn_wheel_set_free_spin, the day's count and what it has
 * paid come from fn_wheel_free_state. It pays diamonds only, so it never
 * touches the bank, the exposure or the invariant printed above it.
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

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { ErrorState, LoadingState } from '../../components/common/EmptyState';
import { SpadeConsole, type ConsoleInk } from '../../components/console/SpadeConsole';
import DiamondWheelService, {
  type WheelConfigPatch,
  type WheelFreeSpinPatch,
  type WheelFreeState,
  type WheelMetrics,
} from '../../services/DiamondWheelService';
import { compactChips } from '../../utils/format';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
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
  free_spin_daily_budget_diamonds: string;
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
    free_spin_daily_budget_diamonds: String(c?.free_spin_daily_budget_diamonds ?? 2000),
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
  const [free, setFree] = useState<WheelFreeState | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
        DiamondWheelService.freeState(uuid).catch((err) => {
          reportError(err, 'ClubWheelOperationsPage.free');
          return null;
        }),
      ]);
      if (!isMountedRef.current) return;
      if (!m.ok) {
        setError(m.error || 'The Wheel Readings Could Not Be Loaded');
        return;
      }
      setMetrics(m);
      setFree(f);
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

  const applyFree = useCallback(
    async (patch: WheelFreeSpinPatch, done: string) => {
      if (!clubUuid) return;
      setSaving(true);
      try {
        const res = await DiamondWheelService.setFreeSpin(clubUuid, patch);
        if (!isMountedRef.current) return;
        if (!res.ok) {
          toast.error(res.error || 'That Change Was Refused');
          return;
        }
        toast.success(done);
        await load();
      } catch (err) {
        reportError(err, 'ClubWheelOperationsPage.applyFree');
        if (isMountedRef.current) toast.error('That Change Did Not Go Through');
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    },
    [clubUuid, isMountedRef, toast, load]
  );

  const saveFreePot = () => {
    const pot = Number(draft.free_spin_daily_budget_diamonds);
    if (!Number.isInteger(pot) || pot < 0)
      return toast.error('The Daily Pot Must Be A Whole Number Of Diamonds, Zero Or More');
    void applyFree({ free_spin_daily_budget_diamonds: pot }, 'The Daily Pot Is Saved');
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
  const freeOn = Boolean(cfg?.free_spin_enabled);
  const hostWord = metrics?.host_kind === 'union' ? 'Union Bank' : 'Club Treasury';
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
          <Row label={hostWord} value={chips(metrics?.bank_chips)} meta="Chips To Pay" />
          <Row
            label="Exposure"
            value={chips(metrics?.exposure_chips)}
            ink={(metrics?.exposure_chips ?? 0) > 0 ? 'gold' : 'silver'}
            meta={`Room ${chips(metrics?.exposure_headroom_chips)}`}
          />
          <Row
            label="Return"
            value={pct(metrics?.realized_rtp_lifetime)}
            meta={`${compactChips(pool?.spins ?? 0)} Spins Against 80%`}
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
            meta="Paid Against Minted"
          />
        </div>
        <p className="sc-copy">
          Paid Never Exceeds Minted Plus The Allowance; The Per-Spin Gate Makes That Arithmetic, And
          The Metrics Re-Derive It. A Locked Tier Is One The Pool Could Not Cover On That Spin.
        </p>
      </SpadeConsole>

      <SpadeConsole eyebrow="Against The 80% Spec" title="Realised Return" foot="foot">
        <div className={styles.rows}>
          <div className={`${styles.grid4} ${styles.grid4Head}`}>
            <span className="sc-label sc-ink--blue">Window</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Spins</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Return</span>
            <span className={`sc-label sc-ink--blue ${styles.cellRight}`}>Z</span>
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
                {pct(w.realized_rtp)}
              </span>
              <span
                className={`${styles.cell} ${styles.cellRight} ${w.drift ? 'sc-ink--red' : 'sc-ink--muted'}`}
              >
                {w.z === null ? 'N/A' : w.z.toFixed(1)}
              </span>
            </div>
          ))}
        </div>
        <p className="sc-copy">
          Z Is The Realised Return Against 80% In Standard Errors Of The Prize Table. Under 2,000
          Spins It Is Noise; Past 2,000, Z Of 4 Or More Either Way Flags Drift And Prints The Window
          In Red.
        </p>
        {metrics?.audit ? (
          <div className={`${styles.rows} ${styles.rowsCompact}`}>
            <Row
              label="Prize Table Returns"
              value={pct(metrics.audit.spec_rtp)}
              meta={`Table ${cfg?.segment_version ?? ''}`}
            />
            <Row
              label="Paid In Chips"
              value={pct(metrics.audit.chip_share)}
              ink="gold"
              meta="Of Intake"
            />
            <Row
              label="Paid In Diamonds"
              value={pct(metrics.audit.diamond_share)}
              ink="blue"
              meta="Of Intake"
            />
            <Row label="The House Keeps" value={pct(metrics.audit.house_share)} meta="Of Intake" />
          </div>
        ) : null}
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
            hint="The Most The Wheel May Pay Beyond What It Has Minted You."
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
        eyebrow="On The House"
        title="Free Spin"
        pill={freeOn ? 'On' : 'Off'}
        pillInk={freeOn ? 'green' : 'red'}
        plates={{
          secondary: {
            label: freeOn ? 'Turn It Off' : 'Turn It On',
            ink: freeOn ? 'red' : 'gold',
            disabled: saving,
            onClick: () =>
              void applyFree(
                { free_spin_enabled: !freeOn },
                freeOn ? 'The Free Spin Is Off' : 'The Free Spin Is On'
              ),
          },
          primary: {
            label: saving ? 'Saving' : 'Save The Pot',
            ink: 'white',
            onClick: saveFreePot,
            disabled: saving,
          },
        }}
      >
        <p className="sc-copy">
          Every Member May Spin Once A Day For Diamonds Only, From A Five-Prize Table Worth 9.75
          Diamonds A Spin On Average. The Pot Is The Most The Free Spins May Pay In A Day; When It
          Is Spent, The Offer Closes Until Tomorrow.
          {enabled ? '' : ' The Wheel Is Closed, So The Free Spin Is Closed With It.'}
        </p>
        <div className={`${styles.rows} ${styles.rowsCompact}`}>
          <Row label="Free Spins Today" value={(free?.spins_today ?? 0).toLocaleString()} />
          <Row
            label="Given Today"
            value={`${(free?.pot_paid_today ?? 0).toLocaleString()} Of ${(free?.pot_diamonds ?? 0).toLocaleString()}`}
            ink="blue"
            meta={
              free?.reason === 'pot_empty'
                ? 'The Pot Is Spent For Today'
                : 'Diamonds From The Daily Pot'
            }
          />
        </div>
        <div className={styles.fields}>
          <Field
            label="Daily Pot (Diamonds)"
            value={draft.free_spin_daily_budget_diamonds}
            onChange={set('free_spin_daily_budget_diamonds')}
            hint="Zero Closes The Free Spin For The Day Without Turning It Off."
          />
        </div>
      </SpadeConsole>

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
          <Row label={`Chips Minted To The ${hostWord}`} value={chips(pool?.chips_minted)} />
          <Row label="Chips Paid To Players" value={chips(pool?.chips_paid)} ink="gold" />
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
