/**
 * What a busted horse should do next — and for how much.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE HOLE THIS FILLS
 * ─────────────────────────────────────────────────────────────────────────
 * Both rebuy sites in the engine did the same two things wrong. They sized
 * the reload as `big_blind * 100` flat — ignoring the table's own minimum and
 * maximum, and the horse's roll entirely — and they asked only one question
 * before reloading: "have I already rebought twice?"
 *
 * So a horse whose bankroll could no longer support a stake reloaded it
 * anyway, forever, at a stack the table might not even permit. That is the
 * precise opposite of the discipline Dan asked for on 2026-08-31: "not risk
 * more of their stack than they should... going down or up in stakes as their
 * bankroll grows or shrinks." A horse that cannot afford the game is supposed
 * to LEAVE it, drop a rung, and come back.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES **NOT** CHANGE: WHERE THE CHIPS COME FROM
 * ─────────────────────────────────────────────────────────────────────────
 * A horse is still funded from the club treasury by `fn_horse_fund_from_
 * treasury`, exactly as before. This module decides only WHETHER and HOW MUCH.
 * No money path is touched, no conservation rule moves, and CLAUDE.md 11.5 is
 * not engaged: nothing here debits, credits, or probes a live balance-moving
 * function.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS MAKES A HORSE MORE OF A PLAYER, NOT LESS (CLAUDE.md 10.5)
 * ─────────────────────────────────────────────────────────────────────────
 * A human's reload is limited by their own wallet. Until now a horse's was
 * limited by nothing at all — which is an asymmetry in the horse's FAVOUR, and
 * the law is symmetrical in both directions: "the same features, the same
 * functionality, the same rules." Applying the roll to the horse's reload is
 * what makes the two identical.
 *
 * Timing is untouched. The five-second rebuy window, the pause, the cadence
 * are all upstream of this call and stay exactly as they are — this only
 * decides the answer the horse gives inside that window, which is the same
 * thing the window exists to let a human decide.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAILING OPEN
 * ─────────────────────────────────────────────────────────────────────────
 * An unreadable balance returns the legacy amount, never zero. `readClubChip
 * Balances` distinguishes "zero" from "could not read" by key ABSENCE for
 * exactly this reason, and the cost of the two mistakes is not symmetrical: a
 * wrong reload is one buy-in, a wrong stand-up empties a table that had a
 * game in it.
 */

import { createHash } from 'node:crypto';
import { bankrollPolicyFor, rebuyDecision, referenceBuyIn } from './HorseBankroll.js';
import { bankrollEvent } from './HorseBankrollTelemetry.js';

/**
 * The wallet read is imported LAZILY, inside the one async function that
 * needs it. `./supabase/wallets.js` pulls in the live client, which aborts
 * the process when SUPABASE_SERVICE_ROLE_KEY is unset — so a static import
 * here would make merely LOADING this module a database dependency, and the
 * pure decision functions beside it untestable without production secrets.
 */

export interface HorseRebuyRequest {
  clubId: string;
  userId: string;
  bigBlind: number;
  minBuyIn?: number | null;
  maxBuyIn?: number | null;
  /** Reloads already taken this session. Buy-ins committed is this plus one. */
  rebuysTaken: number;
}

/**
 * One durable name for one horse bust.
 *
 * A random per-request key does not survive an engine crash or a lost RPC
 * response. Table + player + authoritative hand number identifies the only
 * legitimate rebuy produced by that bust, so every retry and replacement
 * process presents the same UUID and the treasury function can answer the
 * original receipt instead of funding the same stack twice.
 */
export function horseRebuyOperationId(tableId: string, userId: string, handNumber: number): string {
  const hex = createHash('sha256')
    .update(`horse-cash-rebuy|${tableId}|${userId}|${Math.max(0, Math.trunc(handNumber))}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** The flat sizing both call sites used before this module existed. */
export function legacyRebuyAmount(bigBlind: number): number {
  return bigBlind > 0 ? bigBlind * 100 : 200;
}

/** Is this horse done reloading, on temperament alone? Cheap and synchronous. */
export function atRebuyStopLoss(userId: string, rebuysTaken: number): boolean {
  // rebuysTaken + 1 is the buy-ins COMMITTED - see rebuyDecision for why the
  // off-by-one matters to six in ten of the fleet.
  const done = rebuysTaken + 1 >= bankrollPolicyFor(userId).stopLossBuyIns;
  if (done) bankrollEvent('rebuy_refused_stop_loss');
  return done;
}

/**
 * The amount to rebuy for, or 0 for "stand up".
 *
 * Zero here means the horse is choosing to leave — the caller must treat it
 * the same way it already treats a failed funding call.
 */
export async function horseRebuyAmount(req: HorseRebuyRequest): Promise<number> {
  const { clubId, userId, bigBlind, rebuysTaken } = req;
  const legacy = legacyRebuyAmount(bigBlind);
  const policy = bankrollPolicyFor(userId);

  if (rebuysTaken + 1 >= policy.stopLossBuyIns) {
    bankrollEvent('rebuy_refused_stop_loss');
    return 0;
  }

  const minB = Number(req.minBuyIn) > 0 ? Number(req.minBuyIn) : legacy;
  const maxB = Number(req.maxBuyIn) > 0 ? Number(req.maxBuyIn) : legacy;
  const ref = referenceBuyIn(bigBlind, minB, maxB);

  if (!clubId || !userId) return legacy; // unknown club -> fail open

  let roll: number | undefined;
  try {
    const { readClubChipBalances } = await import('./supabase/wallets.js');
    const balances = await readClubChipBalances(clubId, [userId]);
    roll = balances.get(userId);
  } catch {
    return legacy; // a thrown read is an unknown balance, not a poor one
  }
  if (roll === undefined) return legacy; // ABSENT means unread. Fail open.

  const amount = rebuyDecision({
    bankroll: roll,
    refBuyIn: ref,
    minBuyIn: minB,
    maxBuyIn: maxB,
    desired: legacy,
    rebuysTaken,
    policy,
  });
  if (amount <= 0) bankrollEvent('rebuy_refused_underrolled');
  return amount;
}
