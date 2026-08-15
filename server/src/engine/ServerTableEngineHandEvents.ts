/**
 * ServerTableEngine, layer 7/8 — the HandController event switch.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import type { Street as ShadowStreet } from './eventlog/events.js';
import { logHandHistory } from '../services/supabase.js';
import type { HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngineSettlement } from './ServerTableEngineSettlement.js';

export abstract class ServerTableEngineHandEvents extends ServerTableEngineSettlement {
  protected async handleHandEvent(event: HandEvent, players: SeatedPlayer[]): Promise<void> {
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

      case 'TURN_CHANGE': {
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
        // The timer call below skips re-stamping when the deadline already
        // matches, so there is no drift.
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
          this.handleTurnChange(event, players);
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
          const stage = hcState?.stage || 'preflop';
          const actingPlayer = hcState?.players.find((p) => p.seat === event.seat);
          this.currentHandActions.push({
            seat: event.seat,
            userId: actingPlayer?.user_id ?? '', // Bible V8 §2.5
            action: event.action,
            amount: event.amount,
            timestamp: Date.now(), // Bible V8 §2.5
            stage,
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
        {
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
        // Capture showdown hand evaluations for BBJ detection
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
        }));
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
        // 2026-04-16 fix: Emit discrete showdown event so the client can
        // trigger showdown sound + card reveal animations (Bible V8 §4.6).
        // Previously only broadcastCurrentState was called, which sends a
        // state snapshot but NOT a discrete event the client handler matches.
        this.hub?.emitEvent(this.tableId, {
          type: 'showdown',
          table_id: this.tableId,
          hand_number: this.handCount,
          results: this.currentHandShowdownResults.map((r) => ({
            user_id: r.userId,
            hand_name: r.handName,
            hand_ranking: r.handRanking,
          })),
        });
        // AUDIT FIX 2026-07-19: the showdown_cards_revealed event (which carries
        // hole cards) is emitted in the WINNERS handler instead of here — at
        // SHOWDOWN time the winners aren't known yet, so it could not respect
        // auto-muck and leaked every showdown hand to the whole table.
        break;

      case 'WINNERS': {
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
        if (hasWinners) {
          this.currentHandWinnerIds = (event.winners || []).map(
            (w: any) => w.userId || w.user_id || ''
          );
          // Bible V8 §2.7: Winner Object — userId, amount, potIndex, hand (evaluated hand description)
          this.currentHandWinners = (event.winners || []).map((w: any) => ({
            userId: w.userId || w.user_id || '',
            amount: w.amount || 0,
            potIndex: w.potIndex ?? 0,
            hand: w.hand ? { name: w.hand.name || '', ranking: w.hand.ranking ?? 0 } : undefined,
          }));
        }
        if (this.handController) {
          const state = this.handController.getState();
          if (hasWinners) this.currentHandPotSize = state.pot;
          // Note: rake + bbjFee are captured from HAND_COMPLETE event, not from state
          // Bible V8 §1.9: Capture totalInvested for equal-share rakeback tracking (FIX 144)
          this.currentHandContributions.clear();
          for (const enginePlayer of state.players) {
            const localPlayer = players.find((p) => p.user_id === enginePlayer.user_id);
            if (localPlayer) localPlayer.stack = enginePlayer.stack;
            // Track actual contributions for rakeback (totalInvested = blinds + bets + raises + calls)
            this.currentHandContributions.set(
              enginePlayer.user_id,
              enginePlayer.totalInvested ?? 0
            );
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
          const autoMuckEnabled = this.tableInfo?.auto_muck_enabled ?? true;
          const reveals = this.currentHandShowdownResults
            .filter((r) => {
              if (!autoMuckEnabled) return true;
              if (this.currentHandWinnerIds.includes(r.userId)) return true;
              if (this.showHandPlayers?.has(r.userId)) return true;
              return false;
            })
            .map((r) => ({
              user_id: r.userId,
              cards: r.holeCards ?? [],
              best_hand_label: r.handName,
              best_hand_rank: r.handRanking,
            }));
          if (reveals.length > 0) {
            this.hub?.emitEvent(this.tableId, {
              type: 'showdown_cards_revealed',
              table_id: this.tableId,
              hand_number: this.handCount,
              reveals,
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
          this.hub?.emitEvent(this.tableId, {
            type: 'pot_win',
            table_id: this.tableId,
            hand_number: this.handCount,
            winner_ids: this.currentHandWinnerIds,
            pot: this.currentHandPotSize,
            // Per-winner amounts for accurate sub-pot ship animations on chops
            winners: this.currentHandWinners.map((w) => ({
              user_id: w.userId,
              amount: w.amount,
              hand_name: w.hand?.name,
            })),
          });

          // Phase X5 (2026-04-29) — Bible V8 §1.16 pot_distributed companion
          // event with explicit per-pot breakdown (main pot + side pots).
          // Without this, the client must infer side-pot allocations from
          // a state-snapshot diff. This event names every pot index, the
          // amount that pot held, and the user_ids that received that
          // pot's chips.
          const stateSnapshot = this.handController?.getState?.() as unknown as
            | { pots?: Array<{ amount: number; eligibleSeats?: number[]; eligible?: string[] }> }
            | undefined;
          const potBreakdown = (stateSnapshot?.pots ?? []).map((p, idx) => {
            const eligibleIds = p.eligible ?? [];
            const eligibleWinners = this.currentHandWinners.filter(
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
            hand_number: this.handCount,
            total_pot: this.currentHandPotSize,
            pots: potBreakdown,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'HAND_COMPLETE': {
        await this.handleHandCompleteEvent(event, players);
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
        reportError(
          `Hand ${this.handCount} @ ${live.stage}: ` +
            result.violations.map((v) => v.message).join('; '),
          `ServerTableEngine.${this.tableId}.street_integrity_violation`
        );
      }
    } catch (err) {
      // A verification failure must never take down a live hand.
      reportError(err, `ServerTableEngine.${this.tableId}.street_integrity_threw`);
    }
  }
}
