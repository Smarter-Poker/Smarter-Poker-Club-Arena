/**
 * A BUYER IS COUNTED ONCE (2026-09-05), AND A FEEDER KEEPS THE ONES IT WAS
 * OPENED FOR (2026-09-06).
 *
 * `allocateBuyers` is the number the ClusterController reads as a game's
 * horse demand. Measured before it existed: two spare horses sat in the pool
 * of every full Main 1 on the host, so every full game reported two buyers,
 * every one opened a feeder, two horses filled one, and eleven of twelve
 * feeders opened in an hour were abandoned empty at three minutes.
 *
 * Measured again on 2026-09-06 (26 feeders opened in four hours, 15 live, 15
 * abandoned): an opening feeder was served first only because the fleet's
 * sort happened to rank it -1. The claim is explicit now, and the pins below
 * that used to assert the sort order assert the claim instead.
 */
import { describe, it, expect } from 'vitest';
import {
  allocateBuyers,
  FEEDER_BUYERS_TO_GO_LIVE,
  FULL_TABLE_BUYER_PROBE,
  type BuyerClaim,
  type BuyerPool,
} from './HorseBuyerAllocation.js';

const cap = (entries: Array<[string, number]>) => new Map(entries);
const table = (
  tableId: string,
  clusterId: string | null,
  pool: string[],
  seatsWanted: number,
  claim: BuyerClaim = 'seating'
): BuyerPool => ({ tableId, clusterId, pool, seatsWanted, claim });

