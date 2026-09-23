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
import { compactChips } from '../../utils/format';
import './SpinActivationPanel.css';

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

/**
 * TWO WAYS TO PRINT CHIPS, AND WHICH ONE IS NOT A MATTER OF TASTE (2026-09-20).
 *
 * `chips` is for a figure the owner is committing to or being promised: the
 * seed the button will move, the bar, the repayment thresholds and the next
 * instalment. It is the whole number with thousands separators, never
 * abbreviated and never with decimals, and it rounds UP, because a quote that
 * understates a charge is the one direction a quote may never be wrong in.
 * It used to allow two decimals.
 *
 * `compactChips` (utils/format) is for the glance figures - balances and
 * running totals - and rounds down, so a balance is never overstated.
 */
const chips = (n: number | null | undefined) =>
  Math.ceil(Number(n ?? 0) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

/** Chips coming BACK to the owner: whole, unabbreviated, rounded down. */
const chipsReturned = (n: number | null | undefined) =>
  Math.floor(Number(n ?? 0) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function SpinActivationPanel({ clubId }: Props) {
  const toast = useToast();
  const [state, setState] = useState<SpinOwnerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [maxStake, setMaxStake] = useState<number>(10);
  const [wallet, setWallet] = useState<string>('chip_treasury');
  /** What the ROUTE says about this viewer. Null until the first read lands. */
  const [routeCanManage, setRouteCanManage] = useState<boolean | null>(null);
  /**
   * The last refusal, kept on the panel. A toast is gone in a few seconds; an
   * owner whose funding wallet cannot cover the seed needs the reason to still
   * be there when they look back at the form. Cleared on the next attempt.
   */
  const [actionError, setActionError] = useState<string | null>(null);

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
    setActionError(null);
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
      const message = err instanceof Error ? err.message : 'Could Not Activate Spins';
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    setActionError(null);
    try {
      if (!deactivateKeyRef.current) deactivateKeyRef.current = crypto.randomUUID();
      const response = await spinActivationApi.deactivate(clubId, deactivateKeyRef.current);
      deactivateKeyRef.current = null;
      const returned = Number(response.result.seed_returned ?? 0);
      toast.success(
        returned > 0
          ? `Spins Deactivated. ${chipsReturned(returned)} Seed Chips Returned To ${walletLabel(state?.owner_kind, state?.seed_source_wallet)}.`
          : 'Spins Deactivated. The Reserve Remains Locked Until Every Live Spin Is Settled.'
      );
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could Not Deactivate Spins';
      setActionError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="sap" aria-label="Spins">
        <h3 className="sap-title">Spins</h3>
        <p className="sap-note">Loading</p>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="sap" aria-label="Spins">
        <h3 className="sap-title">Spins</h3>
        <p className="sap-note">Spin Settings Are Not Available For This Club</p>
      </section>
    );
  }

  return (
    <section className="sap" aria-label="Spins">
      <h3 className="sap-title">Spins</h3>

      {isUnionOwned && !canAct && (
        <p className="sap-note">
          This Club Belongs To A Union, So The Spin Wallet Belongs To The Union. Only The Union Lead
          Can Change It.
        </p>
      )}

      {/* STATE IS TEXT, ACTIONS ARE BUTTONS. This was a span dressed as the
          page's On / Off toggle button with pointer-events switched off: it
          looked pressable and was not, right above the real control. The state
          now prints as a plain lit line and the only things that look like
          controls are the two that are. */}
      <dl className="sap-rows">
        <div className="sap-row">
          <dt className="sap-label">Status</dt>
          {state.is_active ? (
            <dd className="sap-value sap-value--on">Spins Are On</dd>
          ) : (
            <dd className="sap-value sap-value--off">Spins Are Off</dd>
          )}
        </div>
      </dl>

      {!state.is_active && state.seeded_amount > 0 && (
        <p className="sap-note">
          Seed Of {chips(state.seeded_amount)} Is Still In This Wallet From Before.{' '}
          {state.seed_is_repayable
            ? 'It Counts Toward What You Need, So Turning Spins Back On Will Not Charge You For It Again.'
            : 'It Has No Recorded Source Wallet, So It Cannot Be Returned Automatically.'}
        </p>
      )}

      {state.is_active ? (
        <>
          <dl className="sap-rows">
            <div className="sap-row">
              <dt className="sap-label">Wallet Balance</dt>
              <dd className="sap-value">{compactChips(state.balance)}</dd>
            </div>
            <div className="sap-row">
              <dt className="sap-label">Largest Stake Offered</dt>
              <dd className="sap-value">{compactChips(state.offered_max_stake)}</dd>
            </div>
            <div className="sap-row">
              <dt className="sap-label">Collected From Play</dt>
              <dd className="sap-value">{compactChips(state.collected_from_play)}</dd>
            </div>
            <div className="sap-row">
              <dt className="sap-label">Paid Out As Multipliers</dt>
              <dd className="sap-value">{compactChips(state.total_drawn)}</dd>
            </div>
            {state.seeded_amount > 0 && state.seed_is_repayable && (
              <>
                <div className="sap-row">
                  <dt className="sap-label">Seed Still Owed</dt>
                  <dd className="sap-value sap-value--held">{compactChips(state.seeded_amount)}</dd>
                </div>
                <div className="sap-row">
                  <dt className="sap-label">Returned So Far</dt>
                  <dd className="sap-value">{compactChips(state.seed_returned_amount)}</dd>
                </div>
              </>
            )}
          </dl>

          {state.seeded_amount > 0 && !state.seed_is_repayable ? (
            <p className="sap-note">
              Seed Outstanding {chips(state.seeded_amount)}. It Has No Recorded Source Wallet, So It
              Cannot Be Returned Automatically.
            </p>
          ) : state.seeded_amount > 0 ? (
            <>
              <p className="sap-note">
                Repayment Plan. Half Of Everything Above {chips(state.repay_floor)} Returns To{' '}
                {walletLabel(state.owner_kind, state.seed_source_wallet)} Each Time The Wallet
                Reaches {chips(state.repay_trigger_at)}, Until The Seed Is Square. The Floor Stays
                Behind So The Top Multiplier Is Always Payable.
              </p>
              <p className="sap-note">
                {state.next_instalment > 0
                  ? `Next Instalment ${chipsReturned(state.next_instalment)}, Due On The Next Spin.`
                  : `Next Instalment Once The Wallet Climbs Another ${chips(state.seed_repayable_in)}.`}
              </p>
            </>
          ) : (
            <p className="sap-note">
              Seed Of {chipsReturned(state.seed_returned_amount)} Has Been Returned. Every Chip
              Collected Now Stays Here To Fund Multipliers.
            </p>
          )}

          {actionError && (
            <p className="sap-error" role="alert">
              {actionError}
            </p>
          )}

          {canAct && (
            <button
              type="button"
              className="sap-action sap-action--off"
              onClick={deactivate}
              disabled={busy}
            >
              {busy ? 'Working' : 'Turn Spins Off'}
            </button>
          )}
        </>
      ) : (
        <>
          <p className="sap-note">
            Seed The Wallet To Open Spins. The Seed Is A Loan, Not A Fee. It Comes Back Once Play
            Has Collected As Much On Its Own. Turning Spins Off Also Returns Any Outstanding Seed As
            Soon As Every Live Spin Is Settled. Net Spin Proceeds Stay Here To Pay Multipliers.
          </p>

          <div className="sap-fields">
            <div className="sap-field">
              <label className="sap-label" htmlFor="spin-max-stake">
                Largest Stake To Offer
              </label>
              <select
                id="spin-max-stake"
                className="sap-select"
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
            <div className="sap-field">
              <label className="sap-label" htmlFor="spin-seed-source">
                Seed From
              </label>
              <select
                id="spin-seed-source"
                className="sap-select"
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

          <dl className="sap-rows">
            <div className="sap-row">
              <dt className="sap-label">Required Seed</dt>
              <dd className="sap-value">{chips(required)} Chips</dd>
            </div>
            {stillNeeded < required && (
              <div className="sap-row">
                <dt className="sap-label">Already In This Wallet</dt>
                <dd className="sap-value">{chipsReturned(required - stillNeeded)} Chips</dd>
              </div>
            )}
            <div className="sap-row">
              <dt className="sap-label">You Pay Now</dt>
              <dd className="sap-value sap-value--held">{chips(stillNeeded)} Chips</dd>
            </div>
          </dl>

          <p className="sap-note">
            How It Comes Back. Once The Wallet Reaches{' '}
            {chips(requiredSeedForStake(maxStake) * 1.25)}, Half Of Everything Above{' '}
            {chips(required)} Returns To Your Wallet On Each Spin, Until The Seed Is Repaid. Then
            Every Chip Stays In The Pool To Fund Multipliers.
          </p>
          <p className="sap-note">
            Required Seed {chips(required)} Chips. That Is Two Top Multiplier Jackpots At A Stake Of{' '}
            {maxStake}, So The Wallet Can Always Pay The Biggest Prize It Offers.
            {stillNeeded < required &&
              ` You Only Pay ${chips(stillNeeded)} Because ${chipsReturned(required - stillNeeded)} Is Already Here.`}
          </p>

          {actionError && (
            <p className="sap-error" role="alert">
              {actionError}
            </p>
          )}

          {canAct && (
            <button
              type="button"
              className="sap-action sap-action--on"
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
