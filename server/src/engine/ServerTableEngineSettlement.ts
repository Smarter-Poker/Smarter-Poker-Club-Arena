/**
 * ServerTableEngine, layer 6/8 — the HAND_COMPLETE settlement pipeline and post-hand tasks.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { AtomicStackService, type StackSettlement } from './AtomicStackService.js';
import { StraddleEngine } from './StraddleEngine.js';
import { integrityFeed } from '../integrity/IntegrityFeed.js';
import type { HandHistoryRow } from '../integrity/HandEventAdapter.js';
import { computeSevenDeuceBounties } from './SevenDeuceBounty.js';
import {
  getFullRakeConfig,
  detectBBJHit,
} from '../config/RakeConfig.js';
import {
  loadTable,
  syncStacks,
  syncTournamentChips,
  updateTableStatus,
  autoRebuyHorse,
  markSeatAsLeft,
  processLeavePending,
  logBBJCollection,
  logInsuranceSettlement,
  logHandHistory,
  processBBJPayout,
  completeHandSnapshot,
  supabase,
} from '../services/supabase.js';
import type {
  HandEvent,
  SeatedPlayer,
} from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { queueUnbankedFee } from '../services/FeeReconciler.js';
import { ServerTableEngineDealing } from './ServerTableEngineDealing.js';

export abstract class ServerTableEngineSettlement extends ServerTableEngineDealing {

  /**
   * Bible V8 §1.9 settlement pipeline. Extracted verbatim (2026-08-08 file
   * split) from the `HAND_COMPLETE` case of `handleHandEvent`. The body is
   * unchanged apart from a uniform 4-space dedent for its new nesting level
   * (re-indent it and you get the monolith back line-for-line); the trailing
   * `break;` became the caller’s own `break;`.
   */
  protected async handleHandCompleteEvent(event: HandEvent, players: SeatedPlayer[]): Promise<void> {
    // ═══════════════════════════════════════════════════════════════════
    // Bible V8 §1.9: SETTLEMENT PIPELINE — 15-step mandatory order
    //
    // Step  1: Lock table (no new actions accepted)
    // Step  2: Calculate side pots from contributions
    // Step  3: Evaluate all active players' hands (variant-aware)
    // Step  4: Determine winners per pot (including hi-lo split)
    // Step  5: Calculate rake (percentage with cap, no-flop-no-drop)
    // Step  6: Distribute winnings (integer-cents arithmetic)
    // Step  7: Update player stacks (atomic via AtomicStackService)
    // Step  8: Persist results to database (atomic transaction)
    // Step  9: Update leaderboards
    // Step 10: Trigger achievements/daily challenges
    // Step 11: Calculate VIP points earned
    // Step 12: Calculate rakeback
    // Step 13: Log complete hand history
    // Step 14: Broadcast final state (with showdown cards)
    // Step 15: Unlock table
    //
    // Steps 1-6 are handled inside HandController.advanceStage()
    // Steps 7-15 are handled here + postHandTasks()
    // ═══════════════════════════════════════════════════════════════════

    // SETTLEMENT STEP 1: Lock table (actionLock prevents new actions)
    // Already enforced — handController completes hand, no more actions accepted
    // Phase X5 (2026-04-28): emit explicit table_locked event so the
    // client knows to suppress the action panel until table_unlocked.
    // Bible V8 §1.16 Real-Time Delivery: every state transition gets a
    // discrete named event, never inferred from a state-snapshot diff.
    this.hub?.emitEvent(this.tableId, {
      type: 'table_locked',
      table_id: this.tableId,
      hand_number: this.handCount,
      reason: 'settlement',
      timestamp: Date.now(),
    });

    // SETTLEMENT STEP 14 (early broadcast): Notify clients hand is complete
    // Bible V8 §1.16: discrete hand_complete event
    this.hub?.emitEvent(this.tableId, {
      type: 'hand_complete',
      table_id: this.tableId,
      hand_number: this.handCount,
      winner_ids: this.currentHandWinnerIds,
      timestamp: Date.now(),
    });
    // Rabbit Hunt: Capture remaining deck cards BEFORE handController is nulled
    if (this.handController) {
      try {
        const remainingDeck = this.handController.getRemainingDeck();
        // Only take the next 5 cards max (enough for any board completion)
        this.currentHandRabbitCards = remainingDeck.slice(0, 5);
      } catch {
        this.currentHandRabbitCards = [];
      }
    }

    // SETTLEMENT STEP 8 (partial): Mark hand snapshot as complete
    // FIX 137: Bible V8 §7.17
    completeHandSnapshot(this.tableId, this.handCount).catch(() => {});

    // SETTLEMENT STEP 5: Capture rake and BBJ fee (calculated in HandController)
    if ((event as any).rake !== undefined) {
      this.currentHandRake = (event as any).rake;
    }
    if ((event as any).bbjFee !== undefined) {
      this.currentHandBBJFee = (event as any).bbjFee;
    }

    // SETTLEMENT STEP 4+5: State verification — deduct rake + BBJ and verify chip conservation
    const totalDeductions = this.currentHandRake + this.currentHandBBJFee;
    if (totalDeductions > 0) {
      this.stateVerifier.deductRake(this.tableId, totalDeductions);
    }
    if (this.handController) {
      const finalState = this.handController.getState();
      const verifyResult = this.stateVerifier.verify({
        tableId: this.tableId,
        handNumber: this.handCount,
        players: finalState.players,
        communityCards: finalState.communityCards,
        pot: finalState.pot,
        stage: finalState.stage,
      });
      if (!verifyResult.valid) {
        reportError(
          verifyResult.violations.map((v) => v.message).join('; '),
          'ServerTableEnginethistableId.Hand_thishandCount_FAILED_inte'
        );
      }
    }

    // SETTLEMENT STEP 7: Update player stacks (atomic via AtomicStackService)
    // FIX 150: Wire AtomicStackService — settle final stacks through atomic layer
    // Computes delta (final stack - initial stack tracked by version service) for each player
    // so version tracking stays in sync and race conditions with concurrent rebuy/cashout are prevented.
    if (this.handController) {
      const finalState = this.handController.getState();
      const settlements: StackSettlement[] = [];
      for (const p of finalState.players) {
        const initial = this.atomicStackService.getStackWithVersion(this.tableId, p.user_id);
        const delta = p.stack - initial.stack;
        if (delta !== 0) {
          settlements.push({ userId: p.user_id, delta });
        }
      }
      if (settlements.length > 0) {
        const settleResult = this.atomicStackService.atomicSettle(this.tableId, settlements);
        if (!settleResult.success) {
          reportError(
            settleResult.errors.join('; '),
            'ServerTableEnginethistableId.AtomicSettle_failed'
          );
        }
      }
    }

    // SETTLEMENT STEP 15 (partial): Clean up validator state between hands (unlock table)
    this.actionValidator.clearTable(this.tableId);
    this.preciseTimer.clearTable(this.tableId);

    // Step 5: Clean up supporting modules between hands
    this.preActionEngine.dispose(this.tableId);
    // Note: timeBankEngine persists across hands (pool model — depletes per session, not per hand)
    //       Per-hand activation counter is reset in dealHand() via resetHandActivations()
    // Note: disconnectEngine persists across hands (tracks connection state)
    // Note: atomicStackService persists across hands (tracks stack versions via FIX 150)

    // SETTLEMENT STEP 6 (continued): Insurance settlement — distribute insurance payouts
    // Bible V8 §4.19: Settle insurance BEFORE disposing (offers cleared on dispose)
    // FIX 118: Pass ALL winner IDs — chops (multiple winners) = PUSH (insurance voided)
    if (this.currentHandWinnerIds.length > 0) {
      this.currentHandInsuranceSettlements = this.insuranceEngine.settle(
        this.tableId,
        this.currentHandWinnerIds
      );

      // Bible V8 §4.19: Insurance settlement — applied like rake at the end.
      // - LOSER who bought insurance: Gets insuredAmount from union/club bank → credited to table stack
      // - WINNER who bought insurance: Premium deducted from winnings (taken at end like rake)
      // - Player can't lose more than their premium; can't gain more than insuredAmount
      for (const settlement of this.currentHandInsuranceSettlements) {
        const seatedPlayer = this.seatedPlayers.find((p) => p.user_id === settlement.playerId);
        const enginePlayer = this.handController
          ? this.handController
              .getState()
              .players.find((p) => p.user_id === settlement.playerId)
          : null;

        if (settlement.payout > 0) {
          // LOSER with insurance: credit payout from union/club bank to table stack
          if (seatedPlayer) {
            seatedPlayer.stack += settlement.payout;
            console.log(
              `[ServerTableEngine:${this.tableId}] Insurance payout: ${settlement.playerId} lost hand → +$${settlement.payout} from bank`
            );
          }
          if (enginePlayer) enginePlayer.stack += settlement.payout;
        }

        // ALL insured players: premium deducted from their stack at end (like rake)
        // For losers: payout - premium = net gain. For winners: -premium = net cost.
        if (settlement.premium > 0) {
          // AUDIT M16: the clamps below silently absorb (Math.max(0, ...)) any
          // premium the stack cannot cover. A premium larger than the stack it
          // is pulled from means the insurance bank collected less than the
          // premium that was priced and written to the audit ledger — a
          // real-money under-collection that must never pass silently. Alert
          // with the exact shortfall, durably (raiseFinancialAlert never
          // throws), before clamping exactly as before.
          const premiumStack = seatedPlayer
            ? seatedPlayer.stack
            : enginePlayer
              ? enginePlayer.stack
              : 0;
          if (settlement.premium > premiumStack) {
            const shortfall =
              Math.round((settlement.premium - premiumStack) * 100) / 100;
            await raiseFinancialAlert(
              'critical',
              'ServerTableEngine.insurance_premium_exceeds_stack',
              `Insurance premium ${settlement.premium} exceeds stack ${premiumStack} by ${shortfall} for ${settlement.playerId}; premium clamped and under-collected`,
              {
                tableId: this.tableId,
                playerId: settlement.playerId,
                premium: settlement.premium,
                stack: premiumStack,
                shortfall,
                insuredAmount: settlement.insuredAmount,
                equity: settlement.equity,
                won: settlement.won,
                payout: settlement.payout,
              }
            );
          }
          if (seatedPlayer) {
            seatedPlayer.stack = Math.max(0, seatedPlayer.stack - settlement.premium);
            console.log(
              `[ServerTableEngine:${this.tableId}] Insurance premium: ${settlement.playerId} → -$${settlement.premium} (stack: $${seatedPlayer.stack})`
            );
          }
          if (enginePlayer) {
            enginePlayer.stack = Math.max(0, enginePlayer.stack - settlement.premium);
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SEVEN-DEUCE BOUNTY (7-2 game) — Bible V8 §11 table option
    // A player who WINS a pot holding any 7 and any 2 collects a fixed bounty
    // (default 2 big blinds, configurable per table) from every OTHER player
    // dealt into the hand. Rule (Dan 2026-07-20): the hand MUST have seen a
    // flop to qualify — pots won pre-flop pay no bounty. Any 7 + any 2
    // qualifies. NLH only (meaningless in PLO; short-deck has no deuces).
    // The bounty is a player-to-player table-stack transfer (zero-sum,
    // chip-conserving); each payer pays only up to their remaining stack so
    // no chips are ever minted. Both the seated + engine stack copies are
    // mutated here so syncStacks() in postHandTasks persists the result.
    // ═══════════════════════════════════════════════════════════════════════
    const sevenDeuceEnabled = (this.tableInfo as any)?.seven_deuce_enabled === true;
    const sevenDeuceSawFlop = this.currentHandCommunityCards.length >= 3;
    const sevenDeuceIsNlh = (this.tableInfo?.game_variant || 'nlh') === 'nlh';
    if (
      sevenDeuceEnabled &&
      sevenDeuceSawFlop &&
      sevenDeuceIsNlh &&
      this.tableInfo &&
      this.currentHandWinners.length > 0 &&
      this.handController
    ) {
      const bb = this.tableInfo.big_blind || 0;
      const bbMultiple = Number((this.tableInfo as any)?.seven_deuce_amount ?? 2) || 2;
      const bountyPerPayer = Math.round(bb * bbMultiple * 100) / 100;

      if (bountyPerPayer > 0) {
        const sdState = this.handController.getState();
        const sdDealtIn = players.map((p) => {
          const enginePlayer = sdState.players.find((ep) => ep.user_id === p.user_id);
          const seatedPlayer = this.seatedPlayers.find((sp) => sp.user_id === p.user_id);
          return {
            userId: p.user_id,
            cards: enginePlayer?.cards ?? [],
            stack: seatedPlayer?.stack ?? enginePlayer?.stack ?? 0,
          };
        });

        const sdTransfers = computeSevenDeuceBounties(
          this.currentHandWinnerIds,
          sdDealtIn,
          bountyPerPayer
        );

        let sdAnyApplied = false;
        for (const transfer of sdTransfers) {
          // Apply debits to each payer (re-cap at the live stack in case an
          // earlier transfer this hand already took chips) and credit the
          // winner. Mutate BOTH the seated + engine stack copies.
          let applied = 0;
          const appliedPayers: Array<{ userId: string; amount: number }> = [];
          for (const payer of transfer.payers) {
            const seatedPayer = this.seatedPlayers.find((p) => p.user_id === payer.userId);
            const enginePayer = sdState.players.find((p) => p.user_id === payer.userId);
            const liveStack = Math.max(
              0,
              Math.round((seatedPayer?.stack ?? enginePayer?.stack ?? 0) * 100) / 100
            );
            const pay = Math.min(payer.amount, liveStack);
            if (pay <= 0) continue;
            if (seatedPayer)
              seatedPayer.stack = Math.round((seatedPayer.stack - pay) * 100) / 100;
            if (enginePayer)
              enginePayer.stack = Math.round((enginePayer.stack - pay) * 100) / 100;
            applied = Math.round((applied + pay) * 100) / 100;
            appliedPayers.push({ userId: payer.userId, amount: pay });
          }

          if (applied <= 0) continue;
          sdAnyApplied = true;

          const seatedWinner = this.seatedPlayers.find(
            (p) => p.user_id === transfer.winnerUserId
          );
          const engineWinner = sdState.players.find((p) => p.user_id === transfer.winnerUserId);
          if (seatedWinner)
            seatedWinner.stack = Math.round((seatedWinner.stack + applied) * 100) / 100;
          if (engineWinner)
            engineWinner.stack = Math.round((engineWinner.stack + applied) * 100) / 100;

          const winnerCards = engineWinner?.cards ?? [];
          console.log(
            `[ServerTableEngine:${this.tableId}] 7-2 BOUNTY: ${transfer.winnerUserId} won post-flop with 7-2 -> +$${applied} from ${appliedPayers.length} players`
          );

          // Reveal the 7-2 (even on a fold-around win) + announce the bounty.
          this.hub?.emitEvent(this.tableId, {
            type: 'seven_deuce_bounty',
            table_id: this.tableId,
            hand_number: this.handCount,
            winner_user_id: transfer.winnerUserId,
            total_collected: applied,
            per_player_amount: transfer.perPlayerAmount,
            payers: appliedPayers,
            hole_cards: winnerCards.map((c) => ({ rank: c.rank, suit: c.suit })),
          });

          // Durable audit trail (fire-and-forget, non-fatal).
          if (this.tableInfo.club_id) {
            const sdClubId = this.tableInfo.club_id;
            const sdHandNo = this.handCount;
            Promise.resolve(
              supabase.from('seven_deuce_bounties').insert({
                table_id: this.tableId,
                club_id: sdClubId,
                hand_number: sdHandNo,
                winner_user_id: transfer.winnerUserId,
                total_collected: applied,
                per_player_amount: transfer.perPlayerAmount,
                payers: appliedPayers,
              })
            )
              .then(({ error }: { error: unknown }) => {
                if (error)
                  console.warn(
                    '[Engine] seven_deuce_bounties insert failed (non-fatal):',
                    error
                  );
              })
              .catch((sdErr: unknown) =>
                console.warn('[Engine] seven_deuce_bounties insert threw (non-fatal):', sdErr)
              );
          }
        }

        // Re-broadcast so clients see the bounty-adjusted stacks immediately
        // (the WINNERS snapshot went out before these transfers were applied).
        if (sdAnyApplied) this.broadcastCurrentState();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BBJ HIT DETECTION — Check if showdown qualifies as a Bad Beat Jackpot
    // FIX: Respect table-level bbj_percent — explicit 0 disables per-table.
    // RAKE-AUDIT 2026-07-24: default is now ENABLED (?? 100) to match the
    // fee-drop gate — `?? 0` made jackpots undetectable on every table
    // because bbj_percent was never selected by loadTable. Tournaments are
    // excluded (no fee is collected there).
    // ═══════════════════════════════════════════════════════════════════════
    const tableBbjPercent = this.isTournamentTable()
      ? 0
      : ((this.tableInfo as any)?.bbj_percent ?? 100);
    if (
      tableBbjPercent > 0 &&
      this.currentHandShowdownResults.length >= 2 &&
      this.currentHandWinnerIds.length > 0 &&
      this.tableInfo
    ) {
      const variant = this.tableInfo.game_variant || 'nlh';
      const dealtInPlayerIds = players.map((p) => p.user_id);
      const bbjResult = detectBBJHit(
        this.currentHandShowdownResults,
        this.currentHandWinnerIds[0],
        variant,
        this.currentHandPotSize,
        this.tableInfo.big_blind,
        dealtInPlayerIds.length,
        dealtInPlayerIds
      );

      if (bbjResult.hit) {
        console.log(
          `[ServerTableEngine:${this.tableId}] *** BBJ HIT! *** ` +
            `Loser: ${bbjResult.loserUserId} (${bbjResult.loserHand?.name}), ` +
            `Winner: ${bbjResult.winnerUserId} (${bbjResult.winnerHand?.name})`
        );

        // Get BBJ payout config for this stakes level
        const rakeConfig = getFullRakeConfig(
          this.tableInfo.small_blind,
          this.tableInfo.big_blind,
          variant
        );

        // BBJ payout: chips credited directly to players' table balances
        // The actual pool amounts are fetched from Supabase and paid from union/club bank
        // For now, broadcast the BBJ_HIT event with payout percentages.
        // The actual payout amounts will be calculated in postHandTasks() using the pool balance.
        this.hub?.emitEvent(this.tableId, {
          type: 'bbj_hit',
          table_id: this.tableId,
          hand_number: this.handCount,
          loser: {
            userId: bbjResult.loserUserId,
            hand: bbjResult.loserHand,
            payoutPercent: rakeConfig.bbjPayoutLoser, // % of BBJ pool
          },
          winner: {
            userId: bbjResult.winnerUserId,
            hand: bbjResult.winnerHand,
            payoutPercent: rakeConfig.bbjPayoutWinner,
          },
          tableShare: {
            playerIds: dealtInPlayerIds,
            payoutPercent: rakeConfig.bbjPayoutTable,
          },
          totalPayoutPercent: rakeConfig.bbjPayoutTotalPercent,
          variant,
          qualifyingHandLabel: bbjResult.qualifyingHandLabel,
        });

        // Store BBJ hit for postHandTasks to process the actual payouts
        this.currentHandBBJHit = bbjResult;
        this.currentHandBBJPayoutConfig = rakeConfig;
      }
    }

    // Step 6: Clean up advanced modules between hands
    this.runItTwiceEngine.dispose(this.tableId);
    this.insuranceEngine.dispose(this.tableId);
    // Note: straddleEngine persists (auto-straddle enrollment persists)
    // Note: rakebackEngine persists (accumulates across hands)

    // SETTLEMENT STEP 12: Calculate rakeback (done in postHandTasks)
    // SETTLEMENT STEP 9-11: Leaderboards, achievements, VIP points (done in postHandTasks)

    // Record telemetry for this hand
    this.engineTelemetry.recordPlayerCount(this.tableId, players.length);

    // FIX 211: Bible V8 §1.9 — Track postHandTasks promise so dealingLoop can await
    // it before starting the next hand, preventing stale DB stacks from race conditions.
    this.postHandTasksPromise = this.postHandTasks(players).catch((err) =>
      reportError(err, 'ServerTableEnginethistableId.Posthand_error')
    );
    this.currentHandWinnerIds = [];

    // Rabbit Hunt: Broadcast captured remaining deck ONLY when the hand
    // ended before the river was dealt. If the board already had all 5
    // cards revealed (full showdown), there's nothing to "see" — the
    // event would just confuse the UI by offering a paid reveal of cards
    // the player already saw. Round 65: gate on board.length < 5.
    const board = this.handController?.getState()?.communityCards ?? [];
    const handReachedRiver = board.length >= 5;
    // FIX-D3 2026-07-19 (Bible V8 §11): honor the table's rabbit-hunt toggle.
    // The event was emitted unconditionally, offering rabbit hunt even where
    // the host disabled it. Default allowed unless explicitly off.
    const rabbitAllowed =
      (this.tableInfo as { allow_rabbit_hunt?: boolean })?.allow_rabbit_hunt !== false;
    if (this.currentHandRabbitCards.length > 0 && !handReachedRiver && rabbitAllowed) {
      this.hub?.emitEvent(this.tableId, {
        type: 'rabbit_hunt_available',
        table_id: this.tableId,
        hand_number: this.handCount,
        rabbit_cards: this.currentHandRabbitCards,
        // Round 65: include current board length so client can slice the
        // right number of additional cards (e.g. flop-fold → show turn+river,
        // turn-fold → show river only, preflop-fold → show full 5).
        current_board_length: board.length,
      });
    }

    // ── ADDITIVE event-sourcing shadow (#1): replay + chip-conservation verify at hand end ──
    if (this.shadowRecorder) {
      try {
        this.shadowRecorder.recordHandEnded(this.handCount);
        const finalSeats = players.map((pp) => ({
          seat: pp.seat_number,
          userId: pp.user_id,
          stack: pp.stack,
        }));
        this.shadowRecorder.finalize({ seats: finalSeats });
      } catch (e) {
        reportError(e, 'ServerTableEngine.EVENT_SHADOW_finalize_error');
      }
      this.shadowRecorder = null;
    }
    // ── ADDITIVE observability (#5): close the hand span (feeds hand-duration histogram) ──
    if (this.handSpan) {
      try {
        this.handSpan.end();
      } catch {
        /* tracing must never affect gameplay */
      }
      this.handSpan = null;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // POST-HAND TASKS
  // ═════════════════════════════════════════════════════════════════════════════

  protected async postHandTasks(players: SeatedPlayer[]): Promise<void> {
    // ═══════════════════════════════════════════════════════════════════════
    // Bible V8 §1.9: SETTLEMENT PIPELINE (continued) — Steps 8-15
    // Steps 1-7 completed in HAND_COMPLETE handler above
    // ═══════════════════════════════════════════════════════════════════════

    // SETTLEMENT STEP 8: Persist results to database (atomic transaction)
    await syncStacks(
      this.tableId,
      players.map((p) => ({
        user_id: p.user_id,
        stack: p.stack,
        time_bank_uses_remaining: p.time_bank_uses_remaining,
      }))
    );

    // ─── ROUND 38 + 43 FIX: REORDERED — hand_history FIRST, then rake/BBJ ───
    // Round 38: rake_records.hand_id needed the v_handHistoryId.
    // Round 43: club_wallet_transactions.related_id (rake_in audit row) also
    // needs the hand UUID to link the audit ledger to the source hand. So
    // logHandHistory must precede logRakeCollection / logBBJCollection.
    let v_handHistoryId: string | null = null;
    if (this.tableInfo) {
      const result = await logHandHistory({
        tableId: this.tableId,
        tournamentId: this.tableInfo.tournament_id || undefined,
        handNumber: this.handCount,
        gameVariant: this.tableInfo.game_variant || 'nlh',
        smallBlind: this.tableInfo.small_blind,
        bigBlind: this.tableInfo.big_blind,
        potSize: this.currentHandPotSize,
        rakeAmount: this.currentHandRake,
        bbjAmount: this.currentHandBBJFee,
        communityCards: this.currentHandCommunityCards,
        startedAt: this.currentHandStartedAt || Date.now(),
        endedAt: Date.now(),
        winners: this.currentHandWinners,
        players: players.map((p) => ({
          userId: p.user_id,
          username: p.username,
          seat: p.seat_number,
          stack: p.stack,
          cards: [],
        })),
        actions: this.currentHandActions,
      });
      v_handHistoryId = result.handId;

      // ── ADDITIVE anti-cheat feed (#5): observe-only, fire-and-forget, flag-gated (default OFF) ──
      if (this.integrityFeedEnabled) {
        try {
          const feedRow: HandHistoryRow = {
            id: v_handHistoryId,
            table_id: this.tableId,
            hand_number: this.handCount,
            game_variant: this.tableInfo.game_variant || 'nlh',
            small_blind: this.tableInfo.small_blind,
            big_blind: this.tableInfo.big_blind,
            pot_size: this.currentHandPotSize,
            rake_amount: this.currentHandRake,
            community_cards: this.currentHandCommunityCards,
            started_at: this.currentHandStartedAt || Date.now(),
            ended_at: Date.now(),
            winners: this.currentHandWinners.map((w) => ({ userId: w.userId, amount: w.amount })),
            players: players.map((pp) => ({
              userId: pp.user_id,
              seat: pp.seat_number,
              stack: pp.stack,
            })),
            actions: this.currentHandActions,
          };
          integrityFeed.ingestRow(feedRow);
        } catch {
          /* observe-only: never affect settlement */
        }
      }
    }

    // SETTLEMENT STEP 8b: Distribute rake — ATOMIC + IDEMPOTENT + RECOVERABLE.
    // RAKE-AUDIT 2026-07-24 [money]: replaced the separate, non-atomic
    // logRakeCollection(...) + fire-and-forget rake_records insert (old STEP 12)
    // with ONE awaited atomic_distribute_rake(...) call, mirroring
    // bbj_atomic_payout_v2. In a single SECURITY DEFINER transaction it gates on
    // the hand (idempotent no-op on retry/restart), writes the durable
    // rake_records audit, credits the club_wallets accumulator, and routes the
    // spendable rake (union rake_wallet OR standalone chip_treasury) via a
    // per-leg claim ledger, so a missing leg is re-driven WITHOUT double-crediting.
    // UNION MODEL UNCHANGED: the union still holds 100% of cash rake; the weekly
    // settlement still returns 90% to clubs (nets 10%).
    if (!this.isTournamentTable() && this.currentHandRake > 0 && this.tableInfo?.club_id) {
      const contribsObj: Record<string, number> = {};
      for (const [uid, amt] of this.currentHandContributions.entries()) {
        contribsObj[uid] = amt;
      }
      let rakeDistributed = false;
      for (let attempt = 0; attempt < 3 && !rakeDistributed; attempt++) {
        const { error: rdErr } = await supabase.rpc('atomic_distribute_rake', {
          p_table_id: this.tableId,
          p_club_id: this.tableInfo.club_id,
          p_hand_id: v_handHistoryId,
          p_hand_number: this.handCount,
          p_rake: this.currentHandRake,
          p_bbj: this.currentHandBBJFee,
          p_pot: this.currentHandPotSize,
          p_num_players: this.currentHandContributions.size,
          p_contributions: contribsObj,
          p_tournament_id: this.tableInfo.tournament_id || null,
        });
        if (!rdErr) {
          rakeDistributed = true;
        } else if (attempt === 2) {
          reportError(
            new Error(`[atomic_distribute_rake] failed after retries: ${rdErr.message}`),
            'postHandTasks.atomic_distribute_rake_failed'
          );
          // A5 FIX (2026-08-08): the retries are exhausted, but the rake is
          // ALREADY out of the pot. Reporting an error and moving on destroyed
          // those chips — nothing on disk said they were owed. Queue the exact
          // arguments so the FeeReconciler can re-drive them. Re-driving is
          // safe: atomic_distribute_rake is gated on the hand
          // (uq_rake_records_hand_id), so an entry that actually did land is a
          // no-op rather than a double-bank.
          await queueUnbankedFee('rake', {
            tableId: this.tableId,
            clubId: this.tableInfo?.club_id,
            handId: v_handHistoryId,
            handNumber: this.handCount,
            rake: this.currentHandRake,
            bbj: this.currentHandBBJFee,
            pot: this.currentHandPotSize,
            numPlayers: this.currentHandContributions.size,
            contributions: contribsObj,
            tournamentId: this.tableInfo?.tournament_id || null,
            bigBlind: this.tableInfo?.big_blind ?? null,
            lastError: rdErr.message,
          });
        } else {
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
    }

    // SETTLEMENT STEP 8c: Log BBJ contribution
    // Round 44: pass v_handHistoryId so bbj_contributions.hand_id links to
    // hand_history (consistent with rake_records and club_wallet_transactions).
    if (!this.isTournamentTable() && this.currentHandBBJFee > 0 && this.tableInfo?.club_id) {
      // A5 FIX (2026-08-08): this return value used to be discarded, and
      // logBBJCollection swallowed every failure while logging 1 hand in 100.
      // That was not cosmetic. atomic_distribute_rake computes
      // `v_net := p_rake - v_bbj` and credits the club wallet only v_net,
      // deliberately excluding the BBJ slice because bbj_record_contribution is
      // what puts it into the jackpot pool. So a failure here left the chips in
      // NEITHER place — out of the pot and out of existence. An audit of the
      // 20,000 most recent raked hands (joined on hand_id) found zero actually
      // lost, so this is a hole being closed before it bites rather than a bleed
      // being stopped — but it was a hole nobody could have SEEN bite, which is
      // the part that had to change.
      const bbjBanked = await logBBJCollection(
        this.tableId,
        this.tableInfo.club_id,
        this.handCount,
        this.currentHandBBJFee,
        this.tableInfo.big_blind,
        v_handHistoryId
      );
      if (!bbjBanked) {
        await queueUnbankedFee('bbj_contribution', {
          tableId: this.tableId,
          clubId: this.tableInfo.club_id,
          handId: v_handHistoryId,
          handNumber: this.handCount,
          rake: this.currentHandRake,
          bbj: this.currentHandBBJFee,
          pot: this.currentHandPotSize,
          numPlayers: this.currentHandContributions.size,
          contributions: {},
          tournamentId: this.tableInfo?.tournament_id || null,
          bigBlind: this.tableInfo?.big_blind ?? null,
          lastError: 'logBBJCollection returned false',
        });
      }
    }

    // SETTLEMENT STEP 12: rakeback input (durable rake_records) is now written
    // INSIDE atomic_distribute_rake (STEP 8b) — one atomic, idempotent,
    // recoverable transaction. RAKE-AUDIT 2026-07-24 [money]: the former separate
    // fire-and-forget `rake_records.insert` here was REMOVED — it could silently
    // drop the settler's sole rakeback input on failure, and double-write on a
    // retry. RakebackSettlerService reads rake_records exactly as before.

    // SETTLEMENT STEP 12b: Promo playthrough accrual (unlock-by-wagering).
    // Any player who has an outstanding promo balance accrues their per-hand
    // wagered amount toward the playthrough requirement. When the threshold is
    // met, promo_apply_playthrough RELEASES the promo into cashable chip_balance
    // (atomic, FOR UPDATE, idempotent no-op when no promo is outstanding).
    // Cash tables only — tournament chips never carry a promo playthrough.
    // Fire-and-forget per player: non-blocking to gameplay, failures are logged
    // but never surface to the table (the wager is durably in rake_records above,
    // and the next hand's accrual is additive so nothing is lost permanently).
    if (!this.isTournamentTable() && this.tableInfo?.club_id) {
      const promoClubId = this.tableInfo.club_id;
      for (const [uid, amt] of this.currentHandContributions.entries()) {
        if (!uid || amt <= 0) continue;
        Promise.resolve(
          supabase.rpc('promo_apply_playthrough', {
            p_club_id: promoClubId,
            p_user_id: uid,
            p_wagered: amt,
          })
        )
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn('[Engine] promo_apply_playthrough failed (non-fatal):', error);
            }
          })
          .catch((ppErr: unknown) => {
            console.warn('[Engine] promo_apply_playthrough threw (non-fatal):', ppErr);
          });
      }
    }

    // 3b. Bible V8 §4.19: Log insurance settlements (settled in HAND_COMPLETE handler)
    // Insurance premiums → union bank (or club bank for standalone)
    // Insurance payouts → from union bank (or club bank) to player
    if (
      !this.isTournamentTable() &&
      this.tableInfo?.club_id &&
      this.currentHandInsuranceSettlements.length > 0
    ) {
      for (const settlement of this.currentHandInsuranceSettlements) {
        await logInsuranceSettlement({
          tableId: this.tableId,
          clubId: this.tableInfo.club_id,
          handNumber: this.handCount,
          playerId: settlement.playerId,
          equityPercent: settlement.equity, // FIX-A12: real equity the premium was priced on
          premium: settlement.premium,
          insuredAmount: settlement.insuredAmount,
          payout: settlement.payout,
          playerWon: !settlement.won, // settlement.won = insurance paid out = player lost the hand
        });
      }
    }

    // 3c. BBJ Payout — if a BBJ hit was detected in HAND_COMPLETE, process the actual payout
    // Chips credited directly to players' table balances from union/club BBJ pool
    if (
      !this.isTournamentTable() &&
      this.tableInfo?.club_id &&
      this.currentHandBBJHit?.hit &&
      this.currentHandBBJPayoutConfig
    ) {
      const bbjHit = this.currentHandBBJHit;
      const payoutConfig = this.currentHandBBJPayoutConfig;
      const result = await processBBJPayout({
        tableId: this.tableId,
        clubId: this.tableInfo.club_id,
        handNumber: this.handCount,
        loserUserId: bbjHit.loserUserId!,
        winnerUserId: bbjHit.winnerUserId!,
        loserHandName: bbjHit.loserHand?.name || 'Unknown',
        winnerHandName: bbjHit.winnerHand?.name || 'Unknown',
        dealtInPlayerIds: bbjHit.dealtInPlayerIds || [],
        // FIX P0-2: pass the currently-seated user_ids (engine memory = seat
        // authority) so the payout RPC credits seats for these and credits the
        // wallet directly for any dealt-in recipient who has since left the
        // table (their share is no longer silently dropped).
        seatedUserIds: players.map((p) => p.user_id),
        payoutTotalPercent: payoutConfig.bbjPayoutTotalPercent,
      });

      if (result) {
        // Credit chips directly to players' table stacks
        // LOSER (bad beat holder) gets 50% of total payout
        const loserSeat = players.find((p) => p.user_id === bbjHit.loserUserId);
        if (loserSeat) {
          loserSeat.stack += result.loserShare;
          console.log(
            `[ServerTableEngine:${this.tableId}] BBJ → Loser ${bbjHit.loserUserId} +$${result.loserShare}`
          );
        }

        // WINNER (hand winner) gets 25% of total payout
        const winnerSeat = players.find((p) => p.user_id === bbjHit.winnerUserId);
        if (winnerSeat) {
          winnerSeat.stack += result.winnerShare;
          console.log(
            `[ServerTableEngine:${this.tableId}] BBJ → Winner ${bbjHit.winnerUserId} +$${result.winnerShare}`
          );
        }

        // TABLE SHARE: remaining 25% split equally among dealt-in players (excluding loser/winner)
        const tableOnlyPlayers = (bbjHit.dealtInPlayerIds || []).filter(
          (id) => id !== bbjHit.loserUserId && id !== bbjHit.winnerUserId
        );
        for (const playerId of tableOnlyPlayers) {
          const seat = players.find((p) => p.user_id === playerId);
          if (seat) {
            seat.stack += result.perPlayerShare;
            console.log(
              `[ServerTableEngine:${this.tableId}] BBJ → Table player ${playerId} +$${result.perPlayerShare}`
            );
          }
        }

        // Re-sync stacks to database with BBJ payouts included
        await syncStacks(
          this.tableId,
          players.map((p) => ({
            user_id: p.user_id,
            stack: p.stack,
            time_bank_uses_remaining: p.time_bank_uses_remaining,
          }))
        );

        // Broadcast updated stacks + BBJ payout details so clients show the celebration
        this.hub?.emitEvent(this.tableId, {
          type: 'bbj_payout_complete',
          table_id: this.tableId,
          hand_number: this.handCount,
          totalPayout: result.totalPayout,
          loser: { userId: bbjHit.loserUserId, share: result.loserShare },
          winner: { userId: bbjHit.winnerUserId, share: result.winnerShare },
          tableShare: result.tableShare,
          perPlayerShare: result.perPlayerShare,
          tablePlayerIds: tableOnlyPlayers,
          // Include updated stacks for all players
          updatedStacks: players.map((p) => ({ userId: p.user_id, stack: p.stack })),
        });

        console.log(
          `[ServerTableEngine:${this.tableId}] BBJ payout complete: $${result.totalPayout} distributed to ${players.length} players`
        );
      }
    }

    // SETTLEMENT STEP 8d: Tournament chip sync
    if (this.isTournamentTable() && this.tableInfo?.tournament_id) {
      await syncTournamentChips(this.tableId, this.tableInfo.tournament_id);
    }

    // SETTLEMENT STEP 8e: Process pending add-ons (queued during the hand).
    // Must run AFTER pot distribution + BBJ payouts so we know each player's
    // final stack. Add-ons are capped so stack + add-on <= max buy-in.
    // Any excess is refunded to the player's club wallet.
    if (!this.isTournamentTable()) {
      await this.processPendingAddOns(players);
    }

    // 5. Auto-rebuy busted horses (cash games only)
    if (!this.isTournamentTable()) {
      const bustHorses = players.filter((p) => p.is_horse && p.stack === 0);
      for (const horse of bustHorses) {
        const currentRebuys = this.horseRebuys.get(horse.user_id) || 0;

        // Stop-Loss Bankroll logic: if they have rebought twice already (lost 3 buy-ins total), they leave
        if (currentRebuys >= 2) {
          await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
          // Round 57: clear FSM tracking so the horse doesn't leave a ghost
          // entry in disconnect_states.
          this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
          // Round 64: same for TimeBankEngine.
          this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
          // Round 66: same for StraddleEngine — symmetric cleanup.
          this.straddleEngine.removePlayer(this.tableId, horse.user_id);
          this.preActionEngine.removePlayer(this.tableId, horse.user_id);
          this.horseRebuys.delete(horse.user_id);
          console.log(
            `[ServerTableEngine:${this.tableId}] Stop-Loss: Horse ${horse.username} lost 3 buy-ins and has been removed.`
          );
          continue;
        }

        const rebuyAmount = this.tableInfo?.big_blind ? this.tableInfo.big_blind * 100 : 200;
        const success = await autoRebuyHorse(
          this.tableId,
          horse.user_id,
          rebuyAmount,
          this.tableInfo?.club_id || ''
        );
        if (success) {
          horse.stack = rebuyAmount;
          this.horseRebuys.set(horse.user_id, currentRebuys + 1);
          console.log(
            `[ServerTableEngine:${this.tableId}] Auto-rebuy: ${horse.username} -> ${rebuyAmount} chips (Rebuy #${currentRebuys + 1})`
          );
        } else {
          await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
          // Round 57: clear FSM tracking on insufficient-funds leave too.
          this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
          // Round 64: same for TimeBankEngine.
          this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
          // Round 66: same for StraddleEngine.
          this.straddleEngine.removePlayer(this.tableId, horse.user_id);
          this.preActionEngine.removePlayer(this.tableId, horse.user_id);
          this.horseRebuys.delete(horse.user_id);
          console.log(
            `[ServerTableEngine:${this.tableId}] Horse ${horse.username} left — insufficient funds`
          );
        }
      }
    }

    // 5.5 Auto-Cashout successful horses (Hit-and-Run Bankroll Management)
    // Always wait until right before they are the Big Blind to leave.
    if (!this.isTournamentTable() && players.length >= 2) {
      const maxBuyIn = this.tableInfo?.max_buy_in
        ? Number(this.tableInfo.max_buy_in)
        : (this.tableInfo?.big_blind || 2) * 200;

      // Calculate who will be the next Big Blind — AUDIT FIX 2026-07-19:
      // seat-based from the current button. Next hand's button is the next
      // occupied seat clockwise from lastButtonSeat; BB is one seat past SB
      // (HU: BB is the non-button, i.e. one seat past the button).
      const nextButtonSeat = this.getNextSeat(this.lastButtonSeat, players);
      const nextSbSeat =
        players.length === 2 ? nextButtonSeat : this.getNextSeat(nextButtonSeat, players);
      const nextBbSeat = this.getNextSeat(nextSbSeat, players);
      const nextBbPlayer = players.find((p) => p.seat_number === nextBbSeat);

      const cashedOutHorses = players.filter((p) => {
        if (!p.is_horse) return false;

        // Target is dynamically between 2.5x and 3.5x max buy-in
        // We use their user_id to deterministically seed their target, so they don't randomly flip-flop
        const idInt = parseInt(p.user_id.replace(/-/g, '').substring(0, 8), 16) || 0;
        const targetMultiplier = 2.5 + idInt / 0xffffffff;
        const cashOutTarget = maxBuyIn * targetMultiplier;

        // Only depart if they hit the target AND their NEXT hand is the Big Blind
        const isNextBb = p.user_id === nextBbPlayer?.user_id;

        return p.stack >= cashOutTarget && isNextBb;
      });

      for (const horse of cashedOutHorses) {
        await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
        // Round 57: clear FSM tracking on profit-target cashout too.
        this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
        // Round 64: same for TimeBankEngine.
        this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
        // Round 66: same for StraddleEngine.
        this.straddleEngine.removePlayer(this.tableId, horse.user_id);
        this.preActionEngine.removePlayer(this.tableId, horse.user_id);
        this.horseRebuys.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Bankroll Management: Horse ${horse.username} hit profit target (${Math.floor(horse.stack)} chips) and cashed out before posting the Big Blind.`
        );
      }
    }

    // 5.9 FIX 143: Bible V8 §7.12 — Apply deferred sit-outs now that the hand is over
    if (this.pendingSitOut.size > 0) {
      for (const userId of this.pendingSitOut) {
        this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
        console.log(`[ServerTableEngine:${this.tableId}] Deferred sit-out applied: ${userId}`);
      }
      this.pendingSitOut.clear();
    }

    // 6. Process leave-pending players (cash games only)
    if (!this.isTournamentTable()) {
      // Round 57: processLeavePending now returns the user_ids it cashed out;
      // we use that to unregister DisconnectEngine tracking so player states
      // don't leak. Without this every leaver leaves a ghost FSM entry that
      // persists in hand_state_snapshots.disconnect_states forever.
      // Round 64: extended to also call timeBankEngine.removePlayer so the
      // playerBanks Map sheds its entry too — same architectural fix.
      const cashedOutIds = await processLeavePending(this.tableId, this.tableInfo?.club_id || '');
      for (const userId of cashedOutIds) {
        this.disconnectEngine.unregisterPlayer(this.tableId, userId);
        this.timeBankEngine.removePlayer(this.tableId, userId);
        this.straddleEngine.removePlayer(this.tableId, userId);
        this.preActionEngine.removePlayer(this.tableId, userId);
      }
    }

    // SETTLEMENT STEP 15: Unlock table — authoritative recount, ready for next hand
    const { count: dbPlayerCount } = await supabase
      .from('table_seats')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', this.tableId)
      .is('left_at', null);
    const finalCount = dbPlayerCount ?? 0;
    await updateTableStatus(this.tableId, finalCount, finalCount >= 2 ? 'running' : 'waiting');

    // Phase X5 (2026-04-28): emit table_unlocked event paired with the
    // table_locked emitted at the start of settlement. Bible V8 §1.16.
    this.hub?.emitEvent(this.tableId, {
      type: 'table_unlocked',
      table_id: this.tableId,
      hand_number: this.handCount,
      seated_count: finalCount,
      next_state: finalCount >= 2 ? 'running' : 'waiting',
      timestamp: Date.now(),
    });

    // Settlement pipeline complete — table unlocked for next hand
  }
}
