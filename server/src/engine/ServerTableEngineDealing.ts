/**
 * ServerTableEngine, layer 5/8 — the dealing loop, blinds refresh, hand deal, hole-card delivery.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { noteFire } from './BrainTelemetry.js';
import { resolvePersona, wantsStraddle } from './HorsePersona.js';
import { HandController } from './HandController.js';
import { getTournamentBrainContextSnapshot } from '../services/TournamentBrainContext.js';
import { captureHandSeatGenerations } from './handSeatGeneration.js';
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
  readClubChipBalances,
} from '../services/supabase.js';
import { cashMinBuyIn } from '../config/cashBuyIn.js';
import {
  atRebuyStopLoss,
  horseRebuyAmount,
  rebuyStopLossReached,
} from '../services/HorseRebuyPolicy.js';
import type { SeatPlayer, GameVariant, HandConfig, HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { holeCardCount, deckSizeFor, maxSeatsFor } from './VariantRules.js';
// The VARIANT'S OWN seat ceiling, which is a house rule and not deck
// arithmetic — PLO6 is 6-max and PLO5 is 7-max by Dan's ruling, both tighter
// than the deck alone allows. maxSeatsFor above answers "what fits"; this
// answers "what is permitted", and a bomb-pot variant override must satisfy
// both. See the override block below.
import { maxSeatsForVariant } from '../config/tableSeating.js';
import {
  bombPotSettingsFromTable,
  resolveBombPotVariant,
  type BombPotDecision,
} from './BombPotScheduler.js';

import { ServerTableEngineRunout } from './ServerTableEngineRunout.js';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { secureRandomInt } from './CryptoRandom.js';
import { drawFirstButtonSeat, headsUpButtonSeat } from './headsUpButton.js';
import {
  HAND_COMPLETION,
  handCompletionHoldMs,
  boardClearMs,
} from '../config/handCompletionSpec.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { nextHandGap } from './nextHandGapRecorder.js';
import { currentTournamentDataAuthority } from '../services/supabase/dataActorContext.js';

/**
 * The number of award groups the CLIENT will animate for this hand.
 *
 * Must stay in step with TablePage's `buildAwardGroups`, which groups the
 * pot_awards payload by (board, pot index, hi/lo half) and fires one chip fan
 * plus one "+N" float per group, POT_AWARD_STAGGER_MS apart. The engine needs
 * the COUNT (not the contents) so its post-hand hold covers the last group.
 */
