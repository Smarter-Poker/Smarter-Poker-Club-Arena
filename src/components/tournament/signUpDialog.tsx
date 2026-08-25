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
 * every path that used the hook WITHOUT its own card (the club lobby, the
 * tournament page, XMTT, union games) showed only the terse one, and the one
 * page with the good card showed both.
 *
 * Deleting (2) outright would have left those other four paths taking money
 * with no confirmation at all. So instead the GOOD card is promoted to be the
 * single confirmation, and the hook shows it: one dialog, everywhere, with the
 * numbers a player actually needs before spending.
 *
 * Same imperative shape as `confirmDialog` — one `<SignUpHost/>` at the app
 * root, `await signUpDialog(...)` from anywhere, resolves true on Confirm and
 * false on cancel / backdrop / escape. Concurrent calls queue rather than
 * stomping each other.
 *
 * The markup and class names are deliberately identical to the card that used
 * to live inline in TournamentDetails, so `TournamentDetails.css` (SIGN UP
 * MODAL section) styles this and there is exactly one stylesheet for it too.
 */

import { useCallback, useEffect, useState } from 'react';
import './signUpDialog.css';
import { WalletService } from '../../services/WalletService';
import { formatBuyIn, money, totalBuyIn } from '../../utils/buyIn';
import { reportError } from '../../utils/errorReporter';

export interface SignUpDialogOptions {
  /** Tournament name, shown as the sub-heading. */
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

  useEffect(() => {
    enqueue = (req: SignUpRequest) => setQueue((q) => [...q, req]);
    return () => {
      enqueue = null;
    };
  }, []);

  const current = queue[0] || null;
  const userId = current?.opts.userId;

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
        const b = await WalletService.getPlayerBalance(userId);
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
    // `current` itself, not `current?.id`: the head of the queue is a stable
    // object for as long as it is the head, and depending on the object is what
    // lets the effect see the same request the render is showing.
  }, [current, userId]);

  const settle = useCallback((result: boolean) => {
    setQueue((q) => {
      const [head, ...rest] = q;
      if (head) head.resolve(result);
      return rest;
    });
  }, []);

  // Escape cancels, like every other dialog in the app.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, settle]);

  if (!current) return null;

  const o = current.opts;
  const cost = totalBuyIn(o.buyInAmount, o.buyInFee ?? 0);
  const startLabel = formatStart(o.startTime);
  const short = balance !== null && balance < cost;

  return (
    /* `signup-overlay`, not the app-wide `modal-overlay`: five other
       stylesheets declare `.modal-overlay` and whichever loads last would win,
       which is exactly the kind of accident that left this dialog unstyled in
       the first place. Its own class cannot be reached by any of them. */
    <div className="signup-overlay" onClick={() => settle(false)}>
      <div
        className="signup-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm tournament buy in"
      >
        <button className="modal-close" onClick={() => settle(false)} aria-label="Close">
          ✕
        </button>
        <h2>{o.isLateRegistration ? 'Late Register' : 'Sign Up'}</h2>

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
            <span className="signup-value" style={{ color: '#f87171' }}>
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
              className="signup-value"
              style={{ color: balance === null ? '#9aa9b8' : short ? '#ef4444' : '#10b981' }}
            >
              {balance === null ? '--' : `${money(balance)} Chips`}
            </span>
          </div>
        )}

        {short && (
          <p className="signup-note" style={{ color: '#ef4444' }}>
            Insufficient Balance. Please Add Chips Via Your Cashier.
          </p>
        )}
        <p className="signup-note">Cannot Unregister Within 1 Minute Of The Start Time</p>

        <div className="signup-actions">
          <button className="btn btn-cancel" onClick={() => settle(false)}>
            Cancel
          </button>
          <button className="btn btn-confirm" onClick={() => settle(true)} disabled={short}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

export default signUpDialog;
