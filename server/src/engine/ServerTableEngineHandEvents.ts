/**
 * ServerTableEngine, layer 7/8 — the HandController event switch.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import * as EngineMetrics from '../observability/engineInstruments.js';
import { HandController } from './HandController.js';
import type { Street as ShadowStreet } from './eventlog/events.js';
import { logHandHistory } from '../services/supabase.js';
import type { HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { ServerTableEngineSettlement } from './ServerTableEngineSettlement.js';

export abstract class ServerTableEngineHandEvents extends ServerTableEngineSettlement {
  /**
   * SHOWDOWN POLISH 2026-08-25 (spec 16/19/33): fold the unmerged per-pot
   * awards into ORDERED display groups for pot_win — board 1 before board 2,
   * main pot before side pots, the high half before the low half. Each group
   * carries its winners with the exact post-rake share of that pot(-half),
   * plus the hand identity that won it (for a low, the qualifying low's own
   * self-describing name). Presentation data only; a failure here must never
   * break the payout event, so the whole build is fenced.
   */
  protected buildPotAwardGroups(): Array<{
    pot_index: number;
    /** 1|2 on double-board bomb pots; RUN index 1..3 on run-it-twice hands. */
    board: number;
    low: boolean;
    winners: Array<{
      user_id: string;
      amount: number;
      hand_name: string;
      hand_description: string;
      hole_card_indices: number[];
    }>;
  }> {
    try {
      const awards = this.currentHandPerPotAwards;
      if (!awards || awards.length === 0) return [];
      const keyOf = (a: (typeof awards)[number]) =>
        `${a.board ?? 1}|${a.potIndex}|${a.low ? 1 : 0}`;
      const groups = new Map<string, typeof awards>();
      for (const a of awards) {
        const k = keyOf(a);
        const g = groups.get(k);
        if (g) g.push(a);
        else groups.set(k, [a]);
      }
      const orderedKeys = [...groups.keys()].sort((x, y) => {
        const [bx, px, lx] = x.split('|').map(Number);
        const [by, py, ly] = y.split('|').map(Number);
        if (bx !== by) return bx - by;
        if (px !== py) return px - py;
        return lx - ly;
      });
      return orderedKeys.map((k) => {
        const g = groups.get(k)!;
        const [board, potIndex, low] = k.split('|').map(Number);
        return {
          pot_index: potIndex,
          board: board >= 1 ? board : 1,
          low: low === 1,
          winners: g.map((a) => {
            const sd = this.currentHandShowdownResults.find((r) => r.userId === a.userId);
            const holeIndices: number[] = [];
            try {
              const cards = a.hand?.cards;
              if (sd && Array.isArray(cards)) {
                const used = new Set(cards.map((c) => `${c?.rank}${c?.suit}`));
                (sd.holeCards ?? []).forEach((c, i) => {
                  if (used.has(`${c?.rank}${c?.suit}`)) holeIndices.push(i);
                });
              }
            } catch {
              /* decoration only */
            }
            return {
              user_id: a.userId,
              amount: a.amount,
              // A low hand's name IS its description ("Low: 8-6-4-3-2").
              hand_name: a.hand?.name ?? '',
              // Review fix 2026-08-25: prefer the description the engine
              // computed for THIS entry's hand (a.handDescription). Falling
              // back to the showdown result's description is wrong on
              // double-board hands — sd carries the BOARD-1 hand, so board-2
              // groups paired a board-2 name with a board-1 description.
              hand_description: a.low
                ? (a.hand?.name ?? '')
                : (a.handDescription ?? sd?.handDescription ?? ''),
              hole_card_indices: holeIndices,
            };
          }),
        };
      });
    } catch {
      // Never let the display breakdown break pot_win.
      return [];
    }
  }
  protected async handleHandEvent(
    event: HandEvent,
    players: SeatedPlayer[],
    persistenceGeneration?: number
  ): Promise<void> {
    switch (event.type) {
      case 'HAND_START':
        // Watchdog liveness: a dealt hand is proof the table is alive.
        this.markProgress();
        // FIX 2 (2026-07-24): start a fresh per-hand hole-card cache used for
        // reliable re-push to reconnecting players.
        this.currentHandHoleCards.clear();
        // Round 38 fix: capture wall-clock start so logHandHistory can stamp
        // started_at correctly. Without this, the row's started_at defaulted
        // to the INSERT time (which is hand-end), making replay timestamps
        // and audit reconciliation impossible.
        this.currentHandStartedAt = Date.now();
        // Bible V8 §1.16 (Real-Time Law): emit a discrete hand_started event
        // so the client can immediately reset visual state (clear last action
        // badges, clear community cards, trigger the deal animation) without
        // waiting for the snapshot to arrive and diff-detect.
        this.hub?.emitEvent(this.tableId, {
          type: 'hand_started',
          table_id: this.tableId,
          hand_number: this.handCount,
          dealer_seat: this.handController?.getState().dealerSeat ?? 0,
          timestamp: Date.now(),
        });
        this.broadcastCurrentState();
        break;

      case 'BOMB_POT_TRIGGERED' as any: {
        // Fan the engine's bomb-pot announcement out to the table so
        // BombPotOverlay can explain the forced ante before the flop lands.
        // Board count, in preference order: the event's own figure (post
        // deck-feasibility downgrade), the controller's live count (covers an
        // older HandController build emitting without the field), then the
        // legacy boolean.
        const bpBoardCount =
          (event as any).boardCount ??
          this.handController?.getActiveBoardCount?.() ??
          ((event as any).doubleBoard ? 2 : 1);
        // VARIANT OVERRIDE 2026-08-28 (spec §10.1): what game this bomb hand
        // is being played as — clients label the intro ("PLO4 DOUBLE BOARD")
        // and adjust villain card-backs from it.
        const bpVariant = this.handController?.getGameVariant?.() ?? this.dealtGameVariant();
        this.hub?.emitEvent(this.tableId, {
          type: 'bomb_pot_triggered',
          table_id: this.tableId,
          hand_number: this.handCount,
          ante_amount: (event as any).anteAmount,
          bb_multiplier: (event as any).bbMultiplier,
          // DOUBLE-BOARD BOMB POT 2026-08-20: whether this hand runs two
          // boards, plus per-seat postings for the ante-chip presentation.
          double_board: (event as any).doubleBoard ?? false,
          // TRIPLE-BOARD 2026-08-27: the actual board count (1-3, after any
          // deck-feasibility downgrade) — the overlay badges from this.
          board_count: bpBoardCount,
          // VARIANT OVERRIDE (spec §10.1): the hand's variant, always sent —
          // clients compare it to the table's own game to decide whether to
          // badge the override.
          variant: bpVariant,
          postings: (event as any).postings ?? [],
          timestamp: Date.now(),
        });
        // BOMB POT STANDARDIZATION 2026-08-27 (spec §20): freeze the bomb
        // facts for hand_history.bomb_pot — trigger reason, the equal forced
        // ante, and the boards actually dealt.
        this.currentHandBombPot = {
          trigger_reason: (event as any).triggerReason ?? 'every_n_hands',
          ante_amount: (event as any).anteAmount ?? 0,
          board_count: bpBoardCount,
          variant: bpVariant,
        };
        break;
      }

      case 'BOMB_POT_COMPLETED' as any: {
        // DOUBLE-BOARD BOMB POT 2026-08-20: tell the table the bomb-pot hand
        // is settled so BombPotOverlay dismisses with the hand.
        this.hub?.emitEvent(this.tableId, {
          type: 'bomb_pot_completed',
          table_id: this.tableId,
          hand_number: this.handCount,
          timestamp: Date.now(),
        });
        break;
      }

      case 'BLINDS_POSTED' as any: {
        // Bible V8 §1.16: discrete blinds_posted event so the client animates
        // SB/BB chips flying from each blind seat into the pot, instead of
        // letting the chips just appear in the pot via snapshot.
        const postings = (event as any).postings as
          | Array<{ seat: number; type: string; amount: number }>
          | undefined;
        if (postings && postings.length > 0) {
          this.hub?.emitEvent(this.tableId, {
            type: 'blinds_posted',
            table_id: this.tableId,
            hand_number: this.handCount,
            postings,
            timestamp: Date.now(),
          });
        }
        // ── ADDITIVE event-sourcing shadow (#1): record BlindsPosted ──
        if (this.shadowRecorder && postings && postings.length > 0) {
          this.shadowRecorder.recordBlindsPosted(
            postings.map((bp) => ({
              seat: bp.seat,
              kind: this.shadowBlindKind(bp.type),
              amount: bp.amount,
            }))
          );
        }
        // No broadcast here — TURN_CHANGE will follow shortly with full snapshot.
        //
        // Dan 2026-08-20: "shortly" meant the SAME TICK, which is the turn bug
        // again at the START of a hand. The deal animation is the longest one
        // at the table — 12 cards on an 80ms stagger with a 320ms flight,
        // ~1.2s — and the blinds fly for another 400ms on top. Both were still
        // in the air when the first player went on the clock and their action
        // began. Stamp the moment the blinds land so the first TURN_CHANGE of
        // the hand stretches to handStartSettleMs and the table is actually
        // dealt in before anyone acts.
        this.lastHandStartAtMs = Date.now();
        break;
      }

      /**
       * FORCED MONEY GOES INTO THE HAND RECORD (2026-08-27).
       *
       * `actions` is the only per-hand log that is persisted, and until today
       * it contained no blind, no ante, no straddle and no dead blind — the
       * engine moved those chips and emitted a bus event, and the record kept
       * nothing. Every consumer rebuilding a pot, an investment or a stack
       * from `hand_history` was therefore short by exactly the forced money.
       *
       * Measured before this: the reconstruction lands on the stored
       * `pot_size` on 99.18% of the 4,000 most recent live hands, and every
       * miss is a hand carrying an ante or a straddle.
       *
       * These rows are ADDITIVE. src/utils/handReplay.ts already synthesises
       * the two blinds from `small_blind`/`big_blind` for the millions of rows
       * that predate this, and stands down the moment the log carries real
       * post rows — so old and new hands both rebuild correctly, and no
       * backfill is needed or possible.
       */
      case 'FORCED_BETS_POSTED' as never: {
        const postings = (
          event as never as {
            postings?: Array<{
              seat: number;
              userId: string;
              kind: string;
              amount: number;
              dead?: boolean;
            }>;
          }
        ).postings;
        /**
         * THE ANTE IS SEEN LEAVING THE PLAYER (Dan 2026-09-04): "IF THERE IS
         * AN ANTE, THAT NEEDS TO BE TAKEN FROM THE PLAYER AND ADDED TO THE
         * POT PRE FLOP." The money already moves that way - postBlinds adds a
         * regular ante straight to state.pot, so the pot pill has always
         * counted it from the first snapshot. What the table never SHOWED
         * was the chips going: BLINDS_POSTED carries only the SB and BB (and
         * says so, above), and a bomb ante flies at the blast, but a plain
         * ante just made every stack a little smaller and the pot a little
         * bigger with nothing in between. This event is the presentation the
         * bomb ante already has, for the regular ante: every seat that posted
         * one, and how much, so the client can fly it to the middle.
         */
        if (Array.isArray(postings)) {
          const antePostings = postings
            .filter((p) => p && p.kind === 'ante' && p.amount > 0)
            .map((p) => ({ seat: p.seat, amount: p.amount }));
          if (antePostings.length > 0) {
            this.hub?.emitEvent(this.tableId, {
              type: 'antes_posted',
              table_id: this.tableId,
              hand_number: this.handCount,
              postings: antePostings,
              timestamp: Date.now(),
            });
          }
          for (const p of postings) {
            if (!p || !(p.amount > 0)) continue;
            this.currentHandActions.push({
              seat: p.seat,
              userId: p.userId ?? '',
              action: p.kind,
              amount: p.amount,
              timestamp: Date.now(),
              stage: 'preflop',
              // DEAD money is in the pot but not in the live bet level. A
              // reader that differences a raise-TO level against everything a
              // seat has committed will understate every raise made by anyone
              // who posted an ante, so the distinction travels with the row.
              dead: p.dead === true,
            });
          }
        }
        break;
      }

      /**
       * THE UNCALLED BET COMES BACK ON THE RECORD TOO.
       *
       * `returnUncalledBet` moves the chips and emits this event, and nothing
       * persisted it — so the log showed a player betting 900 and never
       * getting it back, while `pot_size` and the ending stack both already
       * excluded it. Every reader had to INFER the return from the shape of
       * the street to make the arithmetic close.
       *
       * Stored POSITIVE, like every other amount in this array. It is the verb
       * that carries the direction; a negative number in a column of positive
       * ones is how a reader that does not know the verb silently under-counts
       * a pot.
       */
      case 'UNCALLED_BET_RETURNED' as never: {
        const e = event as never as { seat?: number; userId?: string; amount?: number };
        if (e && typeof e.amount === 'number' && e.amount > 0) {
          this.currentHandActions.push({
            seat: e.seat ?? 0,
            userId: e.userId ?? '',
            action: 'return',
            amount: e.amount,
            timestamp: Date.now(),
            stage: this.handController?.getState()?.stage || 'river',
          });
        }
        break;
      }

      case 'CARDS_DEALT':
        // Write hole cards to RLS-protected table for secure per-player delivery.
        // The client subscribes to table_hole_cards INSERTs (RLS filters to own cards only).
        // This prevents card data from leaking via the public Realtime broadcast.
        if (event.seat !== undefined && event.cards && this.handController) {
          const state = this.handController.getState();
          const player = state.players.find((p) => p.seat === event.seat);
          if (player) {
            // FIX 2 (2026-07-24): cache the dealt cards in memory so we can
            // re-push them to a reconnecting/RESYNCing player, and make the RLS
            // insert reliable (awaited + retried) instead of fire-and-forget.
            this.currentHandHoleCards.set(player.user_id, {
              seat: player.seat,
              cards: event.cards,
            });
            await this.persistHoleCardsWithRetry(player.user_id, player.seat, event.cards);
          }
        }
        // ── ADDITIVE event-sourcing shadow (#1): record HoleCardsDealt once per hand ──
        if (this.shadowRecorder && !this.shadowHoleCardsRecorded) {
          const perPlayer = Array.isArray(event.cards) ? event.cards.length : 2;
          this.shadowRecorder.recordHoleCardsDealt(perPlayer);
          this.shadowHoleCardsRecorded = true;
        }
        // Do NOT broadcast state here — cards are delivered securely via table_hole_cards
        break;

      /**
       * PHASE 4 2026-09-01 - the discarded card, to its own player only.
       *
       * Deliberately shaped exactly like CARDS_DEALT above, because it is the
       * same problem: a card that ONE person may see, on a platform whose
       * broadcast everybody hears. The public `player_action` event for this
       * discard has already gone out carrying a seat and a word; this carries
       * the card and goes to Postgres instead, behind
       * `hand_discards_read_own` (auth.uid() = user_id).
       *
       * There is no `this.hub?.emitEvent` in this case and there must never
       * be one. In Crazy Pineapple the discard is not revealed on the discard
       * and not revealed at showdown - it is the one card in the deck nobody
       * else is ever entitled to see.
       */
      case 'PINEAPPLE_DISCARDED': {
        if (event.seat === undefined || !event.card || !this.handController) break;
        const seated = this.handController.getState().players.find((p) => p.seat === event.seat);
        if (!seated?.user_id) break;
        await this.persistDiscardedCard(seated.user_id, event.seat, event.card);
        break;
      }

      case 'TURN_CHANGE': {
        // ═══════════════════════════════════════════════════════════════════
        // Dan 2026-08-20: "every player's action MUST GO IN TURN. Their action
        // MUST BE DISPLAYED, an animation MUST PLAY after every decision. NO
        // action for any horse or player can EVER be skipped or rushed. THE
        // GAME SPEED NEEDS TO SLOW DOWN TO FEEL MORE REAL — focus on the user
        // experience rather than getting more hands dealt."
        //
        // Every action path in the engine — human submit, horse think-timer,
        // queued pre-action, turn timeout, time-bank expiry, disconnect
        // auto-action — ends by advancing the turn, and they ALL funnel
        // through this one event. Previously the ACTION broadcast and this
        // TURN_CHANGE went out back to back in the same tick, so the acting
        // seat's chips (cpSlideIn, 500ms) and its action label had no airtime
        // before the spotlight, the clock and the next player's animation took
        // over. With several pre-actions queued, an entire betting round could
        // resolve in a few milliseconds and read as though players had been
        // skipped entirely.
        //
        // One settle beat here paces EVERY action path at once, and cannot be
        // bypassed by any individual caller. It is deliberately longer than
        // the 500ms chip slide so the wager is fully on the felt and readable
        // before the turn moves on.
        //
        // This costs hands/hour. That is the intended trade.
        if (this.running && this.handController) {
          const handAtAction = this.handCount;
          const controllerAtAction = this.handController;
          // A street was just dealt -> the board reveal owns this beat, and it
          // is longer than an ordinary action's. Anything older than a second
          // is a normal action, not a fresh board.
          const justDealtStreet = Date.now() - this.lastStreetDealtAtMs < 1000;
          // The hand was just dealt -> the deal + blinds own this beat, and it
          // is the longest of the three.
          const justStartedHand = Date.now() - this.lastHandStartAtMs < 1000;
          await this.sleep(
            justStartedHand
              ? this.handStartSettleMs
              : justDealtStreet
                ? this.streetSettleMs
                : this.actionSettleMs
          );
          // The table can be torn down, or the hand replaced, while we settle.
          if (
            !this.running ||
            this.handController !== controllerAtAction ||
            this.handCount !== handAtAction
          ) {
            break;
          }
        }
        // ROOT-CAUSE FIX 2026-04-14 (Dan: "I timed out and the engine moved
        // on without giving me a chance to act"). Prior flow broadcast the
        // snapshot and the discrete turn_change event while
        // playerTurnStartTime / playerTurnDuration still held the PREVIOUS
        // turn's values. Snapshots therefore carried a deadline_ms /
        // turn_deadline_ms in the past (or 0 on hand #1), so the client's
        // countdown was already at zero the moment the hero's panel
        // rendered — the hero looked timed out before their turn began.
        //
        // Fix respects Bible V8 §1.2.3 (broadcast confirms before next turn)
        // AND §6.1 (deadline-based, server-authoritative). We compute the
        // intended deadline up front, stamp it onto playerTurnStartTime /
        // playerTurnDuration so broadcasts have the right deadline, emit
        // the real-time event and snapshot, THEN arm the enforcement timer.
        // 2026-08-26: this used to claim "the timer call below skips
        // re-stamping when the deadline already matches, so there is no
        // drift." That is not true. startTurnTimer stamps
        // `playerTurnStartTime = Date.now()` unconditionally - there is no
        // such guard anywhere in it - so the deadline computed here is
        // re-stamped a moment later and the two differ by however long the
        // broadcast took. The drift is small and has never been the cause of a
        // reported bug, which is exactly why a comment asserting it cannot
        // happen is the dangerous part: it stops the next person looking.
        // Stated accurately instead of reassuringly.
        // STALE-HANDLER GUARD (2026-08-22): TURN_CHANGE handlers are
        // dispatched fire-and-forget, so a fast action landing during the
        // settle beat spawns a SECOND handler for the next seat while this one
        // is still pending. Without this check the stale handler re-stamped
        // playerTurnStartTime/Duration and re-armed the clock for a seat that
        // had already acted — the live player's deadline jumped (countdown
        // ring reset / over-ran) and DisconnectEngine.onPlayerTurn could start
        // a spurious 30s countdown against the OLD player. Only the handler
        // whose seat is still on the clock may proceed.
        if (this.handController?.getState().currentPlayerSeat !== event.seat) {
          break;
        }

        const tcSeatedPlayer = players.find((p) => p.seat_number === event.seat);

        const baseActionTime = this.tableInfo?.action_time_seconds || 15;
        const inReconnectGrace = tcSeatedPlayer?.user_id
          ? this.disconnectEngine.isInReconnectGrace(this.tableId, tcSeatedPlayer.user_id)
          : false;
        const effectiveActionSec = inReconnectGrace ? baseActionTime + 5 : baseActionTime;

        // Stamp the intended deadline NOW so the broadcast carries the
        // current turn's real deadline (start + duration * 1000). The
        // actual DeadlineScheduler registration happens in startTurnTimer
        // below; it reads the same fields so the client + server agree.
        this.playerTurnStartTime = Date.now();
        this.playerTurnDuration = effectiveActionSec;
        this.timeBankActivatedThisTurn = false;

        // 2026-08-15 ROOT-CAUSE FIX (freeze at preflop, first actor never acts).
        //
        // The old order was: await broadcastCurrentState() -> hub.emitEvent()
        // -> handleTurnChange(). handleTurnChange is the ONLY line that arms a
        // clock and the only line that schedules a horse's action. Neither of
        // the two calls above it was wrapped: broadcastCurrentState does a bare
        // hub.publish (structuredClone + JSON-patch diff + a send() per socket),
        // and this emitEvent was the one hub.emitEvent call site in the engine
        // WITHOUT a try/catch. A throw from either — one bad subscriber socket
        // is enough — skipped handleTurnChange entirely. No clock, no horse
        // action, no auto-fold, and the rejection swallowed by index.ts. The
        // hand sat at preflop forever.
        //
        // The shot clock is not best-effort; delivery is. Arm first, deliver
        // after, and let neither failure mode reach the other. The deadline
        // fields were stamped moments ago, so the snapshot that follows still
        // carries the correct turn_deadline_ms — no drift versus the old order.
        this.markProgress();
        try {
          // Dan 2026-08-20: handleTurnChange is async now — a queued
          // pre-action holds a visible beat before it lands. Deliberately NOT
          // awaited: for an ordinary turn nothing before startTurnTimer yields,
          // so the clock is still armed synchronously ahead of the broadcast
          // below, exactly as before. Only the pre-action path suspends, and it
          // owns its own turn end-to-end. The .catch keeps the shot-clock
          // fallback reachable for an ASYNC rejection, which the surrounding
          // try/catch (synchronous throws only) cannot see.
          void this.handleTurnChange(event, players).catch((err) => {
            reportError(err, 'ServerTableEngine.' + this.tableId + '.handleTurnChange_rejected');
            this.forceArmTurnTimer(event.seat, effectiveActionSec);
          });
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.handleTurnChange_threw');
          this.forceArmTurnTimer(event.seat, effectiveActionSec);
        }

        try {
          await this.broadcastCurrentState();
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.broadcast_threw');
        }

        // Bible V8 §1.16 (Real-Time Law): discrete turn_change event. Now
        // carries the correct absolute deadline for the CURRENT player.
        try {
          this.hub?.emitEvent(this.tableId, {
            type: 'turn_change',
            table_id: this.tableId,
            hand_number: this.handCount,
            seat: event.seat,
            user_id: tcSeatedPlayer?.user_id ?? '',
            deadline_ms: this.playerTurnStartTime + this.playerTurnDuration * 1000,
            timestamp: Date.now(),
          });
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.turn_change_emit_threw');
        }
        break;
      }

      case 'PLAYER_ACTION':
        // Watchdog liveness: an accepted action is the strongest proof of life.
        this.markProgress();
        // Track action for hand history
        if (event.seat !== undefined && event.action) {
          const hcState = this.handController?.getState();
          /*
           * THE STAGE COMES FROM THE EVENT (2026-09-01, measured).
           *
           * This used to be `hcState?.stage` alone - the stage read off the
           * LIVE controller at the moment this handler runs, not the stage the
           * action was actually taken on. HandController emits PLAYER_ACTION
           * and then calls advanceGame(), so whenever the emit does not drain
           * synchronously ahead of that, the stage has already moved on by the
           * time this line executes. When a whole hand's events drain late,
           * every action in it is stamped with the stage the hand ENDED on.
           *
           * MEASURED on 2026-08-31: 517 real play actions - 151 check, 127
           * call, 78 fold, 73 bet, 55 all_in, 33 raise - were persisted with
           * stage 'showdown', across 30 hands, at about 17 actions per hand.
           * Whole hands, not stray actions. hand_history for one of them
           * (5e969448-bf2d-4e16-a551-660119e7f37a) holds 23 actions: the two
           * blinds correct at 'preflop' (they are stamped literally, further
           * up this file) and all 21 subsequent actions at 'showdown'.
           *
           * It is not cosmetic. HorseHandReview keys heroPre, postflopActed
           * and every river detector off this field, so on those hands
           * postflopActed is true for a hand that never saw a flop, and a
           * preflop shove reads as river aggression.
           *
           * The event now carries the stage, stamped by HandController at the
           * instant of the action from the same value it writes to its own
           * actionHistory. The live-state read stays as a fallback so an
           * emitter that has not been updated still behaves exactly as before.
           */
          const stage = event.stage ?? hcState?.stage ?? 'preflop';
          const actingPlayer = hcState?.players.find((p) => p.seat === event.seat);
          this.currentHandActions.push({
            seat: event.seat,
            userId: actingPlayer?.user_id ?? '', // Bible V8 §2.5
            action: event.action,
            amount: event.amount,
            timestamp: Date.now(), // Bible V8 §2.5
            stage,
            // V12.3: carry isFullRaise into hand_history. HandController
            // records it on its own actionHistory (a short all-in is NOT a
            // raise, TDA 44) but it was dropped here, so every consumer of the
            // persisted array saw an all-in with no flag. HorseMind.observe
            // requires `isFullRaise === true` to count aggression, and its
            // call/fold branches do not match 'all_in' either — so in the 72h
            // boot replay every all-in counted as NEITHER aggression NOR
            // passivity, biasing hydrated reads passive for anyone who shoves
            // and hiding all-in 3-bets from the anti-exploit pair counters.
            isFullRaise: hcState?.actionHistory[hcState.actionHistory.length - 1]?.isFullRaise,
          });

          // ── ADDITIVE event-sourcing shadow (#1): record PlayerActed ──
          if (this.shadowRecorder) {
            this.shadowRecorder.recordPlayerActed(
              event.seat,
              event.action as never,
              event.amount ?? 0
            );
          }

          // Bible V8 §4.15: When a bet or raise occurs, invalidate all auto_check pre-actions
          // (they're no longer valid because there's now a bet to face)
          if (event.action === 'bet' || event.action === 'raise' || event.action === 'all_in') {
            const actingPlayer = this.seatedPlayers.find((p) => p.seat_number === event.seat);
            this.preActionEngine.onBetPlaced(this.tableId, actingPlayer?.user_id || '');
          }

          // 2026-04-14 USER FEEDBACK FIX: emit a discrete player_action event so
          // the client can fire Bible V8 §5.1/§5.2 visual sequence
          // (action label → chip-to-pot animation → sound → turn indicator).
          // Previously the only signal was the full state snapshot, which the
          // client used to update pot only — chip animations + action labels
          // never fired because their handler was on the deleted Supabase
          // Realtime channel. The full state broadcast still follows below.
          this.hub?.emitEvent(this.tableId, {
            type: 'player_action',
            table_id: this.tableId,
            hand_number: this.handCount,
            seat: event.seat,
            user_id: actingPlayer?.user_id ?? '',
            action: event.action,
            amount: event.amount ?? 0,
            stage,
            timestamp: Date.now(),
          });
        }
        this.broadcastCurrentState();
        break;

      case 'COMMUNITY_CARDS':
        // Watchdog liveness: dealing a street is proof of life. Without this
        // an insurance/RIT window (up to 3 x 20s + 18s) exceeds
        // WATCHDOG_STALL_MS and the watchdog attacks a HEALTHY hand.
        this.markProgress();
        // Dan 2026-08-20: same bug class as the turn bug. HandController deals
        // the street and then sets currentPlayerSeat + emits TURN_CHANGE in the
        // SAME synchronous call, so the board reveal raced the next player's
        // clock. The flop is the worst case: it lands (300ms) and only then
        // fans open (420ms, starting ~520ms in), so it needs ~940ms — more
        // than the 650ms ordinary action settle. Stamping the street here lets
        // the TURN_CHANGE settle below stretch to streetSettleMs, giving the
        // board time to finish revealing AND a beat to be read before anyone
        // is put on the clock.
        this.lastStreetDealtAtMs = Date.now();
        {
          // Bible V8 §6.2: 2 time bank activations PER STREET. A new street is
          // dealt here, so the allowance refreshes. Without this the limit
          // silently degrades to 2 per hand, which is what it used to be.
          this.timeBankEngine.resetStreetActivations(this.tableId);
          if (event.stage === 'flop') this.currentHandWentToFlop = true;
          if (event.cards) {
            // Round 39 audit Pass 3 fix: HandController.dealCommunityCards()
            // emits ONLY the new cards for the current stage (3 for flop, 1 for
            // turn, 1 for river — see HandController.ts:597/622/629). Previously
            // we REPLACED currentHandCommunityCards with event.cards, so a hand
            // that went to the river persisted only the 1 river card to
            // hand_history.community_cards (verified live: hand 268 had 19
            // actions ending on the river but only ["6spades"] stored). Fix:
            // flop resets, turn/river APPEND. This now mirrors HandController's
            // own state.communityCards which already accumulates correctly.
            const newCards = event.cards.map((c: any) =>
              typeof c === 'string' ? c : `${c.rank}${c.suit}`
            );
            if (event.stage === 'flop') {
              this.currentHandCommunityCards = newCards;
            } else {
              this.currentHandCommunityCards = [...this.currentHandCommunityCards, ...newCards];
            }
          }
          // DOUBLE-BOARD BOMB POT 2026-08-20: board 2 accumulates the same way.
          const evCards2 = (event as { cards2?: import('../types.js').Card[] }).cards2;
          if (evCards2 && evCards2.length > 0) {
            const newCards2 = evCards2.map((c: any) =>
              typeof c === 'string' ? c : `${c.rank}${c.suit}`
            );
            if (event.stage === 'flop') {
              this.currentHandCommunityCards2 = newCards2;
            } else {
              this.currentHandCommunityCards2 = [...this.currentHandCommunityCards2, ...newCards2];
            }
          }
          // TRIPLE-BOARD BOMB POT 2026-08-27: board 3 accumulates the same way.
          const evCards3 = (event as { cards3?: import('../types.js').Card[] }).cards3;
          if (evCards3 && evCards3.length > 0) {
            const newCards3 = evCards3.map((c: any) =>
              typeof c === 'string' ? c : `${c.rank}${c.suit}`
            );
            if (event.stage === 'flop') {
              this.currentHandCommunityCards3 = newCards3;
            } else {
              this.currentHandCommunityCards3 = [...this.currentHandCommunityCards3, ...newCards3];
            }
          }
          // Bible V8 §1.16 (Real-Time Law): emit discrete community_cards_dealt
          // so the client slides the flop/turn/river cards onto the board with
          // the spec animation (§6 community cards dealing) the millisecond the
          // engine flips them — not whenever the next snapshot arrives.
          this.hub?.emitEvent(this.tableId, {
            type: 'community_cards_dealt',
            table_id: this.tableId,
            hand_number: this.handCount,
            stage: event.stage,
            // Send only the NEW cards for this stage so the client can animate
            // just the additions (3 for flop, 1 each for turn/river).
            new_cards: event.cards ?? [],
            // Full board too, for clients that want to render the complete
            // state without diffing.
            board: this.currentHandCommunityCards,
            // DOUBLE-BOARD BOMB POT 2026-08-20: board 2 (both empty arrays
            // and the fields absent mean "single board" to the client).
            new_cards2: evCards2 ?? [],
            board2: this.currentHandCommunityCards2,
            // TRIPLE-BOARD BOMB POT 2026-08-27: board 3, same contract.
            new_cards3: evCards3 ?? [],
            board3: this.currentHandCommunityCards3,
            timestamp: Date.now(),
          });
          // ── ADDITIVE event-sourcing shadow (#1): record StreetAdvanced ──
          if (this.shadowRecorder && event.stage) {
            this.shadowRecorder.recordStreetAdvanced(event.stage as ShadowStreet);
          }
          // A7 FIX (2026-08-08): verify chip conservation AT EVERY STREET, while
          // the pot still exists.
          //
          // The verifier previously ran only at HAND_COMPLETE and only summed
          // stacks, which made in-street chip creation structurally invisible: the
          // extra chips sat in the pot, and by the time the check ran the pot had
          // been distributed, so the drift was already folded into a winner's
          // stack where it looked like a legitimate win. Checking here — flop,
          // turn and river — is what actually closes that hole, and it also
          // catches a pot that has drifted from the sum of what players paid in.
          //
          // Safe to assert exact conservation mid-hand: withdrawChips is rejected
          // outright while a hand is live, and a mid-hand add-on is queued rather
          // than applied to the live stack, so nothing legitimately moves chips
          // in or out between the deal and settlement.
          this.verifyStreetIntegrity();
          this.broadcastCurrentState();
          break;
        }

      case 'PINEAPPLE_DISCARD_REQUIRED':
        // FIX 120: Crazy Pineapple — broadcast discard requirement to all players
        // Each player must discard 1 of their 3 hole cards within the action timer.
        // ServerTableEngine starts a discard timer; auto-discards (last card) on expiry.
        this.handlePineappleDiscard(event);
        this.broadcastCurrentState();
        break;

      case 'ALL_IN_RUNOUT':
        // A parked runout is a legitimate wait, not a stall.
        this.markProgress();
        // Bible V8 §4.19: All players are all-in with cards to come.
        // Pause for insurance/RIT offers before dealing remaining community cards.
        this.handleAllInRunout(event, players);
        break;

      case 'SHOWDOWN':
        // Capture showdown hand evaluations for BBJ detection.
        // SHOWDOWN SYSTEM 2026-08-25: also capture the engine-decided reveal
        // metadata — seat, reveal order, muck eligibility, hand description.
        this.currentHandShowdownResults = ((event as any).results || []).map((r: any) => ({
          userId: r.userId,
          handRanking: r.hand?.ranking ?? 0,
          handName: r.hand?.name ?? '',
          kickers: r.hand?.kickers ?? [],
          holeCards: (r.cards || []).map((c: any) =>
            typeof c === 'string'
              ? { rank: c.slice(0, -1), suit: c.slice(-1) }
              : { rank: c.rank, suit: c.suit }
          ),
          seat: r.seat,
          revealOrder: r.revealOrder,
          mucked: r.mucked === true,
          handDescription: r.handDescription ?? '',
        }));
        // SHOWDOWN POLISH 2026-08-25: muck-rate observability. If a future
        // change silently kills mucking, this pair flatlines against each
        // other — no DB sampling needed to notice. Metrics must never affect
        // gameplay, hence the fence.
        try {
          EngineMetrics.showdownHandsTotal.inc(1, { table_id: this.tableId });
          const muckedCount = this.currentHandShowdownResults.filter((r) => r.mucked).length;
          if (muckedCount > 0) {
            EngineMetrics.muckedHandsTotal.inc(muckedCount, { table_id: this.tableId });
          }
        } catch {
          /* metrics must never affect gameplay */
        }
        // 2026-04-16 fix: Emit discrete showdown event so the client can
        // trigger showdown sound + card reveal animations (Bible V8 §4.6).
        // Previously only broadcastCurrentState was called, which sends a
        // state snapshot but NOT a discrete event the client handler matches.
        // SHOWDOWN SYSTEM 2026-08-25: the discrete showdown event now carries
        // the reveal SEQUENCE. Clients stagger the card flips by reveal_order
        // (last final-street aggressor first, then clockwise) and render
        // MUCKED seats instead of hands. A mucked player's hand identity is
        // withheld — publishing "Pair, ranking 2" for a hand whose cards stay
        // private would leak exactly what the muck exists to protect.
        //
        // AUDIT FIX 2026-08-25 (ordering): this event now goes out BEFORE the
        // revealing snapshot below. The client latches its flip stagger on the
        // snapshot's showCards rising edge, reading the order this event
        // delivered — sent after the snapshot, the order routinely lost the
        // race and every reveal degraded to a simultaneous flip.
        this.hub?.emitEvent(this.tableId, {
          type: 'showdown',
          table_id: this.tableId,
          hand_number: this.handCount,
          results: this.currentHandShowdownResults.map((r) => {
            const mucked = this.isMuckedAtShowdown(r.userId);
            return {
              user_id: r.userId,
              seat: r.seat ?? -1,
              reveal_order: r.revealOrder ?? 0,
              mucked,
              hand_name: mucked ? '' : r.handName,
              hand_ranking: mucked ? 0 : r.handRanking,
              hand_description: mucked ? '' : (r.handDescription ?? ''),
            };
          }),
        });
        this.broadcastCurrentState();
        // ── ADDITIVE event-sourcing shadow (#1): record ShowdownRevealed ──
        if (this.shadowRecorder && this.handController) {
          const sdState = this.handController.getState();
          const sdReveals = ((event as any).results || []).map((r: any) => ({
            seat: sdState.players.find((pp) => pp.user_id === r.userId)?.seat ?? -1,
            userId: r.userId,
            cards: [] as import('../types.js').Card[],
          }));
          this.shadowRecorder.recordShowdownRevealed(sdReveals);
        }
        // AUDIT FIX 2026-07-19: the showdown_cards_revealed event (which carries
        // hole cards) is emitted in the WINNERS handler instead of here — at
        // SHOWDOWN time the winners aren't known yet, so it could not respect
        // auto-muck and leaked every showdown hand to the whole table.
        break;

      case 'WINNERS': {
        // ═══════════════════════════════════════════════════════════════════
        // Dan 2026-08-20: same bug class as the turn bug — "a showdown needs
        // to happen, THEN the pot needs to be shipped."
        //
        // HandController.completeHandInner() is SYNCHRONOUS: it emits SHOWDOWN
        // (every remaining hand turns face up) and then WINNERS (-> pot_win,
        // which highlights the winner and ships the pot) in the SAME TICK. So
        // the single most dramatic moment in poker — reading the hands at
        // showdown — got ZERO airtime. The cards flipped up, the winner lit up
        // and the pot flew away all on the same frame.
        //
        // The SHOWDOWN event has already gone out by the time this handler
        // runs, so holding here lets the reveal (cardShowdownFlip 350ms + a
        // 120ms second-card stagger) finish and leaves a beat to actually READ
        // the hands before the pot moves. Only pause when there is a showdown
        // to read — a fold-around win has nothing to reveal and keeps its
        // brisk pace.
        // REGRESSION FIX 2026-08-20 (self-review): the settle used to sit HERE,
        // at the very top of this handler — BEFORE the winner state below is
        // assigned. That was wrong and dangerous.
        //
        // handleHandEvent is dispatched fire-and-forget
        // (`void this.handleHandEvent(...)` in ServerTableEngineDealing), and
        // HandController.completeHandInner() emits WINNERS and HAND_COMPLETE
        // back to back in the same synchronous call. So the moment this handler
        // suspended on an await, the HAND_COMPLETE handler — which READS
        // currentHandWinnerIds for the hand_complete payload, the payouts, the
        // BBJ evaluation and the 7-2 bounty — ran to completion first, against
        // winner state that had not been written yet.
        //
        // The settle is purely VISUAL, so it belongs immediately before the
        // pot_win emission (see below), not before the state commit. Winner
        // state is now assigned synchronously exactly as it was originally,
        // and only the pot-ship broadcast waits for the showdown to be read.
        // SWEEP #4 FIX (2026-07-23): Run-It-Twice hands call dealAndResolveRIT(),
        // which pre-sets currentHandWinnerIds / currentHandShowdownResults /
        // currentHandPotSize for board-0 BBJ + 7-2 evaluation, then calls
        // finalizeRunout(true) which emits WINNERS [] synchronously right before
        // HAND_COMPLETE. The old handler unconditionally overwrote the winner state
        // to empty, so the BBJ payout, the 7-2 bounty, and the pot_win/pot_distributed
        // ship animations were silently skipped on EVERY run-it-twice hand — even
        // though the BBJ fee was still collected (funded-but-unwinnable jackpot). An
        // empty WINNERS event ONLY originates from that skip-distribution path, so
        // preserve the pre-set winner state when winners is empty; the contribution
        // capture + stack sync below still run unconditionally.
        const hasWinners = (event.winners || []).length > 0;
        // Round 2 (double board): capture the per-board breakdown alongside
        // the merged winners so pot_win can tell the client which board each
        // winner took and with what hand.
        // POKERBROS PARITY 2026-08-26: gated on hasWinners like the rest of
        // the winner state — the RIT path pre-sets a per-RUN breakdown before
        // finalizeRunout(true)'s empty WINNERS emit, and the unconditional
        // `?? []` here wiped it a tick before pot_win read it.
        if (hasWinners || (event as any).winnersByBoard) {
          this.currentHandWinnersByBoard = (event as any).winnersByBoard ?? [];
        }
        // SHOWDOWN POLISH 2026-08-25: the unmerged per-pot(-half) breakdown.
        // Gated on hasWinners for the same reason the winner state is (the
        // empty WINNERS emit on the RIT path must not wipe pre-set state).
        if (hasWinners) {
          this.currentHandPerPotAwards = (event as any).perPotAwards ?? [];
        }
        if (hasWinners) {
          this.currentHandWinnerIds = (event.winners || []).map(
            (w: any) => w.userId || w.user_id || ''
          );
          // Bible V8 §2.7: Winner Object — userId, amount, potIndex, hand (evaluated hand description)
          // SHOWDOWN SYSTEM 2026-08-25: keep `cards` — the exact best five the
          // evaluator chose. Narrowing it away here is what left pot_win's
          // card_indices permanently empty: the derivation below reads
          // w.hand?.cards, and this map was dropping it on capture. The five
          // formerly-skipped specs in tests/unit/winningCardHighlight.test.ts
          // pin this wire at both ends.
          this.currentHandWinners = (event.winners || []).map((w: any) => ({
            userId: w.userId || w.user_id || '',
            amount: w.amount || 0,
            potIndex: w.potIndex ?? 0,
            hand: w.hand
              ? {
                  name: w.hand.name || '',
                  ranking: w.hand.ranking ?? 0,
                  cards: Array.isArray(w.hand.cards) ? w.hand.cards : undefined,
                }
              : undefined,
          }));
        }
        if (this.handController) {
          const state = this.handController.getState();
          /* Dan 2026-08-26: "the board never displayed the winning hand, or
             played the push-pot and total animation to the winner. This needs
             to happen 100% of the time after every single hand."

             `if (hasWinners)` was half of why it did not. Every path that
             emits WINNERS: [] skipped this assignment and shipped `pot: 0` to
             the client, whose award handler is gated on `potAmount > 0` — so
             no chip fan, no "+N" float, no pot push, on any of:
             HandController's skip-distribution path, its completeHand-threw
             path, its no-distributable-winners path, and the RIT
             finalizeRunout(true) path.

             The pot SIZE is a fact about the hand that just finished; it does
             not depend on whether this particular emit carries winners.
             Recording it unconditionally means the client always knows what
             was won, and the (correct) decision about whether there is anyone
             to animate it to is left to the winners array itself. */
          this.currentHandPotSize = state.pot;
          // POT-LEVEL SETTLEMENT (Dan section 29, 2026-08-25). `state.pots` is
          // the snapshot `completeHandInner()` took with calculatePots() just
          // before it decided the winners — so `eligiblePlayers` still names
          // everyone who had a claim on each pot, which is the whole question
          // a knockout attribution has to answer.
          //
          // THIS IS THE ONLY MOMENT IT EXISTS. `HandController.getPots()`
          // recalculates from the live players, and by the time postHandTasks
          // runs the winners' stacks have already moved. Capturing here rather
          // than at the write is why hand_history can finally record which pot
          // held the busted player's last chips.
          if (hasWinners && Array.isArray(state.pots)) {
            this.currentHandPots = state.pots.map((p, index) => ({
              index,
              amount: Number(p?.amount) || 0,
              eligible: Array.isArray(p?.eligiblePlayers)
                ? p.eligiblePlayers.map((u) => String(u ?? '')).filter(Boolean)
                : [],
            }));
          }
          // Note: rake + bbjFee are captured from HAND_COMPLETE event, not from state
          // WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): capture each player's
          // ELIGIBLE contribution (totalInvested — already net of any returned
          // uncalled bet, decremented by returnUncalledBet() before this event)
          // plus the returned amount as separate audit state. These feed
          // atomic_distribute_rake's weighted per-player attribution.
          this.currentHandContributions.clear();
          this.currentHandReturnedUncalled.clear();
          for (const enginePlayer of state.players) {
            const localPlayer = players.find((p) => p.user_id === enginePlayer.user_id);
            if (localPlayer) localPlayer.stack = enginePlayer.stack;
            this.currentHandContributions.set(
              enginePlayer.user_id,
              enginePlayer.totalInvested ?? 0
            );
            if ((enginePlayer.returnedUncalled ?? 0) > 0) {
              this.currentHandReturnedUncalled.set(
                enginePlayer.user_id,
                enginePlayer.returnedUncalled ?? 0
              );
            }
          }
        }
        // ── ADDITIVE event-sourcing shadow (#1): record PotAwarded ──
        if (this.shadowRecorder && this.handController && this.currentHandWinners.length > 0) {
          const awState = this.handController.getState();
          const awPayouts = this.currentHandWinners.map((w) => ({
            seat: awState.players.find((pp) => pp.user_id === w.userId)?.seat ?? -1,
            userId: w.userId,
            amount: w.amount,
            potIndex: w.potIndex,
          }));
          this.shadowRecorder.recordPotAwarded(awPayouts);
        }
        this.broadcastCurrentState();
        // AUDIT FIX 2026-07-19: emit the hole-card reveal HERE (winners now
        // known) and respect auto-muck — reveal cards only for winners, players
        // who voluntarily showed, or when auto-muck is disabled for the table.
        // Previously this fired at SHOWDOWN for every participant, leaking
        // losing hands on auto-muck tables.
        {
          // ── Dan 2026-08-18: a showdown turns EVERY hand face up ──
          //
          // This used to gate on `auto_muck_enabled ?? true`, and all 56,052
          // tables have that flag true, so in practice only the winner's cards
          // were ever revealed. Measured across 10,165 hands that reached a
          // full five-card board, the average number of holdings shown was
          // 1.08. Dan's instruction is that at showdown all cards are shown.
          //
          // This is safe, and it is worth stating why, because the 2026-07-19
          // audit removed a reveal from exactly this area for leaking losing
          // hands. `currentHandShowdownResults` is NOT "every player dealt
          // in" - it is built from HandController's SHOWDOWN event, whose
          // results come from getActivePlayers() filtered to those still
          // holding cards. getActivePlayers() drops is_folded and
          // is_sitting_out, and the event is only emitted when more than one
          // such player remains. The set is therefore exactly the players who
          // reached showdown; nobody who folded is in it, so folded hole cards
          // still cannot escape through this path.
          //
          // The uncontested case is untouched: no showdown means no SHOWDOWN
          // event, so none of this runs and a player who wins when everyone
          // folds is still never forced to show.
          // SHOWDOWN SYSTEM 2026-08-25 (Dan spec section 4): a hand the engine
          // ruled muckable stays PRIVATE — it is excluded from the public
          // reveal entirely, and the seat renders MUCKED instead. A voluntary
          // show (showHandPlayers) overrides the muck: hiding is the default,
          // showing is consent. All-in showdowns never produce mucked=true
          // (HandController.applyShowdownRevealRules), so every live all-in
          // hand still rides this event exactly as before.
          const reveals = this.currentHandShowdownResults
            .filter((r) => !this.isMuckedAtShowdown(r.userId))
            .map((r) => ({
              user_id: r.userId,
              // Review fix 2026-08-25: carry the seat so a reconnecting
              // client can rebuild reveal staggering without a players
              // lookup (it still falls back to user_id resolution).
              seat: r.seat ?? -1,
              cards: r.holeCards ?? [],
              best_hand_label: r.handName,
              best_hand_rank: r.handRanking,
              best_hand_description: r.handDescription ?? '',
              reveal_order: r.revealOrder ?? 0,
            }));
          const muckedPlayers = this.currentHandShowdownResults
            .filter((r) => this.isMuckedAtShowdown(r.userId))
            .map((r) => ({ user_id: r.userId, seat: r.seat ?? -1 }));
          if (reveals.length > 0 || muckedPlayers.length > 0) {
            this.hub?.emitEvent(this.tableId, {
              type: 'showdown_cards_revealed',
              table_id: this.tableId,
              hand_number: this.handCount,
              reveals,
              mucked_players: muckedPlayers,
              timestamp: Date.now(),
            });
          }
        }
        // Phase 2 T1-05 (spec §6 Pot Shipping Animation): emit a discrete
        // pot_win event so the client can fire its curved-arc chip fan to
        // each winner. Fires for BOTH contested showdowns AND uncontested
        // fold-around wins (HandController emits WINNERS in both cases).
        // The TablePage POT_WIN handler resolves seats from winner_ids and
        // splits the pot across them via createPotToWinnerEvent.
        if (this.currentHandWinnerIds.length > 0) {
          // ── Dan 2026-08-20: "a showdown needs to happen, THEN the pot needs
          //    to be shipped." ──
          //
          // completeHandInner() emits SHOWDOWN (hands turn face up) and WINNERS
          // in the SAME tick, so without this the reveal, the winner highlight
          // and the pot ship all landed on one frame. Hold here — AFTER the
          // winner state above is committed, so nothing that reads it can race
          // us (see the regression note at the top of this case), and BEFORE
          // the pot_win broadcast that actually moves the chips.
          //
          // Only for a real showdown; a fold-around win has nothing to reveal
          // and keeps its brisk pace.
          //
          // ── 2026-08-26 (Dan: "hands MUST be announced and highlighted at
          //    showdown 100% of the time") — THE SETTLE HOLD ATE ITS OWN
          //    EVENT. completeHandInner() emits WINNERS and then HAND_COMPLETE
          //    in the same tick. This handler is fire-and-forget, so while it
          //    slept here, the HAND_COMPLETE listener ran to completion:
          //    ServerTableEngineDealing nulled `this.handController`
          //    unconditionally and handleHandCompleteEvent cleared
          //    `currentHandWinnerIds`. Waking up, the old guard saw
          //    `handController !== controllerAtShowdown` — true on EVERY
          //    showdown — and broke before emitting. pot_win and
          //    pot_distributed were therefore skipped for every contested
          //    showdown, which is exactly the set of hands the announcement
          //    exists for; fold-around wins (no settle hold) kept working,
          //    making the failure read as "intermittent".
          //
          //    Fix: capture the entire payload BEFORE sleeping (the winner
          //    fields and the controller are guaranteed live here, one tick
          //    after WINNERS), and afterwards guard only on what actually
          //    invalidates a broadcast — the engine stopping or a NEW hand
          //    having started. The controller being nulled is the expected
          //    post-hand state, not a cancellation.
          const emitHandNumber = this.handCount;
          const capturedWinnerIds = [...this.currentHandWinnerIds];
          const capturedWinners = [...this.currentHandWinners];
          const capturedWinnersByBoard = [...this.currentHandWinnersByBoard];
          const capturedShowdownResults = [...this.currentHandShowdownResults];
          const capturedPotSize = this.currentHandPotSize;
          const capturedPotAwards = this.buildPotAwardGroups();
          const liveState = this.handController?.getState?.() as unknown as
            | {
                communityCards?: Array<{ rank?: string; suit?: string }>;
                pots?: Array<{
                  amount: number;
                  eligiblePlayers?: string[];
                  eligible?: string[];
                }>;
              }
            | undefined;
          const capturedBoard = (liveState?.communityCards ?? []) as Array<{
            rank?: string;
            suit?: string;
          }>;
          /**
           * POT ROWS FOR `pot_distributed` (fallback added 2026-09-05).
           *
           * `liveState.pots` is assigned in exactly one place —
           * `completeHandInner()` — which a run-it-twice hand never reaches:
           * it settles through `finalizeRunout(true)` instead. So on EVERY
           * multi-board hand this read produced `[]` and the event went out
           * claiming a hand with a main pot and two side pots had no pots at
           * all. (HandController.audit.test.ts:158 asserts the emptiness at
           * the ALL_IN_RUNOUT point; nothing asserted what shipped afterwards.)
           *
           * `currentHandPots` is the same breakdown in the persisted shape.
           * The RIT path now records it from the live pots the boards are
           * actually evaluated against, so fall back to it and translate
           * `eligible` back to the `eligiblePlayers` name this consumer reads.
           */
          const capturedPots =
            liveState?.pots && liveState.pots.length > 0
              ? liveState.pots
              : this.currentHandPots.map((p) => ({
                  amount: p.amount,
                  eligiblePlayers: p.eligible,
                  eligible: p.eligible,
                }));
          if (this.running && capturedShowdownResults.length >= 2) {
            await this.sleep(this.showdownSettleMs);
            if (!this.running || this.handCount !== emitHandNumber) {
              break;
            }
          }
          /**
           * WHICH CARDS WON (Dan 2026-08-21).
           *
           * Dan's completion law says the winning hand must be "SHOWN AT SHOW
           * DOWN AND IDENTIFIED". We named it ("Straight") but never showed
           * WHICH five cards made it — so a player had to work out their own
           * showdown.
           *
           * Everything needed already existed and was never connected:
           * evaluateHand() returns `cards` (the exact best five), Winner
           * carries that as `hand`, and the board component has accepted
           * `highlightedIndices` with a golden glow and pop animation since
           * the day it was written. The client even reads `card_indices` off
           * this very event. Nothing ever SENT it — dead on arrival, the same
           * shape as the Spin's locked tiers.
           *
           * Board indices only: a winner's five cards may include hole cards,
           * and those are drawn at the seat, not on the felt. Matching is by
           * rank+suit against the community cards actually on the board.
           */
          const cardKey = (c: { rank?: string; suit?: string }) => `${c?.rank}${c?.suit}`;
          const winningBoardIndices = (() => {
            try {
              const used = new Set<string>();
              for (const w of capturedWinners) {
                for (const c of (w.hand?.cards ?? []) as Array<{ rank?: string; suit?: string }>) {
                  used.add(cardKey(c));
                }
              }
              if (used.size === 0) return [];
              const out: number[] = [];
              capturedBoard.forEach((c, i) => {
                if (used.has(cardKey(c))) out.push(i);
              });
              return out;
            } catch {
              // A highlight is decoration: never let it break the payout event.
              return [];
            }
          })();

          this.hub?.emitEvent(this.tableId, {
            type: 'pot_win',
            table_id: this.tableId,
            hand_number: emitHandNumber,
            winner_ids: capturedWinnerIds,
            pot: capturedPotSize,
            // The board cards that are part of the winning hand(s). The client
            // reads this as `card_indices` and lights exactly these.
            card_indices: winningBoardIndices,
            // Per-winner amounts for accurate sub-pot ship animations on chops
            // SHOWDOWN SYSTEM 2026-08-25: hand_description is the secondary
            // display line ("Kings Full Of Nines"); hole_card_indices are the
            // indices of the winner's OWN hole cards that participate in the
            // winning five, so the seat can light exactly those (the board
            // half of the highlight rides card_indices above).
            winners: capturedWinners.map((w) => {
              const sd = capturedShowdownResults.find((r) => r.userId === w.userId);
              const holeIndices: number[] = [];
              try {
                if (sd && w.hand?.cards) {
                  const usedKeys = new Set(
                    (w.hand.cards as Array<{ rank?: string; suit?: string }>).map(
                      (c) => `${c?.rank}${c?.suit}`
                    )
                  );
                  (sd.holeCards ?? []).forEach((c, i) => {
                    if (usedKeys.has(`${c?.rank}${c?.suit}`)) holeIndices.push(i);
                  });
                }
              } catch {
                // Decoration only — never let a highlight break the payout event.
              }
              return {
                user_id: w.userId,
                amount: w.amount,
                hand_name: w.hand?.name,
                hand_description: sd?.handDescription ?? '',
                hole_card_indices: holeIndices,
                // SHOWDOWN follow-up 2026-08-25 (spec 16/19): which pot this
                // winner's FIRST share came from (0 = main). The client
                // sequences award animations by this — main pot first, then
                // each side pot — so a hand with different winners for
                // different pots resolves as a visible sequence, not a blur.
                pot_index: w.potIndex ?? 0,
              };
            }),
            // Round 2 (double board): board 1 / board 2 winner + hand-name
            // breakdown. Empty array on single-board hands.
            winners_by_board: capturedWinnersByBoard.map((w) => ({
              board: w.board,
              user_id: w.userId,
              amount: w.amount,
              hand_name: w.handName,
            })),
            // SHOWDOWN POLISH 2026-08-25 (spec 16/19/33): the UNMERGED award
            // groups, one per (board, pot, hi/lo half), in award order — main
            // pot's high half first, its low half second, then each side pot,
            // then board 2. Each group carries its own winners with the EXACT
            // share of that pot(-half), post-rake-scaled — so the client can
            // finally play "A takes the main… C takes the side" as separate
            // beats even when one player appears in several groups, and can
            // label HIGH vs LOW winners on hi-lo boards. The flat winners[]
            // above stays authoritative for totals.
            pot_awards: capturedPotAwards,
          });

          // Phase X5 (2026-04-29) — Bible V8 §1.16 pot_distributed companion
          // event with explicit per-pot breakdown (main pot + side pots).
          // Without this, the client must infer side-pot allocations from
          // a state-snapshot diff. This event names every pot index, the
          // amount that pot held, and the user_ids that received that
          // pot's chips.
          // SHOWDOWN SYSTEM 2026-08-25 eligibility fix: GameState.pots stores
          // `eligiblePlayers`; the old read of `p.eligible` (the BROADCAST
          // payload's rename, applied only in ServerTableEngine.ts) was always
          // undefined here, so every pot listed every winner and side-pot
          // breakdowns were wrong for the client and the audit trail alike.
          // 2026-08-26: reads the pots captured BEFORE the settle hold — the
          // controller is legitimately null by the time the hold ends (see the
          // capture note above), and reading it here returned an empty
          // breakdown on every contested showdown.
          const potBreakdown = capturedPots.map((p, idx) => {
            const eligibleIds = p.eligiblePlayers ?? p.eligible ?? [];
            const eligibleWinners = capturedWinners.filter(
              (w) => eligibleIds.length === 0 || eligibleIds.includes(w.userId)
            );
            const totalEligibleAmount = eligibleWinners.reduce((s, w) => s + w.amount, 0) || 1;
            return {
              pot_index: idx,
              amount: p.amount,
              winner_user_ids: eligibleWinners.map((w) => w.userId),
              per_winner_share: eligibleWinners.map((w) => ({
                user_id: w.userId,
                share: (w.amount / totalEligibleAmount) * p.amount,
              })),
            };
          });
          this.hub?.emitEvent(this.tableId, {
            type: 'pot_distributed',
            table_id: this.tableId,
            hand_number: emitHandNumber,
            total_pot: capturedPotSize,
            pots: potBreakdown,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'HAND_COMPLETE': {
        if (persistenceGeneration === undefined) {
          throw new Error(`HAND_COMPLETE for table ${this.tableId} has no persistence generation`);
        }
        await this.handleHandCompleteEvent(event, players, persistenceGeneration);
        break;
      }
    }
  }

  /**
   * A7: run the full integrity suite against the live mid-hand state.
   *
   * Cheap (a few sums over at most nine players) and deliberately fired on the
   * hot path — a conservation violation is worth knowing about within
   * milliseconds, not at the end of the hand. Violations are reported by
   * StateVerifier itself and drive the recovery FSM; this only adds the engine
   * context to the log.
   */
  protected verifyStreetIntegrity(): void {
    if (!this.handController) return;
    try {
      const live = this.handController.getState();
      const result = this.stateVerifier.verify({
        tableId: this.tableId,
        handNumber: this.handCount,
        players: live.players,
        communityCards: live.communityCards,
        pot: live.pot,
        stage: live.stage,
        phase: 'in_hand',
        // Nothing is raked until settlement, so every chip is still in a stack
        // or in the pot.
        rakeTaken: 0,
      });
      if (!result.valid) {
        const detail =
          `Hand ${this.handCount} @ ${live.stage}: ` +
          result.violations.map((v) => v.message).join('; ');
        reportError(detail, `ServerTableEngine.${this.tableId}.street_integrity_violation`);

        /**
         * A conservation or pot-accounting violation means chips were created or
         * destroyed inside a live hand. That is the most serious thing this
         * engine can detect about itself, and Sentry alone is the wrong home for
         * it — financial_alerts is the durable, queryable channel operators
         * actually read, and raiseFinancialAlert re-escalates a CRITICAL to
         * Sentry anyway, so this loses nothing and gains a record that survives.
         *
         * Fire-and-forget: this runs on the hot path between streets and must
         * never delay a hand. raiseFinancialAlert never throws or rejects.
         */
        const critical = result.violations.some((v) => v.severity === 'critical');
        void raiseFinancialAlert(
          critical ? 'critical' : 'warning',
          'ServerTableEngine.street_integrity_violation',
          detail,
          {
            tableId: this.tableId,
            handNumber: this.handCount,
            stage: live.stage,
            pot: live.pot,
            chipTotal: result.chipTotal,
            expectedChipTotal: result.expectedChipTotal ?? null,
            drift: result.drift ?? null,
            violations: result.violations.map((v) => ({ type: v.type, severity: v.severity })),
          }
        );
      }
    } catch (err) {
      // A verification failure must never take down a live hand.
      reportError(err, `ServerTableEngine.${this.tableId}.street_integrity_threw`);
    }
  }
}
