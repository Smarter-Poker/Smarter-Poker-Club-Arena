/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY LIGHTNING HAND TEACHES THE HORSES (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-24: "HORSES NEED TO MAKE REAL TIME READS, AND USE ANY AND ALL
 * PLAYER DATA ON THE VERY FIRST HAND EVERY SINGLE TIME THEY START A NEW HAND
 * AT A NEW TABLE WITH NEW PLAYERS."
 *
 * A physical table commits its hand through `saveHandHistory`, which then
 * hands the accepted action stream to the live horse decision lane
 * (`observeCompletedHand`). That one call is how the horse mind learns a
 * player: VPIP and PFR, aggression and passivity, c-bet and 3-bet folds,
 * what they showed down after a big bet, who is hunting which horse, and the
 * fast window that notices a player changing gears. It also carries the
 * actors' fresh durable profiles, which every worker imports.
 *
 * A Lightning hand commits through its own settlement door
 * (`fn_lightning_settle_hand`) and never made that call. Measured on
 * production the same day: about 2.3 Lightning hands a second, none of them
 * observed. So in a fast-fold pool - where every hand is a new table with new
 * players, and the read is ALL a horse has - the in-memory mind never learned
 * a single thing from Lightning play, and in the three Lightning games with no
 * durable memory (fixed-limit hold'em, FLO8, short deck) a horse had no
 * opponent read at all, ever.
 *
 * This is that call, built the same way the physical path builds it: the
 * actors' durable profiles read after the commit, the same fence shape
 * (`table:hand:lease:observe`), the same hand key, the committed hand id, the
 * accepted actions, the big blind, the showdown and the V45 read scope.
 *
 * It never endangers settlement: it runs after the commit, is not awaited by
 * the hand, and every failure is reported and swallowed - exactly the
 * physical path's contract.
 */
import { noteFire } from '../engine/BrainTelemetry.js';
import { readScopeOf } from '../engine/HorseMind.js';
import { memoryVariant, type DurableOpponentProfile } from '../engine/HorseOpponentMemory.js';
import { isOpponentMemoryBusyRefusal, reportThrottled } from '../services/errorReporter.js';
import type {
  CompletedHandObservation,
  LiveHorseDecisionLane,
} from '../engine/horseDecision/index.js';

export interface LightningObservedHand {
  hostTableId: string;
  handNumber: number;
  leaseGeneration: string | null;
  handHistoryId: string;
  variant: string;
  bigBlind: number;
  /** The players dealt into the hand (folded, fast-folded, horse or human). */
  dealtCount: number;
  actions: ReadonlyArray<Record<string, unknown>>;
  showdown: ReadonlyArray<{ userId: string; mucked?: boolean; handName?: string }>;
  /** Settlement's per-player results (HorseWinnerRead). */
  results?: ReadonlyArray<{ playerId: string; contributed: number; won: number }>;
}

export interface LightningObservationDeps {
  lane: () => LiveHorseDecisionLane;
  /** The installed-schema probe (HorseOpponentMemory.horseOpponentMemorySchema). */
  schema: () => Promise<'installed' | 'unavailable' | 'unknown'>;
  readProfiles: (
    userIds: string[],
    variant: string,
    mode: 'cash' | 'tournament',
    size: 'hu' | 'short' | 'full'
  ) => Promise<DurableOpponentProfile[]>;
  report: (error: unknown, where: string) => void;
}

/** The size bucket the durable learner files this hand under (players dealt). */
export function lightningMemorySize(dealtCount: number): 'hu' | 'short' | 'full' {
  return dealtCount <= 2 ? 'hu' : dealtCount <= 5 ? 'short' : 'full';
}

/** The observation the physical engine would send for this hand. Pure. */
export function buildLightningObservation(
  hand: LightningObservedHand,
  durableOpponentProfiles: DurableOpponentProfile[] | undefined
): CompletedHandObservation {
  return {
    ...(durableOpponentProfiles !== undefined ? { durableOpponentProfiles } : {}),
    generation: hand.handNumber,
    fence: [hand.hostTableId, hand.handNumber, hand.leaseGeneration ?? 'unleased', 'observe'].join(
      ':'
    ),
    handKey: `${hand.hostTableId}:${hand.handNumber}`,
    committedHandId: hand.handHistoryId,
    actions: hand.actions.map((a) => ({ ...a })) as CompletedHandObservation['actions'],
    bigBlind: hand.bigBlind,
    showdown: hand.showdown.length
      ? hand.showdown.map((r) => ({
          user_id: r.userId,
          mucked: r.mucked === true,
          ...(r.mucked === true || !r.handName ? {} : { hand_name: r.handName }),
        }))
      : null,
    scope: readScopeOf(hand.variant, hand.dealtCount),
    ...(hand.results
      ? {
          results: hand.results.map((r) => ({
            user_id: r.playerId,
            net: Math.round((r.won - r.contributed) * 100) / 100,
          })),
        }
      : {}),
  };
}

/**
 * Teach the lane this committed Lightning hand. Never throws and never
 * rejects: the hand is already settled and nothing here may touch it.
 */
export async function observeLightningHand(
  hand: LightningObservedHand,
  deps: LightningObservationDeps
): Promise<void> {
  try {
    const variant = memoryVariant(hand.variant);
    let durable: DurableOpponentProfile[] | undefined;
    if (variant && (await deps.schema()) === 'installed') {
      durable = [];
      try {
        const actors = [
          ...new Set(
            hand.actions
              .map((a) => a.userId)
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
          ),
        ];
        if (actors.length)
          durable = await deps.readProfiles(
            actors,
            variant,
            'cash',
            lightningMemorySize(hand.dealtCount)
          );
      } catch (error) {
        if (isOpponentMemoryBusyRefusal(error))
          reportThrottled(
            'LightningHorseObservation.durable_opponent_read',
            'opponent memory unavailable: busy - Lightning completed-hand read refused at admission'
          );
        else deps.report(error, 'LightningHorseObservation.durable_opponent_read');
      }
    }
    const pending = deps.lane().observeCompletedHand(buildLightningObservation(hand, durable));
    // Coverage is a number (horse_brain_telemetry): every settled Lightning
    // hand files exactly one of these two, so observed / settled is the share
    // of Lightning hands the horse mind actually learned.
    await pending.then(
      () => noteFire('lightning_hand_observed'),
      (error) => {
        noteFire('lightning_hand_observe_failed');
        deps.report(error, 'LightningHorseObservation.horse_mind_observation_failed');
      }
    );
  } catch (error) {
    noteFire('lightning_hand_observe_failed');
    deps.report(error, 'LightningHorseObservation.horse_mind_observation_failed');
  }
}
