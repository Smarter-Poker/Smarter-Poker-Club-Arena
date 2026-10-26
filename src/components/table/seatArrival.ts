import { useLayoutEffect, useState } from 'react';

export interface SeatArrival {
  key: string;
  playerId: string;
  delayMs: number;
}
type Occupant = { id: string; isHero?: boolean } | null;
interface Ledger {
  scope: string;
  signature: string;
  known: string[];
  /**
   * LIGHTNING TRANSITION, PHASE 3: the chair each known player (the last
   * roster's occupants, like `known`) sat in.
   * A player met before who is dealt in at a DIFFERENT chair arrives there
   * too; without this they appeared at the new chair with no fade at all.
   * Optional so a ledger from before this field still reads.
   */
  seats?: Record<string, number>;
  serial: number;
  arrivals: Record<number, SeatArrival>;
}
export function nextSeatArrivals(
  previous: Ledger,
  scope: string,
  players: readonly Occupant[]
): Ledger {
  const base =
    previous.scope === scope
      ? previous
      : { scope, signature: '', known: [], seats: {}, serial: 0, arrivals: {} };
  const signature = JSON.stringify(players.map((p) => p?.id ?? null));
  if (base.signature === signature) return base;
  const present = players.filter((p): p is NonNullable<Occupant> => !!p);
  // An idle/reconnect frame is not evidence that these occupants left the pool.
  if (!present.length) return { ...base, signature, arrivals: {} };
  let rank = 0;
  const arrivals: Record<number, SeatArrival> = {};
  const seats: Record<string, number> = {};
  players.forEach((p, index) => {
    if (!p) return;
    seats[p.id] = index + 1;
    const lastSeat = base.seats?.[p.id];
    const moved = lastSeat !== undefined && lastSeat !== index + 1;
    if ((!base.known.includes(p.id) || moved) && !p.isHero) {
      arrivals[index + 1] = {
        key: `${scope}:${base.serial + 1}:${p.id}`,
        playerId: p.id,
        delayMs: Math.min(400, rank++ * 80),
      };
    } else if (base.arrivals[index + 1]?.playerId === p.id)
      arrivals[index + 1] = base.arrivals[index + 1];
  });
  return {
    scope,
    signature,
    known: present.map((p) => p.id),
    seats,
    serial: base.serial + 1,
    arrivals,
  };
}
export function useSeatArrivals(
  scope: string,
  players: readonly Occupant[]
): Record<number, SeatArrival> {
  const [ledger, setLedger] = useState<Ledger>({
    scope,
    signature: '',
    known: [],
    serial: 0,
    arrivals: {},
  });
  const next = nextSeatArrivals(ledger, scope, players);
  useLayoutEffect(() => {
    if (next !== ledger) setLedger(next);
  }, [next, ledger]);
  return next.arrivals;
}
