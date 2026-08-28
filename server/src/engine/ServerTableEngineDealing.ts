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
  processLeavePending,
} from '../services/supabase.js';
import type { SeatPlayer, GameVariant, HandConfig, HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { holeCardCount, deckSizeFor, maxSeatsFor } from './VariantRules.js';
import { bombPotSettingsFromTable } from './BombPotScheduler.js';

import { ServerTableEngineRunout } from './ServerTableEngineRunout.js';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { handCompletionHoldMs, boardClearMs } from '../config/handCompletionSpec.js';
import { collectNitEvictions } from '../services/supabase/nitGame.js';

export abstract class ServerTableEngineDealing extends ServerTableEngineRunout {
  // ═══════════════════════════════════════════════════════════════════════════════
  // DEALING LOOP — Millisecond-level performance
  // ═══════════════════════════════════════════════════════════════════════════════

  protected async dealingLoop(): Promise<void> {
    while (this.running) {
      try {
        // FIX 211: Await any pending postHandTasks before reloading players
        // This ensures DB stacks are synced before the next hand starts.
        // BOUNDED (2026-08-22): postHandTasks performs a chain of Supabase
        // calls, each individually capped at 15s but with no cap on the SUM —
        // and it never calls markProgress(), so a degraded DB could hold this
        // await past the 90s idle watchdog and get the engine killed (across
        // every table at once, since DB degradation is correlated). Cap the
        // wait at 45s; on timeout the remaining tasks keep running in the
        // background (their .catch already reports) and the loop proceeds —
        // stack sync is idempotent and the next hand's settlement re-syncs.
        if (this.postHandTasksPromise) {
          this.setLoopPhase('await_post_hand_tasks');
          const pending = this.postHandTasksPromise;
          let timedOut = false;
          await Promise.race([
            pending,
            new Promise<void>((r) => {
              const t = setTimeout(() => {
                timedOut = true;
                r();
              }, 45_000);
              (t as { unref?: () => void }).unref?.();
            }),
          ]);
          if (timedOut) {
            reportError(
              new Error('postHandTasks exceeded 45s - continuing loop, tasks finish in background'),
              'ServerTableEngine.' + this.tableId + '.postHandTasks_timeout'
            );
            this.markProgress();
          }
          this.postHandTasksPromise = null;
        }

        // ═══════════════════════════════════════════════════════════════════
        // THE PARK — no new hand starts while a deliberate pause is in force.
        //
        // This sits at the TOP of the iteration on purpose. Every guard below
        // exits with `continue` (short-handed, spin-reveal hold, bounty
        // reveal, admin lock), and the start-up wait loop enters the dealing
        // loop here — so a gate placed after `dealHand()` was unreachable for
        // any table that was not already mid-hand, and such a table dealt
        // straight through the break the moment it could. See awaitPauseGate
        // on the base class for the full account.
        //
        // A table WITH cards in the air is unaffected: the loop cannot return
        // to this line until dealHand() resolves, so the hand in progress at
        // :55 always finishes first. That is Dan's rule exactly — the break is
        // announced, every hand finishes, and each table stops as it lands.
        // ═══════════════════════════════════════════════════════════════════
        //
        // `holdBeforeNextHand` is what separates a break from hand-for-hand.
        // A break forbids the next hand outright; hand-for-hand means "deal
        // exactly one more, THEN park", and its sync deliberately re-pauses
        // 500ms after resuming every table. Honouring that re-pause here would
        // park the table before it dealt, the sync would see everyone parked
        // and resume again, and the bubble would never burst. See the field's
        // comment on ServerTableEngineBase.
        if (this.handForHandPaused && this.holdBeforeNextHand) {
          this.setLoopPhase('parked_for_pause');
          await this.awaitPauseGate();
          if (!this.running) break;
          // Fall through and re-evaluate the table from scratch: seats,
          // blinds and stacks may all have moved during a five-minute break.
        }

        // Reload players + refresh blinds before each hand.
        //
        // BUDGETED (2026-08-22): these are three Supabase round trips with
        // nothing bounding them and nothing marking progress while they run,
        // sitting directly under a 90s watchdog that kills the engine. On
        // 2026-08-22 that combination killed every cash table in the fleet
        // 22-30 times in six hours. Each step now stamps its own phase and
        // carries its own budget, so a slow database produces a NAMED, retried
        // step instead of an anonymous kill and a fleet-wide rebuild storm.
        const previousSeatedIds = new Set(this.seatedPlayers.map((p) => p.user_id));
        this.seatedPlayers = await this.withStepBudget(
          'load_seats',
          ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
          loadSeatedPlayers(this.tableId)
        );
        // Restart fidelity: apply persisted is_sitting_out to seats the engine
        // has not seen yet. The start-up loop calls this too, but it breaks the
        // moment enough players are seated and never runs again — so a player
        // who was mid-buy-in at boot, or who joined during the wait, would be
        // dealt in despite the database saying they are sitting out.
        this.restoreSitOutsFromSeats();
        await this.withStepBudget(
          'refresh_blinds',
          ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
          this.refreshBlinds()
        );
        // 2026-08-18: cash tables re-read their rake settings here (throttled
        // to once a minute inside the method). tableInfo is otherwise loaded
        // once per engine lifetime, so before this an owner changing the rake
        // saw nothing until the table restarted.
        await this.withStepBudget(
          'refresh_rake',
          ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
          this.refreshRakeConfig()
        );

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
        // first dealingLoop iteration every such player is registered — which
        // since 2026-08-25 no longer means "wait for the big blind". Cash entry
        // is free and the release a few lines below happens on this same tick.
        // The set now exists only so the two positional hold-outs (never dealt
        // into the small blind, never handed the button on your first hand) get
        // a chance to look at the seat before the deal. On the very first
        // iteration — cold start OR crash recovery — all seated players are
        // treated as the initial roster and none of that applies.
        if (this.dealingLoopFirstIteration) {
          for (const p of this.seatedPlayers) {
            this.knownPlayerIds.add(p.user_id);
            // Dan 2026-08-25, BINDING (restart fidelity): anyone already seated
            // when this engine booted was PLAYING before the restart, so they
            // are a veteran for button purposes. Without this, dealtInUserIds is
            // empty on boot, buttonEligible() falls back to the whole roster,
            // and "a new player never gets the button" is unenforceable for a
            // full orbit after every deploy — the one moment the table is most
            // likely to look wrong to the people sitting at it.
            this.dealtInUserIds.add(p.user_id);
          }
          this.dealingLoopFirstIteration = false;
        } else {
          for (const p of this.seatedPlayers) {
            if (!this.knownPlayerIds.has(p.user_id)) {
              if (!this.returningFromSitout.has(p.user_id) && !this.isTournamentTable()) {
                this.registerWaitForBB(p.user_id);
              } else if (this.isTournamentTable()) {
                // B2 2026-08-27: a tournament arrival cannot be held out for a
                // hand, so it is classified instead — see noteTournamentArrival.
                this.noteTournamentArrival(p.seat_number, p.user_id);
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
            // B2: a player who has left owes this table nothing. If they come
            // back they are a fresh arrival and get classified again.
            this.mustPostBB.delete(id);
          }
        }
        // POST-TO-ENTER RACE FIX 2026-08-27: a queued intent from someone no
        // longer seated (or never seated) is dead weight - drop it.
        for (const id of this.pendingPostToEnter) {
          if (!currentIds.has(id)) this.pendingPostToEnter.delete(id);
        }
        // Same pruning for button eligibility: a player who has left and comes
        // back is a new joiner again and re-earns the button by playing a hand.
        // This also keeps the set bounded by the table rather than by the
        // lifetime of the process.
        for (const id of this.dealtInUserIds) {
          if (!currentIds.has(id)) this.dealtInUserIds.delete(id);
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
        // Extracted to evictExpiredSitOuts (ServerTableEngineBase) so the
        // start-up wait loop can run the same rule. It used to live only here,
        // and the dealing loop is not running in exactly the case Dan reported:
        // a table below the minimum to deal parks in the wait loop, so the last
        // player at the table could sit out and hold the seat forever.
        //
        // countOrbit false here: this tick happens once per loop iteration,
        // which is a hand only when one is actually dealt. The real orbit is
        // counted at the deal itself, below.
        await this.evictExpiredSitOuts({ countOrbit: false });

        // Bible V8 §6.17: Admin pause/maintenance lock — skip dealing
        if (this.adminPauseLock || this.maintenanceLock) {
          if (this.tableFSM.state === 'running') {
            this.tableFSM.transition('paused');
          }
          this.setLoopPhase(this.adminPauseLock ? 'admin_pause_lock' : 'maintenance_lock');
          await this.sleep(3000);
          continue;
        }

        // Bible V8 §4.2: if the big blind is arriving at a waiting player's seat
        // this hand, release them here so they post it as their own blind rather
        // than being treated as a new joiner by the block below.
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

        // POST-TO-ENTER RACE FIX 2026-08-27: apply queued mid-hand posts NOW,
        // after registration (above) and after the natural-BB release (a
        // waiter whose seat just became the big blind posts it as their own -
        // billing them again through bbOnlyPosts would double-charge, and the
        // waitingForBB guard inside postBBToEnter makes that impossible
        // here). The call runs the same positional hold-outs as a live tap;
        // a refusal simply leaves the player waiting, exactly as if they had
        // tapped the button themselves at this moment.
        if (this.pendingPostToEnter.size > 0) {
          for (const userId of Array.from(this.pendingPostToEnter)) {
            this.pendingPostToEnter.delete(userId);
            if (this.waitingForBB.has(userId)) {
              this.postBBToEnter(userId);
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════════
        // A CASH ENTRANT WAITS FOR THE BIG BLIND, OR POSTS. THERE IS NO THIRD
        // OPTION.
        //
        // Dan 2026-08-26, binding, correcting himself:
        //
        //   "i also made a mistake the other night, when I said that a player
        //    doesn't have to post when they are new to a cash game table...
        //    Every single player needs to either wait for the BB or post when
        //    entering a cash game... no free hands or coming in behind the
        //    blinds."
        //
        // What used to be here released EVERY waiter on this tick, free. That
        // was the 2026-08-25 rule ("you don't have to post when you first come
        // to a table"), and it is the rule being reversed. A new joiner was
        // dealt in immediately, behind the blinds, having paid nothing - which
        // is a free hand, and free hands are worth real money at a raked table.
        //
        // So the release block is GONE, deliberately, rather than narrowed. A
        // player put into waitingForBB now stays there until one of exactly two
        // things happens:
        //
        //   1. THE BIG BLIND REACHES THEIR SEAT. Handled above, before this
        //      point: they are removed from the set and post the big blind
        //      because it is genuinely their blind. That is the "wait" half.
        //
        //   2. THEY POST. `postBBToEnter` (POST /post-bb) removes them and adds
        //      them to postingBBToEnter, which bills a live big blind through
        //      bbOnlyPosts. That is the "post" half, and it is a real product
        //      path again - TablePage offers the button.
        //
        // The two positional hold-outs that used to live in this block are not
        // reimplemented here because they no longer need to be: a waiter is
        // held out by default now, so "never dealt into the small blind" and
        // "a new player never gets the button" hold for free on the wait path.
        // They are still enforced on the POST path, in postBBToEnter, because
        // that is now the only way past the wait and neither rule may be bought.
        //
        // returningFromSitout is untouched and still owes a dead SB plus a live
        // BB. Missing blinds and never having posted them are different debts.
        // ═══════════════════════════════════════════════════════════════════

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
          await this.withStepBudget(
            'pending_addons',
            ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
            this.processPendingAddOns(this.seatedPlayers)
          );
          // LEAVE_PENDING SAFETY NET (Dan 2026-08-25: "leave table is like the
          // reset button"). processLeavePending's only other caller is
          // settlement step 6, so a seat flagged during a hand that never
          // COMPLETES — the table dropped below the minimum to deal, or the
          // hand died on the safety timeout, which skips settlement entirely —
          // stayed flagged forever. The player was gone from their screen,
          // still holding the seat, chips still on the table, and nothing in
          // the idle loop looked at it. This sweeps it on every tick, alongside
          // the add-on sweep that exists for exactly the same class of orphan.
          await this.withStepBudget(
            'leave_pending',
            ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
            (async () => {
              const cashedOutIds = await processLeavePending(
                this.tableId,
                this.tableInfo?.club_id || ''
              );
              // Same per-player teardown settlement does, or every leaver
              // strands an FSM entry, a time bank and a pre-action behind them.
              for (const leftUserId of cashedOutIds) {
                this.disconnectEngine.unregisterPlayer(this.tableId, leftUserId);
                this.timeBankEngine.removePlayer(this.tableId, leftUserId);
                this.straddleEngine.removePlayer(this.tableId, leftUserId);
                this.preActionEngine.removePlayer(this.tableId, leftUserId);
              }
              if (cashedOutIds.length > 0) {
                this.seatedPlayers = this.seatedPlayers.filter(
                  (sp) => !cashedOutIds.includes(sp.user_id)
                );
              }
            })()
          );
        } else {
          // THE TOURNAMENT COUNTERPART — see releaseDeadTournamentSeats().
          // A cash table has swept its own dead seats on every idle tick since
          // 2026-08-15; a tournament table had nothing of its own and relied
          // entirely on the 5-second sweep in TournamentManager reaching it.
          //
          // Placed HERE, above the active-player filter, for the same reason
          // the add-on sweep is: a chair freed this tick has to be free for
          // THIS hand, not the next one.
          await this.withStepBudget(
            'release_dead_tournament_seats',
            ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
            this.releaseDeadTournamentSeats()
          );
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
          await this.withStepBudget(
            'recover_busted_horses',
            ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
            this.recoverBustedSeatedHorses()
          );
        }

        if (activePlayers.length < this.minPlayersToDeal()) {
          // Bible V8 §3.1: Table FSM — running → waiting (not enough players).
          // "Enough" is the host's AutoStart figure now, not a hard-coded 2 —
          // see minPlayersToDeal on the base class, which the watchdog reads
          // too so the two cannot disagree
          if (this.tableFSM.state === 'running') {
            this.tableFSM.transition('waiting');
          }
          this.setLoopPhase('idle_not_enough_players');
          await this.sleep(3000);
          continue;
        }

        // SPIN REVEAL HOLD (2026-08-21): the table may not deal while the
        // shared wheel is still running. Re-checked in short slices so a
        // resume is responsive and the loop stays interruptible.
        if (this.dealHoldUntilMs > Date.now()) {
          this.setLoopPhase('spin_reveal_hold');
          await this.sleep(Math.min(this.dealHoldUntilMs - Date.now(), 1000));
          continue;
        }

        // MYSTERY BOUNTY REVEAL GATE (Dan sections 21-26, 61-65). The table
        // waits for the chest, and for EVERY chest behind it — the button may
        // not move until the queue is empty (sections 25 and 64). This sits
        // immediately before dealHand(), which is the single place the button
        // advances and the blinds are posted, so closing the gate here is what
        // makes "no button move, no next hand, no blinds, no action timers"
        // one condition rather than four.
        //
        // Deliberately a COUNT and not a deadline; see beginBountyReveal().
        // Entries expire on their own, so a settle path that dies mid-reveal
        // costs an animation, never a wedged table.
        if (this.hasOpenBountyReveal()) {
          this.setLoopPhase('mystery_bounty_hold');
          await this.sleep(250);
          continue;
        }

        // Bible V8 §3.1: Table FSM — waiting → seating → running (players returned)
        if (this.tableFSM.state === 'waiting') {
          this.tableFSM.transition('seating');
          this.tableFSM.transition('running');
        }

        // Deal hand (self-transition: running → running for next hand)
        this.setLoopPhase('dealing');
        await this.dealHand(activePlayers);
        this.consecutiveErrors = 0;

        // Hand-for-hand / synchronized break: the hand just landed, so park
        // NOW rather than waiting for the showdown display pause below. This
        // is what makes areAllTablesParked() go true promptly, which is what
        // starts the five minutes. Same gate as the top of the loop — see
        // awaitPauseGate on the base class.
        if (this.handForHandPaused && this.running) {
          this.setLoopPhase('parked_for_pause');
          await this.awaitPauseGate();
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
            // POKERBROS PARITY 2026-08-26: a run-it-twice hand's boards are
            // revealed street by street CLIENT-side after settlement — the
            // hold covers that whole timeline (spec RIT_* constants) so the
            // next hand can never deal over a board still turning its river.
            ritRuns: this.currentHandRitBoards,
            // Streets each board still deals: flop at 3 cards, turn at 4,
            // river at 5 — count the stops past the shared base board.
            ritStreetsPerRun: [3, 4, 5].filter((n) => n > this.currentHandRitBaseBoardCount).length,
          });

          // Phase 1: the completion sequence actually plays out.
          this.setLoopPhase('post_hand_hold');
          await this.sleep(resultDisplayMs);
          // Phase 2: board clear (clients animate the card/chip sweep).
          this.broadcastCurrentState(); // Sends clean state (no hand in progress)
          await this.sleep(boardClearMs(wentToShowdown));

          // ── Dan's Rebuy Pause (2026-08-24) ──
          // Give busted players 5 seconds to process the UI modal and hit rebuy before the next hand starts.
          // activePlayers refers to the players DEALT into this hand (so they started > 0 chips).
          // If they now have 0, they just busted.
          //
          // EVERY PLAYER, HORSE OR HUMAN (Dan 2026-08-27). This filter used to
          // carry `&& p.is_horse === false`, so the table held for five seconds
          // when a human busted and snapped straight into the next hand when a
          // horse did. Dan: "YES IT STILL NEEDS TO THE SAME 5 SECOND PAUSE TO
          // REBUY. NOT EVERY HORSE ALWAYS REBUYS IN THE CASH GAMES, AND IF YOU
          // DIDN'T GIVE THEM THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE
          // WOULD NOTICE!"
          //
          // He is right, and the tell is the RHYTHM of the table rather than
          // any one hand: a seat whose bust never costs the table a beat is a
          // seat everybody can identify as a horse. The pause is also not
          // ceremonial for horses — the stop-loss (two rebuys) and an empty
          // club treasury both mean a horse genuinely may not come back, so
          // the window it is given to return has to be the same window.
          //
          // See CLAUDE.md section 10.5. There is no "equal outcome by a
          // different mechanism" exemption: timing is part of the outcome.
          const justBustedPlayers = activePlayers.filter((p) => p.stack === 0);
          if (justBustedPlayers.length > 0) {
            let needsRebuyPause = false;
            if (!this.isTournamentTable()) {
              needsRebuyPause = true; // Cash games always have rebuy
            } else if (this.tableInfo?.tournament_id) {
              try {
                // .maybeSingle(), never .single() (2026-08-26). This was
                // .single(), which answers zero rows with
                // { data: null, error: PGRST116 } instead of throwing — so the
                // catch below never fired, the error was discarded with the
                // destructure, `t` came back null, needsRebuyPause stayed
                // false, and a busted player in a rebuy tournament lost the
                // five second window to buy back in. The next hand simply
                // started. Nothing logged.
                const { data: t, error: tErr } = await supabase
                  .from('tournaments')
                  .select(
                    'is_rebuy, is_reentry, rebuy_levels, late_reg_levels, addon_levels, add_on_available, current_level, prize_pool_finalized'
                  )
                  .eq('id', this.tableInfo.tournament_id)
                  .maybeSingle();

                if (tErr) throw tErr;

                if (t && (t.is_rebuy || (t as { is_reentry?: boolean }).is_reentry)) {
                  /* REBUY-WINDOW 2026-08-27: this gate now does the same
                     arithmetic process_tournament_rebuy does, because four
                     sites were computing three different answers.

                     Production config on the dominant template is
                     rebuy_levels 6 / late_reg_levels 8 / addon_levels 1 /
                     add_on_available true, and the four sites disagreed:

                       SQL (the authority)   levels 0-6   (cap 6+1, closed >= 7)
                       this gate             levels 0-6   by luck; ignored add-on
                       client canRebuy       levels 0-8   late_reg_levels FIRST
                       tryTournamentRebuys   levels 0-6   permissive by one

                     So at levels 7-8 the client opened a modal, the table did
                     NOT pause, and the RPC threw 'Rebuy period has closed'.

                     Four corrections, all matching the SQL:
                       - NULLIF(...,0) semantics, not `??`. `rebuy_levels = 0`
                         yielded cap 0 here, which this code read as "no cap" —
                         an unconditional 5s stall on every bust for the whole
                         event. A stray pause is as much a tell as a missing one.
                       - rebuy_levels FIRST, then late_reg_levels.
                       - + addon_levels when add_on_available (migration
                         20260823310000, rebuys stay open through the add-on
                         window).
                       - closed at `>= cap`, not `<= cap`. */
                  const nz = (v: unknown): number | null => {
                    const n = Number(v);
                    return Number.isFinite(n) && n !== 0 ? n : null;
                  };
                  let cap = nz(t.rebuy_levels) ?? nz(t.late_reg_levels) ?? 0;
                  if (cap > 0 && (t as { add_on_available?: boolean }).add_on_available) {
                    cap += nz((t as { addon_levels?: number }).addon_levels) ?? 1;
                  }
                  const level = Number(t.current_level ?? 0);
                  const windowOpen = cap === 0 || level < cap;
                  /* A finalized prize pool cannot take another chip — the RPC
                     refuses it. Holding the felt for a purchase that is going
                     to be refused helps nobody. */
                  const poolOpen = !(t as { prize_pool_finalized?: boolean }).prize_pool_finalized;
                  if (windowOpen && poolOpen) needsRebuyPause = true;
                }
              } catch (err) {
                /* FAIL OPEN, not closed (2026-08-27). This read decides whether
                   a busted player gets the window they are entitled to. It used
                   to log and leave `needsRebuyPause` false, so one transient
                   Supabase blip silently deleted somebody's chance to buy back
                   in and the next hand just started. Erring toward the pause
                   costs five seconds; erring away from it costs a tournament
                   life. Every other money-adjacent read in this codebase was
                   converted to treat unreadable as UNKNOWN rather than as NO
                   (see PAYOUT-INTEGRITY 2026-08-25); this one had not been. */
                needsRebuyPause = true;
                console.error(
                  `[ServerTableEngine:${this.tableId}] Rebuy-window read failed — pausing anyway (fail-open):`,
                  err
                );
              }
            }

            if (needsRebuyPause) {
              console.log(
                `[ServerTableEngine:${this.tableId}] Rebuy pause (<=5s) for: ${justBustedPlayers.map((p) => p.username).join(', ')}`
              );
              this.setLoopPhase('rebuy_pause');
              /* SNAP-CONTINUE 2026-08-27. Dan's rule has two halves and only
                 one of them was built: "...to allow the player to rebuy in,
                 without skipping the hand, OR SNAP CONTINUES IF THEY CLICK NO
                 TO THE REBUY."

                 This was `await this.sleep(5000)` — a bare setTimeout with no
                 handle. `rejectedRebuys` was a WRITE-ONLY Set: the entire
                 decline chain (TablePage -> POST /reject_rebuy ->
                 engine.rejectRebuy) ended in a `.add()` that nothing read, so
                 the table sat out all five seconds whatever the player clicked.
                 The handler's own docblock described the fast-forward it never
                 got.

                 waitForRebuyDecisions returns the instant every busted seat has
                 answered — declined, or rebought (stack positive again). It
                 covers horses by the same test, because the pause has to look
                 identical from the outside either way. */
              await this.waitForRebuyDecisions(
                justBustedPlayers.map((p) => p.user_id).filter(Boolean),
                5000
              );
            }
          }
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
        // The list this used to carry inline now lives on the base, because
        // `start()` needs the same answer and a second copy is how the two
        // paths came to disagree — survivable here, fatal there.
        const isTransient = ServerTableEngineBase.isTransientDbError(err);

        // A blown step budget is the loop reporting that it is ALIVE and
        // waiting, so it must not read to the watchdog as a dead loop. This
        // is the same call the 45s postHandTasks bound above already makes,
        // for the same reason.
        if (errMsg.includes('deal_step_timeout')) {
          this.markProgress();
          reportError(err, 'ServerTableEngine.' + this.tableId + '.deal_step_timeout', {
            phase: this.loopPhase,
            handCount: this.handCount,
          });
        }

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
          // FIX 2026-08-22: was `this.running = false` alone, which left a
          // half-dead engine — deadlines armed, hand safety timer live,
          // handController possibly non-null — that the reaper then deleted
          // WITHOUT ever cleaning up. killForRestart does the full teardown
          // (ownership-guarded) and lets discovery rebuild a fresh engine.
          this.killForRestart('dealing_loop_10_consecutive_errors');
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
        // Third copy of the same list, now also on the base. This one was the
        // narrowest of the three — it never listed `supabase_timeout`, the
        // wording the DB_TIMEOUT_MS abort actually emits, so the retry it
        // exists to perform did not fire for the most common timeout.
        const isTransient = ServerTableEngineBase.isTransientDbError(err);
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
    // TRIPLE-BOARD BOMB POT 2026-08-27: board 3 + bomb metadata are per-hand.
    this.currentHandCommunityCards3 = [];
    this.currentHandBombPot = null;
    this.currentHandWinnersByBoard = [];
    // SHOWDOWN POLISH 2026-08-25: per-pot award breakdown is per-hand.
    this.currentHandPerPotAwards = [];
    this.currentHandActions = [];
    this.currentHandWinners = [];
    // Dan section 29: a stale pot breakdown would attribute THIS hand's
    // knockout to the previous hand's side pots, so it is cleared with the
    // winners it belongs to and never independently of them.
    this.currentHandPots = [];
    this.currentHandContributions.clear(); // Bible V8 §4.18: Reset equal-share rakeback tracking (FIX 144)
    this.currentHandInsuranceSettlements = []; // Bible V8 §4.19: Reset insurance settlements
    this.currentHandCashoutRedirects = new Map(); // EV CASHOUT 2026-08-28: reset per hand
    this.currentHandShowdownResults = []; // BBJ: Reset showdown results for new hand
    this.currentHandTimerLog = []; // Bible V8 §2.15: Reset timer log
    this.currentHandNotificationLog = []; // Bible V8 §2.16: Reset notification log
    this.currentHandBBJHit = null; // BBJ: Reset hit detection for new hand
    this.currentHandBBJPayoutConfig = null;
    // NOTE: rabbitHuntInFlight is deliberately NOT cleared here. It looks like
    // per-hand state and is not — it is a concurrency LOCK, taken immediately
    // before the billing RPC and released in that call's `finally`. Clearing it
    // at the hand boundary drops the lock out from under an in-flight purchase,
    // so a second tap sails past the "already loading" check and the player is
    // billed twice: exactly the failure the lock was added to prevent. The
    // `finally` is what bounds this set, on every path including a throw.
    this.currentHandRitBoards = 0; // RIT VERIFIER FIX 2026-08-21: new hand, no boards
    this.currentHandRitBaseBoardCount = 0;
    this.currentHandRitExtraBoards = [];
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
    // 2026-08-23: this was a local map, unexported and invisible to the only
    // other copy of the same fact in HandController.getCardsPerPlayer(). Both
    // fell back to 2, so `flo8` would have passed a capacity check computed for
    // a two-card game and then been dealt four. One table now: VariantRules.
    const variantKey = (this.tableInfo?.game_variant || 'nlh').toLowerCase();
    const cardsPerPlayer = holeCardCount(variantKey);
    const deckSize = deckSizeFor(variantKey);
    const maxSeatable = maxSeatsFor(variantKey);

    if (players.length > maxSeatable) {
      reportError(
        new Error(
          `Deck cannot serve ${players.length} seats of ${variantKey} ` +
            `(${cardsPerPlayer}/player, ${deckSize}-card deck, max ${maxSeatable})`
        ),
        'ServerTableEngine.' + this.tableId + '.deck_capacity_exceeded'
      );
      this.handCount--; // this hand never happened

      /**
       * MARK PROGRESS, BECAUSE THE LOOP IS ALIVE (2026-08-25).
       *
       * This refusal is correct - the deck genuinely cannot serve the table -
       * but returning without marking progress made the engine lie about
       * itself. `lastProgressAtMs` froze while the loop kept ticking, so the
       * watchdog read a table that is refusing on purpose as a WEDGED one and
       * called killForRestart. That restarts the WHOLE ENGINE - every table on
       * the instance, ~2 minutes of 4404 rehydration, every seated human
       * dropped - to cure one table that will refuse identically the moment
       * the engine comes back. It is the mass-disconnect workstream's own
       * failure mode, triggered by a guard.
       *
       * The loop is not stuck. It is running, and the answer it keeps
       * producing is "no". Say so honestly and let the alarm above be the
       * signal, rather than a restart nobody asked for.
       *
       * The real cure is upstream: tournament tables are now built through
       * clampSeatsForVariant, so this branch should be unreachable for
       * anything created after 2026-08-25. It stays as a backstop, and a
       * backstop must not be able to take the fleet down.
       */
      this.markProgress();
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
      equipped_frame: p.equipped_frame ?? '',
      equipped_aura: p.equipped_aura ?? '',
    }));

    // Rotate dealer — AUDIT FIX 2026-07-19: SEAT-based moving button. Advance to
    // the next occupied seat clockwise from the previous button seat. If that
    // seat's player busted/left, getNextSeat naturally lands on the next present
    // player (dead-button behavior) — the button never moves backward, skips a
    // seat, or lands twice.
    const sortedSeats = players.map((p) => p.seat_number).sort((a, b) => a - b);
    const prevButtonSeat = this.lastButtonSeat;
    // Dan 2026-08-25, BINDING: "NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING
    // DOWN. It skips over them and moves to the correct person." The wait-for-BB
    // gate above already holds a joiner out when it can SEE the button coming,
    // but the roster can change between that prediction and this rotation (a
    // player busts, leaves, or is evicted mid-iteration), so the guarantee is
    // enforced here, where the button is actually chosen. buttonEligible falls
    // back to the whole roster when nobody has played yet, so a table dealing
    // its first ever hand still gets a button.
    const buttonRoster = this.buttonEligible(players);
    const buttonSeats = buttonRoster.map((p) => p.seat_number).sort((a, b) => a - b);
    // A DRAWN first button (Spins) wins over the default, once, and only if
    // that seat is still occupied. Everything after hand one rotates normally.
    const drawnButton = this.forcedFirstButtonSeat;
    this.forcedFirstButtonSeat = null;
    const drawnIsSeated = drawnButton !== null && sortedSeats.includes(drawnButton);
    let dealerSeat = drawnIsSeated
      ? (drawnButton as number)
      : prevButtonSeat > 0
        ? this.getNextSeat(prevButtonSeat, buttonRoster)
        : buttonSeats[0];
    // THE BUTTON MUST ALWAYS MOVE. getNextSeat over a ONE-seat roster returns
    // that same seat from both of its branches, so when exactly one player is
    // button-eligible and already holds the button, the button stands still and
    // the same two players post the small and big blind twice running. That is
    // reachable any time several players arrive at once around one incumbent.
    //
    // Heads-up is deliberately excluded: with two players the button IS the
    // small blind, so parking it on the veteran is what makes the newcomer the
    // big blind and gets them dealt in free. Forcing it across would put them in
    // the small blind, which the hold-out then refuses, leaving one active
    // player and no hand — a table that never deals again.
    if (
      !drawnIsSeated &&
      prevButtonSeat > 0 &&
      dealerSeat === prevButtonSeat &&
      players.length > 2
    ) {
      dealerSeat = this.getNextSeat(prevButtonSeat, players);
    }
    this.currentHandDealerSeat = dealerSeat;
    this.lastButtonSeat = dealerSeat;
    // Everyone dealt into THIS hand is a veteran from the NEXT one onward, so
    // the button reaches them on the following orbit. Recorded after the button
    // is chosen, never before, or a first-time player would qualify to receive
    // the very button this line exists to keep away from them.
    for (const p of players) {
      this.dealtInUserIds.add(p.user_id);
    }
    // AN ORBIT IS A HAND, NOT A LOOP ITERATION. The sit-out counter used to be
    // bumped by the dealing loop's own tick, which fires once per hand while
    // dealing and once per 3-second idle tick while not — so "removed after the
    // button passes them twice" silently became "after about nine seconds" on a
    // quiet table. It is counted HERE, at the deal, which is the only place an
    // orbit actually advances. The five-minute half is evaluated on every tick
    // regardless, so a table that stops dealing still evicts on the clock.
    if (!this.isTournamentTable()) {
      this.disconnectEngine.tickSitOutsAndCollectEvictions(
        this.tableId,
        this.seatedPlayers.map((p) => p.user_id),
        { countOrbit: true }
      );
    }
    // Keep the legacy index roughly in sync for any remaining reads (defensive).
    this.dealerSeatIndex = Math.max(0, sortedSeats.indexOf(dealerSeat)) + 1;

    // Bible V8 §6: Orbit complete (button wrapped past the top seat) → refill
    // time banks. With seat-based rotation, a wrap means the new button seat is
    // not strictly greater than the previous one.
    if (prevButtonSeat > 0 && dealerSeat <= prevButtonSeat) {
      this.timeBankEngine.onOrbitComplete(this.tableId);
    }

    // Who posts the blinds this hand. ONE computation, used by the straddle
    // block below and by the away-blind cap further down — they were two
    // copies of the same arithmetic, which is a correctness trap: the day
    // somebody fixes the heads-up rule in one of them, the other silently
    // starts billing the wrong seat.
    //
    // This mirrors HandController.postBlinds exactly (heads-up: the button IS
    // the small blind; otherwise the small blind is the next seat clockwise),
    // over the same `players` roster HandController is about to receive. Its
    // getNextActiveSeat filters `is_sitting_out`, and every player in this
    // roster is built with `is_sitting_out: false`, so the two walks agree.
    const sbSeat = players.length === 2 ? dealerSeat : this.getNextSeat(dealerSeat, players);
    const bbSeat = this.getNextSeat(sbSeat, players);

    // Bible V8 §4.4: Process straddles before hand starts
    let straddleResults: { seat: number; amount: number }[] = [];
    if (this.tableInfo.straddle_enabled) {
      // Build seat order starting from UTG (left of BB)
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
    // the GLOBAL allocator — cadence was a coin flip, not a schedule.
    //
    // BOMB POT STANDARDIZATION 2026-08-27 (Dan's spec §4): the raw counter is
    // replaced by BombPotScheduler, which adds once_per_orbit, timed and
    // bomb_pot_only trigger modes, single pending-token semantics (a paused
    // table owes ONE bomb, never a backlog) and the minimum-players gate — a
    // due bomb stays pending until bomb_pot_min_players (default 3) are dealt
    // in. The decision is made HERE, once per hand, at the hand boundary; a
    // hand already in progress can never become a bomb pot (spec §4.1).
    let bombPotConfig: HandConfig['bombPot'];
    {
      const schedulerSettings = bombPotSettingsFromTable(this.tableInfo);
      const decision = this.bombPotScheduler.noteHandStart(
        schedulerSettings,
        dealerSeat,
        players.length,
        Date.now()
      );
      if (decision.isBombPot) {
        // Board count: the canonical 1-3 column wins; the legacy double-board
        // boolean maps to 2. HandController still downgrades stepwise if the
        // deck cannot cover players × holeCards + 5 × boards (spec §3.1).
        const rawBoardCount =
          this.tableInfo.bomb_pot_board_count ??
          ((this.tableInfo.bomb_pot_double_board ?? false) ? 2 : 1);
        const boardCount = (rawBoardCount >= 3 ? 3 : rawBoardCount === 2 ? 2 : 1) as 1 | 2 | 3;
        const anteFixed = this.tableInfo.bomb_pot_ante_fixed ?? 0;
        bombPotConfig = {
          anteMultiplier: this.tableInfo.bomb_pot_ante_multiplier ?? 2,
          // Legacy flag kept in lockstep so older consumers keep working.
          doubleBoard: boardCount >= 2,
          boardCount,
          // FIXED ante mode (spec §3): a positive fixed amount overrides the
          // BB multiple. Zero/null means BB-multiple mode.
          anteFixed: anteFixed > 0 ? anteFixed : undefined,
          triggerReason: decision.triggerReason,
        };
      }
    }

    // ── Dan 2026-08-23: bill this hand's blinds against the away-blind cap ──
    //
    // Recorded here rather than inside HandController.postBlinds because the
    // cap is a property of the PLAYER's presence, and HandController knows
    // nothing about presence — it is a pure hand engine and should stay one.
    // `sbSeat` / `bbSeat` are the shared computation above, so this can never
    // disagree with the seats that actually get charged.
    //
    // Skipped for bomb pots (everyone antes, nobody posts a blind) and for
    // tournaments (a tournament player is blinded off by design — removing
    // them would break elimination and the tournament could never end).
    //
    // noteBlindChargedWhileAway is a no-op for a player who is present, so
    // every branch below is safe to call unconditionally.
    if (!this.isTournamentTable() && !bombPotConfig && players.length >= 2) {
      const chargeBlind = (seatNumber: number, which: 'sb' | 'bb') => {
        const occupant = players.find((p) => p.seat_number === seatNumber);
        if (!occupant) return;
        this.disconnectEngine.noteBlindChargedWhileAway(this.tableId, occupant.user_id, which);
      };

      chargeBlind(sbSeat, 'sb');
      chargeBlind(bbSeat, 'bb');

      // The posted blinds are not the only blinds. Two other paths take money
      // from a seat before a card is dealt, and an away player can be in
      // either — missing them would let somebody be ground down by exactly
      // the charges this cap exists to stop.
      //
      // Dead blinds (returning from sit-out) take a dead SB AND a live BB in
      // the SAME hand, so that player has spent the entire budget in one go
      // and is stood up before the next deal. That is the correct outcome:
      // they came back, immediately went away again, and paid a full blind
      // cycle for it.
      if (this.returningFromSitout.size > 0) {
        for (const p of players) {
          if (!this.returningFromSitout.has(p.user_id)) continue;
          if (p.seat_number === sbSeat || p.seat_number === bbSeat) continue;
          this.disconnectEngine.noteBlindChargedWhileAway(this.tableId, p.user_id, 'sb');
          this.disconnectEngine.noteBlindChargedWhileAway(this.tableId, p.user_id, 'bb');
        }
      }
      // "Post BB to enter" takes a live big blind only.
      if (this.postingBBToEnter.size > 0) {
        for (const p of players) {
          if (!this.postingBBToEnter.has(p.user_id)) continue;
          if (p.seat_number === sbSeat || p.seat_number === bbSeat) continue;
          this.disconnectEngine.noteBlindChargedWhileAway(this.tableId, p.user_id, 'bb');
        }
      }
    }

    // B2 2026-08-27: the seats posting a live-big-blind-only this hand. Two
    // sources, one list — cash "post BB to enter", and tournament arrivals that
    // took a seat the big blind had just passed (see `mustPostBB`). Both are a
    // single live big blind into the pot, so chips are conserved; HandController
    // skips anyone who is the small or big blind this hand, which is what makes
    // "never two big blinds in one orbit" true by construction.
    const bbOnlyPostSeats: { seat: number }[] = [];
    if (!this.isTournamentTable() && this.postingBBToEnter.size > 0) {
      for (const p of players) {
        if (this.postingBBToEnter.has(p.user_id)) bbOnlyPostSeats.push({ seat: p.seat_number });
      }
    }
    if (this.isTournamentTable() && this.mustPostBB.size > 0) {
      for (const p of players) {
        if (this.mustPostBB.has(p.user_id)) bbOnlyPostSeats.push({ seat: p.seat_number });
      }
    }

    const config: HandConfig = {
      tableId: this.tableId,
      handNumber,
      gameVariant: this.dealtGameVariant() as GameVariant,
      smallBlind: this.tableInfo.small_blind,
      bigBlind: this.tableInfo.big_blind,
      /* FIX-219: Bible V8 §4.3 — Respect ante_enabled toggle; if disabled, zero
         out ante. That is a CASH-TABLE toggle: CreateTableModal writes it
         (`ante_enabled: parseFloat(anteAmount) > 0`) and the lobby gates its
         ante badge on it.

         ── A TOURNAMENT ANTE IS NOT SUBJECT TO IT (2026-08-27) ──────────────
         Measured in production: `ante_enabled` is FALSE on ALL 93,416 table
         rows, so this expression yielded `undefined` every time and
         HandController's `if (this.config.ante)` never fired. NO ANTE HAS EVER
         BEEN POSTED, on any table, anywhere.

         For cash that is at worst a dormant feature. For tournaments it is
         wrong: the ante comes from the BLIND STRUCTURE, refreshed on every
         level change by refreshBlindsFromDb (which sets `this.tableInfo.ante =
         data.ante` and cannot set a toggle it does not own). 10,085 tournaments
         carry non-zero antes in their structure and 43 were live at the time of
         writing; every one of them advertised "Level N: x/y ante z" in the
         blinds tab and collected nothing. That materially changes tournament
         play, which is exactly what an ante is for.

         So: tournaments take the ante their level specifies; cash keeps the
         toggle. */
      ante: this.tableInfo.tournament_id
        ? this.tableInfo.ante
        : (this.tableInfo.ante_enabled ?? true)
          ? this.tableInfo.ante
          : undefined,
      bigBlindAnte: this.tableInfo.big_blind_ante_enabled ?? false,
      // 2026-08-22 parity: AoF tables restrict preflop to fold / all-in.
      allInOrFold: this.tableInfo.all_in_or_fold ?? false,
      bombPot: bombPotConfig,
      straddles: straddleResults.length > 0 ? straddleResults : undefined,
      // Bible V8 §4.2: Dead blinds for players returning from sit-out
      deadBlinds:
        !this.isTournamentTable() && this.returningFromSitout.size > 0
          ? players
              .filter((p) => this.returningFromSitout.has(p.user_id))
              .map((p) => ({ seat: p.seat_number }))
          : undefined,
      // AUDIT FIX 2026-07-19: "Post BB to enter" players post a live BB only.
      // B2 2026-08-27: tournament arrivals that owe a big blind join the same list.
      bbOnlyPosts: bbOnlyPostSeats.length > 0 ? bbOnlyPostSeats : undefined,
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
    // B2 2026-08-27: a tournament arrival's big blind is settled the moment it
    // is actually taken. Anyone sitting in the SMALL blind this hand was skipped
    // by bbOnlyPosts (charging them would have been a blind on top of a blind),
    // so they stay on the hook for the next hand — they pay the small blind now
    // and the big blind then, which is one ordinary blind cycle in reverse
    // order, not an extra one. Everyone else has either just been charged or is
    // the big blind and posted it themselves.
    if (this.mustPostBB.size > 0) {
      for (const p of players) {
        if (this.mustPostBB.has(p.user_id) && p.seat_number !== sbSeat) {
          this.mustPostBB.delete(p.user_id);
        }
      }
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
        // ── REVERTED 2026-08-25, same day it shipped. Read this before trying
        //    the restart-fidelity time-bank restore again. ──
        //
        // The intent was right: syncStacks writes time_bank_remaining,
        // loadSeatedPlayers reads it back, and this line threw it away, so a
        // restart refilled everyone's bank for free. The implementation was
        // wrong in a way that made things strictly WORSE than the refill:
        //
        //   `time_bank_remaining INTEGER DEFAULT 30` (20260313_time_bank_
        //   persistence.sql) — the column is never null, and loadSeatedPlayers
        //   additionally coerces `|| 0`. So "is there a persisted value?" was
        //   ALWAYS true and the fallback branch was unreachable for every
        //   player on every table.
        //
        // The damage: every seat got 30s/4 uses instead of the table base plus
        // their VIP and purchased extras, which made fetchTimeBankExtras dead
        // code; and dbConsumedSeconds was seeded at (tbTotal - 30), so a VIP
        // with 300s of extras had 310 seconds of their monthly quota booked as
        // spent the instant they sat down.
        //
        // A correct version needs a way to tell "this seat has never been
        // seeded" from "this seat has 30 seconds left", which the schema cannot
        // currently express. That needs a nullable marker column, not a cleverer
        // read of these two. Until then the generous behaviour is the safe one:
        // a free refill on a restart costs the house a few seconds of clock; the
        // broken version silently overcharged VIP quota on every table.
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
        this.handSafetyTimer = null;
        // CROSS-INSTANCE GUARD (2026-08-22): if this engine has been stopped
        // or superseded while the void timer was armed, the shared timers now
        // belong to the replacement engine — clearing them here would wipe the
        // LIVE table's turn clock ten minutes after the handover. Detach and
        // get out without touching anything shared.
        if (!this.running || !this.isCurrentEngine()) {
          // (review fix) Even when superseded we must still drop OUR OWN
          // hand state: resolving with handController set would let
          // dealingLoop deal the next hand from a superseded instance — two
          // engines dealing one table. Local teardown only; never the shared
          // timers (they belong to the successor).
          unsub();
          this.handController = null;
          this.runoutRevealActive = false;
          resolve();
          return;
        }
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
      // Track on the instance so stop()/killForRestart() can clear it.
      this.handSafetyTimer = handTimeout;

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
          this.handSafetyTimer = null;
          unsub();

          // GUARD (2026-08-22): everything between here and resolve() used to
          // run unprotected inside HandController.emit's listener loop. A
          // throw from recordHandTiming or clearTurnTimer escaped back into
          // completeHand AFTER the void timer was cleared — the dealHand
          // promise then hung forever and the table stopped dealing. Nothing
          // in this block may prevent resolve() from running.
          try {
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
          } catch (e) {
            reportError(e, 'ServerTableEngine.' + this.tableId + '.hand_complete_listener_threw');
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
        this.handSafetyTimer = null;
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

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  GHOST SEATS IN TOURNAMENTS (2026-08-28)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The tournament counterpart of recoverBustedSeatedHorses() above, which a
   * tournament table has never had. A cash table sweeps its own dead seats
   * every idle tick; a tournament table had exactly one thing looking after
   * it — the 5-second elimination sweep in TournamentManager — and when that
   * sweep is late, or is looking at a table this process has no engine for,
   * the chair simply stays occupied.
   *
   * WHAT A GHOST SEAT COSTS, and why this is not cosmetic. It holds a chair
   * at a table other players are waiting to fill. It counts toward the
   * four-table limit, so the account cannot be seated anywhere else. And it
   * cannot act, so every orbit spends a full turn timer folding a player who
   * is not there.
   *
   * ── THE DIVISION OF LABOUR IS DELIBERATE ──
   *
   * This method NEVER eliminates anybody. Eliminating is assigning a
   * finishing place and paying a prize against it, and the places have to be
   * handed out from one place that can see the whole field — the sweep does
   * that, with a lot of hard-won care about distinct positions and
   * double-pays. An engine that eliminated locally would be a second writer
   * of finishing places, which is the exact shape of the 206 duplicated
   * places found on 2026-08-27.
   *
   * So this method only does what is unambiguous and local: if the field
   * already says you are OUT, you do not keep the chair. The status write
   * happened somewhere else; only the release was lost.
   *
   * ── HORSES ARE PLAYERS (CLAUDE.md 10.5) ──
   *
   * There is no is_horse test here, and there must not be one. A human whose
   * seat release failed is sitting in the same ghost chair for the same
   * reason, and the reported case being a horse (ShoveWhale, 22 minutes) says
   * nothing about who it happens to. Same rule, same sweep, same everybody.
   */
  private ghostSeatFirstSeen: Map<string, number> = new Map();

  /** A bust that the sweep has not resolved within this long is escalated. */
  private static readonly GHOST_SEAT_ESCALATE_MS = 120_000;

  protected async releaseDeadTournamentSeats(): Promise<void> {
    const tournamentId = this.tableInfo?.tournament_id;
    if (!tournamentId || this.seatedPlayers.length === 0) return;

    const seatedIds = this.seatedPlayers.map((p) => p.user_id);
    const { data: entrants, error } = await supabase
      .from('tournament_players')
      .select('user_id, status')
      .eq('tournament_id', tournamentId)
      .in('user_id', seatedIds);

    // An unreadable roster is UNKNOWN, not "everybody is fine". Releasing a
    // chair on a failed read would take a live player off the felt mid-hand,
    // which is far worse than a ghost that waits one more tick.
    if (error || !entrants) return;

    const statusById = new Map<string, string>();
    for (const row of entrants) {
      const r = row as { user_id?: string; status?: string };
      if (r.user_id) statusById.set(r.user_id, r.status || '');
    }

    const now = Date.now();
    const stillSeated = new Set<string>();
    const released: string[] = [];

    for (const player of this.seatedPlayers) {
      const status = statusById.get(player.user_id);
      stillSeated.add(player.user_id);

      // ── CASE 1: the field says they are out, and the chair proves nobody
      // told the table. Release it. This is the lost-release case: the status
      // write committed and releaseTournamentSeat() did not, or the process
      // died between the two.
      if (status === 'eliminated' || status === 'winner') {
        await markSeatAsLeft(this.tableId, player.user_id, player.seat_number);
        this.disconnectEngine.unregisterPlayer(this.tableId, player.user_id);
        this.timeBankEngine.removePlayer(this.tableId, player.user_id);
        this.straddleEngine.removePlayer(this.tableId, player.user_id);
        this.preActionEngine.removePlayer(this.tableId, player.user_id);
        this.ghostSeatFirstSeen.delete(player.user_id);
        released.push(player.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Ghost seat released: ${player.username} is ${status} but was still holding seat ${player.seat_number}`
        );
        continue;
      }

      // ── CASE 2: no roster row at all for a seated player. They are not in
      // this tournament, so the seat is a leftover from a table this id was
      // recycled through. Same release, different cause.
      if (status === undefined) {
        await markSeatAsLeft(this.tableId, player.user_id, player.seat_number);
        this.disconnectEngine.unregisterPlayer(this.tableId, player.user_id);
        this.timeBankEngine.removePlayer(this.tableId, player.user_id);
        this.straddleEngine.removePlayer(this.tableId, player.user_id);
        this.preActionEngine.removePlayer(this.tableId, player.user_id);
        this.ghostSeatFirstSeen.delete(player.user_id);
        released.push(player.user_id);
        reportError(
          new Error(
            `[ServerTableEngine:${this.tableId}] seat held by ${player.user_id.slice(0, 8)} who has no row in tournament ${tournamentId.slice(0, 8)} — released`
          ),
          'ServerTableEngine.tournament_seat_without_entrant'
        );
        continue;
      }

      // ── CASE 3: busted, still 'playing'. NOT ours to resolve — the sweep
      // owes them a finishing place and possibly a prize, and it may simply
      // be a few seconds behind, or they may be inside their rebuy window.
      // But a bust that nobody has resolved in two minutes is the reported
      // defect, and it should be loud rather than silent. Escalated once, to
      // the same watchdog that already catches horse_seat_unactable.
      if (player.stack <= 0) {
        const firstSeen = this.ghostSeatFirstSeen.get(player.user_id);
        if (firstSeen === undefined) {
          this.ghostSeatFirstSeen.set(player.user_id, now);
        } else if (
          now - firstSeen >= ServerTableEngineDealing.GHOST_SEAT_ESCALATE_MS &&
          now - firstSeen < ServerTableEngineDealing.GHOST_SEAT_ESCALATE_MS + 60_000
        ) {
          reportError(
            new Error(
              `[ServerTableEngine:${this.tableId}] ${player.username} has held seat ${player.seat_number} at 0 chips for ${Math.round(
                (now - firstSeen) / 1000
              )}s in tournament ${tournamentId.slice(0, 8)} and is still 'playing' — the elimination sweep is not reaching this table`
            ),
            'ServerTableEngine.tournament_ghost_seat'
          );
        }
      } else {
        this.ghostSeatFirstSeen.delete(player.user_id);
      }
    }

    // A chair freed above has to be free for the hand about to be dealt, not
    // the one after it — the same reason the add-on sweep runs where it does.
    if (released.length > 0) {
      this.seatedPlayers = this.seatedPlayers.filter((sp) => !released.includes(sp.user_id));
    }

    // Anybody who left the table by any other route stops being tracked, or
    // this map grows for the life of the process.
    for (const [userId] of this.ghostSeatFirstSeen) {
      if (!stillSeated.has(userId)) this.ghostSeatFirstSeen.delete(userId);
    }
  }
}
