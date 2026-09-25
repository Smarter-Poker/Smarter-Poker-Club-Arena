/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPOSIT/WITHDRAW MODAL - the chips-in and chips-out sheet
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ON THE MASTER (#ClubArenaConsole). This was a rounded navy bottom sheet with
 * a drag handle, an amber progress bar drawn from three inline divs, a filled
 * balance strip, six rounded quick-amount pills, a gradient Continue button and
 * a green gradient disc with a tick inside it. It is the spade console now:
 * ADD CHIPS / CASH OUT CHIPS is engraved in the header well, the stage the
 * request has reached sits in the well's painted pill slot, the balance, the
 * amount, the limits and the summary print on the black glass between the
 * rails, and the two actions per step are the plates painted into the foot.
 * The three-step indicator is PRINTED - the step names, ink by state - because
 * the master paints no bars, and the success tick is the word instead of a
 * disc.
 *
 * NOTHING ABOUT THE MONEY MOVED. Every guard, focus trap, body-scroll lock,
 * idempotency key and limit below is the one that was here before. Every
 * figure on this sheet is a term of the request - the balance it is checked
 * against, the minimum and maximum it must sit between, the amount that will
 * be asked for - so every one of them stays exact and none is abbreviated.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../common/Toast';
import { SpadeConsole } from '../console/SpadeConsole';
import styles from './DepositWithdrawModal.module.css';
import { reportError } from '../../utils/errorReporter';
import { fireVibration } from '../../utils/vibrationGate';
import { uuid } from '../../utils/uuid';

// Haptic feedback utility for mobile-first financial interactions
const triggerHaptic = (pattern: number | number[] = 10) => {
  try {
    // AUDIT 2026-08-20: private copy that called navigator.vibrate directly,
    // so neither vibration switch reached it. Routed through the shared gate.
    fireVibration(pattern);
  } catch (err) {
    reportError(err, 'DepositWithdrawModal.Error');
    /* silent - not all devices support vibration */
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

type Mode = 'deposit' | 'withdraw';

/**
 * ══ THE AGENT IS THE ONLY CHIP PATH. Dan, 2026-09-04, BINDING. ═══════════════
 *
 * Dan, verbatim: "PLAYERS CAN CASH OUT THEIR CHIPS WITH AN AGENT FOR REAL WORLD
 * PRIZES, SMARTER.POKER NEVER RECEIVES PAYOUTS OR TAKES PAYMENT DIRECTLY FOR ANY
 * CLUB ARENA PLAY."
 *
 * This type used to read `'crypto' | 'venmo' | 'zelle' | 'cashapp' | 'agent'`,
 * and the catalog below carried the platform's own handles for four of them:
 * Venmo `@ClubArena`, Zelle `Pay@Clubarena.Com`, Cash App `$ClubArena`, and a
 * crypto wallet address field. Every one of those said, to any player or any
 * app reviewer who opened the sheet, that Club Arena takes money directly. It
 * does not, it never has, and the product's own disclaimer says so twice:
 *
 *   ClubArenaWelcomeModal.tsx:83-89 - "Club Arena Is Not Responsible For Any
 *   Interactions Or Arrangements Between Club Members" and "Club Owners And
 *   Operators Are Independent And Not Affiliated With Or Endorsed By Club
 *   Arena."
 *
 * An arrangement between a player and their agent is exactly the interaction
 * that clause describes, and it happens off this platform. A branded Zelle
 * address on a Club Arena screen is the opposite claim.
 *
 * So the four direct rails are DELETED, not disabled and not feature-flagged.
 * A flag can be flipped and a commented-out rail gets uncommented; neither
 * survives the next agent who reads this file looking for "the payment
 * methods". There is one method because there is one path.
 *
 * DO NOT ADD A PAYMENT RAIL HERE. If Club Arena ever needs to take money
 * directly, that is a licensing decision of Dan's, not a component change, and
 * it arrives with a server route (see FUNDING_ENDPOINT below) rather than a new
 * entry in this union.
 */
type PaymentMethod = 'agent';

interface DepositWithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: Mode;
  userId: string;
  currentBalance: number;
  onComplete?: () => void;
}

interface PaymentMethodInfo {
  id: PaymentMethod;
  icon: string;
  label: string;
  description: string;
  minAmount: number;
  maxAmount: number;
  fee: number; // percentage
  processingTime: string;
}

/* Four branded third-party logos used to live here - Bitcoin orange, Venmo
   blue, Zelle purple, Cash App green - under a banner calling them "high-trust
   payment method icons". They were doing trust-transfer work for a claim that
   was not true: none of those companies has any relationship with Club Arena,
   and Club Arena takes no payment through any of them. Deleted with the rails
   they belonged to. The one path left is not an icon at all now: an emblem is
   part of the render or it is not there, and the master paints its own crest,
   so the agent path is stated in words on the glass. */

/** The stages a request passes through. `method` was the first of four until
    2026-09-04; with one path there is nothing to choose, and a select screen
    offering a single card is a step that exists only to be clicked past. */
type Step = 'amount' | 'confirm' | 'success';

const STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: 'amount', label: 'Amount' },
  { key: 'confirm', label: 'Confirm' },
  { key: 'success', label: 'Done' },
];

