/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL - the operator's console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * What a union owner (or a standalone club's owner) needs to run the wheel and
 * nothing else: turn it on and off, set the spin price, set the exposure
 * allowance (the most the host accepts being ahead of what the wheel has minted
 * it), the per-player caps, and READ the four numbers that say whether the
 * wheel is doing what the odds table promises - realised return against the
 * 80 percent spec as a z-score, the lock rate, the exposure headroom, and the
 * invariant (paid <= minted + allowance) that the arithmetic makes impossible
 * to break and fn_wheel_metrics re-derives anyway.
 *
 * Every control posts a patch to fn_wheel_set_config, which decides who may:
 * fn_wheel_can_operate (union owner, co-owner or admin through
 * fn_union_can_manage_wallets; a standalone club's owner, co_owner or admin;
 * platform management). The page shows a refusal, it never pre-empts one.
 *
 * Route: /clubs/:clubId/wheel-operations, finance access in the operations
 * registry. The player's page is /clubs/:clubId/wheel.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { ErrorState, LoadingState } from '../../components/common/EmptyState';
import DiamondWheelService, {
  type WheelConfigPatch,
  type WheelMetrics,
} from '../../services/DiamondWheelService';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import { useIsMounted } from '../../hooks/useIsMounted';
import styles from './ClubWheelOperationsPage.module.css';

const chips = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? 'N/A' : `${(n * 100).toFixed(digits)}%`;

interface Draft {
  spin_price_diamonds: string;
  exposure_allowance_chips: string;
  max_spins_per_player_per_day: string;
  min_seconds_between_spins: string;
  purchased_only: boolean;
  allow_fixture_accounts: boolean;
}

function draftFrom(m: WheelMetrics | null): Draft {
  const c = m?.config;
  return {
    spin_price_diamonds: String(c?.spin_price_diamonds ?? 100),
    exposure_allowance_chips: String(c?.exposure_allowance_chips ?? 500),
    max_spins_per_player_per_day: String(c?.max_spins_per_player_per_day ?? 200),
    min_seconds_between_spins: String(c?.min_seconds_between_spins ?? 3),
    purchased_only: c?.purchased_only ?? true,
    allow_fixture_accounts: c?.allow_fixture_accounts ?? false,
  };
}

