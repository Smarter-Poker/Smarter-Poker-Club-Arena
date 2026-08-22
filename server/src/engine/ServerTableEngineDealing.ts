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
import {
  loadTable,
  loadSeatedPlayers,
  supabase,
  autoRebuyHorse,
  markSeatAsLeft,
  atomicCashout,
} from '../services/supabase.js';
import type { SeatPlayer, GameVariant, HandConfig, HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngineRunout } from './ServerTableEngineRunout.js';
import { handCompletionHoldMs, boardClearMs } from '../config/handCompletionSpec.js';

export abstract class ServerTableEngineDealing extends ServerTableEngineRunout {
  // ═══════════════════════════════════════════════════════════════════════════════
  // DEALING LOOP — Millisecond-level performance
  // ═══════════════════════════════════════════════════════════════════════════════

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
        // 2026-08-18: cash tables re-read their rake settings here (throttled
        // to once a minute inside the method). tableInfo is otherwise loaded
        // once per engine lifetime, so before this an owner changing the rake
        // saw nothing until the table restarted.
        await this.refreshRakeConfig();

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

        // ── Dan 2026-08-21, BINDING: sit-out eviction ──
        // "IF A PLAYER IS SITTING OUT THEY MUST BE REMOVED AFTER THE BUTTON
        //  PASSES THEM TWICE, OR AFTER 5 MINUTES, WHICHEVER HAPPENS FIRST."
        // Cash tables only (a tournament sit-out is blinded off, never
        // removed). The counter and clock live per (table, player), so this
        // never reaches across a player's other seats — "A PLAYER CAN SIT OUT
        // ON ONE TABLE BUT STILL PLAY TABLES ON SCREEN 2, 3 AND 4".
        if (!this.isTournamentTable()) {
          const evictable = this.disconnectEngine.tickSitOutsAndCollectEvictions(
            this.tableId,
            this.seatedPlayers.map((p) => p.user_id)
          );
          for (const userId of evictable) {
            const seated = this.seatedPlayers.find((p) => p.user_id === userId);
            if (!seated) continue;
            console.log(
              `[ServerTableEngine:${this.tableId}] evicting ${userId} — sat out past the 2-orbit / 5-minute limit`
            );
            this.hub?.emitEvent(this.tableId, {
              type: 'seat_left',
              table_id: this.tableId,
              seat: seated.seat_number,
              user_id: userId,
              mid_hand: false,
              reason: 'sit_out_timeout',
              timestamp: Date.now(),
            });
            atomicCashout(userId, this.tableId, seated.seat_number)
              .then(() => {
                this.disconnectEngine.unregisterPlayer(this.tableId, userId);
                this.timeBankEngine.removePlayer(this.tableId, userId);
                this.straddleEngine.removePlayer(this.tableId, userId);
                this.preActionEngine.removePlayer(this.tableId, userId);
              })
              .catch((err) => {
                reportError(err, 'ServerTableEngine.' + this.tableId + '.sitout_evict_cashout');
                markSeatAsLeft(this.tableId, userId, seated.seat_number);
              });
          }
          if (evictable.length > 0) {
            this.seatedPlayers = this.seatedPlayers.filter((p) => !evictable.includes(p.user_id));
          }
        }

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