/**
 * PRINTED, NOT DRAWN. Three inline-styled bars with a border-radius and a
 * colour ramp used to sit here. The master paints no bars, so the three stages
 * are printed instead and the INK carries the state: green behind you, white
 * where you are, muted ahead of you.
 */
const StepProgress = ({ current }: { current: Step }) => {
  const currentIdx = STEP_LABELS.findIndex((s) => s.key === current);
  return (
    <ol className={styles.steps} aria-label="Progress">
      {STEP_LABELS.map((s, i) => (
        <li
          key={s.key}
          className={`${styles.step} ${
            i < currentIdx ? 'sc-ink--green' : i === currentIdx ? 'sc-ink--white' : 'sc-ink--muted'
          }`}
          aria-current={i === currentIdx ? 'step' : undefined}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
};

/**
 * The server route that would accept a funding request. `null` means there is
 * none - see the block comment on handleConfirm for the four separate reasons
 * the old direct `wallet_transactions` insert could never work, and why it must
 * not simply be repaired into working. Set this to the route path once it
 * exists and the POST below starts carrying real requests.
 */
const FUNDING_ENDPOINT: string | null = null;

/**
 * ONE ENTRY, ON PURPOSE. See the note on PaymentMethod above before adding a
 * second. The `fee` stays on the shape because the confirm screen reads it, but
 * an agent transfer carries none: Club Arena is not in the middle of it and has
 * nothing to charge for.
 */
const AGENT_METHOD: PaymentMethodInfo = {
  id: 'agent',
  icon: '',
  label: 'Agent',
  description: 'Transfer Through Your Agent',
  minAmount: 10,
  maxAmount: 50000,
  fee: 0,
  processingTime: 'Instant',
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function DepositWithdrawModal({
  isOpen,
  onClose,
  mode,
  userId,
  currentBalance,
  onComplete,
}: DepositWithdrawModalProps) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('amount');
  /* Not nullable any more. There is exactly one method, so the sheet opens with
     it already chosen rather than asking a question with one answer. */
  const selectedMethod: PaymentMethod = 'agent';
  const [amount, setAmount] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Withdrawal-specific fields
  const [withdrawAddress, setWithdrawAddress] = useState('');

  /**
   * THE ENTRANCE IS CSS NOW, AND IT ACTUALLY PLAYS.
   *
   * A `mounted` state, a 50ms timer and a render per open used to gate an
   * INLINE animation property whose value was a raw string naming a keyframe
   * declared in this component's .module.css. CSS Modules hashes keyframe
   * names, so that string could never resolve: the declaration was dropped,
   * the sheet has not animated in for as long as the rule has existed, and all
   * the state bought was a 50ms translate before it appeared. The same timer
   * and the same dead entrance were deleted from CashoutRequestModal for the
   * same reason. It is one rule on `.modal` in the stylesheet now, declared and
   * applied in the same file, so it resolves and it plays every time.
   */

  // ── Close handler: resets all form state and calls parent onClose ──
  const handleClose = useCallback(() => {
    setStep('amount');
    setAmount('');
    setError(null);
    setReferenceId(null);
    setWithdrawAddress('');
    onClose();
  }, [onClose]);

  // ── Focus Trap: trap focus inside modal when open ──
  const handleFocusTrap = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key !== 'Tab' || !modalRef.current) return;

      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [handleClose]
  );

  /* THE EFFECT BELOW MUST DEPEND ON `isOpen` AND NOTHING ELSE.
     It used to list `handleFocusTrap`, which is a useCallback on `handleClose`,
     which is a useCallback on the `onClose` PROP - and PlayerWalletPage passes
     `onClose={() => setShowDepositModal(false)}`, a fresh arrow on every one of
     its renders. That page also runs three `useAnimatedNumber` counters, so it
     re-renders at 60fps whenever a balance moves. The effect therefore tore
     itself down and rebuilt sixty times a second while the sheet was open:
     the keydown listener was churned, the 100ms autofocus timer was cancelled
     and restarted before it could ever fire (so the sheet never focused
     anything), and the cleanup's `previousFocusRef.current?.focus()` ran on
     every one of those passes - pulling focus back out of the modal, from
     inside an open modal, while the user was typing an amount into it.

     The handler goes in a ref instead: one stable listener for the life of the
     open sheet, one restore of focus when it actually closes. */
  const focusTrapRef = useRef(handleFocusTrap);
  useEffect(() => {
    focusTrapRef.current = handleFocusTrap;
  }, [handleFocusTrap]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement;
    const onKeyDown = (e: KeyboardEvent) => focusTrapRef.current(e);
    document.addEventListener('keydown', onKeyDown);
    const t = setTimeout(() => {
      if (modalRef.current) {
        const first = modalRef.current.querySelector<HTMLElement>(
          'button:not([disabled]), input:not([disabled])'
        );
        first?.focus();
      }
    }, 100);
    /* The page behind a bottom sheet must not scroll under it. Every other
       modal in the wallet family does this (PlayerWalletModal locks it on the
       same `isOpen`); this one did not, so dragging the sheet on a phone
       scrolled the wallet page underneath and left the sheet floating over a
       different part of the document. */
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  const currentMethod = AGENT_METHOD;
  const parsed = parseFloat(amount);
  const numericAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  // Use integer math to avoid floating-point precision errors:
  // fee = round((amount_cents * fee_percent) / 100) / 100
  const feeAmount = currentMethod ? Math.round(numericAmount * currentMethod.fee) / 100 : 0;
  /* `totalAmount` used to be computed here and never read once. It was also
     WRONG: it said a withdrawal costs `amount + fee`, while the confirm screen
     below says you receive `amount - fee` and the balance check compares the
     bare `amount`. Two contradictory fee models in one component, with the
     unused one quietly waiting for somebody to render it. Deleted rather than
     reconciled - the confirm screen and the balance check already agree with
     each other, and they are the two the player actually sees. */

  const handleAmountSubmit = () => {
    if (!currentMethod) return;

    // Casing: Dan's popup law is about what the player reads, not about which
    // component renders it. These four are in-page messages, so the Toast
    // layer's formatPopupText never reached them and they alone on this screen
    // were in sentence case.
    if (numericAmount < currentMethod.minAmount) {
      setError(`Minimum Amount Is ${currentMethod.minAmount.toLocaleString()}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    if (numericAmount > currentMethod.maxAmount) {
      setError(`Maximum Amount Is ${currentMethod.maxAmount.toLocaleString()}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    if (mode === 'withdraw' && numericAmount > currentBalance) {
      setError(`Insufficient Balance. Available: ${currentBalance.toLocaleString()}`);
      triggerHaptic([30, 50, 30]);
      return;
    }
    /* The destination check that stood here required an address for every
       method EXCEPT agent, so with the four direct rails gone it could never
       fire again. An agent already knows who its own player is; the Agent ID
       field below stays available for a player who wants to name one, and stays
       optional exactly as it always was for this method. */

    triggerHaptic(15);
    setStep('confirm');
    setError(null);
  };

  /**
   * ══ THE CONFIRM STEP COULD NOT SUCCEED. AUDIT 2026-08-25. ══════════════════
   *
   * It inserted into `wallet_transactions` and that insert was impossible in
   * FOUR independent ways, every one of them verified against production:
   *
   *  1. RLS. `wallet_transactions` carries exactly one policy - "Users view own
   *     transactions", cmd SELECT. There is no INSERT policy for `public` or
   *     `authenticated`, so the write returned 42501 every single time. This is
   *     the same control WalletService.logTransaction documents at length: the
   *     browser is deliberately not allowed to forge ledger rows, and "the
   *     denial is the control working".
   *  2. FOUR COLUMNS THAT DO NOT EXIST. It set `fee`, `payment_method`,
   *     `status` and `metadata`. The table has none of them - its columns are
   *     id, user_id, wallet_type, amount, type, category, description,
   *     related_entity_id, table_id, hand_id, created_at, balance_after.
   *  3. A CHECK VIOLATION. `type` was set to 'deposit' / 'withdraw';
   *     `wallet_transactions_type_check` admits only 'credit' and 'debit'.
   *  4. NO CATEGORY. The row carried none, and the category check has no
   *     default that fits a pending request.
   *
   * So both hero buttons on the Player Wallet page have been a guaranteed
   * failure toast plus one error reporting report per click, for as long as this code
   * has existed.
   *
   * AND IT SHOULD NOT BE REPAIRED INTO WORKING. `wallet_transactions` is the
   * SETTLED ledger - TransactionHistory, three lines up the same page, reads
   * it. A pending deposit written there would render to the player as a
   * completed credit for money that has not arrived, above a running balance it
   * did not change. There is no client-writable table for a funding REQUEST
   * either: `chip_requests` holds one row in all of production, and there is no
   * /api/club-arena/ route for deposits or withdrawals.
   *
   * So the modal stops pretending. It says plainly that the channel is not
   * open and sends the player to the agent, which is the real chip path in this
   * product. The seam for the server route is one constant below: give
   * FUNDING_ENDPOINT a URL and restore the POST, exactly as
   * WalletService.mintChips does against /api/club-arena/mint-chips.
   */
  const handleConfirm = async () => {
    if (!currentMethod) return;
    // Double-submit guard: if already processing, ignore subsequent clicks
    if (processing) return;

    if (!FUNDING_ENDPOINT) {
      // Not an exception: nothing failed, the feature has no server side. A
      // reportError here would file a bug report on every click of a button we
      // already know about, which is the noise the logTransaction audit
      // removed from this codebase in the first place.
      setError(
        mode === 'deposit'
          ? 'Deposits Are Not Open On This Channel Yet. Ask Your Agent To Send You Chips'
          : 'Withdrawals Are Not Open On This Channel Yet. Ask Your Agent To Cash You Out'
      );
      triggerHaptic([30, 50, 30]);
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Authentication required');

      const resp = await fetch(FUNDING_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': uuid(),
        },
        body: JSON.stringify({
          userId,
          mode,
          amount: numericAmount,
          fee: feeAmount,
          method: selectedMethod,
          destination: mode === 'withdraw' ? withdrawAddress : null,
        }),
      });
      const result = await resp
        .json()
        .catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
      if (!result.success) throw new Error(result.error || `HTTP ${resp.status}`);

      if (!isMounted.current) return;
      setReferenceId(result.referenceId ?? null);
      setStep('success');
      triggerHaptic([20, 100, 20]);
      onComplete?.();
      // Emit bus event so DynamicWallet and other components refresh balances
      masterBus.emit('BALANCE_UPDATED', { source: mode, amount: numericAmount });
    } catch (err) {
      reportError(err, 'DepositWithdrawModal.mode_failed');
      if (isMounted.current) {
        const msg =
          mode === 'deposit'
            ? 'Could Not Start That Deposit. Please Try Again'
            : 'Could Not Start That Withdrawal. Please Try Again';
        toast.error(msg);
        setError(msg);
      }
    }
    if (isMounted.current) setProcessing(false);
  };

  const quickAmounts = [25, 50, 100, 250, 500, 1000];

  if (!isOpen) return null;

  /* THE FOOT PAINTS BOTH PLATES, so a step with one action uses the flat cap
     and prints that action as a lit word on the glass instead. The success
     step has exactly one: Done. */
  const plates =
    step === 'amount'
      ? {
          secondary: {
            label: 'Close',
            onClick: handleClose,
            'aria-label': 'Close Chip Transfer',
          },
          primary: {
            label: 'Continue',
            ink: numericAmount > 0 ? ('white' as const) : ('muted' as const),
            onClick: handleAmountSubmit,
            disabled: numericAmount <= 0,
          },
        }
      : {
          secondary: { label: 'Back', onClick: () => setStep('amount') },
          primary: {
            label: processing
              ? 'Processing'
              : mode === 'deposit'
                ? 'Confirm Deposit'
                : 'Confirm Withdrawal',
            ink: processing || !FUNDING_ENDPOINT ? ('muted' as const) : ('white' as const),
            onClick: handleConfirm,
            disabled: processing || !FUNDING_ENDPOINT,
          },
        };

  return (
    <div
      className={styles.overlay}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-withdraw-modal-title"
    >
      <div className={styles.modal} ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <SpadeConsole
          onClose={handleClose}
          as="div"
          /* "Funds" was the wrong noun and the wrong claim. What moves here is
             chips, and the welcome disclaimer the player accepted on the way in
             says the chips are virtual and that Club Arena provides no
             real-money service. A sheet headed "Deposit Funds" contradicted
             that in its own title bar. */
          eyebrow={mode === 'deposit' ? 'Chips In' : 'Chips Out'}
          title={mode === 'deposit' ? 'Add Chips' : 'Cash Out Chips'}
          titleId="deposit-withdraw-modal-title"
          pill={step === 'success' ? 'Sent' : step === 'confirm' ? 'Check It' : 'Agent'}
          pillInk={step === 'success' ? 'green' : 'blue'}
          foot={step === 'success' ? 'foot' : 'plates'}
          plates={step === 'success' ? undefined : plates}
        >
          <StepProgress current={step} />

          <div className={styles.row}>
            <span className="sc-label sc-ink--blue">Current Balance</span>
            <strong className={`${styles.value} sc-ink--silver`}>
              {currentBalance.toLocaleString()}
            </strong>
          </div>

          {error && (
            <p role="alert" className={`sc-copy sc-copy--center sc-ink--red ${styles.error}`}>
              {error}
            </p>
          )}

          {/* The four-card method grid stood here. One card is not a choice, so
              the sheet now opens on the amount and states the path instead of
              asking for it. */}

          {/* Step 1: Enter Amount */}
          {step === 'amount' && currentMethod && (
            <>
              <div className={styles.row}>
                <span className="sc-label sc-ink--blue">Through</span>
                <span className={`${styles.meta} sc-ink--silver`}>
                  {currentMethod.label} {currentMethod.processingTime}
                </span>
              </div>

              <input
                className={styles.amountInput}
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label={mode === 'deposit' ? 'Chips To Add' : 'Chips To Cash Out'}
                autoFocus
              />

              {/* Lit numerals on the glass under an engraved rule, not six
                  drawn pills. The 500 no longer wears a green BEST tag: it was
                  a sticker on a number Club Arena has no stake in. */}
              <div className={styles.quickAmounts} role="group" aria-label="Quick Amounts">
                {quickAmounts.map((qa) => (
                  <button
                    key={qa}
                    type="button"
                    onClick={() => setAmount(qa.toString())}
                    className={`${styles.quick} ${
                      numericAmount === qa ? 'sc-ink--white' : 'sc-ink--blue'
                    }`}
                    aria-pressed={numericAmount === qa}
                  >
                    {qa.toLocaleString()}
                  </button>
                ))}
              </div>

              {/* A WITHDRAWAL'S REAL CEILING IS THE BALANCE.
                  This showed the METHOD's limit for both directions, so a player
                  with 300 chips reading "Max: 100,000" typed 5,000, pressed
                  Continue, and only then learned they had 300 - the balance check
                  is in handleAmountSubmit, one screen later. Stating the binding
                  limit is not a new rule, it is the rule that was already being
                  enforced, moved to where it can be read before it bites. */}
              <div className={styles.row}>
                <span className="sc-label sc-ink--blue">Min</span>
                <span className={`${styles.meta} sc-ink--silver`}>
                  {currentMethod.minAmount.toLocaleString()}
                </span>
              </div>
              <div className={styles.row}>
                <span className="sc-label sc-ink--blue">Max</span>
                <span className={`${styles.meta} sc-ink--silver`}>
                  {(mode === 'withdraw'
                    ? Math.min(currentMethod.maxAmount, Math.max(0, currentBalance))
                    : currentMethod.maxAmount
                  ).toLocaleString()}
                </span>
              </div>

              {/* A five-branch ternary picked a label per rail here - Wallet
                  Address, Venmo Username, Email/Phone, Cash App Tag, Agent ID.
                  Four of those destinations no longer exist. */}
              {mode === 'withdraw' && (
                <div className={styles.field}>
                  <label className="sc-label sc-ink--blue" htmlFor="deposit-withdraw-agent">
                    Agent ID (Optional)
                  </label>
                  <input
                    id="deposit-withdraw-agent"
                    className={styles.textInput}
                    type="text"
                    placeholder="Which Agent Is Cashing You Out?"
                    value={withdrawAddress}
                    onChange={(e) => setWithdrawAddress(e.target.value)}
                  />
                </div>
              )}
            </>
          )}

          {/* Step 2: Confirm */}
          {step === 'confirm' && currentMethod && (
            <>
              <div className={styles.row}>
                <span className="sc-label sc-ink--blue">Amount</span>
                <strong className={`${styles.value} sc-ink--silver`}>
                  {numericAmount.toLocaleString()}
                </strong>
              </div>
              {feeAmount > 0 && (
                <div className={styles.row}>
                  <span className="sc-label sc-ink--blue">Fee ({currentMethod.fee}%)</span>
                  <strong className={`${styles.value} sc-ink--red`}>
                    -
                    {feeAmount.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </strong>
                </div>
              )}
              <div className={styles.row}>
                {/* "You Pay" named a payment Club Arena never takes. What this
                    row totals is chips moving between two member accounts. */}
                <span className="sc-label sc-ink--blue">
                  {mode === 'deposit' ? 'Chips Requested' : 'Chips Released'}
                </span>
                <strong className={`${styles.total} sc-ink--white`}>
                  {mode === 'deposit'
                    ? numericAmount.toLocaleString()
                    : (Math.round((numericAmount - feeAmount) * 100) / 100).toLocaleString(
                        undefined,
                        { minimumFractionDigits: 2, maximumFractionDigits: 2 }
                      )}
                </strong>
              </div>
              <div className={styles.row}>
                <span className="sc-label sc-ink--blue">Through</span>
                <span className={`${styles.meta} sc-ink--silver`}>
                  {currentMethod.label} {currentMethod.processingTime}
                </span>
              </div>

              {/* The old three-step list read "Send 500 To Transfer Through Your
                  Agent", then "Include Your Reference ID In The Memo" - a bank
                  memo line, for a transfer Club Arena is not a party to. It was
                  written for the four rails and made no sense once they were the
                  agent. What is true of the agent path is stated instead. */}
              {mode === 'deposit' && (
                <div className={styles.block}>
                  <span className="sc-label sc-ink--blue">How This Works</span>
                  <ol className={styles.steplist}>
                    <li className="sc-copy">
                      Your Agent Sends You {numericAmount.toLocaleString()} Chips From Their Own
                      Balance
                    </li>
                    <li className="sc-copy">
                      The Chips Appear In Your Wallet As Soon As They Send Them
                    </li>
                    <li className="sc-copy">
                      Anything You Arrange With Your Agent Is Between The Two Of You. Club Arena Is
                      Not A Party To It And Takes No Payment
                    </li>
                  </ol>
                </div>
              )}

              {/* Say it BEFORE the button, not after the click. Leading someone
                  through three steps of a money flow and only then telling them
                  the channel does not exist is the same discourtesy as the old
                  generic "Please try again" - it just costs them more time
                  first. */}
              {!FUNDING_ENDPOINT && (
                <p className={`sc-copy sc-copy--center sc-ink--red ${styles.error}`}>
                  {mode === 'deposit'
                    ? 'Deposits Are Not Open On This Channel Yet. Ask Your Agent To Send You Chips'
                    : 'Withdrawals Are Not Open On This Channel Yet. Ask Your Agent To Cash You Out'}
                </p>
              )}
            </>
          )}

          {/* Step 3: Success */}
          {step === 'success' && (
            <>
              <p className={`sc-copy sc-copy--center sc-ink--green ${styles.headline}`}>
                {mode === 'deposit' ? 'Deposit Initiated!' : 'Withdrawal Submitted!'}
              </p>

              {mode === 'deposit' && (
                <>
                  <div className={styles.row}>
                    <span className="sc-label sc-ink--blue">Send Exactly</span>
                    <strong className={`${styles.value} sc-ink--silver`}>
                      {numericAmount.toLocaleString()}
                    </strong>
                  </div>
                  <div className={styles.row}>
                    <span className="sc-label sc-ink--blue">To</span>
                    <span className={`${styles.meta} sc-ink--silver`}>
                      {currentMethod?.description}
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className="sc-label sc-ink--blue">Reference ID</span>
                    <strong className={`${styles.value} sc-ink--gold`}>
                      {referenceId?.slice(0, 8).toUpperCase()}
                    </strong>
                  </div>
                  <p className="sc-copy sc-copy--center">Include This ID In Your Payment Memo</p>
                </>
              )}

              {mode === 'withdraw' && (
                <p className="sc-copy sc-copy--center">
                  Your Withdrawal Is Being Processed. You'll Receive Confirmation Soon.
                </p>
              )}

              <button type="button" className={styles.doneBtn} onClick={handleClose}>
                Done
              </button>
            </>
          )}
        </SpadeConsole>
      </div>
    </div>
  );
}