export default function ClubWheelOperationsPage() {
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [clubUuid, setClubUuid] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<WheelMetrics | null>(null);
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
      const m = await DiamondWheelService.metrics(uuid);
      if (!isMountedRef.current) return;
      if (!m.ok) {
        setError(m.error || 'The Wheel Readings Could Not Be Loaded');
        return;
      }
      setMetrics(m);
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

  const saveNumbers = () => {
    const price = Number(draft.spin_price_diamonds);
    const allowance = Number(draft.exposure_allowance_chips);
    const cap = Number(draft.max_spins_per_player_per_day);
    const gap = Number(draft.min_seconds_between_spins);
    if (!Number.isInteger(price) || price <= 0)
      return toast.error('The Spin Price Must Be A Whole Number Of Diamonds');
    if (!Number.isFinite(allowance) || allowance < 0)
      return toast.error('The Exposure Allowance Must Be Zero Or More');
    if (!Number.isInteger(cap) || cap <= 0)
      return toast.error('The Daily Cap Must Be A Whole Number Of Spins');
    if (!Number.isInteger(gap) || gap < 0)
      return toast.error('The Pause Between Spins Must Be Zero Or More Seconds');
    void apply(
      {
        spin_price_diamonds: price,
        exposure_allowance_chips: Math.round(allowance * 100) / 100,
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
  const hostWord = metrics?.host_kind === 'union' ? 'Union Bank' : 'Club Treasury';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate(`/clubs/${routeClubId}/operations`)}
        >
          ‹ Operations
        </button>
        <h1>Diamond Wheel</h1>
        <span className={`${styles.pill} ${enabled ? styles.pillOn : styles.pillOff}`}>
          {enabled ? 'Open' : 'Closed'}
        </span>
      </header>

      <section className={styles.grid}>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>{hostWord}</span>
          <span className={styles.tileValue}>{chips(metrics?.bank_chips)}</span>
          <span className={styles.tileSub}>Chips Available To Pay Prizes</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Exposure</span>
          <span
            className={`${styles.tileValue} ${(metrics?.exposure_chips ?? 0) > 0 ? styles.warn : ''}`}
          >
            {chips(metrics?.exposure_chips)}
          </span>
          <span className={styles.tileSub}>
            Paid Minus Minted, Headroom {chips(metrics?.exposure_headroom_chips)}
          </span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Realised Return</span>
          <span className={styles.tileValue}>{pct(metrics?.realized_rtp_lifetime)}</span>
          <span className={styles.tileSub}>
            Spec 80.0% Over {(pool?.spins ?? 0).toLocaleString()} Spins
          </span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>House Take</span>
          <span className={styles.tileValue}>{chips(metrics?.house_take_lifetime_chips)}</span>
          <span className={styles.tileSub}>Retired Diamonds, In Chips</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Lock Rate</span>
          <span className={styles.tileValue}>{pct(metrics?.lock_rate)}</span>
          <span className={styles.tileSub}>Spins With A Tier Off The Table</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Invariant</span>
          <span
            className={`${styles.tileValue} ${metrics?.invariant_ok === false ? styles.bad : styles.ok}`}
          >
            {metrics?.invariant_ok === false ? 'Broken' : 'Holds'}
          </span>
          <span className={styles.tileSub}>Paid Never Exceeds Minted Plus Allowance</span>
        </div>
      </section>

      <section className={styles.panel}>
        <h2>Return Against The Spec</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Window</th>
              <th className={styles.num}>Spins</th>
              <th className={styles.num}>Intake</th>
              <th className={styles.num}>Paid</th>
              <th className={styles.num}>Return</th>
              <th className={styles.num}>Z</th>
              <th className={styles.num}>Locked</th>
            </tr>
          </thead>
          <tbody>
            {(metrics?.windows ?? []).map((w) => (
              <tr key={w.window} className={w.drift ? styles.rowBad : undefined}>
                <td>{w.window}</td>
                <td className={styles.num}>{w.spins.toLocaleString()}</td>
                <td className={styles.num}>{chips(w.intake_chips)}</td>
                <td className={styles.num}>{chips(w.paid_chips)}</td>
                <td className={styles.num}>{pct(w.realized_rtp)}</td>
                <td className={styles.num}>{w.z === null ? 'N/A' : w.z.toFixed(2)}</td>
                <td className={styles.num}>{w.constrained.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.note}>
          Z Is The Realised Return Against 80% In Standard Errors Of The Prize Table. Under 2,000
          Spins It Is Noise; Past 2,000, |Z| Of 4 Or More Flags Drift And Colours The Row.
          {metrics?.audit
            ? ` Table Version ${cfg?.segment_version ?? ''}: Return ${pct(metrics.audit.spec_rtp, 2)}, Chips ${pct(metrics.audit.chip_share, 1)}, Diamonds ${pct(metrics.audit.diamond_share, 1)}, House ${pct(metrics.audit.house_share, 1)}, Hit Rate ${pct(metrics.audit.hit_rate, 1)}.`
            : ''}
        </p>
      </section>

      <section className={styles.panel}>
        <h2>Controls</h2>
        <div className={styles.controlRow}>
          <div>
            <span className={styles.controlLabel}>The Wheel Is {enabled ? 'Open' : 'Closed'}</span>
            <span className={styles.controlSub}>
              {enabled
                ? 'Members Can Spin. Closing It Refuses The Next Spin At Once.'
                : 'Nobody Can Spin Until You Open It.'}
            </span>
          </div>
          <button
            type="button"
            className={`${styles.toggle} ${enabled ? styles.toggleOff : styles.toggleOn}`}
            disabled={saving}
            onClick={() =>
              void apply(
                { enabled: !enabled },
                enabled ? 'The Wheel Is Closed' : 'The Wheel Is Open'
              )
            }
          >
            {enabled ? 'Close The Wheel' : 'Open The Wheel'}
          </button>
        </div>

        <div className={styles.fields}>
          <label className={styles.field}>
            <span>Spin Price (Diamonds)</span>
            <input
              inputMode="numeric"
              value={draft.spin_price_diamonds}
              onChange={(e) => setDraft({ ...draft, spin_price_diamonds: e.target.value })}
            />
            <small>A Multiple Of 100. Prizes Scale With It.</small>
          </label>
          <label className={styles.field}>
            <span>Exposure Allowance (Chips)</span>
            <input
              inputMode="decimal"
              value={draft.exposure_allowance_chips}
              onChange={(e) => setDraft({ ...draft, exposure_allowance_chips: e.target.value })}
            />
            <small>The Most The Wheel May Pay Beyond What It Has Minted You.</small>
          </label>
          <label className={styles.field}>
            <span>Spins Per Player Per Day</span>
            <input
              inputMode="numeric"
              value={draft.max_spins_per_player_per_day}
              onChange={(e) => setDraft({ ...draft, max_spins_per_player_per_day: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>Seconds Between Spins</span>
            <input
              inputMode="numeric"
              value={draft.min_seconds_between_spins}
              onChange={(e) => setDraft({ ...draft, min_seconds_between_spins: e.target.value })}
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.purchased_only}
              onChange={(e) => setDraft({ ...draft, purchased_only: e.target.checked })}
            />
            <span>
              Purchased Diamonds Only
              <small>Promotional And Earned Diamonds Cannot Be Spun Into Chips.</small>
            </span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.allow_fixture_accounts}
              onChange={(e) => setDraft({ ...draft, allow_fixture_accounts: e.target.checked })}
            />
            <span>
              Allow Certification Accounts
              <small>For Burn-In Only. Their Spins Are Kept Out Of The Fairness Statistics.</small>
            </span>
          </label>
        </div>
        <button type="button" className={styles.save} disabled={saving} onClick={saveNumbers}>
          {saving ? 'Saving' : 'Save Settings'}
        </button>
      </section>

      <section className={styles.panel}>
        <h2>The Pool</h2>
        <dl className={styles.dl}>
          <dt>Spins</dt>
          <dd>{(pool?.spins ?? 0).toLocaleString()}</dd>
          <dt>Diamonds Taken In</dt>
          <dd>{(pool?.intake_diamonds ?? 0).toLocaleString()}</dd>
          <dt>Chips Minted To The {hostWord}</dt>
          <dd>{chips(pool?.chips_minted)}</dd>
          <dt>Chips Paid To Players</dt>
          <dd>{chips(pool?.chips_paid)}</dd>
          <dt>Diamond Prize Float</dt>
          <dd>
            {(pool?.diamond_float ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </dd>
          <dt>Diamonds Paid As Prizes</dt>
          <dd>{(pool?.diamonds_paid ?? 0).toLocaleString()}</dd>
        </dl>
        <button
          type="button"
          className={styles.link}
          onClick={() => navigate(`/clubs/${routeClubId}/wheel`)}
        >
          Open The Players Wheel
        </button>
      </section>
    </div>
  );
}
