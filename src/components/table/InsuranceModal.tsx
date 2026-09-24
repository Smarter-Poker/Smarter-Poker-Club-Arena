/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INSURANCE MODAL - All-In Insurance + EV Cashout, on the spade console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two-tab modal:
 *   1. Insurance - the fee slider, priced at the exact rate
 *   2. EV Cashout - take guaranteed equity now at a small fee
 *
 * THE CONSOLE (2026-09-08). This was a rounded glass card with a gradient
 * header, a shield glyph stuck on the title, pill tabs, filled player rows and
 * two gradient buttons - a generic sheet over a live table, on the one popup in
 * the app that spends chips. It is now Dan's approved spade master, the same
 * one every Omaha card is drawn from, cut into three boxes that each paint
 * their own slice: top.png for the header well, mid.png for the rails the body
 * runs between, bottom-plates.png for the two painted action plates. The title
 * is engraved in the well, the countdown prints into the well's painted pill
 * slot, everything else prints on the black glass in the master's own inks,
 * and the rows are separated by an engraved rule rather than a drawn card.
 * Nothing is drawn except the fee slider, which the master does not paint -
 * and it stands UP AND DOWN, because a sideways drag at the felt is the
 * table-switch gesture.
 *
 * WHY THE THREE BOXES ARE DIRECT CHILDREN OF THE DIALOG. The clipped-buttons
 * fix below (Dan's recording, hand #3158299) is pinned by
 * tests/unit/insuranceModalLayout.test.tsx as a STRUCTURE: the action row is a
 * sibling of the scroll body and a direct child of the modal, so a short
 * viewport can never hide Insure/No again. The painted foot IS that action
 * row, so the console is composed here from its own slices rather than nested
 * inside <SpadeConsole>, exactly as BuyInModal composes the buy-in master.
 *
 * MONEY IS PRINTED TO THE CENT HERE, DELIBERATELY. compactChips is the rule for
 * figures outside the felt and the headline pot uses it. Every other number on
 * this surface is a TERM OF THE CONTRACT the player is about to buy - the fee
 * they are charged, the rate it multiplies by, the pot it insures, what each
 * outcome pays, the guaranteed cashout - and the 2026-08-28 exact-rate fix
 * exists because a display that rounded charged 76.66 for a dialog that said
 * 75.62. "What is displayed is what is bought, to the cent."
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { haptic, soundService } from '../../services/SoundService';
import { masterBus } from '../../core/MasterBus';
import { serverNow } from '../../utils/serverClock';
import { compactChips } from '../../utils/format';
import {
  PlateButton,
  SPADE_CONSOLE_PLATES_H,
  SPADE_CONSOLE_TOP_H,
  SPADE_CONSOLE_W,
  SPADE_CONSOLE_ZONES,
  ZoneText,
  zonePct,
} from '../console/SpadeConsole';
import { useFitText } from '../lobby/game-cards/useFitText';
import { CardImage } from './CardImage';
import type { Card as CardImageCard } from './CardImage';
import './InsuranceModal.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsuranceOffer {
  maxCoverage: number;
  equityPercent: number; // 0-100
  premiumRate: number; // e.g., 0.05 = 5%
  potAmount: number;
  yourStack: number;
  opponentStack: number;
  yourCards: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  opponentCards?: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  board: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  evCashoutRake?: number; // EV cashout rake (default 1%)
  /**
   * POKERBROS PARITY 2026-08-26: the specific next-street cards that put the
   * opponent ahead — shown as a row of small cards with a count, exactly the
   * information the reference popup leads with. Computed server-side
   * (InsuranceEquity.leaderOuts) and sent with the offer.
   */
  outs?: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[];
  /** Chance (%) the next card is one of the outs — shown next to the count. */
  outPct?: number;
  /**
   * Every all-in opponent, for multiway spots. When present it replaces the
   * single opponentCards column so a 3-way all-in shows BOTH hands you are
   * insured against, each under its player's name.
   */
  opponents?: { username?: string; cards: { rank: string; suit: 'h' | 'd' | 'c' | 's' }[] }[];
  /** Server-published offer window in seconds (drives the popup countdown). */
  timeoutSeconds?: number;
  /**
   * COUNTDOWN HONESTY 2026-08-28: the engine's absolute deadline (epoch ms).
   * When present the countdown derives from it every tick — no transit-lag
   * drift, and a reconnect resumes at the true remaining time.
   */
  deadlineAt?: number;
  /**
   * EV CASHOUT 2026-08-28: the server-priced guaranteed payout (insurable pot
   * x pot-share equity x (1 - fee)). When present it is displayed verbatim —
   * the client never invents a money number the server didn't quote.
   */
  evCashoutAmount?: number;
  /**
   * REFERENCE PARITY 2026-08-26: payout multiple on the fee (insured = fee x
   * rate). Server-computed; derived from premiumRate when absent.
   */
  rate?: number;
  /** The leader's own committed chips — the Break Even preset target. */
  atRisk?: number;
  /** Leader's display name for the player rows. */
  heroName?: string;
}

