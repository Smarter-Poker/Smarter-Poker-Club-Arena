/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BAD BEAT JACKPOT ON A LIGHTNING HAND (Lightning Phase 6 remediation, 2026-10-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Lightning hand pays the BBJ fee exactly as a physical hand does
 * (HandController's bbjConfig, banked by fn_lightning_settle_hand's
 * post-commit envelope), so it must also be able to WIN the jackpot exactly
 * as a physical hand does. Charging the fee without the chance to win would
 * be taking money for a ticket that cannot be drawn.
 *
 * NOTHING HERE IS NEW ECONOMICS. It is the physical settlement path's jackpot
 * step (ServerTableEngineSettlement: the hit check after the showdown, then
 * the `bbj_mini_payout` and `bbj_payout` steps), calling the same functions
 * with the same arguments:
 *
 *   - detection: detectBBJHit, and only when it refuses, detectMiniBBJHit,
 *     gated on the table's bbj_percent > 0, a showdown of two or more and a
 *     winner, with the final board parsed by the same pattern;
 *   - payout: processBBJPayout / processMiniBBJPayout - the write-ahead claim,
 *     the retries, the queue, the freeze deferral and the one idempotency key
 *     (pool, table, hand) - for a cash hand at a club, never a diamond one;
 *   - the same hub events (bbj_hit, bbj_payout_pending, bbj_payout_complete),
 *     with the same fields, to every participant's room.
 *
 * THE ONE DIFFERENCE IS WHERE A SHARE LANDS, AND IT IS FORCED. A physical
 * table names the players still seated there so the payout credits their
 * seat, and everyone else directly. A Lightning hand's players sit at OTHER
 * tables (their anchors), none of them at the host table, so `seatedUserIds`
 * is empty and every recipient is credited directly - the branch the
 * physical path already uses for a recipient who has left the table. The
 * amounts are identical.
 *
 * It runs only after a successful settlement, so a hand that never settled
 * can never pay a jackpot. The drill (an operator's armed table verdict) is a
 * physical-table instrument claimed by that table's own engine; it is not
 * claimed here.
 */
import {
  detectBBJHit,
  detectMiniBBJHit,
  getFullRakeConfig,
  getTierIdForBB,
} from '../config/RakeConfig.js';
import {
  processBBJPayout,
  processMiniBBJPayout,
  recordBBJNearMiss,
} from '../services/supabase/bbj.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import type { ShowdownRecord } from '../engine/presentation/handEventFrames.js';
import type { LightningWorkerLogger } from './LightningClusterWorker.js';

export interface LightningJackpotHand {
  /** The host table: the jackpot's (pool, table, hand) key, as the hand row's. */
  hostTableId: string;
  clubId: string | null;
  /** 'diamonds' never pays a jackpot (the physical isDiamondCash gate). */
  asset: string | null;
  /** tables.bbj_percent of the host table; an explicit 0 disables it. */
  bbjPercent: number | null | undefined;
  handNumber: number;
  variant: string;
  smallBlind: number;
  bigBlind: number;
  showdown: readonly ShowdownRecord[];
  winnerIds: string[];
  potSize: number;
  dealtInPlayerIds: string[];
  /** Board 0, in the engine's accumulated card strings. */
  board: string[];
  /** Every participant's room (player id, pool_session_id). */
  rooms: Array<[string, string]>;
  /** Final stacks, for the celebration's `updatedStacks`. */
  stacks: Array<{ userId: string; stack: number }>;
}

export interface LightningJackpotDeps {
  emit(room: string, payload: Record<string, unknown>): void;
  logger: LightningWorkerLogger;
  now?: () => number;
  /** Injected for tests; the physical payout doors otherwise. */
  payMain?: typeof processBBJPayout;
  payMini?: typeof processMiniBBJPayout;
}

export type LightningJackpotVerdict = 'none' | 'main' | 'mini';

const BOARD_CARD = /^(10|[2-9]|[TJQKA])(hearts|diamonds|clubs|spades)$/;

/** The physical hit check, unchanged in its inputs. Pure. */
export function detectLightningJackpot(hand: LightningJackpotHand): {
  verdict: LightningJackpotVerdict;
  main?: ReturnType<typeof detectBBJHit>;
  mini?: ReturnType<typeof detectMiniBBJHit>;
} {
  const percent = hand.bbjPercent ?? 100;
  if (!(percent > 0) || hand.showdown.length < 2 || hand.winnerIds.length === 0)
    return { verdict: 'none' };
  const board = hand.board
    .map((str) => {
      const m = BOARD_CARD.exec(str);
      return m ? { rank: m[1], suit: m[2] } : null;
    })
    .filter((c): c is { rank: string; suit: string } => c !== null);
  const showdown = hand.showdown as unknown as Parameters<typeof detectBBJHit>[0];
  const main = detectBBJHit(
    showdown,
    hand.winnerIds,
    hand.variant,
    hand.potSize,
    hand.bigBlind,
    hand.dealtInPlayerIds.length,
    hand.dealtInPlayerIds,
    board,
    { doubleBoard: false }
  );
  if (main.hit) return { verdict: 'main', main };
  const mini = detectMiniBBJHit(
    showdown,
    hand.winnerIds,
    hand.variant,
    hand.potSize,
    hand.bigBlind,
    hand.dealtInPlayerIds.length,
    hand.dealtInPlayerIds,
    { doubleBoard: false }
  );
  return mini.hit ? { verdict: 'mini', mini } : { verdict: 'none' };
}

/**
 * Detect and pay. Never throws: a payout that cannot land now is queued by
 * the payout door itself (write-ahead claim + reconciler), exactly as at a
 * physical table.
 */
export async function settleLightningJackpot(
  hand: LightningJackpotHand,
  deps: LightningJackpotDeps
): Promise<LightningJackpotVerdict> {
  const now = deps.now ?? Date.now;
  const payMain = deps.payMain ?? processBBJPayout;
  const payMini = deps.payMini ?? processMiniBBJPayout;
  const emitAll = (payload: Record<string, unknown>) => {
    for (const [, room] of hand.rooms) deps.emit(room, { ...payload, table_id: room });
  };
  let found: ReturnType<typeof detectLightningJackpot>;
  try {
    found = detectLightningJackpot(hand);
  } catch (err) {
    deps.logger.error(`[LightningJackpot:${hand.hostTableId}] hit check failed`, err);
    return 'none';
  }
  if (found.verdict === 'none') return 'none';
  const payable = hand.asset !== 'diamonds' && !!hand.clubId;
  const dealt = hand.dealtInPlayerIds;

  if (found.verdict === 'main' && found.main) {
    const hit = found.main;
    const rakeConfig = getFullRakeConfig(hand.smallBlind, hand.bigBlind, hand.variant);
    EngineMetrics.bbjHitsDetectedTotal.inc(1);
    emitAll({
      type: 'bbj_hit',
      hand_number: hand.handNumber,
      emitted_at: now(),
      replay_until: now() + 60_000,
      loser: {
        userId: hit.loserUserId,
        hand: hit.loserHand,
        payoutPercent: rakeConfig.bbjPayoutLoser,
      },
      winner: {
        userId: hit.winnerUserId,
        hand: hit.winnerHand,
        payoutPercent: rakeConfig.bbjPayoutWinner,
      },
      tableShare: { playerIds: dealt, payoutPercent: rakeConfig.bbjPayoutTable },
      totalPayoutPercent: rakeConfig.bbjPayoutTotalPercent,
      variant: hand.variant,
      qualifyingHandLabel: hit.qualifyingHandLabel,
    });
    if (!payable) return 'main';
    try {
      const outcome = await payMain({
        tableId: hand.hostTableId,
        clubId: hand.clubId!,
        handNumber: hand.handNumber,
        loserUserId: hit.loserUserId!,
        winnerUserId: hit.winnerUserId!,
        loserHandName: hit.loserHand?.name || 'Unknown',
        winnerHandName: hit.winnerHand?.name || 'Unknown',
        dealtInPlayerIds: hit.dealtInPlayerIds || [],
        // Nobody is seated at the host table: every share is credited directly.
        seatedUserIds: [],
        payoutTotalPercent: rakeConfig.bbjPayoutTotalPercent,
      });
      const others = [...new Set(hit.dealtInPlayerIds || [])].filter(
        (id) => id !== hit.loserUserId && id !== hit.winnerUserId
      );
      if (outcome.status === 'queued') {
        EngineMetrics.bbjPayoutsQueuedTotal.inc(1);
        emitAll({
          type: 'bbj_payout_pending',
          hand_number: hand.handNumber,
          emitted_at: now(),
          replay_until: now() + 60_000,
          loser: { userId: hit.loserUserId },
          winner: { userId: hit.winnerUserId },
          tablePlayerIds: others,
        });
      }
      if (outcome.status === 'paid') {
        const result = outcome.result;
        EngineMetrics.bbjPayoutsPaidTotal.inc(1);
        emitAll({
          type: 'bbj_payout_complete',
          hand_number: hand.handNumber,
          emitted_at: now(),
          replay_until: now() + 60_000,
          totalPayout: result.totalPayout,
          loser: { userId: hit.loserUserId, share: result.loserShare },
          winner: { userId: hit.winnerUserId, share: result.winnerShare },
          tableShare: result.tableShare,
          perPlayerShare: result.perPlayerShare,
          tablePlayerIds: others,
          updatedStacks: hand.stacks,
        });
      }
    } catch (err) {
      deps.logger.error(`[LightningJackpot:${hand.hostTableId}] jackpot payout threw`, err);
    }
    return 'main';
  }

  const mini = found.mini!;
  const tierId = getTierIdForBB(hand.bigBlind);
  EngineMetrics.bbjMiniHitsDetectedTotal.inc(1);
  emitAll({
    type: 'bbj_hit',
    kind: 'mini',
    hand_number: hand.handNumber,
    emitted_at: now(),
    replay_until: now() + 60_000,
    loser: { userId: mini.loserUserId, hand: mini.loserHand },
    winner: { userId: mini.winnerUserId, hand: mini.winnerHand },
    tableShare: { playerIds: dealt },
    variant: hand.variant,
    miniTierId: tierId,
    miniRule: (mini as { miniRule?: string }).miniRule,
    qualifyingHandLabel: mini.qualifyingHandLabel,
  });
  if (!payable) return 'mini';
  try {
    const outcome = await payMini({
      tableId: hand.hostTableId,
      clubId: hand.clubId!,
      handNumber: hand.handNumber,
      tierId,
      loserUserId: mini.loserUserId!,
      winnerUserId: mini.winnerUserId!,
      dealtInPlayerIds: mini.dealtInPlayerIds || [],
      seatedUserIds: [],
      metadata: {
        rule: (mini as { miniRule?: string }).miniRule,
        variant: mini.variant,
        loser_hand: mini.loserHand?.name,
        winner_hand: mini.winnerHand?.name,
      },
    });
    const others = [...new Set(mini.dealtInPlayerIds || [])].filter(
      (id) => id !== mini.loserUserId && id !== mini.winnerUserId
    );
    if (outcome.status === 'queued') {
      EngineMetrics.bbjMiniPayoutsQueuedTotal.inc(1);
      emitAll({
        type: 'bbj_payout_pending',
        kind: 'mini',
        hand_number: hand.handNumber,
        emitted_at: now(),
        replay_until: now() + 60_000,
        loser: { userId: mini.loserUserId },
        winner: { userId: mini.winnerUserId },
        tablePlayerIds: others,
      });
      return 'mini';
    }
    if (outcome.status !== 'paid') {
      if (outcome.status === 'skipped' && outcome.reason !== 'already_paid') {
        EngineMetrics.bbjMiniPayoutsRefusedTotal.inc(1);
        void recordBBJNearMiss({
          tableId: hand.hostTableId,
          clubId: hand.clubId,
          handNumber: hand.handNumber,
          variant: mini.variant ?? hand.variant,
          bigBlind: hand.bigBlind,
          potSize: hand.potSize,
          playersDealt: (mini.dealtInPlayerIds || []).length,
          userId: mini.loserUserId ?? undefined,
          handName: mini.loserHand?.name,
          reason: `mini_refused:${outcome.reason || 'unspecified'}`,
          message: `Mini jackpot qualified (${(mini as { miniRule?: string }).miniRule ?? 'rule'}) and was refused: ${outcome.reason || 'unspecified'}`,
        }).catch(() => undefined);
      }
      return 'mini';
    }
    EngineMetrics.bbjMiniPayoutsPaidTotal.inc(1);
    emitAll({
      type: 'bbj_payout_complete',
      kind: 'mini',
      hand_number: hand.handNumber,
      emitted_at: now(),
      replay_until: now() + 60_000,
      totalPayout: outcome.total,
      loser: { userId: mini.loserUserId, share: outcome.loser },
      winner: { userId: mini.winnerUserId, share: outcome.winner },
      tableShare: Math.round((outcome.perPlayer * others.length + Number.EPSILON) * 100) / 100,
      perPlayerShare: outcome.perPlayer,
      tablePlayerIds: others,
      updatedStacks: hand.stacks,
    });
  } catch (err) {
    deps.logger.error(`[LightningJackpot:${hand.hostTableId}] mini jackpot payout threw`, err);
  }
  return 'mini';
}
