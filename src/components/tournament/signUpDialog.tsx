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
 *  R7  AN UNREADABLE BALANCE IS NOT A BALANCE OF ZERO. The gate reads
 *      `WalletService.readPlayerBalance`, which returns `balance: null` when
 *      the read failed. `getPlayerBalance` returns 0 for every failure — RPC
 *      error, RLS denial, an unresolvable club id — and the first version of
 *      this file gated on it, so a funded player could be shown "Insufficient
 *      Balance" and a disabled Confirm because a query did not come back.
 *      Unknown must always fail OPEN; the server RPC is the real gate.
 *
 *  R6  THE BALANCE IS CLUB-SCOPED. `getPlayerBalance` defaults to the AMBIENT
 *      club, so a global-lobby or union buy-in read the wrong wallet and could
 *      disable Confirm for a player who is funded in the right one. The club is
 *      passed in, and an unreadable balance never blocks — the server RPC is
 *      the real gate.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import './signUpDialog.css';
import { WalletService } from '../../services/WalletService';
import { SpadeConsole } from '../console/SpadeConsole';
import { formatBuyIn, money, totalBuyIn } from '../../utils/buyIn';
import { reportError } from '../../utils/errorReporter';
import { formatPrizeAtUnit, moneyWordAtUnit } from '../../utils/format';
import { CHIP_UNIT_CENTS, normalizeUnitCents } from '../../../server/src/tournament/tournamentUnit';
const DiamondsToChipsButton = lazy(() => import('../games/DiamondsToChipsButton'));

