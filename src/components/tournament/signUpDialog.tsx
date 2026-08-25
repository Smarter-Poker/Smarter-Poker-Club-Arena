/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  signUpDialog — THE tournament buy-in confirmation. There is only one.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25 (binding): "You don't need a secondary confirmation for buy
 * ins. That's not needed."
 *
 * WHAT HE WAS SEEING. Registering from the tournament details page asked twice:
 *
 *   1. `TournamentDetails`' own "Sign Up" card — entry fee, bounty, start time,
 *      wallet balance, the unregister warning. Confirm.
 *   2. and then, immediately, `useTournamentRegistration.register`'s generic
 *      `confirmDialog({ title: 'Confirm Buy In' })` — "Register for X? This
 *      will debit 50 from your wallet." Confirm again.
 *
 * The two were unaware of each other: (1) lived in the page's local state, (2)
 * was buried in the hook every register button in the app funnels through. So
 * every path that used the hook WITHOUT its own card showed only the terse one,
 * and the one page with the good card showed both.
 *
 * Deleting (2) outright would have left those other paths taking money with no
 * confirmation at all. So instead the GOOD card is promoted to be the single
 * confirmation, and the hook shows it: one dialog, everywhere, with the numbers
 * a player actually needs before spending.
 *
 * Same imperative shape as `confirmDialog` — one `<SignUpHost/>` at the app
 * root, `await signUpDialog(...)` from anywhere, resolves true on Confirm and
 * false on cancel / backdrop / escape.
 *
 * ─── THIS FILE TAKES MONEY. THE RULES IT OBEYS ───────────────────────────────
 *
 * Every one of these is a defect found in the first version of this file during
 * an adversarial audit on 2026-08-25, hours after it shipped. Read them before
 * changing anything here.
 *
 *  R1  ONE REQUEST, ONE ANSWER. `settle` takes the request id it is answering
 *      and ignores anything that is not the current head. The first version
 *      popped the head unconditionally, so two settles in one React batch (a
 *      double-tapped Confirm, or Escape landing in the same batch as a click)
 *      resolved request #1 AND silently resolved queued request #2 `true` —
 *      confirming a buy-in for a tournament whose card the player never saw.
 *
 *  R2  NEVER RESOLVE INSIDE A STATE UPDATER. `head.resolve(...)` used to run
 *      inside the `setQueue` updater. React runs updaters twice under
 *      StrictMode and may discard a render under concurrent rendering; the
 *      thing on the other end of that resolve debits a wallet. Resolution now
 *      happens in the event handler, before the state change.
 *
 *  R3  A PENDING PROMISE MUST ALWAYS SETTLE. Unmount drains the queue and
 *      resolves everything `false`. The first version dropped them, and the
 *      caller (`useTournamentRegistration`) awaits this AFTER flipping its
 *      re-entrancy ref — so one hung promise bricked that Register button for
 *      the rest of the session, silently.
 *
 *  R4  ONE HOST WINS. The unmount cleanup only clears the module bridge if it
 *      still points at this host, so a remount during HMR cannot null out the
 *      live one.
 *
 *  R5  ON TOP OF EVERYTHING. z-index is the highest in the app. The first
 *      version used 1000 and the app has ~20 overlays above that, including the
 *      offline banner at 9999 — the sole buy-in confirmation was paintable-over.
 *
 *  R6  THE BALANCE IS CLUB-SCOPED. `getPlayerBalance` defaults to the AMBIENT
 *      club, so a global-lobby or union buy-in read the wrong wallet and could
 *      disable Confirm for a player who is funded in the right one. The club is
 *      passed in, and an unreadable balance never blocks — the server RPC is
 *      the real gate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import './signUpDialog.css';
import { WalletService } from '../../services/WalletService';
import { formatBuyIn, money, totalBuyIn } from '../../utils/buyIn';
import { reportError } from '../../utils/errorReporter';

