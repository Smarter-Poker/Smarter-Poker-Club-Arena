/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHO WON A KNOCKOUT — reading the `bounty_collected` broadcast
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Knockout audit 2026-09-04. The 2026-08-31 split-pot ruling made
 * `fn_collect_bounty` divide a tied pot's bounty between every winner of the
 * pot by claim weight, and halve each share onto its own head in a PKO. The
 * MONEY was right from that day. The BROADCAST was not: it kept sending the
 * total under one `knockerUserId`, so TablePage flew the whole bounty to one
 * of the two winners, drew nothing at the other, and in a PKO put the whole
 * `addedToHead` on one head badge. Measured against production: 55 split
 * knockouts between 08-30 and 09-04, every one of them animated wrong.
 *
 * The engine now sends `shares` (one row per winner) on a split knockout and
 * nothing extra on the ordinary one. This is the ONE place that reads it, so
 * the single-winner and split-winner cases cannot drift apart between the
 * animation, the money float and the head badge — they all ask this.
 *
 * Contract:
 *   - `shares` with two or more rows wins over the flat fields. Each row is a
 *     winner with their own cash and their own head increment.
 *   - Otherwise the flat `knockerUserId` / `amount` / `addedToHead` are the one
 *     winner, exactly as every engine build before today sent them. An older
 *     engine that never sends `shares` therefore behaves precisely as before.
 *   - Rows without a user id are dropped. A knockout paid to nobody is not a
 *     winner and must not open a float on an unresolvable seat.
 *   - Amounts are numbers or zero. `Number(undefined)` is NaN and NaN > 0 is
 *     false, so a missing field would silently skip a float; coalescing to 0
 *     makes that explicit.
 */

export interface BountyWinner {
  userId: string;
  name: string;
  /** Cash paid to this winner for this knockout, in chips. */
  amount: number;
  /** PKO only: what landed on this winner's own head. 0 elsewhere. */
  addedToHead: number;
}

interface WireShare {
  userId?: unknown;
  user_id?: unknown;
  name?: unknown;
  amount?: unknown;
  cash?: unknown;
  addedToHead?: unknown;
  to_head?: unknown;
}

interface WirePayload {
  knockerUserId?: unknown;
  knockerName?: unknown;
  amount?: unknown;
  addedToHead?: unknown;
  shares?: unknown;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v == null ? '' : String(v));

/** Every winner of the pot that took this head, with what each one got. */
export function bountyWinnersOf(payload: WirePayload | null | undefined): BountyWinner[] {
  const b = payload || {};
  const rawShares = Array.isArray(b.shares) ? (b.shares as WireShare[]) : [];
  const shares: BountyWinner[] = rawShares
    .map((s) => ({
      userId: str(s?.userId ?? s?.user_id),
      name: str(s?.name) || 'Player',
      amount: num(s?.amount ?? s?.cash),
      addedToHead: num(s?.addedToHead ?? s?.to_head),
    }))
    .filter((s) => s.userId.length > 0);

  if (shares.length > 1) return shares;

  const knockerUserId = str(b.knockerUserId);
  if (!knockerUserId) return [];
  return [
    {
      userId: knockerUserId,
      name: str(b.knockerName) || 'Player',
      amount: num(b.amount),
      addedToHead: num(b.addedToHead),
    },
  ];
}