        // Dan 2026-08-20 (live repro): "Seat Reserved, You'll Be Dealt In Next
        // Hand" must be TRUE. A probe seat sat through 6 straight hands still
        // gated by wait-for-BB — on slow tables the natural BB rotation takes
        // MINUTES to reach a new seat, and nothing on screen explains the
        // wait. Every remaining waiter is auto-entered as "post BB to enter":
        // they pay one live BB (the same fair price PokerBros charges for
        // immediate entry, via the existing bbOnlyPosts path) and are dealt
        // into THIS hand. POST /post-bb stays for players who beat the loop
        // to it; the natural-BB release above still wins when the blind is
        // reaching their seat anyway, in which case they just post normally.
        if (this.waitingForBB.size > 0) {
          // Dan 2026-08-21, BINDING: "CASH GAME PLAYERS CAN NEVER BE DEALT
          // INTO THE SMALL BLIND. THEY MUST WAIT FOR THE BUTTON TO PASS."
          const sbSeatIndex = this.isTournamentTable() ? -1 : this.getSBSeatIndex();
          for (const userId of Array.from(this.waitingForBB)) {
            const seatedWaiter = this.seatedPlayers.find((s2) => s2.user_id === userId);
            if (seatedWaiter && sbSeatIndex > 0 && seatedWaiter.seat_number === sbSeatIndex) {
              console.log(
                `[ServerTableEngine:${this.tableId}] holding ${userId} out one hand — would have been dealt into the SB`
              );
              continue;
            }
            this.waitingForBB.delete(userId);
            this.postingBBToEnter.add(userId);
            console.log(
              `[ServerTableEngine:${this.tableId}] auto post-BB entry for ${userId} — dealt in next hand as promised`
            );
          }
        }

        // Dan 2026-08-19, bug list item 17: "when hero busts and adds chips
        // they're never dealt in - stuck on 'Seat Reserved, You'll Be Dealt In
        // Next Hand'."
        //
        // An add-on requested WHILE A HAND IS RUNNING is debited immediately
        // but only queued onto `table_pending_addons`; it is applied to the
        // seat by `processPendingAddOns`, which ran in exactly one place -
        // settlement step 8e, at the END of a hand. That is a deadlock for the
        // player who needs it most. Bust, and you are filtered out of the deal
        // by `stack > 0`. If the table then drops below two funded seats, the
        // loop parks in the idle branch below: no hand starts, so no
        // settlement runs, so the queued chips are never applied, so the
        // player never gets a stack - and the seat sits on "Seat Reserved,
        // you'll be dealt in next hand" forever. Their money is already
        // debited and sitting in the ledger the whole time.
        //
        // The same hole opens when a hand hits HAND_SAFETY_TIMEOUT: that path
        // nulls the controller and resolves WITHOUT running settlement, so any
        // add-on queued during that hand is left unresolved too.
        //
        // Sweeping every idle tick closes both. It is a cheap no-op unless a
        // sweep is actually outstanding (the method returns immediately when
        // nothing is pending), the RPC is idempotent per ledger row, and it
        // runs BEFORE the active-player filter below so a player whose chips
        // land this tick is dealt into THIS hand rather than the next one.
        // This is the human counterpart of recoverBustedSeatedHorses().
        if (!this.isTournamentTable()) {
          await this.processPendingAddOns(this.seatedPlayers);
        }