export interface SignUpDialogOptions {
  /** Tournament name, shown as its own row. */
  name: string;
  /** `tournaments.buy_in_amount` — the prize-pool share. */
  buyInAmount: number;
  /** `tournaments.buy_in_fee` — the house cut. */
  buyInFee?: number | null;
  /** Bounty per head, when this is a bounty event. Omitted or 0 hides the row. */
  bountyAmount?: number | null;
  isPko?: boolean;
  isMysteryBounty?: boolean;
  /** ISO start time. Omitted hides the row (a Sit & Go has no clock). */
  startTime?: string | null;
  /** Whose wallet to check. Omitted skips the balance row and the funds gate. */
  userId?: string | null;
  /**
   * Which club's chips this buy-in spends. See R6 — without it the balance is
   * read against whatever club the player was last looking at, which is the
   * wrong wallet for a global-lobby, XMTT or union-games entry.
   */
  clubId?: string | null;
  /** Late registration reads differently from signing up before the off. */
  isLateRegistration?: boolean;
}

interface SignUpRequest {
  id: number;
  opts: SignUpDialogOptions;
  resolve: (value: boolean) => void;
}

let enqueue: ((req: SignUpRequest) => void) | null = null;
let counter = 0;

/**
 * Ask the player to confirm a tournament buy-in. Resolves true on confirm.
 *
 * Resolves FALSE when the host is not mounted. Never falls back to registering
 * unconfirmed: a missing dialog must cost a player nothing.
 */
export function signUpDialog(opts: SignUpDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      console.warn('[signUpDialog] SignUpHost not mounted - resolving false');
      resolve(false);
      return;
    }
    enqueue({ id: ++counter, opts, resolve });
  });
}

