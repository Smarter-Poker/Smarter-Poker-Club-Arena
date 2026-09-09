/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE OWNER'S SPIN PANEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "SPINS SHOULD BE 'ACTIVATED' IN THE OWNERS MENU, AND WHEN
 * THEY ARE, THEY NEED TO DECIDE HOW MUCH THEY ARE 'SEEDING' INTO THE WALLET.
 * (THOSE FUNDS ARE RETURNED ONCE ENOUGH IS COLLECTED) AND ALL PROCEEDS ARE
 * KEPT THERE TO FUND THE MULTIPLIER PAYOUTS."
 *
 * The panel has to be honest about three things that are easy to hide:
 *
 *   1. WHOSE MONEY THIS IS. A club inside a union does not have its own Spin
 *      wallet — its union does. Rather than show a club owner a switch that
 *      will refuse them, the panel says so plainly and shows the union's
 *      numbers read-only.
 *   2. WHAT THE SEED COSTS. Two top-tier jackpots at the largest stake offered,
 *      quoted before the owner commits, and recalculated the moment they change
 *      the stake.
 *   3. THAT THE SEED IS A LOAN, NOT A FEE. It comes back once play alone has
 *      collected as much, and the panel shows exactly how far away that is
 *      rather than leaving the owner to wonder whether it ever will.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  spinActivationApi,
  requiredSeedForStake,
  SPIN_BOARD_STAKES,
  SPIN_SEED_SOURCES,
  type SpinOwnerState,
} from '../../services/SpinActivationService';
import { useToast } from '../common/Toast';

interface Props {
  /**
   * Whose Spin wallet to show. A club id, or a UNION id -- both resolve
   * through fn_spin_reserve_owner to the same pool, so the union dashboard
   * passes its own id and gets the union's wallet.
   */
  clubId: string;
}

/** The funding wallet's display name, for copy that says where money goes. */
function walletLabel(kind: string | undefined, wallet: string | null | undefined): string {
  const list = SPIN_SEED_SOURCES[(kind as 'club' | 'union') ?? 'club'] ?? [];
  return list.find((w) => w.value === wallet)?.label ?? 'The Funding Wallet';
}

