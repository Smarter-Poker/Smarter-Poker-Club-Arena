/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INSURANCE ENGINE — All-In Equity Insurance System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages insurance offers when players go all-in:
 * - Triggered when 2+ players are all-in before the river
 * - Uses MonteCarloEquity to calculate real equity percentages
 * - POKERBROS PARITY 2026-08-28 (Dan's ruling): the fee is charged ONLY when
 *   the insured leader WINS. A loss pays the insured amount with NO fee, so
 *   the dialog's "For Losing: <insured pot>" is literally what lands, and
 *   Constant Profit is actually constant. Premium = insured × pLoss/pWin ×
 *   houseMargin (all probabilities conditional on not-push; 20% edge intact:
 *   EV_house = fee×pWin − insured×pLoss = 0.2 × fair cost)
 * - Offer/accept/decline flow with configurable timeout
 * - Partial coverage: player can insure 1-100% via slider (default 100%)
 * - Per-street recalculation: equity changes as board cards are dealt
 * - Max insurable = pot amount
 * - Settlement after board is dealt — premium deducted like rake at end
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/InsuranceEngine.ts (291 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 *
 * FIX 78: House margin 5%→20%, partial coverage slider, per-street recalc
 */

import type { Card } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { deadlineScheduler, type DeadlineScheduler } from './DeadlineScheduler.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsuranceConfig {
  enabled: boolean;
  /** House margin multiplier: 1.20 = 20% house edge on premiums */
  houseMargin: number;
  /** Max insurable as % of pot (100 = can insure up to full pot) */
  maxInsurablePercent: number;
  offerTimeoutSeconds: number;
  minPotForInsurance: number;
  equityIterations: number;
  /**
   * EV CASHOUT 2026-08-28: the leader may take pot x equity now instead of
   * insuring. The hand still runs out; whatever the cashed-out player would
   * have collected goes to the club/union bank at settlement.
   */
  evCashoutEnabled: boolean;
  /** Fee (%) shaved off the equity payout (default 1). */
  evCashoutFeePercent: number;
}

export interface InsuranceOffer {
  tableId: string;
  handId: string;
  playerId: string;
  holeCards: Card[];
  /** Player's equity % (0-100) at current board state */
  equity: number;
  /** Premium for FULL insurance (100% coverage) — scales with coveragePercent */
  fullPremium: number;
  /** Actual premium to pay based on coveragePercent */
  premium: number;
  /** Full insured amount (100% coverage) — scales with coveragePercent */
  fullInsuredAmount: number;
  /** Actual insured amount based on coveragePercent */
  insuredAmount: number;
  /** Coverage percentage chosen by player (1-100, default 100) */
  coveragePercent: number;
  /**
   * REFERENCE PARITY 2026-08-26: the leader's own committed chips this hand.
   * The popup's Break Even preset sets the fee so the payout returns exactly
   * this amount.
   */
  atRisk: number;
  status: 'offered' | 'accepted' | 'declined' | 'settled' | 'cashed_out';
  /** If true, player declined for the entire hand (won't be re-offered on later streets) */
  declinedForHand: boolean;
  /**
   * EV CASHOUT 2026-08-28: the guaranteed payout on offer — insurable pot x
   * pot-share equity x (1 - fee). Undefined when cashout is disabled.
   */
  evCashoutAmount?: number;
  /** Set when the player takes the cashout (status 'cashed_out'). */
  cashoutAmount?: number;
  /**
   * PREFLOP OFFER 2026-08-28: the board size this offer was made on. Decline
   * finality depends on it — a PREFLOP decline is street-only (the flop
   * changes everything; Dan: "OFFERED PRE FLOP, AND REOFFERED ON THE FLOP"),
   * while flop/turn declines stay FINAL for the hand (Dan 2026-08-26).
   */
  boardLength: number;
  // Phase 1.2 PR-G-real: timeouts routed through DeadlineScheduler singleton via
  // the engine's private `scheduler` ref, keyed by
  // eventId = `insurance_offer:${playerId}` on the offer's tableId. The raw
  // setTimeout handle was deleted — nothing else to store on the offer.
}

export interface InsuranceSettlement {
  playerId: string;
  insuredAmount: number;
  premium: number;
  payout: number;
  /** Equity % the premium was priced on (for the audit ledger). */
  equity: number;
  /** true = insurance paid out (player lost the hand) */
  won: boolean;
  /**
   * EV CASHOUT 2026-08-28: 'ev_cashout' settlements pay `payout` (the locked
   * cashout) regardless of outcome, and the settlement layer redirects the
   * player's actual pot winnings to the bank. 'insurance' is the classic
   * contract.
   */
  kind: 'insurance' | 'ev_cashout';
}

/**
 * Contract probabilities must be produced by the worker-only pricing pass.
 * Keeping this structured (rather than accepting a bare pot-share percentage)
 * prevents a caller from silently pricing pushes as losses.
 */
export interface InsurancePricingComponents {
  equity: number;
  strictLossPct: number;
  pushPct: number;
}

export type InsuranceEventType =
  | 'INSURANCE_OFFERED'
  | 'INSURANCE_ACCEPTED'
  | 'INSURANCE_DECLINED'
  | 'INSURANCE_SETTLED'
  | 'INSURANCE_RECALCULATED'
  | 'INSURANCE_CASHED_OUT';

export interface InsuranceEvent {
  type: InsuranceEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSURANCE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class InsuranceEngine {
  private tableConfigs: Map<string, InsuranceConfig> = new Map();
  private activeOffers: Map<string, InsuranceOffer[]> = new Map();
  private onEvent?: (event: InsuranceEvent) => void;
  /**
   * Phase 1.2 PR-G-real: central scheduler used for offer expiry. Replaces
   * per-offer setTimeout handles. The scheduler is the single source of
   * truth for deadlines — it survives rehydration after server restart and
   * one tick loop fires every expiring offer across all tables.
   */
  private scheduler: DeadlineScheduler;

  private readonly DEFAULT_CONFIG: InsuranceConfig = {
    enabled: false,
    houseMargin: 1.2, // 20% house edge — per Dan's explicit instruction
    maxInsurablePercent: 100, // Max insurable = pot amount
    // REFERENCE PARITY 2026-08-26: the reference dialog opens at ~26s and
    // counts down. 25 matches it (was 15).
    offerTimeoutSeconds: 25,
    minPotForInsurance: 0,
    equityIterations: 5000,
    // EV CASHOUT 2026-08-28: on wherever insurance is on; 1% fee.
    evCashoutEnabled: true,
    evCashoutFeePercent: 1,
  };

  constructor(
    onEvent?: (event: InsuranceEvent) => void,
    scheduler: DeadlineScheduler = deadlineScheduler
  ) {
    this.onEvent = onEvent;
    this.scheduler = scheduler;
    // Idempotent: singleton already running in production, but tests may
    // construct their own scheduler and need it started here.
    this.scheduler.start();
  }

  /** Phase 1.2 PR-G-real: stable key for this engine's scheduler entries. */
  private offerEventId(playerId: string): string {
    return `insurance_offer:${playerId}`;
  }

  configure(tableId: string, config: Partial<InsuranceConfig>): void {
    this.tableConfigs.set(tableId, { ...this.DEFAULT_CONFIG, ...config });
  }

  isEnabled(tableId: string): boolean {
    return this.tableConfigs.get(tableId)?.enabled ?? false;
  }

  /**
   * Create insurance offers for all-in players.
   * Called by ServerTableEngine when an all-in runout is pending.
   *
   * Default offer is FULL insurance (100% coverage).
   * Player can adjust via acceptPartial() with a slider before accepting.
   * Premium = (1 - equity%) × insuredAmount × houseMargin
   * Max insurable = min(pot × maxInsurablePercent%, pot × equity%)
   */
  createOffers(
    tableId: string,
    handId: string,
    leaderId: string,
    allInPlayers: Array<{ playerId: string; holeCards: Card[]; atRisk: number }>,
    board: Card[],
    pot: number,
    variant: string,
    shortDeck: boolean,
    // Mandatory worker-authored contract outcomes. There is intentionally no
    // synchronous or bare-equity fallback on the authoritative table thread.
    precomputed: InsurancePricingComponents
  ): InsuranceOffer[] {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if (!config.enabled || pot < config.minPotForInsurance) return [];
    // Need the leader plus at least one opponent whose known cards we price against.
    if (allInPlayers.length < 2) return [];
    // Insurance requires cards still to come (board can be 0 for a preflop all-in).
    if (board.length >= 5) return [];

    const leader = allInPlayers.find((p) => p.playerId === leaderId);
    if (!leader) return [];

    const existing = this.activeOffers.get(tableId) ?? [];
    // If the leader already locked coverage on an earlier street, don't re-offer.
    // EV CASHOUT RE-OFFER GUARD 2026-08-28: 'cashed_out' belongs here too —
    // without it a leader who cashed out on the flop was offered AGAIN on the
    // turn and could double-dip (cash out twice, or cash out AND insure) on
    // equity the bank had already bought. Found in line-by-line review, pinned
    // by InsuranceEvCashout.test.ts before any real chips could hit it.
    if (
      existing.some(
        (o) =>
          o.playerId === leader.playerId &&
          (o.status === 'accepted' || o.status === 'settled' || o.status === 'cashed_out')
      )
    ) {
      return [];
    }

    const opponentHands = allInPlayers
      .filter((p) => p.playerId !== leaderId)
      .map((p) => p.holeCards);
    if (opponentHands.length === 0) return [];

    // FIX-A12: price from the TRUE all-in equity against the KNOWN opponent
    // hands (exact enumeration of the remaining board), not vs random cards.
    // PERF FIX (2026-07-24): use the equity precomputed off the event loop when
    // supplied; only fall back to the synchronous exact enumeration (which blocks
    // the loop) when the worker pool was unavailable.
    // PRICING FIX 2026-08-18: price the CONTRACT, not the pot share.
    // The contract's outcomes are: strict loss -> payout; leader wins alone
    // -> premium kept; chop -> PUSH (premium refunded, FIX 118). The old
    // premium used (1 - potShareEquity), which counts a chop partially as a
    // loss even though a chop refunds the premium - overcharging every
    // chop-prone spot on top of the house margin. Fair premium under the
    // real terms is insured x P(strict loss | not push), then the margin.
    const components = precomputed;
    const equity = components.equity;
    const pushFrac = Math.max(0, Math.min(1, components.pushPct / 100));
    const lossFrac = Math.max(0, Math.min(1, components.strictLossPct / 100));
    // A near-certain chop is uninsurable, and a leader who cannot strictly
    // lose has nothing to insure - no offer in either case.
    if (pushFrac >= 0.99 || lossFrac <= 0) return [];
    const lossGivenNotPush = Math.min(1, lossFrac / (1 - pushFrac));

    // REFERENCE PARITY 2026-08-26 (Dan's leader-seat recording): the insured
    // pot covers the WINNINGS the leader stands to collect, capped by the
    // max-insurable fraction of the pot - the reference dialog's max insured
    // is approximately the pot, well above the leader's own stake. The old
    // at-risk cap (insure only your committed chips) undersold coverage to
    // roughly half the pot heads-up. The leader's committed chips still ride
    // the offer as `atRisk` - the Break Even preset needs them.
    const maxInsurable = pot * (config.maxInsurablePercent / 100);
    const fullInsuredAmount = Math.round(maxInsurable * 100) / 100;
    // POKERBROS PARITY 2026-08-28 (Dan's ruling): the fee is only ever
    // COLLECTED when the leader wins (loss pays the insured amount fee-free,
    // push voids). Fair fee therefore satisfies fee×pWin = insured×pLoss, and
    // the 20% margin rides on top: fee = insured × pLoss/pWin × houseMargin.
    // House EV per contract = fee×pWin − insured×pLoss = (margin−1) × fair
    // cost — the same 20% edge the old always-charged pricing banked.
    const winGivenNotPush = 1 - lossGivenNotPush;
    if (winGivenNotPush <= 0) return [];
    const fullPremium =
      Math.round(
        ((fullInsuredAmount * lossGivenNotPush * config.houseMargin) / winGivenNotPush) * 100
      ) / 100;

    if (fullInsuredAmount <= 0) return [];
    // UNINSURABLE 2026-08-28: if the fee reaches the payout (rate <= 1 — the
    // "leader" loses too often, lossGivenNotPush >= 1/(1+margin)), the
    // contract cannot be rational for anyone: you would pay >= the most you
    // can ever get back. No offer.
    if (fullPremium >= fullInsuredAmount) return [];
    // FINAL AUDIT 2026-08-26: at dust stakes the cents-rounded premium can hit
    // 0.00 while the insured amount is positive - a FREE payout contract the
    // union bank would fund. Uninsurable at this granularity: no offer.
    if (fullPremium <= 0) return [];

    // EV CASHOUT 2026-08-28: the alternative to insuring — take your equity
    // now. Priced on the same insurable pot, from the same exact-enumeration
    // pot-share equity (chop shares included, which is exactly what a
    // cashout buys), minus the configured fee. Zero/dust offers are omitted.
    let evCashoutAmount: number | undefined;
    if (config.evCashoutEnabled) {
      const feeFrac = Math.max(0, Math.min(100, config.evCashoutFeePercent)) / 100;
      const ev = Math.round(fullInsuredAmount * (equity / 100) * (1 - feeFrac) * 100) / 100;
      if (ev > 0) evCashoutAmount = ev;
    }

    const offer: InsuranceOffer = {
      tableId,
      handId,
      playerId: leader.playerId,
      holeCards: leader.holeCards,
      equity,
      fullPremium,
      premium: fullPremium, // default 100% coverage; scaled in acceptPartial
      fullInsuredAmount,
      insuredAmount: fullInsuredAmount,
      coveragePercent: 100,
      atRisk: Math.round(leader.atRisk * 100) / 100,
      status: 'offered',
      declinedForHand: false,
      evCashoutAmount,
      boardLength: board.length,
    };

    // Phase 1.2 PR-G-real: expiry via DeadlineScheduler.
    this.scheduler.schedule({
      tableId,
      eventId: this.offerEventId(leader.playerId),
      deadlineMs: Date.now() + config.offerTimeoutSeconds * 1000,
      callback: () => {
        if (offer.status === 'offered') {
          // POKERBROS PARITY 2026-08-26 (Dan): a decline is FINAL for the hand.
          // "IF A PLAYER DECLINES, THEY DON'T GET OFFERED AGAIN." A timeout is
          // a decline, so it is final too - the player had their window.
          // PREFLOP OFFER 2026-08-28 (Dan): a PREFLOP decline/timeout is
          // street-only — the same leader is re-offered on the flop, where
          // the finality rule takes over.
          this.decline(tableId, leader.playerId, offer.boardLength >= 3, 'timeout');
        }
      },
    });

    // MERGE (do NOT overwrite): keep already-accepted/settled coverage from
    // earlier streets; replace only a prior still-'offered' entry for this leader.
    const merged = existing.filter(
      (o) => !(o.playerId === leader.playerId && o.status === 'offered')
    );
    merged.push(offer);
    this.activeOffers.set(tableId, merged);

    this.emitEvent({
      type: 'INSURANCE_OFFERED',
      tableId,
      handId,
      playerId: leader.playerId,
      equity,
      fullPremium,
      premium: fullPremium,
      fullInsuredAmount,
      insuredAmount: fullInsuredAmount,
      coveragePercent: 100,
      pot,
      evCashoutAmount,
    });

    return [offer];
  }

  /**
   * EV CASHOUT 2026-08-28: lock the equity payout instead of insuring.
   * The offer resolves (the runout pause ends); the hand still runs out; the
   * settlement layer pays `cashoutAmount` from the bank and redirects the
   * player's actual pot winnings to the bank.
   */
  acceptEvCashout(tableId: string, playerId: string): { ok: boolean; amount?: number } {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return { ok: false };
    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return { ok: false };
    if (typeof offer.evCashoutAmount !== 'number' || offer.evCashoutAmount <= 0) {
      return { ok: false };
    }

    offer.status = 'cashed_out';
    offer.cashoutAmount = offer.evCashoutAmount;
    this.scheduler.cancel(tableId, this.offerEventId(playerId));

    this.emitEvent({
      type: 'INSURANCE_CASHED_OUT',
      tableId,
      handId: offer.handId,
      playerId,
      cashoutAmount: offer.cashoutAmount,
      equity: offer.equity,
    });

    return { ok: true, amount: offer.cashoutAmount };
  }

  /**
   * Accept insurance with full coverage (100%).
   */
  accept(tableId: string, playerId: string): boolean {
    return this.acceptPartial(tableId, playerId, 100);
  }

  /**
   * Accept insurance with partial coverage (1-100%).
   * Player uses a slider to choose how much coverage they want.
   * e.g., 75% coverage = 75% of the insuredAmount, 75% of the premium.
   */
  acceptPartial(tableId: string, playerId: string, coveragePercent: number): boolean {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return false;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return false;

    // Clamp coverage to valid range.
    // FINAL AUDIT 2026-08-26: hundredths of a percent, no longer whole
    // percents. The fee-first dialog converts its cents-precision fee to a
    // percentage; rounding that to an integer here charged up to half a
    // percent of the full premium more or less than the number the player
    // was shown. What is displayed is what is bought, to the cent.
    const coverage = Math.max(0.01, Math.min(100, Math.round(coveragePercent * 100) / 100));
    const coverageMultiplier = coverage / 100;

    // Scale insured amount and premium by coverage percentage
    offer.coveragePercent = coverage;
    offer.insuredAmount = Math.round(offer.fullInsuredAmount * coverageMultiplier * 100) / 100;
    offer.premium = Math.round(offer.fullPremium * coverageMultiplier * 100) / 100;
    offer.status = 'accepted';
    // Phase 1.2 PR-G-real: cancel the pending expiry deadline.
    this.scheduler.cancel(tableId, this.offerEventId(playerId));

    this.emitEvent({
      type: 'INSURANCE_ACCEPTED',
      tableId,
      handId: offer.handId,
      playerId,
      premium: offer.premium,
      insuredAmount: offer.insuredAmount,
      coveragePercent: coverage,
    });

    return true;
  }

  /**
   * Decline insurance.
   *
   * POKERBROS PARITY 2026-08-26 (Dan): "IF A PLAYER DECLINES, THEY DON'T GET
   * OFFERED AGAIN." Every decline — button, timeout, or safety fallback — is
   * FINAL for the hand, so the default is now `true` and no caller passes
   * anything else. The parameter survives only so tests can pin the flag.
   */
  decline(
    tableId: string,
    playerId: string,
    forHand: boolean = true,
    // OBSERVABILITY 2026-08-28: 'timeout' when the offer window expired,
    // 'player' when a decline was chosen. Same finality either way.
    source: 'player' | 'timeout' = 'player'
  ): void {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return;

    offer.status = 'declined';
    offer.declinedForHand = forHand;
    // Phase 1.2 PR-G-real: cancel the pending expiry deadline.
    this.scheduler.cancel(tableId, this.offerEventId(playerId));

    this.emitEvent({
      type: 'INSURANCE_DECLINED',
      tableId,
      handId: offer.handId,
      playerId,
      declinedForHand: forHand,
      source,
    });
  }

  /**
   * Get a premium preview for a specific coverage percentage.
   * Used by the client slider to show real-time cost/payout as user adjusts.
   */
  getPreview(
    tableId: string,
    playerId: string,
    coveragePercent: number
  ): { premium: number; insuredAmount: number; coveragePercent: number } | null {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return null;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return null;

    // FINAL AUDIT 2026-08-26: same fractional precision as acceptPartial.
    const coverage = Math.max(0.01, Math.min(100, Math.round(coveragePercent * 100) / 100));
    const coverageMultiplier = coverage / 100;

    return {
      premium: Math.round(offer.fullPremium * coverageMultiplier * 100) / 100,
      insuredAmount: Math.round(offer.fullInsuredAmount * coverageMultiplier * 100) / 100,
      coveragePercent: coverage,
    };
  }

  /**
   * Settle all accepted insurance offers based on hand outcome.
   */
  /**
   * FIX 118 (restored FIX 110): Accept string | string[] for winnerIds.
   * Bible V8 §4.19: TIES = PUSH — if pot is chopped (multiple winners),
   * insurance is voided for the winner (no premium charged, no payout).
   */
  settle(tableId: string, winnerIds: string | string[]): InsuranceSettlement[] {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return [];

    const winners = Array.isArray(winnerIds) ? winnerIds : [winnerIds];
    const isChop = winners.length > 1;
    const settlements: InsuranceSettlement[] = [];

    for (const offer of offers) {
      // EV CASHOUT 2026-08-28: a cashed-out offer pays the locked amount
      // REGARDLESS of the board's outcome. The settlement layer credits it
      // from the bank and separately redirects the player's actual pot
      // winnings back to the bank (it knows the amounts; this engine doesn't).
      if (offer.status === 'cashed_out') {
        const cashout = Math.round((offer.cashoutAmount ?? 0) * 100) / 100;
        const settlement: InsuranceSettlement = {
          playerId: offer.playerId,
          insuredAmount: 0,
          premium: 0,
          payout: cashout,
          equity: offer.equity,
          won: !winners.includes(offer.playerId),
          kind: 'ev_cashout',
        };
        settlements.push(settlement);
        offer.status = 'settled';
        this.emitEvent({
          type: 'INSURANCE_SETTLED',
          tableId,
          handId: offer.handId,
          playerId: offer.playerId,
          payout: cashout,
          premium: 0,
          insuredAmount: 0,
          coveragePercent: 100,
          won: settlement.won,
          kind: 'ev_cashout',
        });
        continue;
      }

      if (offer.status !== 'accepted') continue;

      const playerIsWinner = winners.includes(offer.playerId);

      // FIX 118: TIES = PUSH — chop + player is a winner → insurance voided
      if (isChop && playerIsWinner) {
        const settlement: InsuranceSettlement = {
          playerId: offer.playerId,
          insuredAmount: offer.insuredAmount,
          premium: 0, // PUSH — no premium charged
          payout: 0, // PUSH — no payout
          equity: offer.equity,
          won: false,
          kind: 'insurance',
        };
        settlements.push(settlement);
        offer.status = 'settled';
        this.emitEvent({
          type: 'INSURANCE_SETTLED',
          tableId,
          handId: offer.handId,
          playerId: offer.playerId,
          payout: 0,
          premium: 0,
          insuredAmount: offer.insuredAmount,
          coveragePercent: offer.coveragePercent,
          won: false,
        });
        continue;
      }

      const playerLost = !playerIsWinner;
      const payout = playerLost ? offer.insuredAmount : 0;
      // POKERBROS PARITY 2026-08-28 (Dan's ruling): the fee is charged ONLY
      // when the insured leader WINS. On a loss the insured amount is paid
      // out whole — "For Losing: <insured pot>" in the dialog is literal.
      // Pricing in createOffers builds the waived-fee branch into the rate.
      const premiumCharged = playerLost ? 0 : offer.premium;

      const settlement: InsuranceSettlement = {
        playerId: offer.playerId,
        insuredAmount: offer.insuredAmount,
        premium: premiumCharged,
        payout,
        equity: offer.equity,
        won: playerLost,
        kind: 'insurance',
      };

      settlements.push(settlement);
      offer.status = 'settled';

      this.emitEvent({
        type: 'INSURANCE_SETTLED',
        tableId,
        handId: offer.handId,
        playerId: offer.playerId,
        payout,
        premium: premiumCharged,
        insuredAmount: offer.insuredAmount,
        coveragePercent: offer.coveragePercent,
        won: playerLost,
      });
    }

    // Phase 1.2 PR-G-real: drop any lingering expiry entries for this table.
    // Accepted/declined offers already cancelled theirs at transition time;
    // this belt-and-suspenders covers any edge-case where settle runs while
    // an offer is still notionally 'offered' (chopped tie with no response).
    for (const offer of this.activeOffers.get(tableId) ?? []) {
      this.scheduler.cancel(tableId, this.offerEventId(offer.playerId));
    }
    this.activeOffers.delete(tableId);
    return settlements;
  }

  allResponded(tableId: string): boolean {
    const offers = this.activeOffers.get(tableId);
    if (!offers || offers.length === 0) return true;
    return offers.every((o) => o.status !== 'offered');
  }

  getOffers(tableId: string): InsuranceOffer[] {
    return this.activeOffers.get(tableId) || [];
  }

  /**
   * Per-HAND cleanup: drop this hand's offers and their expiry timers, KEEP
   * the table's configuration.
   *
   * OFFER-CONFIG FIX 2026-08-21 - identical defect to RunItTwiceEngine.endHand
   * (see that doc comment). Settlement's between-hands dispose() also deleted
   * tableConfigs, so insurance_enabled went false after hand 1 and no insurance
   * was ever offered again until the engine restarted.
   */
  endHand(tableId: string): void {
    const offers = this.activeOffers.get(tableId);
    if (offers) {
      // Phase 1.2 PR-G-real: cancel every expiry deadline we own for this table.
      for (const offer of offers) {
        this.scheduler.cancel(tableId, this.offerEventId(offer.playerId));
      }
    }
    this.activeOffers.delete(tableId);
  }

  dispose(tableId: string): void {
    this.endHand(tableId);
    this.tableConfigs.delete(tableId);
  }

  /**
   * AUDIT FIX 2026-07-19: Per-street re-offer previously called dispose(), which
   * wiped ALL offers (including ones the player had already ACCEPTED and paid a
   * premium for) and reset the table config to defaults. Coverage then silently
   * vanished unless it was accepted on the very last offerable street. This
   * clears only still-'offered' (unaccepted) offers, cancels their deadlines,
   * and preserves accepted offers + the table config so settlement still pays.
   */
  clearPendingOffers(tableId: string): void {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return;
    const kept: InsuranceOffer[] = [];
    for (const offer of offers) {
      if (offer.status === 'offered') {
        this.scheduler.cancel(tableId, this.offerEventId(offer.playerId));
      } else {
        kept.push(offer);
      }
    }
    this.activeOffers.set(tableId, kept);
  }

  disposeAll(): void {
    for (const [tableId] of this.activeOffers) {
      this.dispose(tableId);
    }
    this.tableConfigs.clear();
  }

  private emitEvent(event: InsuranceEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'InsuranceEngine.Event_handler_error');
      }
    }
  }
}