describe('allocateBuyers', () => {
  it('one horse in two games pools is allocated once', () => {
    const out = allocateBuyers(
      [table('A-main1', 'A', ['h1'], 2, 'probe'), table('B-main1', 'B', ['h1'], 2, 'probe')],
      cap([['h1', 1]])
    );
    expect(out.get('A-main1')).toBe(1);
    expect(out.get('B-main1')).toBe(0);
  });

  it('two spare horses open ONE feeder, not one per full game (the live defect)', () => {
    const pool = ['h1', 'h2'];
    const tables = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((g) =>
      table(`${g}-main1`, g, pool, FULL_TABLE_BUYER_PROBE, 'probe')
    );
    const out = allocateBuyers(
      tables,
      cap([
        ['h1', 1],
        ['h2', 1],
      ])
    );
    const withTwo = [...out.values()].filter((n) => n >= 2).length;
    expect(withTwo).toBe(1);
    expect([...out.values()].reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('a full table never takes more than the probe size', () => {
    expect(FULL_TABLE_BUYER_PROBE).toBe(2);
    const pool = ['h1', 'h2', 'h3', 'h4', 'h5'];
    const out = allocateBuyers(
      [
        table('full', 'A', pool, FULL_TABLE_BUYER_PROBE, 'probe'),
        table('B-open', 'B', pool, 5, 'seating'),
      ],
      cap(pool.map((h) => [h, 1] as [string, number]))
    );
    expect(out.get('full')).toBe(2);
    // the other three were left for the table with real open seats
    expect(out.get('B-open')).toBe(3);
  });

  it('a horse with capacity 0 is never taken, and an unknown horse has none', () => {
    const out = allocateBuyers(
      [table('t', 'A', ['zero', 'unknown', 'one'], 3)],
      cap([
        ['zero', 0],
        ['one', 1],
      ])
    );
    expect(out.get('t')).toBe(1);
  });

  /* MOVED 2026-09-06. This pin used to assert that the walk order decided who
     was served first, and proved it by reversing the array. The claim is what
     decides now, so the same reversal must NOT change the answer - which is
     the whole point of making the reservation explicit. */
  it('an opening feeder is served first wherever it sits in the walk', () => {
    const tables = [
      table('opening-feeder', 'A', ['h1', 'h2'], 2, 'reserved'),
      table('B-main1', 'B', ['h1', 'h2'], 2, 'probe'),
    ];
    const forward = allocateBuyers(
      tables,
      cap([
        ['h1', 1],
        ['h2', 1],
      ])
    );
    expect(forward.get('opening-feeder')).toBe(2);
    expect(forward.get('B-main1')).toBe(0);
    const reversed = allocateBuyers(
      [...tables].reverse(),
      cap([
        ['h1', 1],
        ['h2', 1],
      ])
    );
    expect(reversed.get('opening-feeder')).toBe(2);
    expect(reversed.get('B-main1')).toBe(0);
  });

  it('an opening feeder gets its two before another GAME takes them', () => {
    const pool = ['h1', 'h2'];
    const out = allocateBuyers(
      [
        // a table with real open seats, listed first and wanting everybody
        table('B-main1', 'B', pool, 6, 'seating'),
        table('A-feeder', 'A', pool, FEEDER_BUYERS_TO_GO_LIVE, 'reserved'),
      ],
      cap([
        ['h1', 1],
        ['h2', 1],
      ])
    );
    expect(out.get('A-feeder')).toBe(2);
    expect(out.get('B-main1')).toBe(0);
  });

  it('the reservation is capped at the two the feeder goes live on', () => {
    expect(FEEDER_BUYERS_TO_GO_LIVE).toBe(2);
    const pool = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    const out = allocateBuyers(
      [
        // a caller asking for the whole table still only claims two
        table('A-feeder', 'A', pool, 6, 'reserved'),
        table('B-main1', 'B', pool, 4, 'seating'),
      ],
      cap(pool.map((h) => [h, 1] as [string, number]))
    );
    expect(out.get('A-feeder')).toBe(2);
    expect(out.get('B-main1')).toBe(4);
  });

  it('a probe of a game that already holds a reservation reports the claim, it does not book a second set', () => {
    const pool = ['h1', 'h2', 'h3', 'h4'];
    const out = allocateBuyers(
      [
        table('A-feeder', 'A', pool, FEEDER_BUYERS_TO_GO_LIVE, 'reserved'),
        table('A-main1', 'A', pool, FULL_TABLE_BUYER_PROBE, 'probe'),
        table('B-main1', 'B', pool, FULL_TABLE_BUYER_PROBE, 'probe'),
      ],
      cap(pool.map((h) => [h, 1] as [string, number]))
    );
    expect(out.get('A-feeder')).toBe(2);
    // A's own probe answers with the claim already made, and takes nobody new
    expect(out.get('A-main1')).toBe(2);
    // ...so the other two horses are still there for the next game
    expect(out.get('B-main1')).toBe(2);
  });

  it('the claim dies with the feeder: the same board with no opening table reserves nothing', () => {
    const pool = ['h1', 'h2'];
    const board = (claim: BuyerClaim) =>
      allocateBuyers(
        [
          table('A-feeder', 'A', pool, FEEDER_BUYERS_TO_GO_LIVE, claim),
          table('B-main1', 'B', pool, FULL_TABLE_BUYER_PROBE, 'probe'),
        ],
        cap([
          ['h1', 1],
          ['h2', 1],
        ])
      );
    // opening: the feeder holds both
    expect(board('reserved').get('A-feeder')).toBe(2);
    expect(board('reserved').get('B-main1')).toBe(0);
    // live (or abandoned, and gone): no claim, the walk order decides again
    const live = board('seating');
    expect(live.get('A-feeder')).toBe(2);
    expect(live.get('B-main1')).toBe(0);
    // and a feeder listed AFTER the other game no longer wins
    const after = allocateBuyers(
      [
        table('B-main1', 'B', pool, FULL_TABLE_BUYER_PROBE, 'probe'),
        table('A-feeder', 'A', pool, FEEDER_BUYERS_TO_GO_LIVE, 'seating'),
      ],
      cap([
        ['h1', 1],
        ['h2', 1],
      ])
    );
    expect(after.get('B-main1')).toBe(2);
    expect(after.get('A-feeder')).toBe(0);
  });

  it('a human waitlist is untouched by any of this: the allocation only ever counts horses', () => {
    /* The controller adds `v_waiting` (the humans on the game's waitlist) to
       whatever this returns - 18.3's `v_buyers := v_waiting + eligible`. This
       function never sees a waitlist row, so no reservation can take a seat
       from a person or change the number they contribute. The pin is that a
       board with NO horse capacity at all still answers zero rather than
       anything that could subtract from the human count. */
    const out = allocateBuyers(
      [
        table('A-feeder', 'A', ['h1'], FEEDER_BUYERS_TO_GO_LIVE, 'reserved'),
        table('A-main1', 'A', ['h1'], FULL_TABLE_BUYER_PROBE, 'probe'),
      ],
      cap([['h1', 0]])
    );
    expect(out.get('A-feeder')).toBe(0);
    expect(out.get('A-main1')).toBe(0);
    expect([...out.values()].every((n) => n >= 0)).toBe(true);
  });

  it('a horse with capacity for two tables may serve two GAMES, never two tables of one game', () => {
    const out = allocateBuyers(
      [
        table('A-main1', 'A', ['h1'], 1),
        table('A-feeder', 'A', ['h1'], 1),
        table('B-main1', 'B', ['h1'], 1),
      ],
      cap([['h1', 2]])
    );
    expect(out.get('A-main1')).toBe(1);
    expect(out.get('A-feeder')).toBe(0);
    expect(out.get('B-main1')).toBe(1);
  });

  it('capacity is spent across the walk: a grinder at three tables opens one more, not four', () => {
    const pool = ['grinder'];
    const out = allocateBuyers(
      ['A', 'B', 'C', 'D'].map((g) => table(`${g}-main1`, g, pool, 1)),
      cap([['grinder', 1]])
    );
    expect([...out.values()]).toEqual([1, 0, 0, 0]);
  });

  it('a duplicate id inside one pool counts once, and a zero ask returns zero', () => {
    const out = allocateBuyers(
      [table('dup', 'A', ['h1', 'h1'], 2), table('none', 'B', ['h2'], 0)],
      cap([
        ['h1', 4],
        ['h2', 4],
      ])
    );
    expect(out.get('dup')).toBe(1);
    expect(out.get('none')).toBe(0);
  });

  it('every table asked about gets an answer, even an empty pool', () => {
    const out = allocateBuyers([table('lonely', 'A', [], 2)], cap([]));
    expect(out.get('lonely')).toBe(0);
  });
});