const chips = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function SpinActivationPanel({ clubId }: Props) {
  const toast = useToast();
  const [state, setState] = useState<SpinOwnerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [maxStake, setMaxStake] = useState<number>(10);
  const [wallet, setWallet] = useState<string>('chip_treasury');
  /** What the ROUTE says about this viewer. Null until the first read lands. */
  const [routeCanManage, setRouteCanManage] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await spinActivationApi.getState(clubId);
      setState(res.state);
      setRouteCanManage(Boolean(res.canManage));
      // Default the source wallet to the first one this owner actually has.
      const sources = SPIN_SEED_SOURCES[res.state?.owner_kind ?? 'club'];
      setWallet((w) => (sources.some((s) => s.value === w) ? w : sources[0].value));
      if (res.state?.offered_max_stake > 0) setMaxStake(res.state.offered_max_stake);
    } catch (err) {
      // A viewer with no permission is a normal outcome, not an error worth
      // shouting about — the panel simply shows nothing it cannot prove.
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    void load();
  }, [load]);

  const required = requiredSeedForStake(maxStake);
  /**
   * What the owner is actually charged. An outstanding seed is already sitting
   * in the pool doing the job the seed exists to do, so it counts toward the
   * bar -- the database applies the same credit, and quoting the gross here
   * would promise a bill that will not arrive.
   */
  const stillNeeded = Math.max(required - Number(state?.seeded_amount ?? 0), 0);
  const sources = SPIN_SEED_SOURCES[state?.owner_kind ?? 'club'];
  const isUnionOwned = state?.owner_kind === 'union';

  /**
   * The single answer both buttons obey, and it comes from ONE place.
   *
   * This used to be `canManage && routeCanManage`, where canManage was the
   * PAGE's guess -- ClubSettingsPage passes its own `isOwner`. That AND was
   * itself the bug it was meant to fix: a union lead who is not the club owner
   * has isOwner === false, so the off switch stayed hidden from the one person
   * the API actually authorises. The route knows about union_admins and
   * clubs.owner_id; the page knows about neither. Its answer is the answer.
   *
   * Fails CLOSED while that answer is still in flight, so a slow read can
   * never briefly offer a control the server will refuse.
   */
  const canAct = routeCanManage === true;

  /* ONE KEY PER ACTIVATION, HELD ACROSS RETRIES (2026-09-09). Activation
     seeds the spin pool out of a real wallet; the key used to be minted
     inside the transport on every request, so a committed activation whose
     response was lost seeded the pool AGAIN on the next press. Keyed on what
     is being bought (the seed and the ceiling), so a genuinely different
     activation gets its own key. Retired on success. */
  const activateKeyRef = useRef<{ seed: number; stake: number; key: string } | null>(null);
  const deactivateKeyRef = useRef<string | null>(null);

  const activate = async () => {
    setBusy(true);
    try {
      if (
        !activateKeyRef.current ||
        activateKeyRef.current.seed !== stillNeeded ||
        activateKeyRef.current.stake !== maxStake
      ) {
        activateKeyRef.current = {
          seed: stillNeeded,
          stake: maxStake,
          key: crypto.randomUUID(),
        };
      }
      await spinActivationApi.activate(
        clubId,
        stillNeeded,
        maxStake,
        wallet,
        activateKeyRef.current.key
      );
      activateKeyRef.current = null;
      toast.success(`Spins Activated With A Seed Of ${chips(stillNeeded)} Chips`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could Not Activate Spins');
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    try {
      if (!deactivateKeyRef.current) deactivateKeyRef.current = crypto.randomUUID();
      const response = await spinActivationApi.deactivate(clubId, deactivateKeyRef.current);
      deactivateKeyRef.current = null;
      const returned = Number(response.result.seed_returned ?? 0);
      toast.success(
        returned > 0
          ? `Spins Deactivated. ${chips(returned)} Seed Chips Returned To ${walletLabel(state?.owner_kind, state?.seed_source_wallet)}.`
          : 'Spins Deactivated. The Reserve Remains Locked Until Every Live Spin Is Settled.'
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could Not Deactivate Spins');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="settings-section">
        <h3>Spins</h3>
        <small className="form-hint">Loading</small>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="settings-section">
        <h3>Spins</h3>
        <small className="form-hint">Spin Settings Are Not Available For This Club</small>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h3>Spins</h3>

      {isUnionOwned && !canAct && (
        <small className="form-hint" style={{ display: 'block', marginBottom: 10 }}>
          This Club Belongs To A Union, So The Spin Wallet Belongs To The Union. Only The Union Lead
          Can Change It.
        </small>
      )}

      <div className="toggle-row">
        <div>
          <label>Status</label>
          <small className="form-hint">
            {state.is_active ? 'Spins Are Running' : 'Spins Are Off'}
          </small>
        </div>
        <span
          className={`toggle-btn ${state.is_active ? 'on' : ''}`}
          style={{ pointerEvents: 'none' }}
        >
          {state.is_active ? 'ON' : 'OFF'}
        </span>
      </div>

      {!state.is_active && state.seeded_amount > 0 && (
        <small className="form-hint" style={{ display: 'block', marginBottom: 10 }}>
          Seed Of {chips(state.seeded_amount)} Is Still In This Wallet From Before.{' '}
          {state.seed_is_repayable
            ? 'It Counts Toward What You Need, So Turning Spins Back On Will Not Charge You For It Again.'
            : 'It Has No Recorded Source Wallet, So It Cannot Be Returned Automatically.'}
        </small>
      )}

      {state.is_active ? (
        <>
          <div className="form-row">
            <div className="form-group">
              <label>Wallet Balance</label>
              <strong>{chips(state.balance)}</strong>
            </div>
            <div className="form-group">
              <label>Largest Stake Offered</label>
              <strong>{chips(state.offered_max_stake)}</strong>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Collected From Play</label>
              <strong>{chips(state.collected_from_play)}</strong>
            </div>
            <div className="form-group">
              <label>Paid Out As Multipliers</label>
              <strong>{chips(state.total_drawn)}</strong>
            </div>
          </div>

          {state.seeded_amount > 0 && !state.seed_is_repayable ? (
            <small className="form-hint" style={{ display: 'block' }}>
              Seed Outstanding {chips(state.seeded_amount)}. It Has No Recorded Source Wallet, So It
              Cannot Be Returned Automatically.
            </small>
          ) : state.seeded_amount > 0 ? (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label>Seed Still Owed</label>
                  <strong>{chips(state.seeded_amount)}</strong>
                </div>
                <div className="form-group">
                  <label>Returned So Far</label>
                  <strong>{chips(state.seed_returned_amount)}</strong>
                </div>
              </div>
              <small className="form-hint" style={{ display: 'block' }}>
                Repayment Plan. Half Of Everything Above {chips(state.repay_floor)} Returns To{' '}
                {walletLabel(state.owner_kind, state.seed_source_wallet)} Each Time The Wallet
                Reaches {chips(state.repay_trigger_at)}, Until The Seed Is Square. The Floor Stays
                Behind So The Top Multiplier Is Always Payable.
              </small>
              <small className="form-hint" style={{ display: 'block' }}>
                {state.next_instalment > 0
                  ? `Next Instalment ${chips(state.next_instalment)}, Due On The Next Spin.`
                  : `Next Instalment Once The Wallet Climbs Another ${chips(state.seed_repayable_in)}.`}
              </small>
            </>
          ) : (
            <small className="form-hint" style={{ display: 'block' }}>
              Seed Of {chips(state.seed_returned_amount)} Has Been Returned. Every Chip Collected
              Now Stays Here To Fund Multipliers.
            </small>
          )}

          {canAct && (
            <button
              type="button"
              className="btn-secondary"
              style={{ marginTop: 12 }}
              onClick={deactivate}
              disabled={busy}
            >
              {busy ? 'Working' : 'Turn Spins Off'}
            </button>
          )}
        </>
      ) : (
        <>
          <small className="form-hint" style={{ display: 'block', marginBottom: 10 }}>
            Seed The Wallet To Open Spins. The Seed Is A Loan, Not A Fee. It Comes Back Once Play
            Has Collected As Much On Its Own. Turning Spins Off Also Returns Any Outstanding Seed As
            Soon As Every Live Spin Is Settled. Net Spin Proceeds Stay Here To Pay Multipliers.
          </small>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="spin-max-stake">Largest Stake To Offer</label>
              <select
                id="spin-max-stake"
                value={maxStake}
                onChange={(e) => setMaxStake(Number(e.target.value))}
                disabled={!canAct || busy}
              >
                {SPIN_BOARD_STAKES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="spin-seed-source">Seed From</label>
              <select
                id="spin-seed-source"
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                disabled={!canAct || busy}
              >
                {sources.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <small className="form-hint" style={{ display: 'block', marginBottom: 6 }}>
            How It Comes Back. Once The Wallet Reaches{' '}
            {chips(requiredSeedForStake(maxStake) * 1.25)}, Half Of Everything Above{' '}
            {chips(required)} Returns To Your Wallet On Each Spin, Until The Seed Is Repaid. Then
            Every Chip Stays In The Pool To Fund Multipliers.
          </small>
          <small className="form-hint" style={{ display: 'block' }}>
            Required Seed {chips(required)} Chips. That Is Two Top Multiplier Jackpots At A Stake Of{' '}
            {maxStake}, So The Wallet Can Always Pay The Biggest Prize It Offers.
            {stillNeeded < required &&
              ` You Only Pay ${chips(stillNeeded)} Because ${chips(required - stillNeeded)} Is Already Here.`}
          </small>

          {canAct && (
            <button
              type="button"
              className="btn-primary"
              style={{ marginTop: 12 }}
              onClick={activate}
              disabled={busy}
            >
              {busy
                ? 'Working'
                : stillNeeded > 0
                  ? `Activate Spins And Seed ${chips(stillNeeded)}`
                  : 'Activate Spins'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