export interface SignUpDialogOptions {
  /** Tournament name, shown as its own row. */
  name: string;
  /** `tournaments.buy_in_amount` — the prize-pool share. */
  buyInAmount: number;
  /** `tournaments.buy_in_fee` — the house cut. */
  buyInFee?: number | null;
  /** Bounty per head, when this is a bounty event. Omitted or 0 hides the row. */
  bountyAmount?: number | null;
  /**
   * THE UNIT THIS ENTRY IS PRICED IN (2026-09-21), read off the tournament's
   * own arena by `tournamentService.readTournamentUnitCents` - never guessed
   * from a figure. It decides two things on this card:
   *
   *   - the Bounty row's word. It printed "Chips" whatever the event was, so a
   *     Diamond bounty event offered a Chip head. At the chip unit the row is
   *     `money(...)` and "Chips", exactly as before; at a Diamond unit it is
   *     whole Diamonds and "Diamonds".
   *   - whether a CHIP WALLET is read at all. `fn_player_spendable_balance`
   *     falls back to the player's home chip club when the arena has no member
   *     row, so a Diamond sign-up printed a chip balance, gated Confirm on it
   *     and offered the chip cashier. A Diamond entry is paid from the Diamond
   *     wallet and refused by its own door in its own words
   *     (`insufficient_diamonds`), so no chip figure belongs on its card.
   *
   * `null` is "could not tell": the head shows the card's own unknown mark,
   * no wallet is read, and the gate fails open to the server, exactly as R7
   * already does for a balance that could not be read.
   */
  unitCents: number | null;
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
  /** Exact noncash entry instrument selected by the server before this opens. */
  tournamentTicketId?: string | null;
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

/**
 * The way out of an empty wallet, which needs the router to take it.
 * SignUpHost itself must NOT ask for the router: it is mounted once at the app
 * root and is rendered on its own by tests that have no Router around it, and
 * useNavigate throws there. Asking for it here keeps that dependency inside the
 * one branch that only ever renders inside the running app, and outside a
 * router the door simply is not offered, because there is nowhere to go.
 */
function SignUpDiamondsDoor({
  clubId,
  onGo,
}: {
  clubId: string | null;
  onGo: (path: string) => void;
}) {
  const inRouter = useInRouterContext();
  if (!inRouter) return null;
  return <SignUpDiamondsDoorRouted clubId={clubId} onGo={onGo} />;
}

function SignUpDiamondsDoorRouted({
  clubId,
  onGo,
}: {
  clubId: string | null;
  onGo: (path: string) => void;
}) {
  const navigate = useNavigate();
  return (
    <Suspense fallback={null}>
      <DiamondsToChipsButton
        clubId={clubId}
        size="compact"
        onGo={(path) => {
          onGo(path);
          navigate(path);
        }}
      />
    </Suspense>
  );
}

/** Mount ONCE at the app root, beside ConfirmHost. */
export function SignUpHost() {
  const [queue, setQueue] = useState<SignUpRequest[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  /**
   * THE QUEUE ITSELF. `queue` state exists only to trigger a render.
   *
   * R8 (2026-08-25, second audit): this ref used to be synced DURING RENDER
   * (`queueRef.current = queue`), which meant it lagged the truth by one
   * commit. A request enqueued in the same batch as an unmount was therefore
   * invisible to the cleanup below and its promise hung forever — which is
   * precisely the R3 failure, surviving R3's fix. It also made `settle` unable
   * to see a request that had only just been enqueued.
   *
   * The ref is now written SYNCHRONOUSLY by `enqueue` and by `settle`, before
   * any state update, so it is never behind. Writing a ref during render is
   * also forbidden by React (a discarded speculative render still mutates it),
   * and this removes the last one in the file.
   */
  const queueRef = useRef<SignUpRequest[]>([]);
  /** Ids already answered, so a second settle for the same request is a no-op. */
  const settledRef = useRef<Set<number>>(new Set());
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** Where focus was before we stole it, so it can be given back. */
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    const mine = (req: SignUpRequest) => {
      // Ref first, synchronously — see R8. State second, purely to re-render.
      queueRef.current = [...queueRef.current, req];
      setQueue(queueRef.current);
    };
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
  const usesTournamentTicket = Boolean(current?.opts.tournamentTicketId);
  /* A chip wallet belongs on this card only when the entry is priced in chips.
     `undefined` (an options object built without a unit) is treated as the
     unread answer it is. */
  const unitCents = current?.opts.unitCents ?? null;
  const pricedInChips = unitCents !== null && normalizeUnitCents(unitCents) === CHIP_UNIT_CENTS;
  const pricedInDiamonds = unitCents !== null && !pricedInChips;

  /**
   * R1 + R2: resolve OUTSIDE the state updater, and only ever for the request
   * whose id was captured when the control was rendered.
   */
  const settle = useCallback((id: number, result: boolean) => {
    if (settledRef.current.has(id)) return;
    settledRef.current.add(id);
    const req = queueRef.current.find((r) => r.id === id);
    queueRef.current = queueRef.current.filter((r) => r.id !== id);
    if (req) req.resolve(result);
    setQueue(queueRef.current);
  }, []);

  // Read the balance when a request becomes current, not when the host mounts —
  // a figure fetched at app start would be stale by the time anyone buys in.
  useEffect(() => {
    let alive = true;
    if (!current || !userId || usesTournamentTicket || !pricedInChips) {
      setBalance(null);
      return;
    }
    setBalance(null);
    (async () => {
      try {
        /* R6: the club that owns this buy-in, not whichever club is ambient.
           R7: `readPlayerBalance`, NOT `getPlayerBalance` — see that method.
           getPlayerBalance collapses every failure into the number 0, so a
           refused RPC, an unresolvable club id or a dropped connection all
           arrived here as "you have no chips" and DISABLED Confirm for a
           funded player. `balance: null` means we could not find out, and the
           gate below treats that as unknown rather than as zero. */
        const r = await WalletService.readPlayerBalance(userId, { clubId });
        if (alive) setBalance(r.balance);
      } catch (e) {
        // readPlayerBalance already reports its own failures and returns null,
        // so this only catches something truly unexpected. Same rule: unknown,
        // never zero.
        reportError(e, 'SignUpHost.balance', { userId });
        if (alive) setBalance(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [current, userId, clubId, usesTournamentTicket, pricedInChips]);

  // Escape cancels, like every other dialog in the app.
  useEffect(() => {
    if (!current) return;
    const id = current.id;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        /* NOT `stopPropagation`. This listener is on `window` in the CAPTURE
           phase, which is the very first node in the propagation path, so
           stopping it there blocked Escape for EVERY deeper listener in the app
           — React's synthetic root included — for as long as this dialog was
           open. Cancelling the dialog is all that is wanted; nothing else in
           the tree is above it to conflict with. */
        e.preventDefault();
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
      /* `inside` deliberately EXCLUDES the card element itself. When Confirm is
         disabled the open-effect focuses the card as a fallback, and
         `card.contains(card)` is true — so the old test thought focus was
         already inside a control and trapped nothing, letting Shift+Tab walk
         out onto the page behind a dialog that takes money. Anything that is
         not one of the buttons is treated as outside and pulled back in. */
      const inside =
        active instanceof Node && active !== cardRef.current
          ? cardRef.current.contains(active)
          : false;
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
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
  const short = !usesTournamentTicket && balance !== null && balance < cost;
  /* The head, at the entry's unit. `--` is this card's own unknown mark, the
     one the balance row has always used for a figure it could not read. */
  const headText =
    unitCents === null
      ? '--'
      : `${
          pricedInChips ? money(o.bountyAmount || 0) : formatPrizeAtUnit(o.bountyAmount, unitCents)
        } ${moneyWordAtUnit(unitCents)}`;

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
        {/* THE CONSOLE (#ClubArenaConsole, 2026-09-08). The card is Dan's
            approved spade master: the tournament name is the eyebrow, SIGN UP
            or LATE REGISTER is engraved in the header well, the state sits in
            the well's painted pill slot, the money prints as rows on the black
            glass, and CANCEL / CONFIRM are the two plates painted into the
            foot. `btn-confirm` stays on the primary plate because the
            open-effect above focuses it by that exact selector, and the focus
            trap cycles `button:not([disabled])` inside this card - both plates
            are buttons, so both are still trapped. The global `btn` dress is
            NOT on them: the plate is painted in the art and paints nothing
            itself, and `.btn`'s `justify-content: center` stops the plate's
            grid track from stretching, which collapsed the label's face to a
            fraction of the text and clipped CANCEL and CONFIRM (measured
            2026-09-13: a 25.8px face under a 36.9px word). The X in the corner
            is the console's own painted close zone (Dan 2026-09-23: "an X in
            the top right of every popup"), and it settles FALSE exactly as
            Cancel, Escape and the backdrop do - it is not a third foot
            control. */}
        <SpadeConsole
          onClose={() => settle(id, false)}
          as="div"
          className="signup-console"
          eyebrow={o.name}
          title={o.isLateRegistration ? 'Late Register' : 'Sign Up'}
          titleId={`signup-title-${id}`}
          pill={short ? 'Short' : o.isLateRegistration ? 'Late' : 'Entry'}
          pillInk={short ? 'red' : o.isLateRegistration ? 'gold' : 'blue'}
          plates={{
            secondary: {
              label: 'Cancel',
              className: 'btn-cancel',
              onClick: () => settle(id, false),
              'aria-label': 'Cancel Sign Up',
            },
            primary: {
              label: 'Confirm',
              ink: 'white' as const,
              className: 'btn-confirm',
              onClick: () => settle(id, true),
              disabled: short,
            },
          }}
        >
          <div className="signup-row">
            <span className="signup-label sc-label sc-ink--blue">Tournament</span>
            <span className="signup-value sc-ink--silver">{o.name}</span>
          </div>

          {usesTournamentTicket ? (
            /* The server already picked the exact ticket; no chips move, so
               there is no figure to print and no balance to gate on. */
            <div className="signup-row total">
              <span className="signup-label sc-label sc-ink--blue">Entry</span>
              <span className="signup-value sc-ink--silver">Tournament Ticket</span>
            </div>
          ) : (
            /* One line, not three. The player is deciding on the TOTAL; where it
               splits is the second question. See utils/buyIn formatBuyIn.
               EXACT, never compacted: this is the figure the server charges. */
            <div className="signup-row total">
              <span className="signup-label sc-label sc-ink--blue">Entry Fee</span>
              <span className="signup-value sc-ink--silver">
                {formatBuyIn(o.buyInAmount, o.buyInFee ?? 0)}
              </span>
            </div>
          )}

          {(o.bountyAmount ?? 0) > 0 && (
            <div className="signup-row">
              <span className="signup-label sc-label sc-ink--blue">Bounty</span>
              <span className="signup-value signup-value--bounty">
                {headText}
                {o.isPko && ' (PKO)'}
                {o.isMysteryBounty && ' (Mystery)'}
              </span>
            </div>
          )}

          {startLabel && (
            <div className="signup-row">
              <span className="signup-label sc-label sc-ink--blue">Start Time</span>
              <span className="signup-value sc-ink--silver">{startLabel}</span>
            </div>
          )}

          {o.userId && !usesTournamentTicket && !pricedInDiamonds && (
            <div className="signup-row">
              <span className="signup-label sc-label sc-ink--blue">Your Balance</span>
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
          {short && (
            <SignUpDiamondsDoor
              clubId={clubId}
              onGo={() => {
                settle(id, false);
              }}
            />
          )}
          {/* Only true for a scheduled event you are entering BEFORE the off.
              A late registration cannot be unregistered, and an SNG or Spin has
              no scheduled boundary for the rule to describe. */}
          {!o.isLateRegistration && !!startLabel && (
            <p className="signup-note">You Can Unregister Any Time Before The Tournament Starts</p>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}

export default signUpDialog;