        // FIX 143: Bible V8 §7.12 — Exclude sitting-out players from the deal.
        // Standard online poker: sitting-out players skip the hand entirely.
        // They miss their blind and owe a dead blind when they return (§4.2).
        // Bible V8 §4.2: Also exclude players waiting for BB.
        //
        // TOURNAMENT EXCEPTION (2026-08-21): a sat-out TOURNAMENT player is
        // still DEALT IN — they post blinds and are auto-folded when action
        // reaches them (onPlayerTurn handles that instantly). Excluding them
        // from the deal would freeze their stack: no blind-off, no
        // elimination, a tournament that can never end. This is how every
        // real poker site handles tournament sit-outs.
        const dealInWhileSittingOut = this.isTournamentTable();
        const activePlayers = this.seatedPlayers.filter(
          (p) =>
            p.stack > 0 &&
            (dealInWhileSittingOut ||
              !this.disconnectEngine.isSittingOut(this.tableId, p.user_id)) &&
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

        // DEAD-TABLE / ZOMBIE-SEAT RECOVERY (2026-08-15, live E2E finding):
        // after a mid-hand engine restart the table hydrates from table_seats
        // with horses whose stacks were already committed to the aborted
        // hand's pot (stack 0, left_at NULL). Settlement's auto-rebuy step
        // only scans the players OF A COMPLETED HAND, so hydrated 0-stack
        // horses are invisible to it forever: with fewer than 2 funded seats
        // the table slept in the branch below with every seat showing 0
        // chips (dead table), and with 2+ funded seats the zombies sat out
        // eternally while others played around them (live DB showed tables
        // running 2-handed with five 0-stack horses seated). Run the same
        // rebuy-or-remove routine every idle tick — it is a no-op when no
        // seated horse is busted, and per-horse attempts are throttled.
        if (!this.isTournamentTable()) {
          await this.recoverBustedSeatedHorses();
        }

        if (activePlayers.length < 2) {
          // Bible V8 §3.1: Table FSM — running → waiting (not enough players)
          if (this.tableFSM.state === 'running') {
            this.tableFSM.transition('waiting');
          }
          await this.sleep(3000);
          continue;
        }

        // SPIN REVEAL HOLD (2026-08-21): the table may not deal while the
        // shared wheel is still running. Re-checked in short slices so a
        // resume is responsive and the loop stays interruptible.
        if (this.dealHoldUntilMs > Date.now()) {
          await this.sleep(Math.min(this.dealHoldUntilMs - Date.now(), 1000));
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
            /**
             * Safety timeout so a table can never wedge forever.
             *
             * Dan 2026-08-19: this was hard-coded to 120 seconds. A
             * synchronized break is five minutes measured from AFTER the last
             * hand completes, so every table silently self-resumed two minutes
             * in and dealt through the rest of the break. The budget now comes
             * from whoever requested the pause (pauseAfterHand), defaulting to
             * the original two minutes for hand-for-hand.
             */
            const maxWaitMs = this.pauseMaxWaitMs ?? 120000;
            setTimeout(() => {
              if (this.handForHandResolve === resolve) {
                console.warn(
                  `[ServerTableEngine:${this.tableId}] Pause safety timeout after ${Math.round(maxWaitMs / 1000)}s — resuming to avoid a wedged table`
                );
                this.handForHandResolve = null;
                resolve();
              }
            }, maxWaitMs);
          });
        }

        // Bible V8 §4.23: Formal cleanup timing between hands.
        //
        // ── Dan 2026-08-18: "stop rushing the showdowns" ──
        //
        // This was a flat 1.5s of result display for every hand. That is fine
        // for "everyone folded, one player wins", where there is nothing to
        // read - but nowhere near enough for a showdown, where a player is
        // trying to take in several opponents' hole cards, the winning hand
        // name and the pot shipping inside the same window. It got worse the
        // same day: showdowns now turn EVERY hand face up instead of only the
        // winner's, so there is strictly more to look at than when 1.5s was
        // chosen.
        //
        // The pause is now split by what actually happened. A showdown gets
        // time proportional to how many hands there are to read; a fold-win
        // keeps the original brisk pace, because stretching that one out only
        // slows the game for no benefit. Still fully deterministic - no
        // randomness - so hands-per-hour stays predictable.
        if (this.running) {
          // currentHandShowdownResults is populated on the SHOWDOWN event with
          // one entry per player who reached it. 2+ means a real showdown with
          // cards face up; 0 or 1 means the pot was never contested to the end.
          const showdownHands = this.currentHandShowdownResults.length;
          const wentToShowdown = showdownHands >= 2;

          // ── Dan 2026-08-20: "if a user wins a hand by raising and taking it,
          //    the pot animation must be shipped to the player who won — many
          //    steps and animations are being skipped." ──
          //
          // 1500ms could not physically contain the uncontested-win sequence.
          // The client plays it as two ORDERED beats now (bets sweep into the
          // pot, 700ms; then the pot travels to the winner, 700ms) plus a beat
          // to actually read who won. That is ~1400ms of motion before anything
          // can be read, so the old window cut the pot push off mid-flight and
          // the next hand was already dealing. Every fold win looked like the
          // pot teleported.
          //
          // 2600ms is the same base a heads-up showdown already gets: sweep
          // (700) + ship (700) + ~1200ms to register the winner. Hands/hour
          // drops slightly and that is the intended trade — Dan's rule is that
          // no beat is ever skipped.
          // ── Dan's hand-completion law (2026-08-21) ──────────────────────
          //
          // "A HAND IS NOT COMPLETED, UNTIL THE WINNING HAND IS SHOWN AT SHOW
          //  DOWN AND IDENTIFIED, THE PUSH POT ANIMATION, WITH THE POT TOTAL
          //  HAS RAN. AND ACTUALLY PUSHED THE POT TO THE WINNER, THAT THE
          //  CARDS ARE MUCKED."
          //
          // The hold is no longer three hand-written numbers that drift from
          // whatever the client actually animates. It is DERIVED from the
          // animation spec both sides share (src/config/handCompletionSpec.ts,
          // mirrored under server/src/config/), so the table always waits for
          // the real sequence: showdown read -> bets sweep -> pot push
          // carrying its total -> muck.
          //
          // This fixed a live truncation: the pot-win float runs 2200ms and
          // only starts after the 700ms sweep, so 2900ms of animation was
          // being cut off by a 2600ms hold and the next hand was dealt over
          // the number telling the player what they had just won.
          const resultDisplayMs = handCompletionHoldMs({
            wentToShowdown,
            showdownHands,
            bbjHit: !!this.currentHandBBJHit?.hit,
          });

          // Phase 1: the completion sequence actually plays out.
          await this.sleep(resultDisplayMs);
          // Phase 2: board clear (clients animate the card/chip sweep).
          this.broadcastCurrentState(); // Sends clean state (no hand in progress)
          await this.sleep(boardClearMs(wentToShowdown));
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
          errMsg.includes('socket hang up') ||
          // 2026-08-15: emitted by the new DB_TIMEOUT_MS abort in
          // services/supabase/client.ts. A hung socket is by definition
          // transient — it must back off and retry, not count toward the
          // 10-error engine shutdown.
          errMsg.includes('supabase_timeout') ||
          errMsg.includes('This operation was aborted') ||
          errMsg.includes('The operation was aborted');

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

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEAL HAND — Complete hand lifecycle
  // ═══════════════════════════════════════════════════════════════════════════════

  protected async dealHand(players: SeatedPlayer[]): Promise<void> {
    if (!this.tableInfo) return;

    // GLOBAL HAND NUMBER (2026-08-18). Allocated from the database sequence at
    // the moment the hand is dealt, so numbers ascend in true deal order across
    // every table, club, union, cash game and tournament, and can never repeat.
    // Was `this.handCount++` — a per-table counter that reset on every engine
    // restart and produced the same "Hand #196" on dozens of tables at once.
    this.handCount = await this.allocateGlobalHandNumber();
    this.handsDealtThisSession++;
    const handNumber = this.handCount;
    const handStartMs = Date.now(); // FIX 149: Capture hand start time for telemetry
    this.currentHandWentToFlop = false;
    this.currentHandPotSize = 0;
    this.currentHandWinnerIds = [];
    this.currentHandRake = 0;
    this.currentHandBBJFee = 0;
    this.currentHandCommunityCards = [];
    this.currentHandCommunityCards2 = [];
    this.currentHandWinnersByBoard = [];
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
    this.currentHandRitBoards = 0; // RIT VERIFIER FIX 2026-08-21: new hand, no boards
    this.timeBankActivatedThisTurn = false; // Bible V8 §6.2: Reset time bank flag for new hand
    this.showHandPlayers = null; // Reset voluntary show-hand set for new hand
    // Dan 2026-08-18: per-card reveal picks are per-hand intent too. If this
    // were not cleared, a card clicked on hand 12 would keep being exposed
    // on every later hand that happened to deal the same index.
    this.showHandCards = null;

    console.log(
      `[ServerTableEngine:${this.tableId}] Hand #${handNumber} — ${players.length} players`
    );

    // Convert to SeatPlayer format
    // ── DECK CAPACITY GUARD (2026-08-15) ─────────────────────────────────
    // Deck.deal throws 'Not enough cards in deck' when hole cards exhaust the
    // deck. HAND_START is emitted BEFORE dealHoleCards, and HAND_START marks
    // watchdog progress — so a table that cannot physically be dealt looped
    // "deal -> throw -> sleep 2s -> deal" forever with a perfectly green
    // watchdog. Refuse the deal instead, loudly and slowly.
    const CARDS_PER_PLAYER: Record<string, number> = {
      plo4: 4,
      plo5: 5,
      plo6: 6,
      plo8: 4,
      pineapple: 3,
    };
    const variantKey = (this.tableInfo?.game_variant || 'nlh').toLowerCase();
    const cardsPerPlayer = CARDS_PER_PLAYER[variantKey] ?? 2;
    const deckSize = variantKey.includes('short') ? 36 : 52;
    const maxSeatable = Math.floor((deckSize - 5) / cardsPerPlayer);
    if (players.length > maxSeatable) {
      reportError(
        new Error(
          `Deck cannot serve ${players.length} seats of ${variantKey} ` +
            `(${cardsPerPlayer}/player, ${deckSize}-card deck, max ${maxSeatable})`
        ),
        'ServerTableEngine.' + this.tableId + '.deck_capacity_exceeded'
      );
      this.handCount--; // this hand never happened
      await this.sleep(30000); // do NOT hot-loop
      return;
    }

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
      // 2026-08-21 (round 2 — Dan: "they just get blinded out, it should
      // never affect the actual tournament functionality"): this MUST stay
      // hardcoded false. HandController's is_sitting_out filters mean "deal
      // AROUND this seat" — no cards, NO BLINDS — which is the opposite of
      // blind-off. Every player in hcPlayers is a full hand participant:
      // cash sit-outs were excluded from the roster above; tournament
      // sit-outs are dealt in, post blinds, and are insta-folded by
      // DisconnectEngine.onPlayerTurn when action reaches them. The
      // sitting-out UI state lives on table_seats.is_sitting_out, persisted
      // by the PLAYER_SAT_OUT/PLAYER_SAT_BACK handler in
      // ServerTableEngineBase and streamed to clients via realtime.
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
    // A DRAWN first button (Spins) wins over the default, once, and only if
    // that seat is still occupied. Everything after hand one rotates normally.
    const drawnButton = this.forcedFirstButtonSeat;
    this.forcedFirstButtonSeat = null;
    const drawnIsSeated = drawnButton !== null && sortedSeats.includes(drawnButton);
    const dealerSeat = drawnIsSeated
      ? (drawnButton as number)
      : prevButtonSeat > 0
        ? this.getNextSeat(prevButtonSeat, players)
        : sortedSeats[0];
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

    // FIX-218: Bible V8 §4.22 — Bomb pot detection based on table settings.
    // ROUND 3 AUDIT FIX (2026-08-20): the modulo ran on handNumber, which is
    // the GLOBAL allocator (see handsSinceBombPot in Base) — cadence was a
    // coin flip, not a schedule. Dedicated per-table counter now.
    let bombPotConfig: { anteMultiplier: number; doubleBoard?: boolean } | undefined;
    if (
      this.tableInfo.bomb_pot_enabled &&
      this.tableInfo.bomb_pot_frequency &&
      this.tableInfo.bomb_pot_frequency > 0
    ) {
      this.handsSinceBombPot++;
    }
    if (
      this.tableInfo.bomb_pot_enabled &&
      this.tableInfo.bomb_pot_frequency &&
      this.tableInfo.bomb_pot_frequency > 0 &&
      this.handsSinceBombPot >= this.tableInfo.bomb_pot_frequency
    ) {
      this.handsSinceBombPot = 0;
      bombPotConfig = {
        anteMultiplier: this.tableInfo.bomb_pot_ante_multiplier ?? 2,
        // DOUBLE-BOARD BOMB POT 2026-08-20: table opt-in for the two-board
        // variant. HandController still downgrades if the deck can't cover it.
        doubleBoard: this.tableInfo.bomb_pot_double_board ?? false,
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
    // Bible V8 §6.2: clear the per-street time bank allowance for the new hand.
    // The same reset runs again on every flop/turn/river (see the
    // COMMUNITY_CARDS handler) because the limit is 2 per STREET, not per hand.
    this.timeBankEngine.resetStreetActivations(this.tableId);
    // VIP time banks 2026-08-17: new players get the free session base PLUS
    // their DB-backed extras (VIP monthly remaining + purchased extensions),
    // batch-fetched in one RPC. Before this, EVERY player got the table
    // default (120 uses = 1800s) in memory, VIP or not - the perk was
    // meaningless and the monthly quota never depleted.
    const tbNewPlayers = hcPlayers.filter(
      (p) => !this.timeBankEngine.getPlayerBank(this.tableId, p.user_id)
    );
    const tbExtras = await this.fetchTimeBankExtras(tbNewPlayers.map((p) => p.user_id));
    for (const p of hcPlayers) {
      this.atomicStackService.initializeStack(this.tableId, p.user_id, p.stack);
      // Only initialize time bank if player is NEW (don't reset existing pool per session)
      if (!this.timeBankEngine.getPlayerBank(this.tableId, p.user_id)) {
        const tbTotal = this.timeBankBaseSeconds + (tbExtras.get(p.user_id) ?? 0);
        this.timeBankEngine.initializePlayer(this.tableId, p.user_id, {
          remainingSeconds: tbTotal,
          usesRemaining: Math.ceil(tbTotal / 20),
        });
        this.timeBankMeta.set(p.user_id, {
          initialSeconds: tbTotal,
          baseSeconds: this.timeBankBaseSeconds,
          dbConsumedSeconds: 0,
        });
      }
      this.disconnectEngine.registerPlayer(this.tableId, p.user_id);
    }

    // Step 5: Wire disconnect auto-action callback into HandController
    this.disconnectEngine.onAutoAction(this.tableId, (disconnectAction) => {
      if (!this.handController) return;
      const state = this.handController.getState();
      const dcPlayer = state.players.find((p) => p.user_id === disconnectAction.playerId);
      if (!dcPlayer) return;
      // Stale deadline: the turn has already moved on. Acting here would be a
      // phantom action attributed to a player who is not in the decision.
      if (state.currentPlayerSeat !== dcPlayer.seat) return;

      // This callback is the ONLY resolution path for a disconnected or
      // sitting-out player's turn — handleTurnChange returns early for them
      // WITHOUT arming a clock. performAction returns false on an illegal
      // action (the countdown captures `canCheck` up to 30s earlier, so it goes
      // stale), and the old try/catch never saw that: no action, no clock, no
      // retry. Permanent freeze.
      let applied = false;
      try {
        applied = this.handController.performAction(dcPlayer.seat, disconnectAction.action as any);
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.disconnect_autoaction_threw');
      }
      if (!applied) applied = this.forceResolveSeat(dcPlayer.seat, true);
      if (applied) {
        this.markProgress();
        console.log(
          `[ServerTableEngine:${this.tableId}] Disconnect auto-${disconnectAction.action} for ${disconnectAction.playerId} (${disconnectAction.reason})`
        );
      } else {
        reportError(
          new Error('Disconnect auto-action rejected at seat ' + dcPlayer.seat),
          'ServerTableEngine.' + this.tableId + '.disconnect_autoaction_rejected'
        );
        this.forceArmTurnTimer(dcPlayer.seat, this.tableInfo?.action_time_seconds || 15);
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
        this.runoutRevealActive = false;
        resolve();
      }, HAND_SAFETY_TIMEOUT_MS);

      unsub = this.handController!.onEvent((event: HandEvent) => {
        // 2026-08-15: handleHandEvent is async and its promise was discarded,
        // so ANY rejection inside it (broadcast, hub publish, settlement DB
        // write) vanished into index.ts's unhandled-rejection swallow while the
        // hand silently stopped advancing. Catch it here so at minimum it is
        // reported and the watchdog can see the table stop making progress.
        void this.handleHandEvent(event, players).catch((err) =>
          reportError(err, 'ServerTableEngine.' + this.tableId + '.handleHandEvent_rejected', {
            eventType: event.type,
            handNumber: this.handCount,
          })
        );

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
          // ANIMATION AUDIT 2026-08-19: end of the all-in reveal window.
          this.runoutRevealActive = false;
          resolve();
        }
      });

      // Start the hand!
      try {
        // ANIMATION AUDIT 2026-08-19: defensive — a fresh hand must never
        // inherit a stale all-in reveal flag from an abnormal exit.
        this.runoutRevealActive = false;
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // EVENT HANDLING
  // ═══════════════════════════════════════════════════════════════════════════════

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

  /**
   * DEAD-TABLE RECOVERY (2026-08-15): rebuy-or-remove any SEATED horse whose
   * stack is 0 on a cash table. Mirrors Settlement step 5 ("Auto-rebuy busted
   * horses"), which only fires when a hand completes — this variant runs from
   * the dealing loop every iteration so tables that hydrated with busted
   * horses after a mid-hand restart come back to life instead of sleeping
   * forever, and zombie 0-stack seats on still-active tables get swept too.
   * Per-horse attempts are throttled to one per 30s so a drained club
   * treasury cannot turn the 3s idle loop into an RPC hammer.
   */
  private bustRecoveryLastAttempt: Map<string, number> = new Map();

  protected async recoverBustedSeatedHorses(): Promise<void> {
    const bustHorses = this.seatedPlayers.filter((p) => p.is_horse && p.stack <= 0);
    if (bustHorses.length === 0) return;

    const now = Date.now();
    for (const horse of bustHorses) {
      const lastAttempt = this.bustRecoveryLastAttempt.get(horse.user_id) || 0;
      if (now - lastAttempt < 30000) continue;
      this.bustRecoveryLastAttempt.set(horse.user_id, now);

      const currentRebuys = this.horseRebuys.get(horse.user_id) || 0;

      // Stop-Loss Bankroll logic (same rule as Settlement step 5): after two
      // rebuys (3 buy-ins lost) the horse leaves instead of rebuying again.
      if (currentRebuys >= 2) {
        await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
        this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
        this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
        this.straddleEngine.removePlayer(this.tableId, horse.user_id);
        this.preActionEngine.removePlayer(this.tableId, horse.user_id);
        this.horseRebuys.delete(horse.user_id);
        this.bustRecoveryLastAttempt.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Dead-table recovery: Horse ${horse.username} at stop-loss — removed.`
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
        this.bustRecoveryLastAttempt.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Dead-table recovery: rebought ${horse.username} -> ${rebuyAmount} chips (Rebuy #${currentRebuys + 1})`
        );
      } else {
        await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
        this.disconnectEngine.unregisterPlayer(this.tableId, horse.user_id);
        this.timeBankEngine.removePlayer(this.tableId, horse.user_id);
        this.straddleEngine.removePlayer(this.tableId, horse.user_id);
        this.preActionEngine.removePlayer(this.tableId, horse.user_id);
        this.horseRebuys.delete(horse.user_id);
        this.bustRecoveryLastAttempt.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Dead-table recovery: Horse ${horse.username} left — insufficient treasury funds`
        );
      }
    }
  }
}
