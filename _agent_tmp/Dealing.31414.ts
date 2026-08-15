/**
 * ServerTableEngine, layer 5/8 — the dealing loop, blinds refresh, hand deal, hole-card delivery.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import { ShadowRecorder } from './eventlog/ShadowRecorder.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import { startHandSpan } from '../observability/Tracing.js';
import { getPlayerCountCaps } from '../config/RakeConfig.js';
import { loadTable, loadSeatedPlayers, supabase } from '../services/supabase.js';
import type { SeatPlayer, GameVariant, HandConfig, HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngineRunout } from './ServerTableEngineRunout.js';

export abstract class ServerTableEngineDealing extends ServerTableEngineRunout {
  // ═════════════════════════════════════════════════════════════════════════════
  // DEALING LOOP — Millisecond-level performance
  // ═════════════════════════════════════════════════════════════════════════════

  protected async dealingLoop(): Promise<void> {
    while (this.running) {
      try {
        // FIX 211: Await any pending postHandTasks before reloading players
        // This ensures DB stacks are synced before the next hand starts
        if (this.postHandTasksPromise) {
          await this.postHandTasksPromise;
          this.postHandTasksPromise = null;
        }

        // Reload players + refresh blinds before each hand
        const previousSeatedIds = new Set(this.seatedPlayers.map((p) => p.user_id));
        this.seatedPlayers = await loadSeatedPlayers(this.tableId);
        await this.refreshBlinds();

        // Phase X5 (2026-04-29) — Bible V8 §1.16 seat_taken event for any
        // player who appeared in seatedPlayers since the previous hand.
        // (seat_left is emitted from leaveTable() at the moment of leave;
        // here we only need to announce arrivals after the seat reload.)
        for (const p of this.seatedPlayers) {
          if (!previousSeatedIds.has(p.user_id)) {
            this.hub?.emitEvent(this.tableId, {
              type: 'seat_taken',
              table_id: this.tableId,
              seat: p.seat_number,
              user_id: p.user_id,
              username: p.username ?? null,
              starting_stack: p.stack ?? 0,
              timestamp: Date.now(),
            });
          }
        }
        // Phase X5 (2026-04-29) — online_count broadcast every hand-start so
        // dashboards / spectator view can show current seated count without
        // diffing snapshots.
        this.hub?.emitEvent(this.tableId, {
          type: 'online_count',
          table_id: this.tableId,
          seated_count: this.seatedPlayers.length,
          timestamp: Date.now(),
        });

        // Bible V8 §4.2: Detect new joiners. Any userId that appears in
        // seatedPlayers but wasn't known before is a new player. After the
        // first dealingLoop iteration, every such player is flagged as
        // waiting-for-BB so they can't play until the BB reaches their seat
        // (they can opt out via POST /post-bb). On the very first iteration
        // — cold start OR crash recovery — all seated players are treated as
        // the initial roster and no wait is required.
        if (this.dealingLoopFirstIteration) {
          for (const p of this.seatedPlayers) {
            this.knownPlayerIds.add(p.user_id);
          }
          this.dealingLoopFirstIteration = false;
        } else {
          for (const p of this.seatedPlayers) {
            if (!this.knownPlayerIds.has(p.user_id)) {
              if (!this.returningFromSitout.has(p.user_id)) {
                this.registerWaitForBB(p.user_id);
              }
              this.knownPlayerIds.add(p.user_id);
            }
          }
        }
        // Prune knownPlayerIds for truly-gone players (left_at set → filtered
        // out of loadSeatedPlayers). If they come back later they'll be treated
        // as a brand-new joiner again.
        const currentIds = new Set(this.seatedPlayers.map((p) => p.user_id));
        for (const id of this.knownPlayerIds) {
          if (!currentIds.has(id)) {
            this.knownPlayerIds.delete(id);
            this.waitingForBB.delete(id);
          }
        }

        // Bible V8 §6.3: Check for stale heartbeats before each hand
        this.disconnectEngine.checkStaleHeartbeats(this.tableId);

        // Bible V8 §6.17: Admin pause/maintenance lock — skip dealing
        if (this.adminPauseLock || this.maintenanceLock) {
          if (this.tableFSM.state === 'running') {
            this.tableFSM.transition('paused');
          }
          await this.sleep(3000);
          continue;
        }

        // Bible V8 §4.2: Wait-for-BB — new/returning players can't play until
        // the big blind reaches their position. Check each waiting player:
        // if this hand's BB position equals their seat, clear the wait flag.
        if (this.waitingForBB.size > 0 && this.tableInfo) {
          const bbSeatIndex = this.getBBSeatIndex();
          for (const userId of this.waitingForBB) {
            const p = this.seatedPlayers.find((s) => s.user_id === userId);
            if (p && p.seat_number === bbSeatIndex) {
              this.waitingForBB.delete(userId);
              // Player will now post BB naturally this hand
            }
          }
        }

        // FIX 143: Bible V8 §7.12 — Exclude sitting-out players from the deal.
        // Standard online poker: sitting-out players skip the hand entirely.
        // They miss their blind and owe a dead blind when they return (§4.2).
        // Bible V8 §4.2: Also exclude players waiting for BB.
        const activePlayers = this.seatedPlayers.filter(
          (p) =>
            p.stack > 0 &&
            !this.disconnectEngine.isSittingOut(this.tableId, p.user_id) &&
            !this.waitingForBB.has(p.user_id)
        );

        // Clean up rebuy map (Garbage Collection for horses no longer sitting here)
        const currentHorseIds = new Set(
          this.seatedPlayers.filter((p) => p.is_horse).map((p) => p.user_id)
        );
        for (const [horseId] of this.horseRebuys.entries()) {
          if (!currentHorseIds.has(horseId)) {
            this.horseRebuys.delete(horseId);
          }
        }

        if (activePlayers.length < 2) {
          // Bible V8 §3.1: Table FSM — running → waiting (not enough players)
          if (this.tableFSM.state === 'running') {
            this.tableFSM.transition('waiting');
          }
          await this.sleep(3000);
          continue;
        }

        // Bible V8 §3.1: Table FSM — waiting → seating → running (players returned)
        if (this.tableFSM.state === 'waiting') {
          this.tableFSM.transition('seating');
          this.tableFSM.transition('running');
        }

        // Deal hand (self-transition: running → running for next hand)
        await this.dealHand(activePlayers);
        this.consecutiveErrors = 0;

        // Hand-for-hand: if paused, wait until tournament manager resumes all tables
        // Bible V8 §3.1: Table FSM — running → paused
        if (this.handForHandPaused && this.running) {
          this.tableFSM.transition('paused');
          console.log(
            `[ServerTableEngine:${this.tableId}] Hand-for-hand: waiting for all tables to complete...`
          );
          await new Promise<void>((resolve) => {
            this.handForHandResolve = resolve;
            // Safety timeout: resume after 2 minutes if something goes wrong
            setTimeout(() => {
              if (this.handForHandResolve === resolve) {
                this.handForHandResolve = null;
                resolve();
              }
            }, 120000);
          });
        }

        // Bible V8 §4.23: Formal cleanup timing between hands.
        // Phase 1 (1.5s): Result display — winners, amounts, hand names visible to all players.
        // Phase 2 (0.5s): Board clear — community cards, pot chips swept away.
        // Total: 2 seconds of deterministic inter-hand pause. No randomness.
        if (this.running) {
          // Phase 1: Result display time (clients show winner popups during this window)
          await this.sleep(1500);
          // Phase 2: Board clear (clients animate card/chip sweep)
          this.broadcastCurrentState(); // Sends clean state (no hand in progress)
          await this.sleep(500);
        }
      } catch (err) {
        const errMsg =
          err instanceof Error
            ? err.message
            : (err as any)?.message ||
              (typeof err === 'object' ? JSON.stringify(err) : String(err));
        // BUG-SENTRY-7463185461 FIX: 'fetch failed' is the Node.js wording for
        // a transient Supabase network blip — same as browser's 'Failed to fetch'.
        // Both must be listed or they increment consecutiveErrors and fire Sentry.
        const isTransient =
          errMsg.includes('Project not specified') ||
          errMsg.includes('ECONNRESET') ||
          errMsg.includes('ETIMEDOUT') ||
          errMsg.includes('Failed to fetch') ||
          errMsg.includes('fetch failed') ||
          errMsg.includes('ENOTFOUND') ||
          errMsg.includes('socket hang up');

        if (!isTransient) {
          this.consecutiveErrors++;
        }

        const backoffMs = Math.min(3000 * Math.pow(2, this.consecutiveErrors - 1), 30000);

        if (!isTransient) {
          reportError(err, 'ServerTableEnginethistableId.Error_attempt_thisconsecutiveE');
        } else {
          console.warn(
            `[ServerTableEngine:${this.tableId}] Transient network error during deal cycle:`,
            errMsg
          );
        }

        if (this.consecutiveErrors >= 10) {
          reportError(
            new Error(`[ServerTableEngine:${this.tableId}] Too many errors — stopping`),
            'ServerTableEnginethistableId.Too_many_errors__stopping'
          );
          this.running = false;
        } else {
          await this.sleep(backoffMs);
        }
      }
    }
  }

  protected async refreshBlinds(): Promise<void> {
    if (!this.tableInfo || !this.isTournamentTable()) return;
    // BUG-SENTRY-7463185461 FIX: retry up to 3x on transient fetch failures.
    // A single Node.js 'TypeError: fetch failed' (Supabase network blip) was
    // bubbling through to dealingLoop, triggering the Sentry error reporter
    // and incrementing consecutiveErrors toward the 10-error shutdown threshold.
    // Retrying here absorbs one-off network hiccups before they reach the loop.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const data = await loadTable(this.tableId);
        if (data) {
          this.tableInfo.small_blind = data.small_blind;
          this.tableInfo.big_blind = data.big_blind;
          this.tableInfo.ante = data.ante;
        }
        return; // success
      } catch (err: any) {
        const msg = err?.message || String(err);
        const isTransient =
          msg.includes('fetch failed') ||
          msg.includes('Failed to fetch') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('ENOTFOUND') ||
          msg.includes('socket hang up');
        if (!isTransient || attempt === MAX_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // DEAL HAND — Complete hand lifecycle
  // ═════════════════════════════════════════════════════════════════════════════

  protected async dealHand(players: SeatedPlayer[]): Promise<void> {
    if (!this.tableInfo) return;

    this.handCount++;
    const handNumber = this.handCount;
    const handStartMs = Date.now(); // FIX 149: Capture hand start time for telemetry
    this.currentHandWentToFlop = false;
    this.currentHandPotSize = 0;
    this.currentHandWinnerIds = [];
    this.currentHandRake = 0;
    this.currentHandBBJFee = 0;
    this.currentHandCommunityCards = [];
    this.currentHandActions = [];
    this.currentHandWinners = [];
    this.currentHandContributions.clear(); // Bible V8 §4.18: Reset equal-share rakeback tracking (FIX 144)
    this.currentHandInsuranceSettlements = []; // Bible V8 §4.19: Reset insurance settlements
    this.currentHandShowdownResults = []; // BBJ: Reset showdown results for new hand
    this.currentHandTimerLog = []; // Bible V8 §2.15: Reset timer log
    this.currentHandNotificationLog = []; // Bible V8 §2.16: Reset notification log
    this.currentHandBBJHit = null; // BBJ: Reset hit detection for new hand
    this.currentHandBBJPayoutConfig = null;
    this.currentHandRabbitCards = []; // Rabbit Hunt: Reset remaining deck
    this.timeBankActivatedThisTurn = false; // Bible V8 §6.2: Reset time bank flag for new hand
    this.showHandPlayers = null; // Reset voluntary show-hand set for new hand

    console.log(
      `[ServerTableEngine:${this.tableId}] Hand #${handNumber} — ${players.length} players`
    );

    // Convert to SeatPlayer format
    const hcPlayers: SeatPlayer[] = players.map((p) => ({
      seat: p.seat_number,
      user_id: p.user_id,
      username: p.username,
      stack: p.stack,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      // Bible V8 §2.3: Carry through identity fields for broadcast
      is_horse: p.is_horse ?? false,
      avatar_url: p.avatar_url ?? '',
    }));

    // Rotate dealer — AUDIT FIX 2026-07-19: SEAT-based moving button. Advance to
    // the next occupied seat clockwise from the previous button seat. If that
    // seat's player busted/left, getNextSeat naturally lands on the next present
    // player (dead-button behavior) — the button never moves backward, skips a
    // seat, or lands twice.
    const sortedSeats = players.map((p) => p.seat_number).sort((a, b) => a - b);
    const prevButtonSeat = this.lastButtonSeat;
    const dealerSeat =
      prevButtonSeat > 0 ? this.getNextSeat(prevButtonSeat, players) : sortedSeats[0];
    this.currentHandDealerSeat = dealerSeat;
    this.lastButtonSeat = dealerSeat;
    // Keep the legacy index roughly in sync for any remaining reads (defensive).
    this.dealerSeatIndex = Math.max(0, sortedSeats.indexOf(dealerSeat)) + 1;

    // Bible V8 §6: Orbit complete (button wrapped past the top seat) → refill
    // time banks. With seat-based rotation, a wrap means the new button seat is
    // not strictly greater than the previous one.
    if (prevButtonSeat > 0 && dealerSeat <= prevButtonSeat) {
      this.timeBankEngine.onOrbitComplete(this.tableId);
    }

    // Bible V8 §4.4: Process straddles before hand starts
    let straddleResults: { seat: number; amount: number }[] = [];
    if (this.tableInfo.straddle_enabled) {
      // Build seat order starting from UTG (left of BB)
      const sbSeat = players.length === 2 ? dealerSeat : this.getNextSeat(dealerSeat, players);
      const bbSeat = this.getNextSeat(sbSeat, players);
      const utgSeat = this.getNextSeat(bbSeat, players);

      const seatOrder: Array<{ seat: number; playerId: string }> = [];
      let currentSeat = utgSeat;
      for (let i = 0; i < players.length - 2; i++) {
        // Exclude SB and BB
        const p = players.find((pl) => pl.seat_number === currentSeat);
        if (p) seatOrder.push({ seat: p.seat_number, playerId: p.user_id });
        currentSeat = this.getNextSeat(currentSeat, players);
      }

      const stackMap = new Map(players.map((p) => [p.user_id, p.stack]));
      // FIX 114: UTG straddle only — no Mississippi
      const straddleConfig = {
        enabled: true,
        maxStraddles: 1, // FIX 114: UTG only — always 1
        straddleMultiplier: 2,
        // A6/A7: mandatory UTG straddle when the host chose "Auto UTG Straddle"
        mandatoryUtg: (this.tableInfo as any).auto_utg_straddle === true,
      };
      this.straddleEngine.configure(this.tableId, straddleConfig);
      const result = this.straddleEngine.processStraddles(
        this.tableId,
        this.tableInfo.big_blind,
        seatOrder,
        stackMap
      );
      if (result.posted) {
        straddleResults = result.straddles.map((s) => ({ seat: s.seatNumber, amount: s.amount }));
      }
    }

    // Bible V8 §1.9 / Appendix A: Get full rake + BBJ config for this stakes/variant
    // Single lookup — used for both rakeConfig and bbjConfig
    const fullRakeConfig = this.getFullRakeAndBBJConfig();

    // FIX-218: Bible V8 §4.22 — Bomb pot detection based on table settings
    // Triggers every N hands when bomb_pot_enabled + bomb_pot_frequency are set
    let bombPotConfig: { anteMultiplier: number } | undefined;
    if (
      this.tableInfo.bomb_pot_enabled &&
      this.tableInfo.bomb_pot_frequency &&
      this.tableInfo.bomb_pot_frequency > 0 &&
      handNumber % this.tableInfo.bomb_pot_frequency === 0
    ) {
      bombPotConfig = {
        anteMultiplier: this.tableInfo.bomb_pot_ante_multiplier ?? 2,
      };
    }

    const config: HandConfig = {
      tableId: this.tableId,
      handNumber,
      gameVariant: this.tableInfo.game_variant as GameVariant,
      smallBlind: this.tableInfo.small_blind,
      bigBlind: this.tableInfo.big_blind,
      // FIX-219: Bible V8 §4.3 — Respect ante_enabled toggle; if disabled, zero out ante
      ante: (this.tableInfo.ante_enabled ?? true) ? this.tableInfo.ante : undefined,
      bigBlindAnte: this.tableInfo.big_blind_ante_enabled ?? false,
      bombPot: bombPotConfig,
      straddles: straddleResults.length > 0 ? straddleResults : undefined,
      // Bible V8 §4.2: Dead blinds for players returning from sit-out
      deadBlinds:
        this.returningFromSitout.size > 0
          ? players
              .filter((p) => this.returningFromSitout.has(p.user_id))
              .map((p) => ({ seat: p.seat_number }))
          : undefined,
      // AUDIT FIX 2026-07-19: "Post BB to enter" players post a live BB only.
      bbOnlyPosts:
        this.postingBBToEnter.size > 0
          ? players
              .filter((p) => this.postingBBToEnter.has(p.user_id))
              .map((p) => ({ seat: p.seat_number }))
          : undefined,
      // RAKE-AUDIT 2026-07-24: tournament pots are NEVER raked and never pay a
      // BBJ fee — the house take for tournaments/SNGs is the 10% entry fee at
      // buy-in. Pre-fix the cash schedule (10% + cap) was deducted from every
      // tournament pot and credited NOWHERE (postHandTasks skips all tournament
      // rake logging), silently destroying tournament chips on every raked hand
      // (verified live: 62,422 tournament chips deducted across 4,735 tournament
      // hands in the 7 days before this fix).
      rakeConfig: this.isTournamentTable()
        ? { percent: 0, cap: 0, noFlopNoDrop: true }
        : {
            percent: fullRakeConfig.rakePercent,
            cap: fullRakeConfig.rakeCap,
            noFlopNoDrop: true,
            // FIX 166: Bible V8 §7.19 — player-count-based rake caps (heads-up = 50%, 3-handed = 67%)
            playerCountCaps: getPlayerCountCaps(fullRakeConfig.rakeCap),
          },
      bbjConfig: {
        // FIX-A2 2026-07-19 gated the BBJ fee-drop on bbj_percent > 0.
        // RAKE-AUDIT 2026-07-24: that gate killed BBJ platform-wide — every live
        // table had bbj_percent at its 0.00 column default AND loadTable never
        // selected the column, so `?? 0` disabled the fee on all 878 active
        // tables (verified live: zero BBJ collected after 2026-07-19 16:29 UTC).
        // BBJ is now ON by default for eligible cash games per Dan's rake
        // schedule; an EXPLICIT bbj_percent = 0 on the table row still disables
        // it per-table (loadTable now selects bbj_percent; DB backfilled to 100).
        // Tournaments never collect the BBJ fee.
        enabled:
          !this.isTournamentTable() &&
          fullRakeConfig.bbjEnabled &&
          ((this.tableInfo as any)?.bbj_percent ?? 100) > 0,
        feeBB: fullRakeConfig.bbjFeeBB,
        minPotBB: fullRakeConfig.rules.minPotBB,
        minPlayersDealt: fullRakeConfig.rules.minPlayersDealt,
      },
    };

    this.handController = new HandController(config, hcPlayers, dealerSeat);

    // ── ADDITIVE observability (#5): hands-dealt counter (always) + hand span (flag-gated) ──
    try {
      EngineMetrics.handsTotal.inc(1, {
        table_id: this.tableId,
        variant: String(this.tableInfo?.game_variant ?? ''),
      });
    } catch {
      /* metrics must never affect gameplay */
    }
    if (this.engineMetricsEnabled) {
      try {
        this.handSpan = startHandSpan(EngineMetrics.engineTracer, {
          tableId: this.tableId,
          handNumber,
          variant: String(this.tableInfo?.game_variant ?? ''),
        });
      } catch {
        this.handSpan = null;
      }
    }

    // ── ADDITIVE event-sourcing shadow (#1): construct recorder + record HandStarted (observe-only) ──
    this.shadowHoleCardsRecorded = false;
    if (this.eventShadowEnabled) {
      try {
        this.shadowRecorder = new ShadowRecorder(`${this.tableId}#${handNumber}`, {
          onDivergence: (report) => {
            if (report.ok) return;
            reportError(
              new Error(
                `[EVENT_SHADOW ${this.tableId}] hand #${handNumber} divergence: ` +
                  `${report.seatDivergences.length} seat(s); conservation ` +
                  `${report.conservation.ok ? 'ok' : report.conservation.violations.length + ' violation(s)'}`
              ),
              'ServerTableEngine.EVENT_SHADOW_DIVERGENCE'
            );
            try {
              EngineMetrics.metricsRegistry
                .counter('poker_event_shadow_divergences_total', 'Event-shadow replay divergences')
                .inc(1, { table_id: this.tableId });
            } catch {
              /* ignore */
            }
          },
        });
        this.shadowRecorder.recordHandStarted({
          seed: handNumber,
          handNumber,
          buttonSeat: dealerSeat,
          players: hcPlayers.map((p) => ({ seat: p.seat, userId: p.user_id, stack: p.stack })),
          stakes: {
            smallBlind: config.smallBlind,
            bigBlind: config.bigBlind,
            ante: config.ante,
          },
        });
      } catch {
        this.shadowRecorder = null;
      }
    }

    // Bible V8 §4.2: Clear returning-from-sitout after dead blinds are passed to config
    if (this.returningFromSitout.size > 0) {
      this.returningFromSitout.clear();
    }
    if (this.postingBBToEnter.size > 0) {
      this.postingBBToEnter.clear();
    }

    // Step 4: Record initial chip totals for state verification
    this.stateVerifier.recordInitialChipTotal(this.tableId, hcPlayers);

    // Step 5: Initialize atomic stacks, time banks, and disconnect tracking for each player
    // Bible V8 §6.2: Reset per-hand time bank activation counters
    this.timeBankEngine.resetHandActivations(this.tableId);
    for (const p of hcPlayers) {
      this.atomicStackService.initializeStack(this.tableId, p.user_id, p.stack);
      // Only initialize time bank if player is NEW (don't reset existing pool per session)
      if (!this.timeBankEngine.getPlayerBank(this.tableId, p.user_id)) {
        this.timeBankEngine.initializePlayer(this.tableId, p.user_id);
      }
      this.disconnectEngine.registerPlayer(this.tableId, p.user_id);
    }

    // Step 5: Wire disconnect auto-action callback into HandController
    this.disconnectEngine.onAutoAction(this.tableId, (disconnectAction) => {
      if (!this.handController) return;
      const state = this.handController.getState();
      const dcPlayer = state.players.find((p) => p.user_id === disconnectAction.playerId);
      if (!dcPlayer) return;
      try {
        this.handController.performAction(dcPlayer.seat, disconnectAction.action as any);
        console.log(
          `[ServerTableEngine:${this.tableId}] Disconnect auto-${disconnectAction.action} for ${disconnectAction.playerId} (${disconnectAction.reason})`
        );
      } catch (err) {
        reportError(err, 'ServerTableEnginethistableId.Disconnect_autoaction_failed');
      }
    });

    // Wait for hand to complete
    return new Promise<void>((resolve) => {
      // FIX 178: Bible V8 §6.1 — Hand safety timeout must accommodate full multi-player hands.
      // A 9-player hand with 15s action timers × 4 betting rounds = 540s worst case.
      // With time banks + insurance/RIT pauses, 10 minutes is a safe ceiling.
      // The old 60s timeout was killing hands prematurely mid-action.
      const HAND_SAFETY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
      // Declared with `let` so the timeout callback can call it (see AUDIT FIX).
      let unsub: () => void = () => {};
      const handTimeout = setTimeout(() => {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Hand ${handNumber} timed out after 10 minutes`
        );
        // AUDIT FIX 2026-07-19: previously the timeout nulled the controller but
        // left the HAND_COMPLETE listener attached and action timers running. A
        // late completion (e.g. a pending horse think-timer) could then fire the
        // HAND_COMPLETE branch and null the NEXT live hand's controller. Detach
        // the listener and cancel this table's action timers on timeout.
        unsub();
        this.preciseTimer.clearTable(this.tableId);
        this.actionValidator.clearTable(this.tableId);
        this.handController = null;
        resolve();
      }, HAND_SAFETY_TIMEOUT_MS);

      unsub = this.handController!.onEvent((event: HandEvent) => {
        this.handleHandEvent(event, players);

        if (event.type === 'HAND_COMPLETE') {
          clearTimeout(handTimeout);
          unsub();

          // FIX 149: Wire telemetry — record hand timing
          const handElapsedMs = Date.now() - handStartMs;
          this.engineTelemetry.recordHandTiming(this.tableId, 0, 0, handElapsedMs);

          // Fire hand-complete callback for tournament chip sync
          this.clearTurnTimer();
          if (this.handCompleteCallback) {
            const finalStacks = players.map((p) => ({
              user_id: p.user_id,
              stack: p.stack,
            }));
            try {
              this.handCompleteCallback(this.tableId, finalStacks);
            } catch (e) {
              reportError(e, 'ServerTableEnginethistableId.handCompleteCallback_error');
            }
          }

          this.handController = null;
          resolve();
        }
      });

      // Start the hand!
      try {
        this.handController!.start();

        // FIX 137: Bible V8 §7.17 — Snapshot initial hand state for crash recovery.
        // C15: deliberately NOT coalesced. The hand-start snapshot is the anchor
        // every later delta is read against, so it is worth one guaranteed write.
        this.snapshotDirty = true;
        void this.flushSnapshot();
      } catch (err) {
        reportError(err, 'ServerTableEnginethistableId.Failed_to_start_hand');
        clearTimeout(handTimeout);
        unsub();
        this.handController = null;
        resolve();
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // EVENT HANDLING
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * FIX 2 (2026-07-24): reliably persist a player's hole cards to the
   * RLS-protected `table_hole_cards` table (the secure per-player delivery
   * channel). The old path was fire-and-forget with only a console.warn, so a
   * transient RPC failure left the player with no cards while the
   * server-authoritative turn timer ticked toward an auto-fold. This awaits the
   * insert and retries up to 3× with backoff; on final failure it emits a
   * `hole_cards_unavailable` event so the client can force a re-fetch.
   */
  protected async persistHoleCardsWithRetry(
    userId: string,
    seat: number,
    cards: unknown
  ): Promise<void> {
    const payload = JSON.stringify([{ user_id: userId, seat_number: seat, cards }]);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { error } = await supabase.rpc('insert_hole_cards', {
          p_table_id: this.tableId,
          p_hand_number: this.handCount,
          p_cards: payload,
        });
        if (!error) return;
        console.warn(
          `[ServerTableEngine:${this.tableId}] insert_hole_cards attempt ${attempt}/3 failed for seat ${seat}:`,
          error.message
        );
      } catch (err) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] insert_hole_cards attempt ${attempt}/3 threw for seat ${seat}:`,
          err
        );
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    // All retries exhausted — tell the client its cards are missing so it can
    // re-query table_hole_cards instead of sitting blind until the auto-fold.
    reportError(
      new Error('insert_hole_cards failed after 3 attempts'),
      `ServerTableEngine.${this.tableId}.insert_hole_cards_failed`,
      { userId, seat, handNumber: this.handCount }
    );
    this.hub?.emitEvent(this.tableId, {
      type: 'hole_cards_unavailable',
      table_id: this.tableId,
      hand_number: this.handCount,
      user_id: userId,
      seat,
      timestamp: Date.now(),
    });
  }

  /**
   * FIX 2 (2026-07-24): re-deliver a player's hole cards for the current hand
   * on reconnect / RESYNC. Re-inserting (ON CONFLICT DO UPDATE) fires the
   * client's table_hole_cards Realtime subscription so it re-fetches the hero's
   * cards. No-op when there is no live hand or no cached cards for the player.
   */
  public async rePushHoleCards(userId: string): Promise<void> {
    if (!this.handController) return;
    const entry = this.currentHandHoleCards.get(userId);
    if (!entry) return;
    await this.persistHoleCardsWithRetry(userId, entry.seat, entry.cards);
  }
}
