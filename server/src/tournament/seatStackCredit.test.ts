/**
 * The production games behind `docs/changelog/2026-09-02-chip-std-spin-chips.md`
 * as fixtures. Each `it` below is a game whose chip total broke across an
 * engine restart because creditSeatStacks raised seats to starting_chips.
 * Against the rule that shipped in #2333 (`playUnderWay ? stack <= 0 :
 * stack < target`, play read from hand_history) the first three are red.
 */
import { describe, expect, it } from 'vitest';
import { selectSeatsToFund, tournamentChipSupply } from './seatStackCredit.js';

const seat = (id: string, stack: number) => ({ id, stack });

describe('selectSeatsToFund - the restart mint, game by game', () => {
  it('0573b719: a busted seat during play is NOT a stranded reservation (+1000)', () => {
    // hand 3976291 ended 0 / 1527 / 1473; SIGTERM before the elimination
    // sweep; resume() found seat 1 live at 0 and #2333's branch funded it.
    const d = selectSeatsToFund({
      seats: [seat('s1', 0), seat('s2', 1527), seat('s3', 1473)],
      target: 1000,
      handRecorded: true,
      chipSupply: 3000,
    });
    expect(d.playUnderWay).toBe(true);
    expect(d.fund).toEqual([]);
    expect(d.credit).toBe(0);
  });

  it('3a2fee36: a seat above the target is proof of play even with no hand row (+320)', () => {
    // hand_history had no row for the game after the 04:09 restart, but one
    // seat held 620 on a 300-chip board. The old rule read "no hand dealt
    // yet" and raised both short seats to 300.
    const d = selectSeatsToFund({
      seats: [seat('s1', 20), seat('s2', 620), seat('s3', 260)],
      target: 300,
      handRecorded: false,
      chipSupply: 900,
    });
    expect(d.playUnderWay).toBe(true);
    expect(d.fund).toEqual([]);
  });

  it('2579af22 / 39607ce4: losing seats are never topped up (pre-#2333 shape)', () => {
    for (const seats of [
      [seat('a', 664), seat('b', 1336)],
      [seat('a', 1587), seat('b', 915), seat('c', 498)],
    ]) {
      const d = selectSeatsToFund({ seats, target: 1000, handRecorded: true, chipSupply: 3000 });
      expect(d.fund).toEqual([]);
    }
  });

  it('funds the genuine stranded reservation: every seat at 0, no hand, within supply', () => {
    const d = selectSeatsToFund({
      seats: [seat('a', 0), seat('b', 0), seat('c', 0)],
      target: 300,
      handRecorded: false,
      chipSupply: 900,
    });
    expect(d.playUnderWay).toBe(false);
    expect(d.fund).toEqual(['a', 'b', 'c']);
    expect(d.credit).toBe(900);
    expect(d.refused).toBeNull();
  });

  it('raises a placeholder tier to the drawn stack before the first deal', () => {
    const d = selectSeatsToFund({
      seats: [seat('a', 300), seat('b', 300), seat('c', 300)],
      target: 1000,
      handRecorded: false,
      chipSupply: 3000,
    });
    expect(d.fund).toEqual(['a', 'b', 'c']);
    expect(d.credit).toBe(2100);
  });

  it('refuses a pre-deal credit that would put more chips on the felt than were issued', () => {
    const d = selectSeatsToFund({
      seats: [seat('a', 0), seat('b', 300), seat('c', 300)],
      target: 300,
      // roster says two entrants only: seat a is not a reservation anyone paid for
      chipSupply: 600,
      handRecorded: false,
    });
    expect(d.fund).toEqual([]);
    expect(d.refused).toEqual({ reason: 'exceeds_supply', feltTotal: 600, chipSupply: 600 });
  });

  it('applies no ceiling when the supply could not be read, but still refuses in play', () => {
    const preDeal = selectSeatsToFund({
      seats: [seat('a', 0), seat('b', 0)],
      target: 300,
      handRecorded: false,
      chipSupply: null,
    });
    expect(preDeal.fund).toEqual(['a', 'b']);
    const inPlay = selectSeatsToFund({
      seats: [seat('a', 0), seat('b', 600)],
      target: 300,
      handRecorded: false,
      chipSupply: null,
    });
    expect(inPlay.fund).toEqual([]);
  });

  it('a hand read that failed is treated as play under way', () => {
    const d = selectSeatsToFund({
      seats: [seat('a', 0), seat('b', 0)],
      target: 300,
      handRecorded: true,
      chipSupply: 600,
    });
    expect(d.fund).toEqual([]);
  });

  it('funds nothing on a non-positive target', () => {
    expect(
      selectSeatsToFund({ seats: [seat('a', 0)], target: 0, handRecorded: false, chipSupply: 0 })
        .fund
    ).toEqual([]);
  });
});

describe('tournamentChipSupply', () => {
  it('is entrants x starting stack for a fixed-entry spin/SNG', () => {
    expect(
      tournamentChipSupply({ entrants: 3, startingChips: 1000, rebuyCount: 0, addonCount: 0 })
    ).toBe(3000);
  });

  it('adds rebuy and add-on grants with the same defaults process_tournament_rebuy uses', () => {
    expect(
      tournamentChipSupply({
        entrants: 10,
        startingChips: 1000,
        rebuyCount: 3,
        addonCount: 2,
        rebuyChips: 1500,
        addonChips: null,
      })
    ).toBe(10 * 1000 + 3 * 1500 + 2 * 1000);
  });
});
