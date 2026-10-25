/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LIGHTNING STRENGTH MATRIX (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: a brain change has to prove it still wins in Lightning before it ships.
 *
 * Plays Lightning hands through the real LightningHandHost and HandController,
 * with every horse seat decided by the real brain and learning the way the
 * production worker learns (HorseMind live, every completed hand observed -
 * workerRuntime.observeCompletedHand's own steps), against ONE opponent
 * archetype who is dealt into a brand-new table with brand-new horses every
 * hand, exactly as a person meets the pool:
 *
 *   maniac   raises or shoves every decision it can
 *   station  calls everything, never raises, never folds to a bet
 *   nit      plays only the top ~12% of starting hands, then bets/calls them
 *   reg      a simple tight-aggressive regular: ~22% of hands, raises its
 *            strong ones, folds its weak ones to aggression
 *
 * The result is the horses' combined net against the archetype in big blinds
 * per 100 of the archetype's hands (the archetype's own loss, sign flipped),
 * rake included. The archetype's strength reading uses the brain's own
 * preflop percentile (LightningHorseEarlyFold.horsePreflopStrength) so "top
 * 12%" means the same thing to both sides.
 */
import { vi } from 'vitest';
import { HorseLogic } from '../engine/HorseLogic.js';
import { restoreFastRandom, saveFastRandom, seedFastRandom } from '../engine/HorseEval.js';
import { equityGovernor } from '../engine/EquityLoadGovernor.js';
import { HorseMind } from '../engine/HorseMind.js';
import { completedHandActionsForMind } from '../engine/horseDecision/completedHandActions.js';
import { horseMindHandFromCompletion } from '../engine/HorseMindHandIdentity.js';
import { observeHandResults, resetWinnerReads } from '../engine/HorseWinnerRead.js';
import { horsePreflopStrength } from '../lightning/LightningHorseEarlyFold.js';
import type { CompletedHandObservation } from '../engine/horseDecision/index.js';
import * as kit from './lightningHostTestKit.js';

export type Archetype = 'maniac' | 'station' | 'nit' | 'reg';

export interface MatrixResult {
  archetype: Archetype;
  variant: string;
  hands: number;
  /** horses' net against the archetype, bb per 100 of its hands */
  horsesBB100: number;
}

function archetypeAction(
  kind: Archetype,
  legal: string[],
  strength: number,
  toCall: number,
  rnd: () => number
): string {
  const has = (a: string) => legal.includes(a);
  const passive = has('check') ? 'check' : 'fold';
  switch (kind) {
    case 'maniac':
      if (has('raise') && rnd() < 0.7) return 'raise';
      if (has('bet')) return 'bet';
      if (has('all_in')) return 'all_in';
      return has('call') ? 'call' : passive;
    case 'station':
      if (has('call')) return 'call';
      return passive;
    case 'nit':
      if (strength < 0.62) return toCall > 0 ? 'fold' : passive;
      if (has('raise') && strength > 0.8) return 'raise';
      if (has('bet')) return 'bet';
      return has('call') ? 'call' : passive;
    case 'reg':
      if (strength < 0.44) return toCall > 0 ? 'fold' : passive;
      if (strength > 0.66 && has('raise')) return 'raise';
      if (strength > 0.55 && has('bet')) return 'bet';
      if (toCall > 0 && strength < 0.5 && rnd() < 0.5) return 'fold';
      return has('call') ? 'call' : passive;
  }
}

/** The production worker's learning steps, in process. */
function observeLikeTheWorker(o: CompletedHandObservation): void {
  const completed = completedHandActionsForMind(o.actions as never, o.scope ?? null);
  const identity = horseMindHandFromCompletion(o as never);
  if (completed && identity) {
    const prev = HorseMind.currentScope();
    HorseMind.setDecisionScope(completed.scope);
    try {
      HorseMind.observe(completed.actions as never, [], identity);
    } finally {
      HorseMind.setDecisionScope(prev);
    }
  }
  HorseMind.observeHandComplete(
    o.handKey,
    o.actions as never,
    o.bigBlind,
    o.showdown ?? null,
    o.scope ?? null,
    false
  );
  observeHandResults(o.handKey, o.results, o.bigBlind);
}

export async function playLightningMatrix(opts: {
  archetype: Archetype;
  variant: string;
  hands: number;
  seed: number;
  seats?: number;
}): Promise<MatrixResult> {
  const previousRng = saveFastRandom();
  equityGovernor.__setScaleForTest(1);
  try {
    HorseMind.reset();
    resetWinnerReads();
    // The brain's own jitter, seeded: with a seeded deck (the caller's) the run
    // is a fixed experiment, so a changed number is a changed brain.
    seedFastRandom(opts.seed);
    const n = opts.seats ?? 6;
    let state = opts.seed >>> 0 || 1;
    const rnd = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) % 1_000_000) / 1_000_000;
    };
    // Host tempo changes the order of priced early looks and turn decisions.
    // It has its own RNG seam; leaving it on Math.random shifted the brain's
    // seeded draw stream between runtimes even with the same deck and clock.
    // Keep tempo independent of both the brain and the opponent action dice.
    let hostState = opts.seed >>> 0 || 1;
    const hostRandom = () => {
      hostState ^= hostState << 13;
      hostState ^= hostState >>> 17;
      hostState ^= hostState << 5;
      return (hostState >>> 0) / 0x100000000;
    };
    const villain = kit.uid(777_777);
    let net = 0;
    let played = 0;
    for (let h = 0; h < opts.hands; h++) {
      // A brand-new table every hand: fresh horse ids, the villain rotating seats.
      const formed = kit.formedHand(n, opts.seed * 10_000 + h * 10);
      const slot = h % n;
      formed.players[slot] = villain;
      if (slot === 0) formed.bb = villain;
      if (slot === 1) formed.sb = villain;
      if (slot === n - 1) formed.btn = villain;
      const t = kit.buildHost(
        formed,
        Array.from({ length: n }, () => 100),
        {
          horses: new Set(formed.players.filter((p) => p !== villain)),
          rules: { game_variant: opts.variant, big_blind: 1, small_blind: 0.5 },
          deps: { random: hostRandom },
        }
      );
      // The general host fixture randomizes physical hand numbers. This fixed
      // experiment needs stable, unique learning identities as well as a seeded deck.
      vi.mocked(t.backend.nextHandNumber).mockResolvedValue(1_000_001 + h);
      try {
        const lane = t.horseLane.raw;
        lane.decideFast.mockImplementation(
          async (snap: any) =>
            ({
              type: 'FAST_RESULT',
              requestId: 1,
              planBinding: null,
              planIssueDisposition: 'no_effects',
              generation: snap.generation,
              fence: snap.fence,
              decision: HorseLogic.decide(
                snap.player,
                snap.gameState,
                snap.style,
                snap.mods ?? {},
                {
                  telemetry: false,
                  decisionTimeMs: Date.UTC(2026, 9, 24),
                  // Existing offline evidence mode removes host-speed budget variance;
                  // candidate selection and the real brain remain unchanged.
                  phase13EvidenceMode: true,
                } as never
              ),
              rngBefore: 0,
              rngAfter: 0,
              computeMs: 1,
              governorScale: 1,
              effects: [],
            }) as never
        );
        lane.observeCompletedHand.mockImplementation(async (o: CompletedHandObservation) => {
          observeLikeTheWorker(o);
          return { type: 'ACK' } as never;
        });
        await t.host.start();
        for (let i = 0; i < 600 && t.host.lifecycle === 'dealing'; i++) {
          const st = t.host.peekState();
          const cur = st?.players.find((x: any) => x.seat === st.currentPlayerSeat);
          if (
            cur?.user_id === villain &&
            ['preflop', 'flop', 'turn', 'river'].includes(st!.stage)
          ) {
            const auth = (t.host as any).hc.getAuthoritativeActionState(villain);
            const legal: string[] = auth?.legalActions ?? [];
            if (legal.length) {
              const cards = (t.host as any).holeCards.get(villain)?.cards ?? [];
              const s = horsePreflopStrength(cards, opts.variant);
              const a = archetypeAction(
                opts.archetype,
                legal,
                Number.isFinite(s) ? s : 0.3,
                auth.toCall ?? 0,
                rnd
              );
              const amount =
                a === 'raise' || a === 'bet'
                  ? Math.min(
                      auth.maxRaiseTo ?? 0,
                      Math.max(auth.minRaiseTo ?? 0, (st!.pot || 1) * 0.75 + (auth.toCall ?? 0))
                    )
                  : undefined;
              const r = t.host.handlePlayerAction(villain, a, amount);
              if (!r.success)
                t.host.handlePlayerAction(villain, legal.includes('check') ? 'check' : 'fold');
            }
          }
          await vi.advanceTimersByTimeAsync(400);
        }
        const settled = t.calls.settle[0];
        const mine = settled?.results.find((r: any) => r.playerId === villain);
        if (mine) {
          net += mine.won - mine.contributed;
          played++;
        }
      } finally {
        await t.host.abort('matrix_done');
      }
    }
    return {
      archetype: opts.archetype,
      variant: opts.variant,
      hands: played,
      horsesBB100: played ? (-net / played) * 100 : 0,
    };
  } finally {
    restoreFastRandom(previousRng);
    equityGovernor.__setScaleForTest(null);
    HorseMind.reset();
    resetWinnerReads();
  }
}