export interface InsuranceModalProps {
  isOpen: boolean;
  onClose: () => void | boolean | Promise<void | boolean>;
  onAccept: (coverageAmount: number) => void | boolean | Promise<void | boolean>;
  onDecline: () => void | boolean | Promise<void | boolean>;
  /** FIX 89: "Decline for Hand" — never re-offered on later streets.
   * If omitted, only "Decline Now" button is shown. */
  onDeclineForHand?: () => void | boolean | Promise<void | boolean>;
  onEvCashout?: (cashoutAmount: number) => void | boolean | Promise<void | boolean>;
  offer: InsuranceOffer;
  timeRemaining?: number;
  currency?: string;
  enableEvCashout?: boolean;
}

type ModalTab = 'insurance' | 'ev-cashout';

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeRank(rank: string): CardImageCard['rank'] {
  if (rank === '10') return 'T';
  return rank as CardImageCard['rank'];
}

function toCardImage(card: { rank: string; suit: 'h' | 'd' | 'c' | 's' }): CardImageCard {
  return { rank: normalizeRank(card.rank), suit: card.suit };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function InsuranceModal({
  isOpen,
  onClose,
  onAccept,
  onDecline,
  onDeclineForHand,
  onEvCashout,
  offer,
  timeRemaining = 15,
  currency = '',
  enableEvCashout = true,
}: InsuranceModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>('insurance');
  const [mounted, setMounted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const actionInFlightRef = useRef(false);
  const modalRef = useRef<HTMLDivElement>(null);
  // POKERBROS PARITY 2026-08-26: a LIVE countdown. The prop used to be a
  // static number that rendered "15s" for the whole window; the reference
  // popup visibly counts down to its auto-decline.
  // COUNTDOWN HONESTY 2026-08-28: when the engine publishes its absolute
  // deadline, every tick derives from serverNow() against it - the seconds
  // shown are the seconds the server will actually wait. Date.now() until
  // 2026-09-06, which made that promise false on any skewed device, on the
  // one countdown in the app that is spending chips.
  const remainingNow = useCallback(
    () =>
      offer.deadlineAt
        ? Math.max(0, Math.ceil((offer.deadlineAt - serverNow()) / 1000))
        : (offer.timeoutSeconds ?? timeRemaining),
    [offer.deadlineAt, offer.timeoutSeconds, timeRemaining]
  );
  const [secondsLeft, setSecondsLeft] = useState(remainingNow);

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
      setActiveTab('insurance');
      setIsSubmitting(false);
      actionInFlightRef.current = false;
    }
  }, [isOpen]);

  // A timed financial choice must be announced as a real dialog and receive
  // focus without placing it on the purchase button. Escape follows the same
  // final-decline path as the visible No button; it never dismisses only the
  // pixels while leaving an offer unanswered on the server.
  useEffect(() => {
    if (!isOpen) return;
    modalRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || actionInFlightRef.current) return;
      event.preventDefault();
      actionInFlightRef.current = true;
      setIsSubmitting(true);
      void Promise.resolve(onClose()).finally(() => {
        actionInFlightRef.current = false;
        setIsSubmitting(false);
      });
    };
    // Capture before the table's global Escape handlers. Those close menus and
    // stop propagation; without capture, the visible insurance dialog never
    // receives the key and the server offer remains unanswered.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen, onClose]);

  // Countdown ticks once per second while open; re-arms when a later street's
  // offer replaces this one (offer identity changes).
  useEffect(() => {
    if (!isOpen) return;
    setSecondsLeft(remainingNow());
    const iv = setInterval(() => {
      // Deadline-anchored when available (drift-proof); simple decrement
      // otherwise (legacy offers without deadlineAt).
      if (offer.deadlineAt) setSecondsLeft(remainingNow());
      else setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(iv);
  }, [isOpen, offer, timeRemaining, remainingNow]);

  // ── Insurance calculations — REFERENCE PARITY 2026-08-26 ──
  // The reference dialog is FEE-first: the player slides the Insurance Fee,
  // and Insured Pot = fee x Rate. Internally coverageAmount (the insured pot)
  // stays the contract with TablePage's accept path; the fee is the visible
  // parameter. Rate = insured/premium is constant across the slider.
  const cents = (n: number) => Math.round(n * 100) / 100;
  // EXACT-RATE FIX 2026-08-28 (Dan's recording, hand #3158299): all MONEY math
  // must use the exact multiple 1/premiumRate, never the 1-decimal display
  // rate. The insured pot used to be fee x rate(1dp) — 75.62 x 3.2 = 241.98 —
  // while the server derives the premium from that coverage at the EXACT
  // premiumRate, charging 76.66 for a dialog that said 75.62. "What is
  // displayed is what is bought, to the cent" (acceptPartial's own audit
  // note). insuredPot = fee / premiumRate round-trips to the shown fee.
  const rate = useMemo(() => {
    if (offer.premiumRate > 0) return 1 / offer.premiumRate;
    return offer.rate && offer.rate > 0 ? offer.rate : 0;
  }, [offer.rate, offer.premiumRate]);
  const feeMax = useMemo(
    () => cents(offer.maxCoverage * offer.premiumRate),
    [offer.maxCoverage, offer.premiumRate]
  );
  const feeMin = useMemo(() => Math.max(0.01, cents(feeMax * 0.01)), [feeMax]);
  const clampFee = useCallback(
    (f: number) => Math.min(feeMax, Math.max(feeMin, cents(f))),
    [feeMin, feeMax]
  );
  // Break Even: the payout returns exactly the chips the leader committed.
  const breakEvenFee = useMemo(
    () => clampFee((offer.atRisk ?? offer.maxCoverage) * offer.premiumRate),
    [offer.atRisk, offer.maxCoverage, offer.premiumRate, clampFee]
  );
  // Constant Profit: winning and losing pay the same — pot - fee = fee x rate.
  const constantProfitFee = useMemo(
    () => clampFee(rate > 0 ? offer.potAmount / (rate + 1) : feeMax),
    [offer.potAmount, rate, feeMax, clampFee]
  );

  const [feeAmount, setFeeAmount] = useState(constantProfitFee);

  // STALE-SLIDER GUARD 2026-08-26: re-seed when a different offer replaces
  // this one; the reference opens at the fully-hedged (Constant Profit) spot.
  useEffect(() => {
    setFeeAmount(constantProfitFee);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer]);

  const insuredPot = useMemo(() => cents(feeAmount * rate), [feeAmount, rate]);
  const forWinning = useMemo(
    () => Math.max(0, cents(offer.potAmount - feeAmount)),
    [offer.potAmount, feeAmount]
  );
  // Keep the TablePage contract: accept sends the COVERAGE amount.
  const coverageAmount = insuredPot;
  const premium = feeAmount;

  // ── EV Cashout calculations ──
  // DEAD-BUTTON FIX 2026-08-26: enableEvCashout defaulted true, TablePage
  // never passed onEvCashout, and at that time no server endpoint existed for
  // EV cashout, so the tab rendered a "Cash Out" button that quietly did
  // nothing to a player making a financial decision. The tab still requires a
  // real handler before it renders.
  // CORRECTED 2026-09-22: the endpoint exists. Since 2026-08-28 POST /insurance
  // accepts response 'cashout' (server/src/handlers/insurance.ts), the engine's
  // respondToInsurance locks the offer through InsuranceEngine.acceptEvCashout
  // and settlement pays it as an 'ev_cashout', and TablePage passes onEvCashout
  // (handleInsuranceEvCashout -> respondToInsurance(tableId, 'cashout')) through
  // TableModalsLayer, so at the table the Cash Out tab is live.
  const evCashoutAvailable = enableEvCashout && typeof onEvCashout === 'function';
  const evCashoutRake = offer.evCashoutRake ?? 0.01;
  const evRaw = useMemo(
    () => Math.round(offer.potAmount * (offer.equityPercent / 100) * 100) / 100,
    [offer.potAmount, offer.equityPercent]
  );
  // EV CASHOUT 2026-08-28: the server's quote wins — the engine computed it
  // on the same insurable pot and exact equity it will settle with. The
  // client formula remains only as a fallback for offers without one.
  const evCashoutAmount = useMemo(() => {
    if (typeof offer.evCashoutAmount === 'number' && offer.evCashoutAmount > 0) {
      return offer.evCashoutAmount;
    }
    return Math.round(evRaw * (1 - evCashoutRake) * 100) / 100;
  }, [offer.evCashoutAmount, evRaw, evCashoutRake]);
  const evRakeAmount = useMemo(() => evRaw - evCashoutAmount, [evRaw, evCashoutAmount]);

  // FIX 187: Insurance accept is a financial decision — dedicated sound + haptic
  const runDecision = useCallback(
    async (decision: () => void | boolean | Promise<void | boolean>) => {
      // React state is not a same-frame mutex. The ref closes the gap between
      // a touch and the render that disables the buttons, so a fast double tap
      // cannot send two financial decisions.
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setIsSubmitting(true);
      try {
        await decision();
      } finally {
        actionInFlightRef.current = false;
        setIsSubmitting(false);
      }
    },
    []
  );

  const handleAccept = useCallback(() => {
    soundService.playInsurancePurchase();
    void runDecision(() => onAccept(coverageAmount));
  }, [coverageAmount, onAccept, runDecision]);

  const handleDecline = useCallback(() => {
    soundService.playInsuranceDecline();
    void runDecision(onDecline);
  }, [onDecline, runDecision]);

  // FIX 89: "Decline for Hand" — player won't be re-offered insurance on later streets
  const handleDeclineForHand = useCallback(() => {
    haptic.light();
    void runDecision(onDeclineForHand ?? onDecline);
  }, [onDeclineForHand, onDecline, runDecision]);

  const handleEvCashout = useCallback(() => {
    haptic.medium();
    masterBus.emit('EV_CASHOUT_ACCEPTED', {
      handId: '',
      tableId: '',
      playerId: '',
      cashoutAmount: evCashoutAmount,
      equityPercent: offer.equityPercent,
    });
    if (onEvCashout) void runDecision(() => onEvCashout(evCashoutAmount));
  }, [evCashoutAmount, offer.equityPercent, onEvCashout, runDecision]);

  // Fee slider grid. MICRO-STAKES MONEY MATH 2026-08-26: cents below 100
  // chips, whole chips above — same convention as the raise slider.
  const feeStep = feeMax >= 100 ? Math.floor(feeMax / 100) : 0.01;
  const feeGridMax = useMemo(() => {
    if (!(feeMax > 0)) return feeMax;
    return Math.floor(feeMax / feeStep) * feeStep;
  }, [feeMax, feeStep]);
  // The lit run of the vertical groove: the fee, as a share of its own range.
  const feePercent = feeMax > feeMin ? ((feeAmount - feeMin) / (feeMax - feeMin)) * 100 : 0;

  // The countdown prints into the master's painted pill slot; it is fitted the
  // same way every other zone is.
  const timerRef = useFitText<HTMLSpanElement>(`${secondsLeft}s`, 1, 0.5);

  if (!isOpen) return null;

  return (
    <div className="insurance-overlay">
      <div
        ref={modalRef}
        className="insurance-modal ac-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="insurance-modal-title"
        aria-busy={isSubmitting}
        tabIndex={-1}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        {/* ── Head: the master's own header well ─────────────────────────── */}
        <div className="insurance-modal__head">
          <ZoneText
            text={activeTab === 'insurance' ? 'Insurance Offer' : 'Cash Out Offer'}
            className="sc__eyebrow sc-ink--blue"
            style={zonePct(SPADE_CONSOLE_ZONES.eyebrow, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
          />
          <ZoneText
            as="h2"
            id="insurance-modal-title"
            text={activeTab === 'insurance' ? 'All-In Insurance' : 'EV Cashout'}
            className="sc__title sc-ink--silver"
            style={zonePct(
              SPADE_CONSOLE_ZONES.titleBesidePill,
              SPADE_CONSOLE_W,
              SPADE_CONSOLE_TOP_H
            )}
          />
          {/* Gold, red inside the last five seconds - the master's own inks.
              The window closes into a decline that is final for the hand. */}
          <span
            className={`sc-zone sc__pill insurance-modal__timer ${secondsLeft <= 5 ? 'insurance-modal__timer--urgent sc-ink--red' : 'sc-ink--gold'}`}
            style={zonePct(SPADE_CONSOLE_ZONES.pill, SPADE_CONSOLE_W, SPADE_CONSOLE_TOP_H)}
            role="timer"
            aria-label={`${secondsLeft} Seconds Remaining`}
          >
            <span ref={timerRef}>{secondsLeft}s</span>
          </span>
        </div>

        {/* CLIPPED-BUTTONS FIX 2026-08-28 (Dan's recording, hand #3158299):
            the modal is height-capped and on a phone the content above the
            actions row is TALLER than the cap - so the No/Insure buttons
            rendered below the clip line and could not be seen or tapped. The
            25s window then expired into an auto-decline, final for the hand.
            Everything except the head and the painted plates lives in this
            scrollable body; the plates are the foot, pinned below it and
            always on screen. */}
        <div className="insurance-modal__body">
          {/* The street and the pot, on the glass between the rails.
              PREFLOP OFFER 2026-08-28: with no flop there are no "outs" — the
              strip labels the street instead of showing a meaningless 0. */}
          <div className="insurance-modal__info-strip">
            {offer.board.length >= 3 ? (
              <span className="insurance-modal__info-item sc-ink--blue">
                Outs: {offer.outs?.length ?? 0}
              </span>
            ) : (
              <span className="insurance-modal__info-item sc-ink--blue">Preflop All-In</span>
            )}
            {/* The headline pot is context, not a term of the contract, so it
                is the one figure here that abbreviates (Dan: over 1,000 use
                1K). Everything the player is charged or paid stays exact. */}
            <span className="insurance-modal__info-item sc-ink--silver">
              Pot: {currency}
              {compactChips(offer.potAmount)}
            </span>
          </div>

          {/* Tab Switcher */}
          {evCashoutAvailable && (
            <div className="insurance-modal__tabs">
              <button
                type="button"
                className={`insurance-modal__tab ${activeTab === 'insurance' ? 'insurance-modal__tab--active' : ''}`}
                onClick={() => {
                  haptic.light();
                  setActiveTab('insurance');
                }}
              >
                Insurance
              </button>
              <button
                type="button"
                className={`insurance-modal__tab ${activeTab === 'ev-cashout' ? 'insurance-modal__tab--active' : ''}`}
                onClick={() => {
                  haptic.light();
                  setActiveTab('ev-cashout');
                }}
              >
                EV Cashout
              </button>
            </div>
          )}

          {/* Board */}
          <div className="insurance-modal__board">
            <span className="insurance-modal__board-label sc-label sc-ink--muted">Board:</span>
            {offer.board.map((card, i) => (
              <span key={i} className="insurance-modal__board-card">
                <CardImage card={toCardImage(card)} size="xs" />
              </span>
            ))}
          </div>

          {/* Player rows: name, live equity, hole cards — the leader first,
            then every all-in opponent (multiway shows them all). */}
          <div className="insurance-modal__players">
            <div className="insurance-modal__player-row insurance-modal__player-row--hero">
              <span className="insurance-modal__player-name sc-ink--gold">
                {offer.heroName || 'You'}
              </span>
              <span className="insurance-modal__player-equity sc-ink--green">
                {offer.equityPercent.toFixed(2)}%
              </span>
              <span className="insurance-modal__player-cards">
                {offer.yourCards.map((card, i) => (
                  <span key={i} className="insurance-modal__card">
                    <CardImage card={toCardImage(card)} size="xs" />
                  </span>
                ))}
              </span>
            </div>
            {(offer.opponents && offer.opponents.length > 0
              ? offer.opponents.map((opp) => ({
                  name: opp.username || 'Opponent',
                  cards: opp.cards,
                }))
              : [{ name: 'Opponent', cards: offer.opponentCards ?? [] }]
            ).map((opp, oi, arr) => (
              <div key={oi} className="insurance-modal__player-row">
                <span className="insurance-modal__player-name sc-ink--silver">{opp.name}</span>
                <span className="insurance-modal__player-equity sc-ink--muted">
                  {/* Heads-up the villain's share is the complement; multiway
                    shows the leader's number only (server sends one equity). */}
                  {arr.length === 1 ? `${(100 - offer.equityPercent).toFixed(2)}%` : ''}
                </span>
                <span className="insurance-modal__player-cards">
                  {opp.cards.map((card, i) => (
                    <span key={i} className="insurance-modal__card">
                      <CardImage card={toCardImage(card)} size="xs" />
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>

          {/* Outs — the specific next-street cards that put you behind */}
          {offer.outs && offer.outs.length > 0 && (
            <div className="insurance-modal__outs">
              <span className="insurance-modal__outs-label sc-label sc-ink--red">
                Outs Against You ({offer.outs.length}
                {offer.outPct ? ` • ${offer.outPct.toFixed(1)}%` : ''})
              </span>
              <div className="insurance-modal__outs-cards">
                {offer.outs.map((card, i) => (
                  <span key={i} className="insurance-modal__outs-card">
                    <CardImage card={toCardImage(card)} size="xs" />
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ═══ INSURANCE TAB — fee-first, like the reference dialog ═══ */}
          {activeTab === 'insurance' && (
            <>
              {/* Fee / Rate / Insured Pot readouts */}
              <div className="insurance-modal__readouts">
                <div className="insurance-modal__readout">
                  <span className="insurance-modal__readout-label sc-label sc-ink--blue">
                    Insurance Fee
                  </span>
                  <span className="insurance-modal__readout-value insurance-modal__readout-value--fee sc-ink--gold">
                    {currency}
                    {premium.toLocaleString()}
                  </span>
                </div>
                <div className="insurance-modal__readout">
                  <span className="insurance-modal__readout-label sc-label sc-ink--blue">Rate</span>
                  {/* EXACT-RATE FIX 2026-08-28: 2 decimals so Fee x Rate matches
                    the Insured Pot readout instead of drifting ~1.4%. */}
                  <span className="insurance-modal__readout-value sc-ink--silver">
                    {rate.toFixed(2)}
                  </span>
                </div>
                <div className="insurance-modal__readout">
                  <span className="insurance-modal__readout-label sc-label sc-ink--blue">
                    Insured Pot
                  </span>
                  <span className="insurance-modal__readout-value insurance-modal__readout-value--insured sc-ink--green">
                    {currency}
                    {insuredPot.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* The one control the master does not paint. It stands UP AND
                  DOWN (Dan, binding): a sideways drag at the felt is the
                  table-switch gesture, so a horizontal slider here fights the
                  page on the surface that is spending chips. */}
              <div className="insurance-modal__coverage">
                <div className="insurance-modal__slider-container">
                  <input
                    type="range"
                    className="insurance-modal__slider"
                    min={feeMin}
                    max={feeMax}
                    step={feeStep}
                    value={feeAmount}
                    /* A range input only emits `min + n*step`; treat the last grid
                     stop as the true maximum, exactly as the raise slider does. */
                    onChange={(e) => {
                      const raw = parseFloat(e.target.value);
                      setFeeAmount(clampFee(raw >= feeGridMax ? feeMax : raw));
                    }}
                    aria-label={`Insurance Fee, ${feeMin} To ${feeMax}`}
                    aria-orientation="vertical"
                    style={{ '--slider-percent': `${feePercent}%` } as React.CSSProperties}
                  />
                  {/* Column-reverse: the DOM keeps min first, the groove puts
                      the maximum at the top where the slider's own max is. */}
                  <div className="insurance-modal__slider-range">
                    <span>{feeMin.toLocaleString()}</span>
                    <span>{feeMax.toLocaleString()}</span>
                  </div>
                </div>
                {/* The reference's two hedging presets */}
                <div className="insurance-modal__presets">
                  <button
                    type="button"
                    className={`insurance-modal__preset ${feeAmount === breakEvenFee ? 'insurance-modal__preset--active' : ''}`}
                    onClick={() => {
                      haptic.light();
                      setFeeAmount(breakEvenFee);
                    }}
                    title="Fee Sized So A Loss Returns Exactly Your Committed Chips"
                  >
                    Break Even
                  </button>
                  <button
                    type="button"
                    className={`insurance-modal__preset ${feeAmount === constantProfitFee ? 'insurance-modal__preset--active' : ''}`}
                    onClick={() => {
                      haptic.light();
                      setFeeAmount(constantProfitFee);
                    }}
                    title="Fee Sized So Winning And Losing Pay The Same"
                  >
                    Constant Profit
                  </button>
                </div>
              </div>

              {/* What each outcome pays */}
              <div className="insurance-modal__outcomes">
                <span className="insurance-modal__outcomes-label sc-label sc-ink--muted">
                  With Insurance You Will Get:
                </span>
                <div className="insurance-modal__outcomes-row">
                  <span className="insurance-modal__outcome">
                    For Winning:{' '}
                    <strong>
                      {currency}
                      {forWinning.toLocaleString()}
                    </strong>
                  </span>
                  <span className="insurance-modal__outcome">
                    For Losing:{' '}
                    <strong>
                      {currency}
                      {insuredPot.toLocaleString()}
                    </strong>
                  </span>
                </div>
              </div>
            </>
          )}

          {/* ═══ EV CASHOUT TAB ═══ */}
          {activeTab === 'ev-cashout' && evCashoutAvailable && (
            <>
              <div className="insurance-modal__ev-section">
                <div className="insurance-modal__ev-hero">
                  <span className="insurance-modal__ev-amount sc-ink--green">
                    {currency}
                    {evCashoutAmount.toLocaleString()}
                  </span>
                  <span className="insurance-modal__ev-subtitle sc-label sc-ink--muted">
                    Guaranteed Payout
                  </span>
                </div>

                <div className="insurance-modal__summary">
                  <div className="insurance-modal__summary-row">
                    <span className="insurance-modal__summary-label sc-label sc-ink--blue">
                      Pot Size
                    </span>
                    <span className="insurance-modal__summary-value sc-ink--silver">
                      {currency}
                      {offer.potAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="insurance-modal__summary-row">
                    <span className="insurance-modal__summary-label sc-label sc-ink--blue">
                      Your Equity ({offer.equityPercent.toFixed(1)}%)
                    </span>
                    <span className="insurance-modal__summary-value sc-ink--silver">
                      {currency}
                      {evRaw.toLocaleString()}
                    </span>
                  </div>
                  <div className="insurance-modal__summary-row">
                    <span className="insurance-modal__summary-label sc-label sc-ink--blue">
                      Cashout Fee ({(evCashoutRake * 100).toFixed(0)}%)
                    </span>
                    <span className="insurance-modal__summary-value insurance-modal__summary-value--negative sc-ink--red">
                      -{currency}
                      {evRakeAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="insurance-modal__summary-row insurance-modal__summary-row--total">
                    <span className="insurance-modal__summary-label sc-label sc-ink--blue">
                      You Receive
                    </span>
                    <span className="insurance-modal__summary-value insurance-modal__summary-value--highlight sc-ink--green">
                      {currency}
                      {evCashoutAmount.toLocaleString()}
                    </span>
                  </div>
                </div>

                <p className="insurance-modal__ev-note sc-copy sc-copy--center">
                  Take Your Guaranteed Equity Now. The Hand Will Continue But Your Payout Is Locked.
                </p>
              </div>
            </>
          )}
        </div>

        {/* CLIPPED-BUTTONS FIX 2026-08-28: the actions are the master's own
            painted foot - a sibling of the scrollable body and a direct child
            of the dialog, so a timed financial decision's buttons never depend
            on scroll position or viewport height. Nothing is drawn here: the
            two plates are in the art and the buttons over them add a label. */}
        {activeTab === 'insurance' && (
          /* A decline is FINAL for the hand (Dan 2026-08-26). */
          <div className="insurance-modal__actions">
            <PlateButton
              zone={SPADE_CONSOLE_ZONES.plateSecondary}
              canvasH={SPADE_CONSOLE_PLATES_H}
              label="No"
              className="insurance-modal__btn insurance-modal__btn--decline"
              onClick={handleDeclineForHand}
              disabled={isSubmitting}
              title="Decline Insurance For The Rest Of This Hand"
            />
            <PlateButton
              zone={SPADE_CONSOLE_ZONES.platePrimary}
              canvasH={SPADE_CONSOLE_PLATES_H}
              label="Insure"
              ink="white"
              className="insurance-modal__btn insurance-modal__btn--accept"
              onClick={handleAccept}
              disabled={isSubmitting}
            />
          </div>
        )}
        {activeTab === 'ev-cashout' && evCashoutAvailable && (
          <div className="insurance-modal__actions">
            <PlateButton
              zone={SPADE_CONSOLE_ZONES.plateSecondary}
              canvasH={SPADE_CONSOLE_PLATES_H}
              label="Play It Out"
              className="insurance-modal__btn insurance-modal__btn--decline"
              onClick={handleDecline}
              disabled={isSubmitting}
            />
            <PlateButton
              zone={SPADE_CONSOLE_ZONES.platePrimary}
              canvasH={SPADE_CONSOLE_PLATES_H}
              label="Cash Out"
              ink="green"
              className="insurance-modal__btn insurance-modal__btn--cashout"
              onClick={handleEvCashout}
              disabled={isSubmitting}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default InsuranceModal;
