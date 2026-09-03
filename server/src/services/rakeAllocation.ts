/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WEIGHTED CONTRIBUTED RAKE — canonical per-player rake allocation (TS mirror)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-29 (BINDING): Club Arena cash games use WEIGHTED CONTRIBUTED
 * rake. A player's credited rake is proportional to the player's actual
 * eligible contribution to the rakeable pot. Being dealt in earns nothing;
 * contributing $0 earns $0; returned uncalled bets never count (the engine
 * already excludes them — returnUncalledBet() decrements totalInvested BEFORE
 * contributions are captured). This RETIRES equal-dealt attribution (FIX 144 /
 * DECISION D-001) for new cash hands.
 *
 * This module is the TypeScript mirror of the SQL source of truth,
 * `public.fn_allocate_rake_credits` (migration
 * 20260829_weighted_contributed_rake.sql). The two implement the IDENTICAL
 * deterministic algorithm and are pinned against the same reference vectors
 * (rakeAllocation.test.ts here; the migration's self-test DO block there).
 * If you change one, change the other IN THE SAME COMMIT.
 *
 * ALGORITHM (integer cents, largest remainder, stable tie-break):
 *   contribCents_i = round(contribution_i * 100)          (positive only)
 *   totalCents     = Σ contribCents_i
 *   amountCents    = round(amount * 100)
 *   numerator_i    = amountCents * contribCents_i         (exact, BigInt)
 *   floor_i        = numerator_i div totalCents
 *   remainder_i    = numerator_i mod totalCents
 *   leftover       = amountCents − Σ floor_i              (< playerCount)
 *   +1 cent to the `leftover` players with the largest remainder_i,
 *   ties broken by user id ascending.
 *
 * Properties: Σ credits == round(amount, 2) EXACTLY (invariants 4 & 9);
 * zero amount -> zero credits (invariant 5); zero contribution -> no credit
 * (invariant 6); re-running the same hand yields identical output
 * (invariant 10 support). BigInt keeps the math exact for play-chip stakes
 * far beyond Number.MAX_SAFE_INTEGER intermediate products.
 *
 * DEALT_EQUAL remains ONLY for processing historical rows under the
 * methodology they were settled with (rake_records.rake_method). It must
 * never be used for a new cash hand.
 */

export type RakeMethod = 'DEALT_EQUAL' | 'WEIGHTED_CONTRIBUTED';

export const WEIGHTED_CONTRIBUTED: RakeMethod = 'WEIGHTED_CONTRIBUTED';
export const DEALT_EQUAL: RakeMethod = 'DEALT_EQUAL';

/**
 * Weighted contributed allocation. Returns a per-user credit map (currency
 * units, 2dp) whose values sum EXACTLY to round(totalAmount, 2). Users with a
 * non-positive contribution get no entry.
 */
export function allocateWeightedShareCents(
  totalAmount: number,
  contributions: Record<string, number> | Array<[string, number]>
): Map<string, number> {
  const map = new Map<string, number>();
  const entries = Array.isArray(contributions) ? contributions : Object.entries(contributions);

  const players: Array<{ uid: string; cc: bigint }> = [];
  let totalCents = 0n;
  for (const [uid, amt] of entries) {
    const n = Number(amt);
    if (!uid || !Number.isFinite(n) || n <= 0) continue;
    const cc = BigInt(Math.round(n * 100));
    if (cc <= 0n) continue;
    players.push({ uid, cc });
    totalCents += cc;
  }
  if (players.length === 0 || totalCents <= 0n) return map;

  const amountCents = BigInt(Math.max(0, Math.round((Number(totalAmount) || 0) * 100)));

  let floorSum = 0n;
  const rows = players.map(({ uid, cc }) => {
    const numerator = amountCents * cc;
    const fl = numerator / totalCents;
    const rem = numerator % totalCents;
    floorSum += fl;
    return { uid, fl, rem };
  });

  // Largest remainder first; ties broken by user id ascending — identical to
  // the SQL `ORDER BY rem DESC, uid ASC`.
  const order = [...rows].sort((a, b) => {
    if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
  let leftover = amountCents - floorSum;
  const extra = new Set<string>();
  for (const row of order) {
    if (leftover <= 0n) break;
    extra.add(row.uid);
    leftover -= 1n;
  }

  for (const row of rows) {
    const cents = row.fl + (extra.has(row.uid) ? 1n : 0n);
    map.set(row.uid, Number(cents) / 100);
  }
  return map;
}

/**
 * LEGACY equal split (FIX 144 / D-001 — SUPERSEDED for new hands, Dan
 * 2026-08-29). Kept verbatim so rake_records rows stamped DEALT_EQUAL keep
 * reproducing their historical attribution. Remainder cents go to the
 * earliest users in the given order (deterministic per hand).
 */
export function allocateEqualShareCents(totalRake: number, userIds: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const n = userIds.length;
  if (n === 0) return map;
  const totalCents = Math.round(totalRake * 100);
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;
  for (const uid of userIds) {
    let cents = base;
    if (remainder > 0) {
      cents += 1;
      remainder -= 1;
    }
    map.set(uid, cents / 100);
  }
  return map;
}

/** The subset of a rake_records row the allocation needs. */
export interface RakeRecordLike {
  rake_amount: number;
  player_contributions: Record<string, number> | null;
  rake_method?: string | null;
}

/**
 * LEDGER-FIRST shares for one rake_records row (POLISH 4, 2026-08-30).
 *
 * `atomic_distribute_rake` already persisted the authoritative per-player
 * allocation into `rake_attributions` at banking time. Recomputing it in JS
 * was a SECOND implementation of the same arithmetic — correct today (it is
 * parity-tested against the SQL twin), but two implementations of one money
 * rule is precisely the shape that produced the equal-dealt bug, the missing
 * pot-overage clamp, and the 49%-underfunded jackpot. Reading what was
 * written removes the divergence risk entirely.
 *
 * `ledger` is the per-hand map the caller batch-loaded (one query per page,
 * not per hand). When a hand has ledger rows they ARE the answer. When it has
 * none — a historical hand, a pruned horse-only hand, a tournament fee row, a
 * null-hand row — we fall back to the canonical allocator, exactly as the SQL
 * side does via fn_rake_shares_for_record. Same contract, same fallback.
 */
export function sharesForRakeRecordWithLedger(
  row: RakeRecordLike & { hand_id?: string | null },
  ledger: Map<string, Map<string, number>>
): Map<string, number> {
  const handId = row.hand_id;
  if (handId) {
    const stored = ledger.get(handId);
    if (stored && stored.size > 0) return stored;
  }
  return sharesForRakeRecord(row);
}

/**
 * Per-player rake credits for one rake_records row, under the methodology the
 * row was SETTLED with. This is the single call every JS consumer (rakeback
 * periods, agent commissions, player_stats) uses — do not re-derive shares
 * anywhere else.
 */
export function sharesForRakeRecord(row: RakeRecordLike): Map<string, number> {
  if (!row.player_contributions) return new Map();
  const dealtIn = Object.entries(row.player_contributions).filter(([, amt]) => Number(amt) > 0);
  if (dealtIn.length === 0) return new Map();
  if (row.rake_method === WEIGHTED_CONTRIBUTED) {
    return allocateWeightedShareCents(Number(row.rake_amount), dealtIn);
  }
  // Historical rows (and pre-deploy engine rows) reproduce their historical
  // equal split — key order, exactly as the settler always iterated them.
  return allocateEqualShareCents(
    Number(row.rake_amount),
    dealtIn.map(([uid]) => uid)
  );
}