function formatStart(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Mount ONCE at the app root, beside ConfirmHost. */
export function SignUpHost() {
  const [queue, setQueue] = useState<SignUpRequest[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  /** The queue, readable from an unmount cleanup that must not re-subscribe. */
  const queueRef = useRef<SignUpRequest[]>([]);
  queueRef.current = queue;
  /** Ids already answered, so a second settle for the same request is a no-op. */
  const settledRef = useRef<Set<number>>(new Set());
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** Where focus was before we stole it, so it can be given back. */
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    const mine = (req: SignUpRequest) => setQueue((q) => [...q, req]);
    enqueue = mine;
    return () => {
      // R4: only stand down if this host is still the live one.
      if (enqueue === mine) enqueue = null;
      // R3: nothing may be left hanging. A pending buy-in prompt that never
      // settles brings its caller's Register button down with it.
      const pending = queueRef.current;
      queueRef.current = [];
      for (const req of pending) {
        if (settledRef.current.has(req.id)) continue;
        settledRef.current.add(req.id);
        req.resolve(false);
      }
    };
  }, []);

  const current = queue[0] || null;
  const userId = current?.opts.userId;
  const clubId = current?.opts.clubId ?? null;

  /**
   * R1 + R2: resolve OUTSIDE the state updater, and only ever for the request
   * whose id was captured when the control was rendered.
   */
  const settle = useCallback((id: number, result: boolean) => {
    if (settledRef.current.has(id)) return;
    settledRef.current.add(id);
    const req = queueRef.current.find((r) => r.id === id);
    if (req) req.resolve(result);
    setQueue((q) => q.filter((r) => r.id !== id));
  }, []);

  // Read the balance when a request becomes current, not when the host mounts —
  // a figure fetched at app start would be stale by the time anyone buys in.
  useEffect(() => {
    let alive = true;
    if (!current || !userId) {
      setBalance(null);
      return;
    }
    setBalance(null);
    (async () => {
      try {
        // R6: the club that owns this buy-in, not whichever club is ambient.
        const b = await WalletService.getPlayerBalance(userId, { clubId });
        if (alive) setBalance(Number(b) || 0);
      } catch (e) {
        // A balance we could not read must not silently read as zero, which
        // would gate a funded player out of a game they can afford. Null keeps
        // the row honest ("--") and leaves the button enabled; the server RPC
        // is the real gate and refuses an underfunded entry anyway.
        reportError(e, 'SignUpHost.balance', { userId });
        if (alive) setBalance(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [current, userId, clubId]);

  // Escape cancels, like every other dialog in the app.
  useEffect(() => {
    if (!current) return;
    const id = current.id;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        settle(id, false);
        return;
      }
      // A modal that takes money must not let Tab wander onto the page behind
      // it. Two focusables (Cancel, Confirm) plus the close button, cycled.
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusables = cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled])');
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !cardRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current, settle]);

  // Move focus in when a card opens, and hand it back when it closes.
  useEffect(() => {
    if (!current) return;
    restoreFocusRef.current = document.activeElement;
    const t = setTimeout(() => {
      const btn = cardRef.current?.querySelector<HTMLElement>('.btn-confirm:not([disabled])');
      (btn ?? cardRef.current)?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      const back = restoreFocusRef.current as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [current]);

  if (!current) return null;

  const o = current.opts;
  const id = current.id;
  const cost = totalBuyIn(o.buyInAmount, o.buyInFee ?? 0);
  const startLabel = formatStart(o.startTime);
  const short = balance !== null && balance < cost;

  return (
    <div className="signup-overlay" onClick={() => settle(id, false)}>
      <div
        className="signup-modal"
        ref={cardRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`signup-title-${id}`}
      >
        <button
          type="button"
          className="modal-close"
          onClick={() => settle(id, false)}
          aria-label="Close"
        >
          ✕
        </button>
        <h2 id={`signup-title-${id}`}>{o.isLateRegistration ? 'Late Register' : 'Sign Up'}</h2>

        <div className="signup-row">
          <span className="signup-label">Tournament:</span>
          <span className="signup-value">{o.name}</span>
        </div>

        {/* One line, not three. The player is deciding on the TOTAL; where it
            splits is the second question. See utils/buyIn formatBuyIn. */}
        <div className="signup-row total">
          <span className="signup-label">Entry Fee:</span>
          <span className="signup-value">{formatBuyIn(o.buyInAmount, o.buyInFee ?? 0)}</span>
        </div>

        {(o.bountyAmount ?? 0) > 0 && (
          <div className="signup-row">
            <span className="signup-label">Bounty:</span>
            <span className="signup-value signup-value--bounty">
              {money(o.bountyAmount || 0)} Chips
              {o.isPko && ' (PKO)'}
              {o.isMysteryBounty && ' (Mystery)'}
            </span>
          </div>
        )}

        {startLabel && (
          <div className="signup-row">
            <span className="signup-label">Start Time:</span>
            <span className="signup-value">{startLabel}</span>
          </div>
        )}

        {o.userId && (
          <div className="signup-row">
            <span className="signup-label">Your Balance:</span>
            <span
              className={`signup-value${
                balance === null ? '' : short ? ' signup-value--short' : ' signup-value--ok'
              }`}
            >
              {balance === null ? '--' : `${money(balance)} Chips`}
            </span>
          </div>
        )}

        {short && (
          <p className="signup-note signup-note--error" role="alert">
            Insufficient Balance. Please Add Chips Via Your Cashier.
          </p>
        )}
        {/* Only true for a scheduled event you are entering BEFORE the off.
            A late registration cannot be unregistered at all, and an SNG or
            Spin has no start time for the rule to be about. Printing it in
            those cases was telling the player something untrue. */}
        {!o.isLateRegistration && !!startLabel && (
          <p className="signup-note">Cannot Unregister Within 1 Minute Of The Start Time</p>
        )}

        <div className="signup-actions">
          <button type="button" className="btn btn-cancel" onClick={() => settle(id, false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-confirm"
            onClick={() => settle(id, true)}
            disabled={short}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

export default signUpDialog;