function countAwardGroups(
  awards: Array<{ potIndex: number; low: boolean; board?: number; amount: number }>
): number {
  const keys = new Set<string>();
  for (const a of awards) {
    // A zero-amount entry animates nothing, so it must not lengthen the hold.
    if (!(a.amount > 0)) continue;
    keys.add(`${a.board ?? 1}:${a.potIndex}:${a.low ? 'lo' : 'hi'}`);
  }
  return Math.max(1, keys.size);
}
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
        // There is no time-based escape from settlement. Retry slices preserve
        // process liveness; settlementAgeMs independently exposes a blocked hand.
        /* THE BARRIER IS RE-READ AFTER EVERY WAIT (chip standard 2026-09-04).
           handleHandCompleteEvent assigns the barrier and settleCompletedHand
           later REASSIGNS it to include the postHandTasks chain (sync_stacks,
           rake, BBJ, pending add-ons, horse rebuys). This loop captured the
           field once, waited on that one promise, and nulled the field - so
           when the reassignment landed after the capture, the loop walked on
           while the chain was still running, reloaded seats from the database
           before step 8e had credited the pending add-ons, and the next hand
           dealt from the pre-credit stacks. The hand write then erased the
           credit. `while` instead of `if`, and the field is only cleared when
           it still holds the promise that was just awaited. */
        while (this.postHandTasksPromise) {
          this.setLoopPhase('await_post_hand_tasks');
          const pending = this.postHandTasksPromise;
          /* ═══ WAIT WITH LIVENESS, DO NOT WALK AWAY (2026-08-31) ═══════════
             This used to race the settlement against a single 45s timer and
             then PROCEED, with the settlement still running in the background
             against the per-hand capture fields the very next dealHand()
             blanks. Under a degraded database that is not a liveness save, it
             is record corruption on a schedule: hand N's history written from
             hand N+1's empty fields (the rake-law audit's board_not_recorded
             warnings are that corpse). The 45s cap existed only because this
             await never called markProgress() and the idle watchdog would
             kill the engine - so keep the engine provably alive in 15s
             slices instead, and simply do not deal the next hand until this
             hand's money and record are done. A table on a database too sick
             to settle for five full minutes has no business dealing anyway;
             keep waiting and expose its age in the settlement health signal. */
          const sliceMs = 15_000;
          let waited = 0;
          let settled = false;
          while (!settled && this.running) {
            settled = await Promise.race([
              pending.then(() => true),
              new Promise<boolean>((r) => {
                const t = setTimeout(() => r(false), sliceMs);
                (t as { unref?: () => void }).unref?.();
              }),
            ]);
            if (!settled) {
              waited += sliceMs;
              this.markProgress();
            }
          }
          /* There is no elapsed-time escape from an authoritative settlement.
             A slow database may park one table, but time cannot turn an
             uncommitted hand into permission to deal another one.  The only
             non-success exit is an explicit engine stop, whose drain owns the
             still-in-flight promise. */
          if (!settled && !this.running) {
            /* The engine is stopping with this hand's settlement still in
               flight. That is NOT this loop's problem to report - it is the
               drain's problem to WAIT for, and GameServer.drainHands() now
               refuses to call this table parked until the promise settles
               (hasSettlementInFlight). Say it once, at info, so the shutdown
               is legible in the log, and let the drain do its job. */
            console.log(
              `[ServerTableEngine ${this.tableId}] stopping with hand #${this.handCount} ` +
                `settlement in flight after ${waited / 1000}s - the drain owns it from here`
            );
            // Do not erase either ownership marker. stop() captured this loop
            // before publishing the terminal fence and will join the exact
            // settlement before releasing the table to another generation.
            return;
          }
          if (this.postHandTasksPromise === pending) this.postHandTasksPromise = null;
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
        // PHASE 2 (2026-09-02): THE BREAK IS ITS OWN AUTHORITY HERE TOO.
        // #2537 split the break out of hand-for-hand: pauseForMaintenance sets
        // maintenancePaused + holdBeforeNextHand and deliberately NOT
        // handForHandPaused. It wired the new flag into the start-up wait loop
        // and into isPausedByDesign() (#2695), and into neither of the two
        // gates in THIS loop - so a table that was dealing never parked, and
        // only quiet tables did. Measured 21:53-21:57 on 34c6194b (which has
        // #2695): 722 / 738 / 663 / 423 hands a minute straight through the
        // last-hand call, against 161 / 5 / 0 on the last build that parked
        // via hand-for-hand. Same shape as the start-up loop gate on the base
        // class, on purpose.
        if (
          this.maintenancePaused ||
          this.finalTableDealPaused ||
          this.terminalCloseoutPaused ||
          this.tournamentMovePauseOwners.size > 0 ||
          (this.handForHandPaused && this.holdBeforeNextHand)
        ) {
          this.setLoopPhase('parked_for_pause');
          // 2026-09-04 (audit item 2): the last word on presence before the
          // process dies. Awaited, budgeted by the write itself (one upsert),
          // and never thrown - see persistPresenceForRestart.
          if (this.maintenancePaused) await this.persistPresenceForRestart('parked');
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
        this.seatedPlayers = await this.prepareNextHand();
        // Restart fidelity: apply persisted is_sitting_out to seats the engine
        // has not seen yet. The start-up loop calls this too, but it breaks the
        // moment enough players are seated and never runs again — so a player
        // who was mid-buy-in at boot, or who joined during the wait, would be
        // dealt in despite the database saying they are sitting out.
        //
        // PRESENCE FOLLOWS THE PLAYER (2026-09-05): a mover's presence is
        // adopted BEFORE the sit-out restore, because that restore registers
        // the player and restoreFsmStates never clobbers a live entry. See
        // ServerTableEngineBase.adoptMovedPresence.
        this.adoptMovedPresence();
        this.restoreSitOutsFromSeats();

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
        // A SEAT CHANGED (2026-09-05): an arrival or a departure seen in the
        // rows this iteration wakes the game's ClusterController tick.
        let rosterChanged = false;
        if (this.dealingLoopFirstIteration) {
          // Dan 2026-08-30: BEFORE the veteran seeding below, because that
          // seeding is what used to destroy the hold. Both halves of the fix
          // live in these few lines — the hold comes back, and the player
          // holding it is excluded from `dealtInUserIds`.
          this.restoreEntryHoldsFromSeats();
          for (const p of this.seatedPlayers) {
            this.knownPlayerIds.add(p.user_id);
            // A HELD PLAYER IS NOT A VETERAN. They have never been dealt a
            // hand at this table — that is what the hold means — so seeding
            // them here made them button-eligible on what is really their
            // first hand, which is exactly the rule "a new player never gets
            // the button when sitting down" exists to prevent. The seeding
            // itself is right for everyone else: they were genuinely playing
            // before the restart, and without it buttonEligible() falls back
            // to the whole roster for a full orbit after every deploy.
            if (this.waitingForBB.has(p.user_id)) continue;
            /* A ROW HOLD THE RESTORE NEVER SAW (2026-09-09, must-move audit).
               restoreEntryHoldsFromSeats runs ONCE per process, and the
               start-up wait loop runs it first - so a chair that arrived
               while the table was still waiting for players (a must-move or a
               balance move landing `entry_hold = 'moved'`, a seat change
               landing `'waiting'` + agreed) was never restored and was then
               seeded here as a veteran with its row marker left standing. The
               marker is a lie the moment the deal includes them, and it is a
               lie that costs money at the next :55 restart: the restore reads
               'waiting' on a player who has been dealt for an hour and holds
               them for the big blind again. This first deal is the table's
               first hand, so the blinds post by position and nobody enters
               behind them - the marker is cleared, and the chair is NOT
               seeded as a veteran, because it has never been dealt a hand
               here ("a new player never gets the button"). A 'posting' hold
               the restore DID see is left alone: its billing clears it. */
            const rowHold = (p as { entry_hold?: string | null }).entry_hold ?? null;
            if (rowHold !== null && !this.postingBBToEnter.has(p.user_id)) {
              this.persistEntryHold(p.user_id, { hold: null, agreed: false });
              continue;
            }
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
              rosterChanged = true;
              // CHIP CONTINUITY: a fresh arrival is a fresh session, even if
              // the mirror wrote this player off a moment ago.
              this.chipContinuity.welcome(p.user_id);
              const entryHold = (p as { entry_hold?: string | null }).entry_hold ?? null;
              const entryAgreed =
                (p as { entry_post_agreed?: boolean | null }).entry_post_agreed === true;
              if (!this.isTournamentTable() && entryHold === 'moved') {
                // MOVED BY THE GAME (Dan 2026-09-05): a must-move or a break
                // brought them here. "IF THEY ARE AUTO MOVED, NO POST ... FREE
                // HANDS UNTIL BB BECAUSE THEY ALREADY POSTED AT THE PREVIOUS
                // TABLE." Not registered as waiting, nothing owed: they are in
                // the next deal and take the big blind when it comes round.
                // Not a veteran either (dealtInUserIds is filled by the deal),
                // so the button cannot land on them before they have played a
                // hand here. The marker is cleared now; a restart between here
                // and the deal reads a plain seat, which is the same thing.
                this.persistEntryHold(p.user_id, { hold: null, agreed: false });
                console.log(
                  `[ServerTableEngine:${this.tableId}] ${p.user_id.slice(0, 8)} arrived by must-move: dealt in, nothing to post`
                );
              } else if (!this.returningFromSitout.has(p.user_id) && !this.isTournamentTable()) {
                this.registerWaitForBB(p.user_id);
                if (entryHold === 'waiting' && entryAgreed) {
                  // A SEAT CHANGE ARRIVES (Dan 2026-09-05): "SEAT CHANGE ALWAYS
                  // RE POSTS THE BB WHEN GETTING TO A NEW TABLE." The executor
                  // wrote the agreement on the chair; the same replay that
                  // honours a tapped POST honours it - the live big blind on
                  // the next deal, held until clear if they landed between the
                  // button and the blind.
                  this.postBBWhenClear.add(p.user_id);
                  this.persistEntryHold(p.user_id, { hold: 'waiting', agreed: true });
                }
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
            rosterChanged = true;
            this.knownPlayerIds.delete(id);
            this.waitingForBB.delete(id);
            // A held swap side that is gone from the roster: the other table
            // landed the swap. Nothing to hold any more.
            this.heldForSwap.delete(id);
            // B2: a player who has left owes this table nothing. If they come
            // back they are a fresh arrival and get classified again.
            this.mustPostBB.delete(id);
            /* NO STALE PRESENCE ON THE OLD TABLE (2026-09-09, must-move
               audit). A cash player can leave a roster through a path this
               engine never ran: the OTHER table's transaction landing a swap
               (the partner never executes here), the tab-close beacon
               (player_leave_table), the controller cashing out a second chair
               on a breaking table. Every leave this engine DOES run tears the
               per-player mirrors down (settlement step 6, the idle sweep, the
               move executor); this one left them standing, so the departed
               player kept a presence entry the heartbeat checker marked
               disconnected on a chair nobody sat in, a time bank, a straddle
               and a pre-action - and getFsmStatesForTable wrote the phantom
               into every snapshot and into the :55 park. Same teardown as the
               other leave paths.

               CASH ONLY, and the reason changed at the 2026-09-10 merge. It
               used to be "a tournament chair has its own engine-side release";
               that watcher is GONE. Tournament seat release now has ONE
               transactional authority and it is in the database: the accepted
               hand closes the exact seat generation in the same transaction as
               the zero stack and the knockout evidence
               (20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt),
               and every elimination holds a scoped seat-exit capability
               (20260909014545_tournament_seat_exits_stay_inside_tournament_authority).
               An engine-side poll or repair here would be exactly the split
               transaction that removal closed, and
               TournamentGhostSeat.law pins this file against re-growing one.
               So: this teardown stays cash-only, and a tournament seat that
               closes is simply absent from the next loadSeatedPlayers. */
            if (!this.isTournamentTable()) {
              this.disconnectEngine.unregisterPlayer(this.tableId, id);
              this.timeBankEngine.removePlayer(this.tableId, id);
              this.straddleEngine.removePlayer(this.tableId, id);
              this.preActionEngine.removePlayer(this.tableId, id);
              this.leaveHeldByClock.delete(id);
              /* `forcedLeaves` is deliberately absent: main retired that map
                 at the 2026-09-10 merge (the leave path is occupancy-keyed
                 now), and this list is exactly settlement step 6's teardown
                 minus it. `chipContinuity` is absent for a different reason -
                 its own reconcile drops any row whose player is no longer in
                 the roster, which is the very condition we are in here. */
            }
          }
        }
        if (rosterChanged) this.wakeClusterGame('seat_change');
        // POST-TO-ENTER RACE FIX 2026-08-27: a queued intent from someone no
        // longer seated (or never seated) is dead weight - drop it.
        for (const id of this.pendingPostToEnter) {
          if (!currentIds.has(id)) this.pendingPostToEnter.delete(id);
        }
        // Dan 2026-08-29: and the same for a standing agreement to post. It is
        // an answer about ONE seat at ONE table; a player who has left has
        // nothing to agree to, and coming back makes them a fresh arrival who
        // is asked again. The replay below prunes this too, but doing it here
        // as well keeps every "player is gone" rule in one place rather than
        // relying on the replay having run.
        for (const id of this.postBBWhenClear) {
          if (!currentIds.has(id)) this.postBBWhenClear.delete(id);
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
              // Dan 2026-08-30: and the seat owes nothing from here on, so the
              // persisted hold goes with it. `agreed: false` clears any
              // standing post agreement in the same write — the big blind
              // reached them first, so there is nothing left to agree to and
              // billing it again would be a second blind.
              this.postBBWhenClear.delete(userId);
              this.persistEntryHold(userId, { hold: null, agreed: false });
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
        // A STANDING AGREEMENT TO POST, REPLAYED UNTIL THE SEAT CLEARS
        // (Dan 2026-08-29 — see postBBWhenClear in ServerTableEngineBase)
        //
        // Unlike pendingPostToEnter above, membership is NOT consumed on the
        // attempt. A player put here tapped Post Big Blind from the seat the
        // small blind or the button was about to reach; that is refused, and
        // must stay refused, so consuming the intent on the first pass would
        // throw the answer away again and put us back at "it makes you hit
        // the button again". It is retried every pass instead and removed by
        // `postBBToEnter` itself, on exactly two outcomes:
        //
        //   - the seat cleared and the post went through (billed one live big
        //     blind through postingBBToEnter, same as a live tap);
        //   - the big blind reached them first, the release above took them
        //     out of waitingForBB, and they post it as their own blind. The
        //     agreement is dropped rather than charged a second time.
        //
        // Ordering matters and is deliberate: this sits AFTER the natural-BB
        // release for that second case, and after the registration pass so a
        // brand-new joiner is already in waitingForBB by the time it runs.
        //
        // Positions are read fresh inside postBBToEnter each pass, so this
        // grants nothing the player could not have got by tapping again at
        // this exact moment. It only spares them the tapping.
        if (this.postBBWhenClear.size > 0) {
          for (const userId of Array.from(this.postBBWhenClear)) {
            const stillSeated = this.seatedPlayers.some((s) => s.user_id === userId);
            if (!stillSeated || !this.waitingForBB.has(userId)) {
              /* Two ways out that are not a post, and both end the agreement
                 HERE rather than inside postBBToEnter, so this loop can never
                 re-add its own entry:

                 - LEFT THE TABLE. An agreement cannot outlive the seat it was
                   made from; the next occupant answers for themselves.
                 - ALREADY RELEASED. The big blind reached them (the block
                   above) and they post it as their own blind, so there is
                   nothing left to agree to. Routing this through
                   postBBToEnter instead would fall into queuePostToEnter,
                   which re-queues an unknown player and would leave this set
                   populated forever. */
              this.postBBWhenClear.delete(userId);
              continue;
            }
            this.postBBToEnter(userId);
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
              const cashedOutIds = await this.takePreparedLeavePending();
              // Same per-player teardown settlement does, or every leaver
              // strands an FSM entry, a time bank and a pre-action behind them.
              for (const { userId: leftUserId, occupancyId } of cashedOutIds) {
                const current = this.seatedPlayers.find((sp) => sp.user_id === leftUserId);
                if (current && current.occupancy_id !== occupancyId) continue;
                this.disconnectEngine.unregisterPlayer(this.tableId, leftUserId);
                this.timeBankEngine.removePlayer(this.tableId, leftUserId);
                this.straddleEngine.removePlayer(this.tableId, leftUserId);
                this.preActionEngine.removePlayer(this.tableId, leftUserId);
                this.leaveHeldByClock.delete(leftUserId);
                this.chipContinuity.forget(leftUserId);
              }
              if (cashedOutIds.length > 0) {
                this.seatedPlayers = this.seatedPlayers.filter(
                  (sp) =>
                    !cashedOutIds.some(
                      (left) => left.userId === sp.user_id && left.occupancyId === sp.occupancy_id
                    )
                );
              }
            })()
          );
        }

        /* DEFERRED SIT-OUTS ORPHANED BY A HAND THAT NEVER SETTLED (2026-08-28).
         *
         * Sitting out DURING a hand is deferred: ServerTableEngineSeating.sitOut()
         * puts the id in `pendingSitOut` and settlement step 5.9 drains it. That
         * set had exactly one drain, so it shared the orphan class the add-on and
         * leave_pending sweeps immediately above were built for: a hand killed by
         * HAND_SAFETY_TIMEOUT nulls the controller and resolves WITHOUT running
         * settlement, and a hand abandoned when the table drops below the minimum
         * never settles either.
         *
         * The player's request was then silently dropped. They believed they were
         * sitting out — the client had already switched to the sat-out UI on the
         * handler's `{ success: true }` — while the engine had no sit-out state,
         * no clock, and therefore no eviction. The seat was held indefinitely.
         * That is the same reported symptom as the registration gap in
         * DisconnectEngine.sitOut(), reached by a second route, which is why both
         * are closed in one change.
         *
         * Guarded on there being no live hand: draining mid-hand is precisely
         * what the deferral exists to prevent. Both cash and tournament — a
         * tournament sit-out is never evicted, but it still has to be TRUE, or
         * the player is dealt in and blinded off while their screen says
         * otherwise. */
        if (this.handController === null && this.pendingSitOut.size > 0) {
          for (const userId of this.pendingSitOut) {
            this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
            console.log(
              `[ServerTableEngine:${this.tableId}] Deferred sit-out applied by idle sweep ` +
                `(hand never settled): ${userId}`
            );
          }
          this.pendingSitOut.clear();
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
            !this.waitingForBB.has(p.user_id) &&
            // A swap side holding for its partner's table (Dan 2026-09-05).
            !this.isHeldForSwap(p.user_id)
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
          /* THE HUMAN HALF OF THE SAME SWEEP (Dan 2026-08-28): "MAKE SURE THAT
             THE USER GETS REMOVED FROM THE TABLE AS SOON AS THEY HAVE NO CHIPS."
             Deliberately adjacent to the horse recovery above and running on the
             same tick, because CLAUDE.md 10.5 requires the two to be identical
             from the outside — a felt that clears a busted horse's seat promptly
             and leaves a busted human's sitting there is a tell either way round.

             HERE rather than beside the rebuy pause at the end of the hand, and
             the reason is worth writing down: settlement fires postHandTasks
             WITHOUT awaiting it, and postHandTasks commits the accepted hand. So
             at the end of a hand the busted stack may not have reached the
             database yet, and a check there would read a stale non-zero stack
             and skip the removal — permanently, because on the next pass the
             player is no longer in `activePlayers` to be noticed. The top of the
             loop is AFTER `await postHandTasksPromise` and after
             loadSeatedPlayers, so `this.seatedPlayers` is freshly authoritative.
             The rebuy decision window has already opened by then, at the
             end of the previous hand. */
          await this.withStepBudget(
            'stand_up_busted_players',
            ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
            this.standUpBustedCashPlayers()
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
          /* NOBODY WAITS FOR A BLIND THAT CANNOT ARRIVE (2026-09-11).
             `activePlayers` above excludes a player waiting for the big
             blind, so a table whose seats are mostly waiters reads as short
             and sleeps here - and sleeping is what stops the big blind that
             would have released them. Seven live must-move tables were shut
             that way, one for an hour and a half with six funded seats on it.
             See releaseWaitersNoBlindCanReach: it fires only when letting
             everyone in actually starts the game, and the released seat is
             still not a veteran, so the button rule is untouched. */
          this.releaseWaitersNoBlindCanReach();
          // MUST-MOVE (Slice 2; moved here 2026-09-05): a table with no hand
          // to finish is at a hand boundary all the time, so every pending
          // move lands now, announced or not. This used to run in the
          // leave_pending sweep above, on EVERY iteration - which executed a
          // move milliseconds after the deal had announced "Moving After
          // This Hand", before the hand.
          await this.executeIdleSeatMoves();
          await this.withStepBudget(
            'idle_cluster_closed',
            ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
            this.stopIfClusterTableClosed()
          );
          if (!this.lifecycleCanMutate()) return;
          // A completed short-handed sweep is real progress just like the
          // startup waiting sweep. Stamp after all awaited idle work so a
          // hung read or move remains visible to the existing watchdog.
          this.markProgress();
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

        // MUST-MOVE (Slice 2): a player with a planned move is told now, once,
        // that they move after this hand - HERE, immediately before the deal,
        // so the notice only ever speaks of a hand that is about to be dealt
        // (2026-09-05: it used to run at load_seats, on idle iterations too).
        // Bounded like every other step.
        await this.withStepBudget(
          'announce_seat_moves',
          ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
          this.announcePendingSeatMoves()
        );
        if (this.terminalCloseoutPaused || this.tournamentMovePauseOwners.size > 0) {
          await this.awaitPauseGate();
          if (!this.running) break;
          continue;
        }

        // THE REST ENDS HERE (Dan 2026-09-07). Everything above this line
        // since the hand-free broadcast - the settlement barrier, the roster
        // read, the sweeps, the seat-move notice - ran under the armed rest;
        // this waits out whatever of it is left, records how long the felt
        // actually waited, and only then deals.
        await this.awaitNextHandRest();
        // A pause may arrive while the roster, rest or blind read is pending.
        // Return through the owner's gate before using the prepared hand.
        if (this.isNextHandPaused()) {
          if (!this.adminPauseLock && !this.maintenanceLock) await this.awaitPauseGate();
          if (!this.running) break;
          continue;
        }

        /* The event loop may have resumed after the local lease deadline but
           before its raw timeout callback got CPU. Re-prove authority at the
           sole new-hand edge; a stale dealer cannot allocate a hand number,
           move the button, post blinds, or deal one more card. */
        if (!this.lifecycleCanMutate()) return;
        if (this.terminalCloseoutPaused || this.tournamentMovePauseOwners.size > 0) {
          await this.awaitPauseGate();
          if (!this.running) break;
          continue;
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
        if (
          (this.handForHandPaused ||
            this.maintenancePaused ||
            this.finalTableDealPaused ||
            this.terminalCloseoutPaused ||
            this.tournamentMovePauseOwners.size > 0) &&
          this.running
        ) {
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
            // MULTI-POT FIX 2026-08-28: how many award groups the client is
            // about to animate, counted the SAME way it groups them — one per
            // (board, pot, hi/lo half) that actually pays. Without this the
            // hold was flat and the last winner's "+N" float was cut off by
            // the board clear on every side pot and every hi-lo split.
            potAwardGroups: countAwardGroups(this.currentHandPerPotAwards),
          });

          // Phase 1: the completion sequence actually plays out. When this
          // sleep ends the hand IS completed in Dan's 2026-08-21 sense: the
          // winning hand shown, the pot pushed with its total, the cards
          // mucked.
          this.setLoopPhase('post_hand_hold');
          await this.sleep(resultDisplayMs);
          // Phase 2: the hand-free broadcast. Clients animate the board clear
          // from it, and it is what makes the Rabbit Hunt button visible.
          this.broadcastCurrentState(); // Sends clean state (no hand in progress)
          // Phase 3: THE REST (Dan 2026-09-07: "THE NEXT HAND 2 SECONDS AFTER
          // THE HAND IS COMPLETED"). One number, HAND_COMPLETION.NEXT_HAND_REST_MS,
          // between completion and the next deal. The board clear
          // (boardClearMs, ~0.4-0.6s), the Rabbit Hunt window (Dan 2026-09-05,
          // RABBIT_HUNT_WINDOW_MS, the same number) and every piece of
          // next-hand bookkeeping live INSIDE it.
          //
          // It is ARMED here and AWAITED immediately before dealHand
          // (awaitNextHandRest), not slept here. Before 2026-09-07 the engine
          // slept the clear and the window at this point and only THEN went to
          // the top of the loop to wait for settlement, reload the roster, run
          // the seat sweeps and allocate a hand number - a chain of PostgREST
          // round trips at the 250-700ms each really costs from the engine
          // box. Measured on production that evening: p50 11.2s, p90 20.6s
          // from one hand's end to the next hand's start, against a designed
          // 2.25-2.65s. Arming the deadline first lets all of that run under
          // the rest, and the felt waits for whichever finishes last.
          //
          // Unconditional, on every hand, with nothing to branch on between
          // the broadcast and the arming - a rest that varied with the deck
          // would tell the table what the deck still held (CLAUDE.md 10.5:
          // timing is part of the treatment). The per-user "hide the button"
          // setting does not shorten it. boardClearMs is the floor, so the
          // clear animation can never outlive the rest whatever the constants
          // are set to.
          this.armNextHandRest(
            Math.max(HAND_COMPLETION.NEXT_HAND_REST_MS, boardClearMs(wentToShowdown))
          );

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
              /* CAN THEY ACTUALLY COME BACK? (Dan 2026-08-28)
               *
               * "IN A CASH GAME, CHECK IF THEY HAVE ENOUGH CHIPS TO REBUY, (40
               * BB MINIMUM). IF THEY DO, YOU GIVE THEM THE 5 SECOND PERIOD TO
               * REBUY OR DECLINE."
               *
               * This was an unconditional `true`, so the felt stopped for five
               * seconds on every cash bust including the ones where the player
               * had nothing left to buy in with. That is a stall the table pays
               * for on behalf of a decision nobody can make — and, per the
               * rhythm argument in CLAUDE.md 10.5, a pause that happens when
               * nothing can come of it is as much of a tell as a missing one.
               *
               * An UNREADABLE balance counts as CAN afford. Erring toward the
               * pause costs five seconds; erring away from it takes the rebuy
               * window off somebody who had the money, and then
               * standUpBustedCashPlayers below removes them for it. Same
               * fail-open reasoning as the tournament branch underneath. */
              needsRebuyPause = await this.anyBustedPlayerCanAffordARebuy(justBustedPlayers);
              if (!needsRebuyPause) {
                console.log(
                  `[ServerTableEngine:${this.tableId}] No rebuy pause - none of ` +
                    `${justBustedPlayers.map((p) => p.username).join(', ')} can cover this ` +
                    `table's minimum buy-in`
                );
              }
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
                  /**
                   * Dan 2026-08-30, verbatim: "REBUYS IN A TOURNAMENT SHOULD
                   * NOT PAUSE THE ACTION." The felt rolls on; the busted
                   * player's DECISION WINDOW lives in the elimination sweep
                   * now (REBUY_DECISION_GRACE_MS in
                   * TournamentManagerEliminations), and a landed rebuy
                   * re-seats them wherever the balancer most needs a player —
                   * same table and seat included. The window arithmetic above
                   * is still computed so the log says WHY nothing paused.
                   * The 5-second pause remains CASH-ONLY (section 10.5: same
                   * pause for horse and human at cash tables).
                   */
                  if (windowOpen && poolOpen) {
                    console.log(
                      `[ServerTableEngine:${this.tableId}] Tournament bust - rebuy window open, table does NOT pause (Dan 2026-08-30); elimination grace covers the decision`
                    );
                  }
                }

                /**
                 * THE BLOCK BELOW USED TO SIT INSIDE THE REBUY BRANCH ABOVE,
                 * AND THAT MADE IT UNREACHABLE FOR MOST OF THE PRODUCT (Dan
                 * 2026-09-05: "IM SURE THIS SAME BUG EXISTS IN ALL THE OTHER
                 * SEATS FOR MTT, SPINS AND HEADS UP AS WELL. CHECK FOR ALL
                 * SIMILAR BUGS GLOBALLY.").
                 *
                 * The gate it sat behind is `is_rebuy || is_reentry`. spinSpec
                 * and headsUpSpec declare neither, and a freezeout MTT declares
                 * neither by definition - so a busted Spin, Heads-Up or
                 * freezeout seat was NEVER vacated here. It sat on the felt
                 * until the former polling sweep noticed it later, which is
                 * exactly the lingering
                 * this block was written to end.
                 *
                 * The rebuy arithmetic has not moved and is still gated, because
                 * it is genuinely about rebuy events. Vacating a busted seat is
                 * not: a seat with no chips in it is finished at every format.
                 */

                // The hand-stack RPC commits stack=0, tournament_players=0,
                // the physical seat exit and the table count in one database
                // transaction. The engine only publishes that committed fact
                // and wakes the rebuy/elimination state machine; it never
                // performs a second compensating seat or roster write.
                for (const player of justBustedPlayers) {
                  if (!player.user_id) continue;
                  this.hub?.emitEvent(this.tableId, {
                    type: 'seat_left',
                    table_id: this.tableId,
                    user_id: player.user_id,
                    reason: 'busted_awaiting_rebuy_decision',
                    timestamp: Date.now(),
                  } as never);
                }

                if (this.handCompleteCallback && justBustedPlayers.length > 0) {
                  try {
                    this.handCompleteCallback(
                      this.tableId,
                      justBustedPlayers
                        .filter((player) => !!player.user_id)
                        .map((player) => ({ user_id: player.user_id!, stack: 0 }))
                    );
                  } catch (wakeErr) {
                    reportError(wakeErr, 'ServerTableEngine.busted_fallback_wake_failed', {
                      tableId: this.tableId,
                    });
                  }
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
                // Tournament tables never pause for rebuys (Dan 2026-08-30);
                // an unreadable window costs a log line, not a stall. The
                // elimination-side grace is the fail-open that protects the
                // player now.
                console.error(
                  `[ServerTableEngine:${this.tableId}] Rebuy-window read failed (tournament - no pause either way):`,
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
        // BUG-error reporting-7463185461 FIX: 'fetch failed' is the Node.js wording for
        // a transient Supabase network blip — same as browser's 'Failed to fetch'.
        // Both must be listed or they increment consecutiveErrors and fire error reporting.
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
          reportError(
            err,
            `ServerTableEngine.${this.tableId}.deal_error_attempt_${this.consecutiveErrors}`
          );
        } else {
          console.warn(
            `[ServerTableEngine:${this.tableId}] Transient network error during deal cycle:`,
            errMsg
          );
        }

        if (this.consecutiveErrors >= 10) {
          reportError(
            new Error(`[ServerTableEngine:${this.tableId}] Too many errors - stopping`),
            `ServerTableEngine.${this.tableId}.too_many_errors_stopping`
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

  /** Read fresh hand inputs only after the settlement and pause gates. */
  /**
   * THE REST (Dan 2026-09-07). Armed at the hand-free broadcast, awaited
   * immediately before the next deal. See the note where it is armed.
   */
  protected armNextHandRest(restMs: number): void {
    const now = Date.now();
    this.nextHandNotBeforeMs = now + restMs;
    this.lastCompletionAtMs = now;
    this.gapPhaseMs = {};
    this.gapPhaseName = this.loopPhase;
    this.gapPhaseSinceMs = now;
    this.gapHadRebuyPause = false;
    this.gapSawIdle = false;
  }

  protected async awaitNextHandRest(): Promise<void> {
    await this.settlePreparedHandNumber();
    if (this.nextHandNotBeforeMs !== null) {
      const remaining = this.nextHandNotBeforeMs - Date.now();
      if (remaining > 0) {
        this.setLoopPhase('next_hand_rest');
        await this.sleep(remaining);
      }
      this.nextHandNotBeforeMs = null;
    }
    // A level may advance while the prepared roster waits under the rest.
    // Read the tournament stakes here, before the caller rechecks its lease
    // and pause gates. This replaces the earlier prefetched blind read.
    if (this.isTournamentTable()) {
      await this.withStepBudget(
        'refresh_blinds',
        ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
        this.refreshBlinds()
      );
    }
    if (this.lastCompletionAtMs !== null && !this.gapSawIdle) {
      const now = Date.now();
      this.accrueGapPhase(now);
      nextHandGap.record({
        tableId: this.tableId,
        gapMs: now - this.lastCompletionAtMs,
        phases: this.gapPhaseMs,
        rebuyPaused: this.gapHadRebuyPause,
        at: now,
      });
    }
    // A table that idled between the two hands (short-handed, parked, held
    // for a spin reveal) is not a sample of the rest; it waited on people.
    this.lastCompletionAtMs = null;
    this.gapPhaseMs = {};
  }

  /** Loop phases that mean the table was waiting on something other than bookkeeping. */
  private static readonly IDLE_LOOP_PHASES = new Set([
    'idle_not_enough_players',
    'start_wait_for_players',
    'parked_for_pause',
    'spin_reveal_hold',
    'mystery_bounty_hold',
    'admin_pause_lock',
    'maintenance_lock',
    'idle_cluster_closed',
    'idle_seat_moves',
  ]);

  /** Per-phase share of the current gap; called from setLoopPhase while a rest is armed. */
  protected accrueGapPhase(now: number): void {
    // `== null` on purpose: the base constructor sets a loop phase before this
    // class's field initialisers have run, and undefined must read as "no rest armed".
    if (this.lastCompletionAtMs == null) return;
    const dt = now - this.gapPhaseSinceMs;
    if (dt > 0) this.gapPhaseMs[this.gapPhaseName] = (this.gapPhaseMs[this.gapPhaseName] ?? 0) + dt;
    this.gapPhaseName = this.loopPhase;
    this.gapPhaseSinceMs = now;
    if (this.loopPhase === 'rebuy_pause') this.gapHadRebuyPause = true;
    if (ServerTableEngineDealing.IDLE_LOOP_PHASES.has(this.loopPhase)) this.gapSawIdle = true;
  }

  protected override setLoopPhase(phase: string): void {
    super.setLoopPhase(phase);
    this.accrueGapPhase(Date.now());
  }

  private nextHandNotBeforeMs: number | null = null;
  private lastCompletionAtMs: number | null = null;
  private gapPhaseMs: Record<string, number> = {};
  private gapPhaseName = '';
  private gapPhaseSinceMs = 0;
  private gapHadRebuyPause = false;
  private gapSawIdle = false;

  /**
   * EVERYTHING THE NEXT HAND NEEDS FROM THE DATABASE, IN ONE ROUND (2026-09-07).
   *
   * The independent reads and hand allocation used to run one after another
   * at the top of the iteration: the roster (itself two round trips), the
   * leave-pending sweep, and - inside dealHand - the global hand number. At
   * the 250-700ms a PostgREST call costs from the engine box that was two to
   * three seconds on the felt, every hand, AFTER the rest had already been
   * slept. They now start together, under the rest.
   *
   * Independence, stated so it can be checked:
   * - readNextHandInputs reads seats and rake; nothing here writes them.
   *   Tournament blinds are read after the rest, at the next-deal boundary.
   * - processLeavePending marks leaving seats left and cashes them out. It is
   *   raced with the roster read ONLY when no add-on is pending (an add-on
   *   must credit a seat before that seat can leave, so the serial order
   *   pending_addons -> leave_pending is kept whenever one exists). The
   *   roster is filtered by the sweep's result afterwards in either order, so
   *   a seat that left during the read never deals.
   * - allocateGlobalHandNumber takes the next value of a sequence. It is
   *   consumed by dealHand a few seconds later or discarded (see
   *   takePreparedHandNumber), never reused.
   * The roster read failing still throws exactly as before; the other two
   * settle on their own and are consumed where they always were.
   */
  protected async prepareNextHand(): Promise<SeatedPlayer[]> {
    const releaseSeatBoundary = await this.acquireSeatBoundary();
    try {
      const leaveSweepCanRace =
        !this.isTournamentTable() &&
        !this.pendingAddOnSweepNeeded &&
        this.pendingAddOns.size === 0 &&
        this.preparedLeavePending === null;
      let rawSweep: ReturnType<typeof processLeavePending> | null = null;
      let budgetedSweep: ReturnType<typeof processLeavePending> | null = null;
      if (leaveSweepCanRace) {
        rawSweep = processLeavePending(
          this.tableId,
          this.tableInfo?.club_id || '',
          (lockedUserId, stayRemainingMs, occupancyId) =>
            this.onLeaveRefusedAtSettlement(lockedUserId, stayRemainingMs, occupancyId)
        );
        budgetedSweep = this.withStepBudget(
          'leave_pending',
          ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
          rawSweep
        );
        this.preparedLeavePending = budgetedSweep;
      }
      if (this.preparedHandNumber === null) {
        this.preparedHandNumber = this.allocateGlobalHandNumber()
          .then((n) => ({ n, at: Date.now() }))
          .catch((err: unknown) => {
            console.warn(
              `[ServerTableEngine:${this.tableId}] hand number pre-allocation failed; dealHand will retry:`,
              err instanceof Error ? err.message : err
            );
            return null;
          });
      }
      // A failed sibling read or elapsed step budget does not cancel a
      // transaction. Join the raw cashout before releasing engine ownership.
      // Read and cashout still start together; no new polling is introduced.
      const [roster, departure, budget] = await Promise.allSettled([
        this.readNextHandInputs(),
        rawSweep ?? Promise.resolve([]),
        budgetedSweep ?? Promise.resolve([]),
      ]);
      if (departure.status === 'fulfilled' && departure.value.length > 0) {
        const stillSeated = (seat: SeatedPlayer) =>
          !departure.value.some(
            (left) => left.userId === seat.user_id && left.occupancyId === seat.occupancy_id
          );
        this.seatedPlayers = this.seatedPlayers.filter(stillSeated);
        if (roster.status === 'fulfilled') roster.value = roster.value.filter(stillSeated);
      }
      if (roster.status === 'rejected') throw roster.reason;
      if (departure.status === 'rejected') throw departure.reason;
      if (budget.status === 'rejected') throw budget.reason;
      return roster.value;
    } finally {
      releaseSeatBoundary();
    }
  }

  private preparedLeavePending: ReturnType<typeof processLeavePending> | null = null;
  private preparedHandNumber: Promise<{ n: number; at: number } | null> | null = null;
  private preparedHandNumberValue: { n: number; at: number } | null = null;
  /** A pre-allocated hand number older than this is discarded rather than dealt. */
  protected static readonly PREPARED_HAND_NUMBER_MAX_AGE_MS = 15_000;

  protected async takePreparedLeavePending(): ReturnType<typeof processLeavePending> {
    const prepared = this.preparedLeavePending;
    this.preparedLeavePending = null;
    if (prepared) return prepared;
    return processLeavePending(
      this.tableId,
      this.tableInfo?.club_id || '',
      (lockedUserId, stayRemainingMs, occupancyId) =>
        this.onLeaveRefusedAtSettlement(lockedUserId, stayRemainingMs, occupancyId)
    );
  }

  /** Resolves the pre-allocation (if any) into a value dealHand can take synchronously. */
  protected async settlePreparedHandNumber(): Promise<void> {
    const pending = this.preparedHandNumber;
    this.preparedHandNumber = null;
    if (!pending) return;
    this.preparedHandNumberValue = await pending;
  }

  protected takePreparedHandNumber(): number | null {
    const prepared = this.preparedHandNumberValue;
    this.preparedHandNumberValue = null;
    if (!prepared) return null;
    if (Date.now() - prepared.at > ServerTableEngineDealing.PREPARED_HAND_NUMBER_MAX_AGE_MS) {
      return null;
    }
    return prepared.n;
  }

  protected async readNextHandInputs(): Promise<SeatedPlayer[]> {
    // Seats and cash rake can be prepared in parallel under the rest.
    // Tournament blinds must wait until that rest ends: a level may advance
    // after this prepared roster is ready but before its hand is created.
    const reads = [
      this.withStepBudget(
        'load_seats',
        ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
        loadSeatedPlayers(this.tableId)
      ),
      this.withStepBudget(
        'refresh_rake',
        ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
        this.refreshRakeConfig()
      ),
    ] as const;
    this.setLoopPhase('load_next_hand_inputs');
    // Do not fail fast and start another iteration while a sibling read is
    // still in its budget. The old roster is retained if any input fails.
    const [seats, rake] = await Promise.allSettled(reads);
    if (seats.status === 'rejected') throw seats.reason;
    if (rake.status === 'rejected') throw rake.reason;
    return seats.value;
  }

  protected async refreshBlinds(): Promise<void> {
    if (!this.tableInfo || !this.isTournamentTable()) return;
    // BUG-error reporting-7463185461 FIX: retry up to 3x on transient fetch failures.
    // A single Node.js 'TypeError: fetch failed' (Supabase network blip) was
    // bubbling through to dealingLoop, triggering the error reporting error reporter
    // and incrementing consecutiveErrors toward the 10-error shutdown threshold.
    // Retrying here absorbs one-off network hiccups before they reach the loop.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const data = await loadTable(this.tableId);
        if (data) {
          /* AND TELL THE FELT (2026-09-09). `TABLE_META_UPDATE` - the message
             `TableService.subscribeToTable` has consumed since the 2026-05-18
             migration off `postgres_changes` - is CONSTRUCTED NOWHERE in this
             engine, and `ChannelHub` has no table subscription to deliver it
             on, so live blind-level changes and table renames have been
             silent for every seated player since that migration. The table's
             own socket is already subscribed and already carries every other
             discrete fact about this table, so the meta change goes out the
             same way, as `table_meta_update`. (`useTableStore`'s copy of the
             subscription still goes through the channel client and is still
             dead; the FELT is the surface a player is looking at.) */
          const changed =
            Number(this.tableInfo.small_blind) !== Number(data.small_blind) ||
            Number(this.tableInfo.big_blind) !== Number(data.big_blind) ||
            Number(this.tableInfo.ante ?? 0) !== Number(data.ante ?? 0);
          this.tableInfo.small_blind = data.small_blind;
          this.tableInfo.big_blind = data.big_blind;
          this.tableInfo.ante = data.ante;
          if (changed) {
            this.hub?.emitEvent(this.tableId, {
              type: 'table_meta_update',
              table_id: this.tableId,
              name: this.tableInfo.name ?? null,
              game_variant: this.tableInfo.game_variant ?? null,
              small_blind: data.small_blind,
              big_blind: data.big_blind,
              ante: data.ante ?? 0,
              timestamp: Date.now(),
            });
          }
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
    const releaseSeatBoundary = await this.acquireSeatBoundary();
    try {
      // The roster was selected before the between-hand rest and may now contain
      // a cashed-out occupancy. Revalidate it while departures cannot run.
      players = players.filter(
        (p) =>
          this.seatedPlayers.some(
            (current) =>
              current.user_id === p.user_id &&
              current.seat_number === p.seat_number &&
              current.occupancy_id === p.occupancy_id
          ) &&
          (this.isTournamentTable() || !this.disconnectEngine.isSittingOut(this.tableId, p.user_id))
      );
      if (players.length < 2) return;
      if (!this.tableInfo) return;

      // GLOBAL HAND NUMBER (2026-08-18). Allocated from the database sequence at
      // the moment the hand is dealt, so numbers ascend in true deal order across
      // every table, club, union, cash game and tournament, and can never repeat.
      // Was `this.handCount++` — a per-table counter that reset on every engine
      // restart and produced the same "Hand #196" on dozens of tables at once.
      // ALLOCATED UNDER THE REST since 2026-09-07 (prepareNextHand) - the same
      // sequence, taken at most a few seconds earlier and only for a hand that is
      // about to be dealt; a number held for longer than that is discarded and a
      // fresh one taken here, so the ascending-by-deal-order property holds.
      this.handCount = this.takePreparedHandNumber() ?? (await this.allocateGlobalHandNumber());
      if (this.discardPreparedHandForPause()) return;
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
      this.currentHandVariant = null;
      this.currentHandWinnersByBoard = [];
      // SHOWDOWN POLISH 2026-08-25: per-pot award breakdown is per-hand.
      this.currentHandPerPotAwards = [];
      this.currentHandActions = [];
      this.currentHandWinners = [];
      // Dan section 29: a stale pot breakdown would attribute THIS hand's
      // knockout to the previous hand's side pots, so it is cleared with the
      // winners it belongs to and never independently of them.
      this.currentHandPots = [];
      this.currentHandContributions.clear(); // Weighted contributed rake (Dan 2026-08-29): reset per-hand eligible contributions
      this.currentHandReturnedUncalled.clear(); // ... and the returned-uncalled audit map
      this.currentHandInsuranceSettlements = []; // Bible V8 §4.19: Reset insurance settlements
      this.currentHandInsuranceNet = 0; // chip standard 2026-09-04: declared to the stack write
      this.currentHandCashoutRedirects = new Map(); // EV CASHOUT 2026-08-28: reset per hand
      this.currentHandShowdownResults = []; // BBJ: Reset showdown results for new hand
      this.currentHandTimerLog = []; // Bible V8 §2.15: Reset timer log
      this.currentHandNotificationLog = []; // Bible V8 §2.16: Reset notification log
      this.currentHandBBJHit = null; // BBJ: Reset hit detection for new hand
      this.currentHandBBJPayoutConfig = null;
      this.currentHandMiniBBJHit = null;
      this.currentHandMiniBBJTierId = null;
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
        `[ServerTableEngine:${this.tableId}] Hand #${handNumber} - ${players.length} players`
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
      /**
       * THE FIRST BUTTON AT A TWO-HANDED TABLE IS DRAWN (2026-08-31, Phase 2.1).
       *
       * A Spin draws its first button in TournamentManagerBase.scheduleSpinPostReveal
       * and hands it here through `forcedFirstButtonSeat`. A 2-max SNG -- the
       * Heads-Up duel, ~11k games a week -- never reaches that path, so it fell
       * through to `buttonSeats[0]`: the LOWEST occupied seat. Seating is
       * seat-first, so the low seat is whoever arrived first, and heads-up the
       * button IS the small blind: acts first preflop and last postflop, the
       * largest positional edge in poker, in a format frequently decided in a
       * handful of hands. Horse-vs-horse play cancels it out in aggregate
       * (measured 49.94 / 50.06 by seat), which is why the money it moves has
       * never shown up in a win-rate query.
       *
       * Same generator as the deck and as the Spin draw: crypto, never
       * Math.random, because this is a money game.
       */
      const drawsFirstButton = !drawnIsSeated && prevButtonSeat <= 0 && sortedSeats.length === 2;
      const headsUpFirstButton = drawsFirstButton
        ? drawFirstButtonSeat(sortedSeats, secureRandomInt)
        : null;
      let dealerSeat = drawnIsSeated
        ? (drawnButton as number)
        : headsUpFirstButton !== null
          ? headsUpFirstButton
          : prevButtonSeat > 0
            ? this.getNextSeat(prevButtonSeat, buttonRoster)
            : buttonSeats[0];
      if (headsUpFirstButton !== null && this.isTournamentTable()) {
        /**
         * PERSISTED, OR A RESTART RE-DRAWS IT. `lastButtonSeat` is memory only
         * and there is no settled hand for restoreButtonFromHistory to read, so
         * a restart between this draw and the first settled hand would come back
         * with prevButtonSeat = 0 and draw a SECOND time -- a fresh coin flip on
         * a game that already flipped. tables.first_button_seat is the column the
         * Spin draw already uses for exactly this, and TournamentManagerBase
         * .restoreDrawnFirstButtons re-applies it on resume for any tournament
         * table that has not yet settled a hand. Fire-and-forget with a warning:
         * losing the persist costs a re-draw, refusing to deal costs the game.
         *
         * TOURNAMENT TABLES ONLY, because that manager is the only reader of
         * the column -- nothing else in the repo selects it. A cash table
         * restarting before its first hand re-draws instead, which is fair
         * (no hand has been played), and a column written by one path and read
         * by none is the "declared 37 times, read by var() exactly zero times"
         * shape this codebase has already been bitten by.
         */
        void Promise.resolve(
          supabase
            .from('tables')
            .update({ first_button_seat: headsUpFirstButton })
            .eq('id', this.tableId)
        )
          .then(({ error }: { error: { message?: string } | null }) => {
            if (error) {
              console.warn(
                `[ServerTableEngine:${this.tableId}] Drawn heads-up first button (seat ${headsUpFirstButton}) not persisted (${error.message}) -- a restart before the first settled hand would re-draw it`
              );
            }
          })
          .catch((err: unknown) => {
            console.warn(
              `[ServerTableEngine:${this.tableId}] Heads-up first button persist threw: ${(err as Error)?.message ?? err}`
            );
          });
      }
      // A sole eligible incumbent can keep the button for one entry hand.
      // Giving it to a newcomer breaks cash entry rules and disagrees with the
      // blind predictor. Once dealt, the newcomers join the eligible rotation.
      /**
       * THE DEAD BUTTON, AND THE BIG BLIND THAT WAS PAID TWICE
       * (2026-08-31, Phase 2.2. TDA Rule 33.)
       *
       * Rotating the BUTTON forward is right at 3+ handed and wrong the moment a
       * table drops to two. Worked example, the common one: seats 1/2/3, button
       * on 1, small blind 2, big blind 3. Seat 1 busts. The rotation above walks
       * the button from 1 to the next occupied seat, 2 -- and heads-up the button
       * IS the small blind, so seat 2 posts the small and seat 3 posts the big
       * AGAIN. A full big blind of EV, taken from one player and handed to the
       * other, on roughly one in three Spins that reach heads-up.
       *
       * The rule the rest of poker uses is that the BLINDS advance and the button
       * follows them: the big blind moves one live player forward every hand and
       * the other seat takes the button. A player may post the small blind twice
       * running (that is what makes the button "dead"); nobody ever posts the big
       * blind twice. Re-running the example: the last big blind was seat 3, the
       * next live seat after 3 wraps to 2, so seat 2 posts the big blind and seat
       * 3 takes the button. Seat 3 paid the big blind and now pays the small.
       * Correct for the other two bust cases too -- see the table-driven spec.
       *
       * GATED ON BOTH PLAYERS HAVING BEEN DEALT IN ALREADY, which keeps this away
       * from the case the "button must always move" comment above protects: a
       * newcomer sitting down opposite an incumbent must be given the big blind,
       * not the button, or the wait-for-BB hold-out refuses and the table never
       * deals again.
       */
      if (!drawnIsSeated && headsUpFirstButton === null && players.length === 2) {
        // Dan 2026-08-25, BINDING: a player sitting down never receives the
        // button. Both survivors of a 3-handed hand are veterans by definition,
        // so the rule below applies to every case it is meant for; a newcomer
        // opposite an incumbent keeps the existing rotation, which hands them
        // the big blind and gets them dealt in.
        const bothWereDealtIn = players.every((p) => this.dealtInUserIds.has(p.user_id));
        const headsUpSeat = bothWereDealtIn
          ? headsUpButtonSeat(sortedSeats, this.lastBigBlindSeat)
          : null;
        if (headsUpSeat !== null && headsUpSeat > 0) {
          dealerSeat = headsUpSeat;
        }
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
      // Keep the legacy index roughly in sync for any remaining reads (defensive).
      this.dealerSeatIndex = Math.max(0, sortedSeats.indexOf(dealerSeat)) + 1;

      // Bible V8 §6: Orbit complete (button wrapped past the top seat) → refill
      // time banks. With seat-based rotation, a wrap means the new button seat is
      // not strictly greater than the previous one.
      const orbitComplete = prevButtonSeat > 0 && dealerSeat <= prevButtonSeat;
      if (orbitComplete) {
        this.timeBankEngine.onOrbitComplete(this.tableId);
      }

      /**
       * ── AN ORBIT IS A BUTTON ROTATION, NOT A HAND (Dan, 2026-08-29) ─────────
       *
       * The rule is "removed after the button passes them TWICE, or after 5
       * minutes, whichever happens first". This counter has been wrong twice, in
       * the same direction, each fix moving it closer without arriving:
       *
       *   originally  bumped by the dealing loop's own tick — once per hand while
       *               dealing and once per 3-SECOND IDLE TICK while not, so on a
       *               quiet table "two orbits" became about nine seconds;
       *   2026-08-28  moved here, to the deal, and the comment said "an orbit is
       *               a hand". It is not. At a 6-max table a real orbit is about
       *               six hands, so "2 orbits" was being enforced as 3 hands —
       *               a player booted roughly four times sooner than the rule
       *               they were told.
       *
       * The correct signal was already being computed one line above for time
       * banks: `orbitComplete` is a genuine button wrap. Counted there now, so
       * the two halves of the rule finally mean what they say, and the
       * five-minute half is usually the one that fires — which is the rule as
       * Dan states it.
       *
       * The five-minute half is still evaluated on EVERY tick, deal or not. That
       * is the half that has to work when the table has gone quiet, which is
       * exactly when a seat would otherwise be held forever.
       */
      if (orbitComplete && !this.isTournamentTable()) {
        /* THE RETURN IS DELIBERATELY DISCARDED. This call's job is to ADVANCE the
         orbit counter, not to act on it: a hand is being dealt right now, and
         standing a player up between the button moving and the cards going out
         is the mid-hand removal that `evictExpiredSitOuts` and `leaveTable`
         both refuse. Whoever this increment just pushed over the limit is
         collected on the next pass of `evictExpiredSitOuts({ countOrbit:
         false })` at the top of the loop, which runs between hands and takes
         the seat lock. Said out loud because a bare discarded `string[]` of
         evictable players reads like a dropped result. */
        void this.disconnectEngine.tickSitOutsAndCollectEvictions(
          this.tableId,
          this.seatedPlayers.map((p) => p.user_id),
          { countOrbit: true }
        );
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

        // ═══ V48 VOLUNTARY STRADDLE (2026-09-05) ═══════════════════════════
        // A horse has never posted a voluntary straddle. The layer that reads
        // a straddled pot correctly shipped on 2026-08-26 (V18) and the fleet
        // opened straddle tables on 2026-08-28, but nothing on the horse side
        // ever ENROLLED, so every straddle at every table came from a human or
        // from the host's mandatory setting. It is one of the most visible
        // absences at a live table: the seat that never straddles, ever.
        //
        // The rate is the horse's own persona (HorsePersona.straddleRate,
        // skewed the way real players are - most never, a few nearly always),
        // and the answer is deterministic in (horse, hand): a replayed hand
        // must straddle the same way twice, and a test must be able to assert
        // the distribution. Humans are untouched - this only ever enrolls or
        // unenrolls a horse, and the host's mandatory setting still overrides
        // everything.
        for (const entry of seatOrder) {
          const seated = this.seatedPlayers.find((sp) => sp.user_id === entry.playerId);
          if (!seated?.is_horse) continue;
          try {
            const persona = resolvePersona(seated.horse_profile, seated.user_id);
            const wants = wantsStraddle(seated.user_id, handNumber, persona.straddleRate);
            this.straddleEngine.toggleAutoStraddle(this.tableId, seated.user_id, wants);
            if (wants) noteFire('v48_straddle_enrolled');
          } catch {
            /* a persona must never be able to stop a hand being dealt */
          }
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
      let bombHandVariant: string | null = null;
      {
        const schedulerSettings = bombPotSettingsFromTable(this.tableInfo);
        // FULL SCHEDULER PERSISTENCE (2026-08-28): restore the trigger state —
        // every-N counter, orbit anchor, pending token, timed clock, separate
        // bomb button — on the first hand after an engine restart. restoreState
        // fills a FRESH scheduler only, so this is a no-op ever after. The
        // legacy bomb_pot_next_due_at column stays as a timed-mode fallback for
        // rows written before the jsonb existed.
        if (schedulerSettings.enabled) {
          const persistedState = this.tableInfo.bomb_pot_sched_state;
          this.bombPotScheduler.restoreState(persistedState);
          if (
            this.bombButtonSeat == null &&
            persistedState &&
            typeof (persistedState as { b?: unknown }).b === 'number'
          ) {
            this.bombButtonSeat = (persistedState as { b: number }).b;
          }
          if (schedulerSettings.triggerMode === 'timed') {
            const persisted = Date.parse(this.tableInfo.bomb_pot_next_due_at ?? '');
            if (Number.isFinite(persisted)) this.bombPotScheduler.seedNextDueAt(persisted);
          }
        }

        // The scheduler decides FIRST. Two reasons, both learned here:
        //
        //  1. COST. The manual-pending flag needs a FRESH read (the throttled
        //     tableInfo re-read is far too slow for "next hand"), and that is
        //     one extra round trip per hand per bomb table. Asking the
        //     scheduler first means the read is skipped entirely on hands that
        //     are already bombs.
        //  2. THE HOST'S REQUEST IS NOT SWALLOWED. Reading first consumed and
        //     cleared the manual flag even when the scheduler was about to fire
        //     anyway — the host asked for an EXTRA bomb, got the one that was
        //     already coming, and their request vanished with nothing to show
        //     for it. Spec §4.3 collapses two SCHEDULED triggers into one; a
        //     manual request is a separate intent, so it is preserved for the
        //     next hand that is not already a bomb.
        let decision: BombPotDecision = this.bombPotScheduler.noteHandStart(
          schedulerSettings,
          dealerSeat,
          players.length,
          Date.now()
        );

        // MANUAL_NEXT_HAND (spec §2.1/§15.3): an authorized host can schedule
        // exactly one bomb for the next valid hand via
        // fn_request_manual_bomb_pot (role-gated + audited server-side). Only
        // consulted on a bomb-enabled table that is not ALREADY dealing a bomb.
        // Fail closed: if the flag cannot be cleared the bomb does not fire,
        // because a bomb that fires twice is worse than one that arrives a hand
        // late.
        if (
          !decision.isBombPot &&
          this.tableInfo.bomb_pot_enabled === true &&
          // PUSHED, NOT POLLED (2026-08-29). This block used to run on EVERY
          // non-bomb hand of every bomb table — one round trip on the hand-start
          // critical path to learn a flag that is false essentially always.
          // fn_request_manual_bomb_pot now broadcasts on the table topic this
          // engine already holds open, and the throttled table refresh (which
          // was already happening) latches the column as the backstop for a
          // broadcast the engine was not alive to hear. Either way the database
          // is touched only when there is genuinely something to claim.
          this.manualBombPushed &&
          // Below the floor the request simply stays pending (spec §3.1), so
          // there is nothing to claim and no reason to touch the database.
          players.length >= schedulerSettings.minPlayers
        ) {
          try {
            /**
             * ONE ROUND TRIP, AND THE CLAIM IS ATOMIC (2026-08-29).
             *
             * This was SELECT-then-UPDATE: two sequential awaits on the
             * hand-start critical path of every bomb-enabled table, on every
             * hand that was not already a bomb. It was also a check-then-act
             * with no predicate on the write, so two engines overlapping during
             * a shard handoff or a restart could both read `true` and both fire
             * — precisely the "a bomb that fires twice" outcome the fail-closed
             * comment above says it exists to prevent.
             *
             * A conditional UPDATE ... WHERE bomb_pot_manual_pending = true is
             * both halves at once: exactly one caller gets a row back, and that
             * caller owns the bomb. No row back means somebody else claimed it
             * or it was never set. Still fails closed — an error claims nothing.
             *
             * The minPlayers gate moved OUT of this block and into the condition
             * above, because with an atomic claim the order matters: claiming
             * first and then discovering the table is short would consume the
             * host's request and fire nothing.
             */
            const { data: claimed, error: claimErr } = await supabase
              .from('tables')
              .update({ bomb_pot_manual_pending: false })
              .eq('id', this.tableId)
              .eq('bomb_pot_manual_pending', true)
              .select('id')
              .maybeSingle();
            if (claimErr) {
              // Fail closed and KEEP the armed flag, so the next hand tries
              // again rather than dropping the host's request on one blip.
              console.warn('[BombPot] manual claim failed - deferring:', claimErr.message);
            } else if (claimed) {
              this.manualBombPushed = false;
              decision = { isBombPot: true, triggerReason: 'manual_next_hand' };
            } else {
              // No row came back: somebody else claimed it, or the flag was
              // already false (a broadcast heard twice, or heard after another
              // engine consumed it). Disarm — there is nothing left to claim.
              this.manualBombPushed = false;
            }
          } catch (err) {
            console.warn('[BombPot] manual claim threw:', err);
          }
        }

        if (decision.isBombPot) {
          // SEPARATE BOMB BUTTON (spec §5.3, buttonPolicy SEPARATE_BOMB_BUTTON):
          // bomb hands keep their own button rotation and the REGULAR button
          // does not move — the next normal hand resumes exactly where it would
          // have been had the bomb hand not happened. That is the "intervening
          // hands" definition the spec demands be explicit: normal rotation is
          // simply blind to bomb hands. The bomb button starts on the current
          // regular button and advances clockwise among the seats dealt into
          // each bomb hand (getNextSeat skips vacated seats — dead-button
          // behaviour matches the regular rotation's own).
          if ((this.tableInfo.bomb_pot_button_policy ?? 'regular') === 'separate') {
            // 2026-08-29: rotate over buttonRoster, not the raw seat list.
            // buttonRoster is this.buttonEligible(players), built above for the
            // regular rotation precisely to honour Dan's binding rule — "NEW
            // PLAYERS NEVER GET THE BUTTON WHEN SITTING DOWN. It skips over them
            // and moves to the correct person." Rotating the BOMB button over
            // `players` let a player who had never been dealt a hand here
            // receive the button on their very first one, which sets postflop
            // action order and odd-chip allocation for that hand. The rule is
            // about the button, not about which kind of hand it is.
            const bombSeat =
              this.bombButtonSeat != null
                ? this.getNextSeat(this.bombButtonSeat, buttonRoster)
                : dealerSeat;
            this.bombButtonSeat = bombSeat;
            // Rewind the regular rotation: it advanced above for what is now a
            // bomb hand. prevButtonSeat is this function's pre-rotation state.
            this.lastButtonSeat = prevButtonSeat > 0 ? prevButtonSeat : this.lastButtonSeat;
            dealerSeat = bombSeat;
            this.currentHandDealerSeat = bombSeat;
          }
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
          // VARIANT OVERRIDE (spec §10.1): an NLH table can deal PLO bomb
          // hands. resolveBombPotVariant whitelists the value — anything
          // unknown means "same as table", never a half-understood game.
          const tableVariant = this.dealtGameVariant();
          const resolved = resolveBombPotVariant(tableVariant, this.tableInfo.bomb_pot_variant);
          if (resolved !== tableVariant) {
            // Deck feasibility for the OVERRIDE variant: a 9-handed table
            // overridden to PLO6 would need 54 hole cards from a 52-card deck.
            // The multi-board downgrade in HandController assumes hole cards
            // fit; hole cards that do not fit mean the override — not the
            // boards — must yield, and the hand deals as the table's own game.
            const holeNeed = players.length * holeCardCount(resolved) + 5;
            /**
             * 2026-08-29: the deck test alone is not the seat law.
             *
             * maxSeatsFor('plo5') is (52-5)/5 = 9, so nine players passed this
             * check and were dealt a NINE-HANDED PLO5 bomb hand — a table this
             * same file (and ServerTableEngineRunout) states is illegal: "PLO6
             * is 6-max and PLO5 is 7-max (Dan)". maxSeatsForVariant is where
             * that rule lives, and it was not being asked.
             *
             * It was not only a rules violation. Nine PLO5 hands is 45 hole
             * cards, so 15 more for three boards does not fit and
             * postBombPotAntes silently downgraded the host's three boards to
             * one — the host lost the whole feature to a console.warn nobody
             * reads, on a hand that should not have used the override at all.
             *
             * Both tests must pass. Failing either means the OVERRIDE yields
             * and the hand deals the table's own game, which is exactly the
             * fallback the surrounding comment already describes.
             */
            const seatMax = maxSeatsForVariant(resolved);
            if (holeNeed <= deckSizeFor(resolved) && players.length <= seatMax) {
              bombHandVariant = resolved;
            } else if (players.length > seatMax) {
              console.warn(
                `[BombPot] variant override ${resolved} skipped: ${players.length} players exceeds ` +
                  `its ${seatMax}-seat limit - dealing ${tableVariant}`
              );
            } else {
              console.warn(
                `[BombPot] variant override ${resolved} skipped: ${players.length} players need ` +
                  `${holeNeed} cards > ${deckSizeFor(resolved)}-card deck - dealing ${tableVariant}`
              );
            }
          }
        }

        /**
         * PERSIST THE SCHEDULER — AFTER THE DECISION, NOT BEFORE (2026-08-29).
         *
         * Counter ticks, token set/consumed, clock reset, bomb button advanced.
         * One small row write per hand, bomb-enabled tables only.
         * Fire-and-forget: a lost write costs one cycle of drift after the NEXT
         * restart, the exact cost every restart carried before persistence
         * existed.
         *
         * Two changes here.
         *
         * ORDER. This block used to run BEFORE `if (decision.isBombPot)`, so on
         * a bomb hand the `b` it wrote was the PREVIOUS bomb hand's button seat
         * — the seat this hand is using had not been chosen yet. It self-healed
         * on the next hand in modes that write every hand, but a restart in that
         * window replayed a stale bomb button.
         *
         * THE OFF SWITCH. The write was gated on `schedulerSettings.enabled`,
         * while noteHandStart calls reset() when the schedule is disabled. So
         * turning bomb pots off dropped the in-memory token and left the
         * PERSISTED one — `{p: true}` — sitting in the row. Re-enable, restart,
         * and restoreState loaded that stale token and detonated a bomb on the
         * first valid hand, which is precisely what "re-enabling starts a fresh
         * schedule" exists to prevent. A disabled schedule now clears the row,
         * once, and the JSON-diff guard keeps it to a single write.
         */
        {
          const enabled = schedulerSettings.enabled;
          const dueAt = enabled ? this.bombPotScheduler.nextBombDueAt(schedulerSettings) : null;
          const dueAtIso = dueAt !== null ? new Date(dueAt).toISOString() : null;
          const snapObj = enabled
            ? { ...this.bombPotScheduler.exportState(), b: this.bombButtonSeat ?? null }
            : null;
          const snap = JSON.stringify(snapObj);
          if (snap !== this.bombPotSchedPersistedJson) {
            this.bombPotSchedPersistedJson = snap;
            this.tableInfo.bomb_pot_sched_state = snapObj;
            this.tableInfo.bomb_pot_next_due_at = dueAtIso;
            // Promise.resolve turns the PostgrestBuilder thenable into a real
            // Promise so the house .catch rule (noUnhandledRejections.test.ts)
            // is satisfiable.
            void Promise.resolve(
              supabase
                .from('tables')
                .update({ bomb_pot_sched_state: snapObj, bomb_pot_next_due_at: dueAtIso })
                .eq('id', this.tableId)
            )
              .then(({ error }) => {
                if (error) {
                  console.warn('[BombPot] scheduler persistence failed:', error.message);
                }
              })
              .catch((err: unknown) => {
                console.warn('[BombPot] scheduler persistence threw:', err);
              });
          }
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
      /**
       * THE BIG BLIND ANCHOR, RECORDED ONLY WHEN A BIG BLIND IS ACTUALLY POSTED
       * (2026-08-31, audit of my own Phase 2 commit).
       *
       * The heads-up dead-button rule reads `lastBigBlindSeat` on the NEXT hand
       * to decide who posts next. It was written beside the shared sb/bb
       * computation above, which runs on every hand -- including a bomb pot,
       * where HandController calls postBombPotAntes and returns BEFORE
       * postBlinds(), so nobody posts a blind at all. The very next block skips
       * its away-blind charge for exactly that reason and says so.
       *
       * Recording a big blind that was never posted walks the anchor one seat
       * too far, and on the following hand the rule would hand the big blind
       * back to the player who last really paid it -- reintroducing, at a
       * two-handed bomb-pot table, the bug this rule exists to remove.
       *
       * `bombPotConfig` is only decided further up, which is why this sits here
       * rather than beside the computation it copies.
       */
      if (!bombPotConfig) {
        this.lastBigBlindSeat = bbSeat;
      }

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
        asset: this.tableInfo.arena?.asset ?? 'chips',
        tableId: this.tableId,
        handNumber,
        /* Dan 2026-08-28, binding: a tournament showdown is always face up, so
         applyShowdownRevealRules skips the cash-game muck courtesy entirely.
         Same predicate every other tournament branch in this file uses. */
        isTournament: this.isTournamentTable(),
        // VARIANT OVERRIDE (spec §10.1): a bomb hand may play a different
        // variant from the table. Everything downstream — evaluator, hole-card
        // count, betting structure, horse equity, hand history — reads the
        // HAND's variant, so this one assignment is the entire override.
        gameVariant: (bombHandVariant ?? this.dealtGameVariant()) as GameVariant,
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
        /**
         * A BOMB HAND HAS NO STRADDLE (2026-08-29).
         *
         * The straddle block runs above, BEFORE the bomb decision, so on a
         * straddle-enabled table straddleResults was populated on every bomb
         * hand and handed straight into HandConfig. HandController reads
         * config.straddles in exactly two places — postBlinds, and the
         * preflop-first-action branch of setNextPlayer — and a bomb hand reaches
         * neither, because everyone antes and the hand opens on the flop.
         *
         * So no money moved and nothing was visibly wrong. What existed was a
         * HandConfig asserting straddles that were never posted: a loaded gun
         * for whoever next touches either of those branches, or adds a third
         * reader. Say plainly that a bomb hand has none.
         */
        straddles: bombPotConfig || straddleResults.length === 0 ? undefined : straddleResults,
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

      // VARIANT OVERRIDE (spec §10.1): remember what THIS hand is being played
      // as — Settlement writes hand_history.game_variant from this, and it must
      // say plo4 on a PLO4 bomb hand even at an NLH table.
      this.currentHandVariant = config.gameVariant;

      this.currentHandSeatGenerations = captureHandSeatGenerations(players);
      // Bind the tournament identity to this hand. Each accepted action reads
      // only the existing cache; later table reassignment cannot change it.
      const observationTournamentId = this.tableInfo?.tournament_id;
      this.handController = new HandController(
        config,
        hcPlayers,
        dealerSeat,
        config.isTournament && observationTournamentId
          ? () => getTournamentBrainContextSnapshot(observationTournamentId)
          : undefined
      );
      // chip-std Lane F (2026-09-02): the stacks this hand was dealt from. The
      // tournament persist gate in postHandTasks holds the settled stacks of
      // these exact players to this exact total.
      // Chip standard 2026-09-04: ALSO what every seat's hand write is measured
      // against. Settlement sends (stack_before, stack) per seat and the
      // database applies the difference to the row, so a credit that landed
      // on the row while the engine's copy was stale (a pending add-on resolved
      // by step 8e after the loop had reloaded seats, a horse funding, a
      // between-hands add-on) is preserved instead of overwritten. Measured
      // 2026-09-04 before this: 64 add-ons / 7,685.70 chips erased in 3 hours.
      this.currentHandDealtStacks = new Map(
        hcPlayers.map((p) => [p.user_id, Number(p.stack) || 0] as [string, number])
      );

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
                  .counter(
                    'poker_event_shadow_divergences_total',
                    'Event-shadow replay divergences'
                  )
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
        // Dan 2026-08-30: the debt is settled, so the seat owes nothing and is
        // in the rotation. Clearing the persisted hold here — at the moment the
        // live big blind has actually been handed to the hand config — is what
        // stops a restart re-billing it, or worse, re-holding a player who has
        // already paid to come in.
        for (const userId of this.postingBBToEnter) {
          this.persistEntryHold(userId, { hold: null, agreed: false });
        }
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
      if (this.discardPreparedHandForPause()) return;
      /**
       * THE ENGINE MAY HAVE BEEN TORN DOWN DURING THAT AWAIT (2026-09-06).
       *
       * That RPC is the one await between `new HandController(...)` above and
       * `this.handController!.onEvent(...)` below, and both `stop()` and
       * `killForRestart()` set `this.handController = null` - a table that broke
       * or closed under the cluster controller, an engine superseded by its
       * replacement, the :55 cut-over. The `!` then dereferenced null:
       *
       *     TypeError: Cannot read properties of null (reading 'onEvent')
       *       at ServerTableEngineDealing.js:2363  (dealHand)
       *
       * four times in three hours on 2026-09-06, every one a table the cluster
       * controller had just broken. Nothing was dealt (start() is inside the
       * promise, after the listener), so the only harm was a stack trace with a
       * misleading name and one wasted attempt on the dealing loop's retry
       * ladder - but a hand that was torn down is not a hand to deal, and a
       * stopped engine must not go on to arm timers and write a snapshot for a
       * controller its successor owns. Leave quietly; the loop sees `running`.
       */
      if (!this.handController || !this.running) {
        console.log(
          `[ServerTableEngine:${this.tableId}] hand ${handNumber} not dealt - the engine was ` +
            `stopped while the time banks were being read`
        );
        return;
      }
      for (const p of hcPlayers) {
        this.atomicStackService.initializeStack(this.tableId, p.user_id, p.stack);
        // Only initialize time bank if player is NEW (don't reset existing pool per session)
        if (!this.timeBankEngine.getPlayerBank(this.tableId, p.user_id)) {
          const tbTotal = this.timeBankBaseSeconds + (tbExtras.get(p.user_id) ?? 0);
          // ── REVERTED 2026-08-25, same day it shipped. Read this before trying
          //    the restart-fidelity time-bank restore again. ──
          //
          // The intent was right: the accepted-hand envelope writes time_bank_remaining,
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
        this.disconnectEngine.registerPlayer(
          this.tableId,
          p.user_id,
          this.seatedPlayers.find((seat) => seat.user_id === p.user_id)?.reconnect_membership
        );
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
          applied = this.handController.performAction(
            dcPlayer.seat,
            disconnectAction.action as any,
            undefined,
            'forced'
          );
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
        const controllerForHand = this.handController!;
        let persistenceGeneration: number | undefined;
        // FIX 178: Bible V8 §6.1 — Hand safety timeout must accommodate full multi-player hands.
        // A 9-player hand with 15s action timers × 4 betting rounds = 540s worst case.
        // With time banks + insurance/RIT pauses, 10 minutes is a safe ceiling.
        // The old 60s timeout was killing hands prematurely mid-action.
        const HAND_SAFETY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
        // Declared with `let` so the timeout callback can call it (see AUDIT FIX).
        let unsub: () => void = () => {};
        let handWaitReleased = false;
        const releaseHandWait = (reason: string): void => {
          if (handWaitReleased) return;
          handWaitReleased = true;
          try {
            clearTimeout(handTimeout);
            if (this.handSafetyTimer === handTimeout) this.handSafetyTimer = null;
            unsub();
          } catch (error) {
            reportError(error, 'ServerTableEngine.' + this.tableId + '.hand_wait_release_failed', {
              reason,
              handNumber,
            });
          } finally {
            if (this.activeHandWaitRelease?.controller === controllerForHand) {
              this.activeHandWaitRelease = null;
            }
            if (this.handController === controllerForHand) this.handController = null;
            this.runoutRevealActive = false;
            resolve();
          }
        };
        const handTimeout = setTimeout(() => {
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
            releaseHandWait('engine_stopped_or_superseded');
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
          this.preciseTimer.clearTable(this.tableId);
          this.actionValidator.clearTable(this.tableId);
          /**
           * THE BOMB OVERLAY MUST BE DISMISSED ON THIS PATH TOO (2026-08-29).
           *
           * BOMB_POT_COMPLETED is what tells the client's BombPotOverlay the
           * hand is over. HandController emits it after every HAND_COMPLETE —
           * the normal settlement, the skip-distribution path, the no-winner
           * path and the catch block, four places, all covered. This is the
           * fifth exit and it is the only one that does not go through
           * HandController at all: the safety timer tears the hand down from
           * outside, so nothing ever emits it.
           *
           * A voided bomb hand therefore left the overlay on screen with no
           * dismissal signal, on top of a table that had just started dealing
           * the next hand. Ten minutes is rare, but "rare" is exactly when a
           * player is already looking at a table that has misbehaved.
           *
           * Emitted through handleHandEvent so it takes the same route to the
           * hub as the four that already work.
           */
          if (this.currentHandBombPot) {
            void this.handleHandEvent(
              { type: 'BOMB_POT_COMPLETED', handNumber } as HandEvent,
              players
            ).catch((err) =>
              reportError(err, 'ServerTableEngine.' + this.tableId + '.bomb_completed_on_void')
            );
          }
          releaseHandWait('hand_safety_timeout');
        }, HAND_SAFETY_TIMEOUT_MS);
        // Track on the instance so stop()/killForRestart() can clear it.
        this.handSafetyTimer = handTimeout;

        unsub = controllerForHand.onEvent((event: HandEvent) => {
          // 2026-08-15: handleHandEvent is async and its promise was discarded,
          // so ANY rejection inside it (broadcast, hub publish, settlement DB
          // write) vanished into index.ts's unhandled-rejection swallow while the
          // hand silently stopped advancing. Catch it here so at minimum it is
          // reported and the watchdog can see the table stop making progress.
          void this.handleHandEvent(event, players, persistenceGeneration).catch((err) =>
            reportError(err, 'ServerTableEngine.' + this.tableId + '.handleHandEvent_rejected', {
              eventType: event.type,
              handNumber: this.handCount,
            })
          );

          if (event.type === 'HAND_COMPLETE') {
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

              // Clear the action clock here. Tournament hand-complete callbacks
              // intentionally do NOT fire here: handleHandEvent has only queued
              // postHandTasks at this point, so table_seats still carries the
              // pre-hand stacks and the knockout hand is not queryable yet.
              // ServerTableEngineSettlement fires it after both writes succeed.
              this.clearTurnTimer();
            } catch (e) {
              reportError(e, 'ServerTableEngine.' + this.tableId + '.hand_complete_listener_threw');
            }

            releaseHandWait('hand_complete');
          }
        });
        this.activeHandWaitRelease = {
          controller: controllerForHand,
          release: releaseHandWait,
        };

        // Start the hand!
        try {
          // ANIMATION AUDIT 2026-08-19: defensive — a fresh hand must never
          // inherit a stale all-in reveal flag from an abnormal exit.
          this.runoutRevealActive = false;
          if (this.discardPreparedHandForPause()) {
            releaseHandWait('terminal_closeout_before_start');
            return;
          }
          persistenceGeneration = this.beginTerminalBoundaryPersistence();
          // Start the exact controller whose listener and release fence were
          // installed above. A mutable field is not ownership evidence.
          controllerForHand.start();

          // FIX 137: Bible V8 §7.17 — Snapshot initial hand state for crash recovery.
          // C15: deliberately NOT coalesced. The hand-start snapshot is the anchor
          // every later delta is read against, so it is worth one guaranteed write.
          this.snapshotDirty = true;
          void this.flushSnapshot();
        } catch (err) {
          if (persistenceGeneration !== undefined) {
            this.finishTerminalBoundaryPersistence(persistenceGeneration, false);
          }
          reportError(err, `ServerTableEngine.${this.tableId}.failed_to_start_hand`);
          releaseHandWait('hand_start_failed');
        }
      });
    } finally {
      releaseSeatBoundary();
    }
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
  /**
   * PHASE 4 2026-09-01 - write one player's discarded card where only that
   * player can read it.
   *
   * Modelled on persistHoleCardsWithRetry below, including its hand-number
   * capture: `this.handCount` is reallocated when the next hand deals, and
   * this awaits, so re-reading it per attempt could stamp THIS hand's discard
   * with the NEXT hand's number.
   *
   * Deliberately NOT retried and NOT escalated the way hole cards are. A
   * missing hole card blinds a player in a live hand and has its own
   * `hole_cards_unavailable` recovery path; a missing discard row costs one
   * line of a REPLAY, after the hand is over. Retrying it three times with
   * backoff inside the hand's own event loop would spend live-hand latency on
   * a history record. One attempt, and a report if it fails.
   */
  protected async persistDiscardedCard(userId: string, seat: number, card: unknown): Promise<void> {
    const handNumberAtDiscard = this.handCount;
    try {
      const { error } = await supabase.from('hand_discards').upsert(
        {
          table_id: this.tableId,
          hand_number: handNumberAtDiscard,
          user_id: userId,
          seat_number: seat,
          discarded_card: card,
        },
        { onConflict: 'table_id,hand_number,user_id' }
      );
      if (error) {
        reportError(
          new Error(`hand_discards upsert failed: ${error.message}`),
          `ServerTableEngine.${this.tableId}.hand_discards_failed`,
          { userId, seat, handNumber: handNumberAtDiscard }
        );
      }
    } catch (err) {
      reportError(err, `ServerTableEngine.${this.tableId}.hand_discards_threw`, {
        userId,
        seat,
        handNumber: handNumberAtDiscard,
      });
    }
  }

  private holeCardWriteBatches?: Map<
    string,
    {
      rows: Array<{ userId: string; seat: number; json: string }>;
      promise: Promise<void>;
    }
  >;

  protected async persistHoleCardsWithRetry(
    userId: string,
    seat: number,
    cards: unknown
  ): Promise<void> {
    if (!this.lifecycleCanMutate()) return;
    // Freeze the payload now: a later draw may replace or mutate these cards.
    const row = {
      userId,
      seat,
      json: JSON.stringify({ user_id: userId, seat_number: seat, cards }),
    };
    const handNumberAtDeal = this.handCount;
    // Private socket delivery stays synchronous and never waits for PostgREST.
    this.hub?.sendToUser(this.tableId, userId, {
      kind: 'hole_cards',
      row: {
        table_id: this.tableId,
        user_id: userId,
        seat_number: seat,
        hand_number: handNumberAtDeal,
        cards,
      },
    });

    // HandController emits the whole deal synchronously. One microtask groups
    // those rows into the existing array RPC, without an added timer or cache.
    // Each engine owns its queue. Service work and manager generations cannot
    // share it, and the flush inherits the first caller's async authority.
    const authority = currentTournamentDataAuthority();
    const key = JSON.stringify([
      handNumberAtDeal,
      authority?.tournamentId,
      authority?.leaseGeneration,
    ]);
    const batches = (this.holeCardWriteBatches ??= new Map());
    const pending = batches.get(key);
    if (pending) {
      pending.rows.push(row);
      return pending.promise;
    }
    const batch = {
      rows: [row],
      promise: Promise.resolve().then(async () => {
        // Retire the queue BEFORE awaiting HTTP. A later reconnect/draw must
        // get its own write, even while this batch is still in flight.
        if (batches.get(key) === batch) batches.delete(key);
        await this.persistHoleCardBatchWithRetry(handNumberAtDeal, batch.rows);
      }),
    };
    batches.set(key, batch);
    return batch.promise;
  }

  private async persistHoleCardBatchWithRetry(
    handNumberAtDeal: number,
    rows: ReadonlyArray<{ userId: string; seat: number; json: string }>
  ): Promise<void> {
    const payload = '[' + rows.map((row) => row.json).join(',') + ']';
    const isCurrent = () => this.handCount === handNumberAtDeal && this.lifecycleCanMutate();
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!isCurrent()) return;
      try {
        const { error } = await supabase.rpc('insert_hole_cards', {
          p_table_id: this.tableId,
          p_hand_number: handNumberAtDeal,
          p_cards: payload,
        });
        if (!error) return;
        console.warn(
          `[ServerTableEngine:${this.tableId}] insert_hole_cards attempt ${attempt}/3 failed for ${rows.length} seats:`,
          error.message
        );
      } catch (err) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] insert_hole_cards attempt ${attempt}/3 threw for ${rows.length} seats:`,
          err
        );
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
    if (!isCurrent()) return;
    reportError(
      new Error('insert_hole_cards failed after 3 attempts'),
      `ServerTableEngine.${this.tableId}.insert_hole_cards_failed`,
      { seats: rows.map((row) => row.seat), handNumber: handNumberAtDeal }
    );
    // The recovery event carries identities only, never another player's cards.
    for (const row of rows) {
      this.hub?.emitEvent(this.tableId, {
        type: 'hole_cards_unavailable',
        table_id: this.tableId,
        hand_number: handNumberAtDeal,
        user_id: row.userId,
        seat: row.seat,
        timestamp: Date.now(),
      });
    }
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

  /**
   * Could ANY of these busted cash players cover this table's minimum buy-in?
   *
   * Decides whether the felt is worth holding for five seconds. See the call
   * site in the dealing loop for Dan's wording.
   *
   * HORSES ARE PLAYERS (CLAUDE.md 10.5), and this is one of the two places
   * where the horse's INPUT DEVICE legitimately differs: a horse has no member
   * wallet, it is funded from the club treasury by autoRebuyHorse, and its
   * stop-loss is its temperament's (HorseRebuyPolicy: a nit stops at two
   * buy-ins committed, standard at three, a gambler at four). So "can afford"
   * is asked of the treasury path for
   * a horse and of club_members.chip_balance for a human. What must not differ
   * — and does not — is the outcome: a seat that cannot fund a rebuy gets no
   * pause and is stood up, whichever kind of player is in it.
   *
   * Fails OPEN. An unreadable balance, an unknown minimum, or a thrown read all
   * return true, because the cost of a wrong `true` is five seconds and the
   * cost of a wrong `false` is taking a rebuy away from someone who could pay.
   */
  protected async anyBustedPlayerCanAffordARebuy(busted: SeatedPlayer[]): Promise<boolean> {
    if (this.tableInfo?.arena?.asset === 'diamonds') return false;
    if (busted.length === 0) return false;

    const minBuyIn = cashMinBuyIn(this.tableInfo);
    // A table we cannot price is not a table anyone is stood up from.
    if (!Number.isFinite(minBuyIn) || minBuyIn <= 0) return true;

    // A horse inside its stop-loss still has a funding route (the treasury),
    // so it is owed the window. Settlement step 5 does the actual attempt.
    // The stop-loss is the temperament's (HorseRebuyPolicy), the same figure
    // that decides the reload itself - this used to hard-code `< 2`, which
    // held the felt for a nit that was leaving and did not hold it for a
    // gambler that was reloading (2026-09-09).
    const horses = busted.filter((p) => p.is_horse);
    for (const horse of horses) {
      if (!rebuyStopLossReached(horse.user_id, this.horseRebuys.get(horse.user_id) || 0))
        return true;
    }

    const humans = busted.filter((p) => !p.is_horse);
    if (humans.length === 0) return false; // Every horse present is at stop-loss.

    const clubId = this.tableInfo?.club_id || '';
    if (!clubId) return true; // Unknown club -> unknown wallets -> fail open.

    const balances = await readClubChipBalances(
      clubId,
      humans.map((p) => p.user_id).filter(Boolean)
    );

    for (const human of humans) {
      if (!balances.has(human.user_id)) return true; // Unread -> fail open.
      if ((balances.get(human.user_id) ?? 0) >= minBuyIn) return true;
    }
    return false;
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  A BUSTED CASH SEAT IS NOT A SEAT (2026-08-28)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Dan: "MAKE SURE THAT THE USER GETS REMOVED FROM THE TABLE AS SOON AS THEY
   * HAVE NO CHIPS."
   *
   * Called immediately after the rebuy window closes, so by the time it runs
   * every busted seat has either bought back in, declined, or run out of time.
   * Anyone STILL on zero is done, and the seat goes back to the table.
   *
   * CASH ONLY, and the guard is deliberate. A tournament player on zero chips
   * is NOT ours to remove: they are owed a finishing place and possibly a
   * prize, and both are computed by TournamentManager.eliminatePlayer against
   * the set of places still free. An engine that released the seat first would
   * strand exactly that — which is the shape of the 2026-08-20 incident where
   * a tournament disbursed 107% of its pool because two paths disagreed about
   * who owned a finishing place. Tournament settlement and elimination now
   * change the exact roster row and its exact seat generation in one database
   * transaction; this cash-only path must not become a second authority.
   *
   * Operates on `this.seatedPlayers`, which the caller has just reloaded from
   * the database — no second read, and no risk of acting on the pre-hand
   * snapshot. See the call site for why it lives at the top of the loop rather
   * than beside the rebuy pause.
   *
   * A SHORT GRACE, because a 0-chip seat is not always a busted seat. A player
   * who has just taken a seat but whose buy-in has not landed yet is legally at
   * 0 — that is the "Seat Reserved, you'll be dealt in next hand" state, and
   * their chips may be sitting in `table_pending_addons` waiting for the sweep
   * that runs a few lines above this one. Standing them up would take the seat
   * off somebody who had already paid for it. So a seat has to be seen at zero
   * for BUSTED_GRACE_MS before it is released, and a seat with money in flight
   * is skipped outright.
   */
  private bustedSince: Map<string, number> = new Map();

  /** How long a seat must sit at zero before it is released. */
  static readonly BUSTED_GRACE_MS = 10_000;
  /**
   * A heartbeat carrying `rebuyPromptOpen` within this window means the
   * player is at the bust-rebuy dialog; the seat is not released while they
   * are (2026-09-04 second sweep). Heartbeats run every few seconds, so this
   * is two missed beats, not one. The map itself lives on the base class,
   * because the heartbeat (Turns) writes it and this sweep (Dealing) reads it.
   */
  static readonly REBUY_PROMPT_HOLD_MS = 12_000;

  protected async standUpBustedCashPlayers(): Promise<void> {
    if (this.isTournamentTable()) return;
    // THE FREEZE (CLAUDE.md 13.5): the horse twin below checks it twice; this
    // one stood humans up through the break. Same gate, same place.
    if (isMaintenanceFrozen()) return;

    // Horses have their own recovery pass with its own stop-loss and treasury
    // accounting; removing them here too would double-handle the same seat.
    const seated = this.seatedPlayers.filter((p) => p.user_id && !p.is_horse);
    const broke = seated.filter((p) => Number(p.stack ?? 0) <= 0);

    // Anyone who is funded again stops being watched.
    const brokeIds = new Set(broke.map((p) => p.user_id));
    for (const [id] of this.bustedSince) {
      if (!brokeIds.has(id)) this.bustedSince.delete(id);
    }
    if (broke.length === 0) return;

    const now = Date.now();
    const removed: string[] = [];

    /* CHIP STANDARD C3 (2026-09-02): the in-memory `pendingAddOns` map only
       knows about add-ons THIS engine debited. A bust rebuy is debited by the
       browser's atomic_table_rebuy call and lands only as an unresolved
       `table_pending_addons` row (kind 'rebuy'), so the map cannot see it.
       Ask the ledger for every broke seat before releasing any of them; a
       hit also requests the sweep that delivers the chips. An unreadable
       ledger (null) is "maybe owed", and nobody is stood up on a maybe - the
       grace timer keeps running and the next tick asks again. */
    const owed = await this.usersWithPendingLedgerChips(broke.map((p) => p.user_id));
    if (owed === null) return;

    for (const player of broke) {
      /* Money already on its way to this seat. `pendingAddOns` is the queue
         processPendingAddOns drains a few lines above; a player in it has been
         DEBITED already and is owed their chips, not their seat taken away. */
      if (this.pendingAddOns.has(player.user_id) || owed.has(player.user_id)) {
        this.bustedSince.delete(player.user_id);
        continue;
      }

      /* The player is standing at the cashier. A fresh rebuy-prompt heartbeat
         restarts the grace: the clock measures how long a seat sat at zero
         with NOBODY minding it, not how long a human took to decide. */
      const promptSeen = this.rebuyPromptOpenAt.get(player.user_id) ?? 0;
      if (now - promptSeen < ServerTableEngineDealing.REBUY_PROMPT_HOLD_MS) {
        this.bustedSince.set(player.user_id, now);
        continue;
      }

      const firstSeen = this.bustedSince.get(player.user_id);
      if (firstSeen === undefined) {
        this.bustedSince.set(player.user_id, now);
        continue;
      }
      if (now - firstSeen < ServerTableEngineDealing.BUSTED_GRACE_MS) continue;

      /* Never remove a player who is all-in in a live hand. Same rule the
         eviction sweep and leaveTable both enforce — a seat cannot leave the
         table mid-all-in (Dan 2026-08-26). Belt and braces: this runs between
         hands, so handController should already be null. */
      const liveHand = this.handController?.getState();
      const inHand = liveHand?.players.find((p) => p.user_id === player.user_id);
      if (inHand?.is_all_in && !inHand.is_folded) continue;

      /* One door out for a busted seat (releaseBustedSeat): the money path,
         then the event, then the trackers - and on a failed write nothing at
         all, so the roster and grace tracking wait for a later sweep to ask
         the same cashout again. An unknown outcome is not a leave. */
      const released = await this.releaseBustedSeat(player, 'busted_no_rebuy');
      if (!released) continue;
      this.bustedSince.delete(player.user_id);
      this.rebuyPromptOpenAt.delete(player.user_id);
      removed.push(player.occupancy_id!);
      console.log(
        `[ServerTableEngine:${this.tableId}] ${player.username} busted and did not rebuy - seat ${player.seat_number} released`
      );
    }

    if (removed.length > 0) {
      this.seatedPlayers = this.seatedPlayers.filter(
        (sp) => !sp.occupancy_id || !removed.includes(sp.occupancy_id)
      );
    }
  }

  protected async recoverBustedSeatedHorses(): Promise<void> {
    if (this.tableInfo?.arena?.asset === 'diamonds') return;
    if (isMaintenanceFrozen()) return;
    const bustHorses = this.seatedPlayers.filter((p) => p.is_horse && p.stack <= 0);
    if (bustHorses.length === 0) return;

    const now = Date.now();
    for (const horse of bustHorses) {
      if (isMaintenanceFrozen()) return;
      const lastAttempt = this.bustRecoveryLastAttempt.get(horse.user_id) || 0;
      if (now - lastAttempt < 30000) continue;
      this.bustRecoveryLastAttempt.set(horse.user_id, now);

      const currentRebuys = this.horseRebuys.get(horse.user_id) || 0;

      // Stop-loss: the SAME rule Settlement step 5 applies (HorseRebuyPolicy,
      // the temperament's own figure). This site used to hard-code `>= 2`
      // while Settlement had moved on, which is the "two sites reloading on
      // two different rules" the comment below warns about.
      if (atRebuyStopLoss(horse.user_id, currentRebuys)) {
        /* HORSES ARE PLAYERS (CLAUDE.md 10.5): the same door the busted human
           leaves through - money path, then `seat_left`, then the trackers -
           so a busted horse's seat clears on every client at the same moment
           a human's does. Timing is part of the treatment (Dan 2026-08-27). */
        const released = await this.releaseBustedSeat(horse, 'busted_stop_loss');
        if (!released) continue;
        this.horseRebuys.delete(horse.user_id);
        this.bustRecoveryLastAttempt.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Dead-table recovery: Horse ${horse.username} at stop-loss - removed.`
        );
        continue;
      }

      // Same decision as the settlement path, for the same reasons - see
      // HorseRebuyPolicy. Two sites reloading on two different rules is how a
      // horse ends up disciplined on one code path and not the other.
      const rebuyAmount = await horseRebuyAmount({
        clubId: this.tableInfo?.club_id || '',
        tableId: this.tableId,
        userId: horse.user_id,
        bigBlind: Number(this.tableInfo?.big_blind) || 0,
        minBuyIn: this.tableInfo?.min_buy_in as number | null | undefined,
        maxBuyIn: this.tableInfo?.max_buy_in as number | null | undefined,
        rebuysTaken: currentRebuys,
      });
      if (isMaintenanceFrozen()) return;
      const funding =
        rebuyAmount > 0
          ? await autoRebuyHorse(
              this.tableId,
              horse.user_id,
              rebuyAmount,
              this.tableInfo?.club_id || '',
              this.handCount
            )
          : { status: 'declined' as const };
      // An unreadable response may follow a committed transfer. Preserve the seat.
      if (funding.status === 'unknown') return;
      if (funding.status === 'funded') {
        horse.stack = funding.stack;
        this.horseRebuys.set(horse.user_id, currentRebuys + 1);
        this.bustRecoveryLastAttempt.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Dead-table recovery: rebought ${horse.username} -> ${rebuyAmount} chips (Rebuy #${currentRebuys + 1})`
        );
      } else {
        const released = await this.releaseBustedSeat(horse, 'busted_unfunded');
        if (!released) continue;
        this.horseRebuys.delete(horse.user_id);
        this.bustRecoveryLastAttempt.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Dead-table recovery: Horse ${horse.username} left - insufficient treasury funds`
        );
      }
    }
  }
}
