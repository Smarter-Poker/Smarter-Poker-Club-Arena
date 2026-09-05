/**
 * A BUYER IS COUNTED ONCE (2026-09-05).
 *
 * `allocateBuyers` is the number the ClusterController reads as a game's
 * horse demand. Measured before it existed: two spare horses sat in the pool
 * of every full Main 1 on the host, so every full game reported two buyers,
 * every one opened a feeder, two horses filled one, and eleven of twelve
 * feeders opened in an hour were abandoned empty at three minutes.
 */
import { describe, it, expect } from 'vitest';
import { allocateBuyers, FULL_TABLE_BUYER_PROBE } from './HorseBuyerAllocation.js';

const cap = (entries: Array<[string, number]>) => new Map(entries);

describe('allocateBuyers', () => {
  it('one horse in two games pools is allocated once', () => {
    const out = allocateBuyers(
      [
        { tableId: 'A-main1', clusterId: 'A', pool: ['h1'], seatsWanted: 2 },
        { tableId: 'B-main1', clusterId: 'B', pool: ['h1'], seatsWanted: 2 },
      ],
      cap([['h1', 1]])
    );
    expect(out.get('A-main1')).toBe(1);
    expect(out.get('B-main1')).toBe(0);
  });

  it('two spare horses open ONE feeder, not one per full game (the live defect)', () => {
    const pool = ['h1', 'h2'];
    const tables = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'].map((g) => ({
      tableId: `${g}-main1`,
      clusterId: g,
      pool,
      seatsWanted: FULL_TABLE_BUYER_PROBE,
    }));
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
        { tableId: 'full', clusterId: 'A', pool, seatsWanted: FULL_TABLE_BUYER_PROBE },
        { tableId: 'B-open', clusterId: 'B', pool, seatsWanted: 5 },
      ],
      cap(pool.map((h) => [h, 1] as [string, number]))
    );
    expect(out.get('full')).toBe(2);
    // the other three were left for the table with real open seats
    expect(out.get('B-open')).toBe(3);
  });

  it('a horse with capacity 0 is never taken, and an unknown horse has none', () => {
    const out = allocateBuyers(
      [{ tableId: 't', clusterId: 'A', pool: ['zero', 'unknown', 'one'], seatsWanted: 3 }],
      cap([
        ['zero', 0],
        ['one', 1],
      ])
    );
    expect(out.get('t')).toBe(1);
  });

  it('respects the order given: the first table in the walk is served first', () => {
    const tables = [
      { tableId: 'opening-feeder', clusterId: 'A', pool: ['h1', 'h2'], seatsWanted: 2 },
      { tableId: 'B-main1', clusterId: 'B', pool: ['h1', 'h2'], seatsWanted: 2 },
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
    expect(reversed.get('B-main1')).toBe(2);
    expect(reversed.get('opening-feeder')).toBe(0);
  });

  it('a horse with capacity for two tables may serve two GAMES, never two tables of one game', () => {
    const out = allocateBuyers(
      [
        { tableId: 'A-main1', clusterId: 'A', pool: ['h1'], seatsWanted: 1 },
        { tableId: 'A-feeder', clusterId: 'A', pool: ['h1'], seatsWanted: 1 },
        { tableId: 'B-main1', clusterId: 'B', pool: ['h1'], seatsWanted: 1 },
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
      ['A', 'B', 'C', 'D'].map((g) => ({
        tableId: `${g}-main1`,
        clusterId: g,
        pool,
        seatsWanted: 1,
      })),
      cap([['grinder', 1]])
    );
    expect([...out.values()]).toEqual([1, 0, 0, 0]);
  });

  it('a duplicate id inside one pool counts once, and a zero ask returns zero', () => {
    const out = allocateBuyers(
      [
        { tableId: 'dup', clusterId: 'A', pool: ['h1', 'h1'], seatsWanted: 2 },
        { tableId: 'none', clusterId: 'B', pool: ['h2'], seatsWanted: 0 },
      ],
      cap([
        ['h1', 4],
        ['h2', 4],
      ])
    );
    expect(out.get('dup')).toBe(1);
    expect(out.get('none')).toBe(0);
  });

  it('every table asked about gets an answer, even an empty pool', () => {
    const out = allocateBuyers(
      [{ tableId: 'lonely', clusterId: 'A', pool: [], seatsWanted: 2 }],
      cap([])
    );
    expect(out.get('lonely')).toBe(0);
  });
});
