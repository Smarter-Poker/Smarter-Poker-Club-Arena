/**
 * A REFUSED BUY-IN SAYS WHY (2026-09-06). Every literal below is a message
 * `atomic_table_buyin` (or a trigger on `table_seats`) actually raised on
 * production in the four hours that were measured.
 */
import { describe, it, expect } from 'vitest';
import { classifyBuyInRefusal, formatRefusals } from './HorseBuyInRefusal.js';

describe('classifyBuyInRefusal', () => {
  it('names the refusal that hid the feeder loop for two days', () => {
    expect(
      classifyBuyInRefusal(
        'FOUR TABLE LIMIT: user 8338bf08-f33d-481e-9072-fba81076bc9a is already ' +
          'committed to 4 games and may not take another'
      )
    ).toBe('four_game_limit');
  });

  it('names the six other quiet ones', () => {
    expect(classifyBuyInRefusal('TABLE_CAP_REACHED: already seated at 4 cash tables (max 4)')).toBe(
      'table_cap'
    );
    expect(classifyBuyInRefusal('Insufficient club chips for buy-in (club abc)')).toBe('no_chips');
    expect(classifyBuyInRefusal('Player already seated at this table')).toBe('already_seated');
    expect(
      classifyBuyInRefusal(
        'duplicate key value violates unique constraint "table_seats_table_id_seat_number_key"'
      )
    ).toBe('seat_taken');
    expect(
      classifyBuyInRefusal('BUYIN_BELOW_FLOOR: minimum buy-in for this game right now is 40')
    ).toBe('below_floor');
    expect(classifyBuyInRefusal('Insufficient balance')).toBe('no_chips');
  });

  it('names the loud ones too, so one map covers the whole door', () => {
    expect(
      classifyBuyInRefusal(
        'TABLE_CLOSING: this table is closed and takes no new players - the game will seat you at its next open table'
      )
    ).toBe('table_closing');
    expect(classifyBuyInRefusal('TABLE_SIZE: table is full (6 of 6 seats taken)')).toBe(
      'table_full'
    );
    expect(classifyBuyInRefusal('VPIP_BARRED:7196')).toBe('vpip_barred');
    expect(classifyBuyInRefusal('SEAT_RESERVED: the open seat is held for the next player')).toBe(
      'seat_reserved'
    );
  });

  it('an unrecognised message is still a counter, never a silence', () => {
    expect(classifyBuyInRefusal('something nobody has seen yet')).toBe('refused');
    expect(classifyBuyInRefusal(null)).toBe('refused');
    expect(classifyBuyInRefusal(undefined)).toBe('refused');
  });
});

describe('formatRefusals', () => {
  it('prints non-zero reasons in first-seen order', () => {
    expect(
      formatRefusals(
        new Map([
          ['four_game_limit', 12],
          ['no_chips', 0],
          ['table_full', 3],
        ])
      )
    ).toBe('four_game_limit=12 table_full=3');
  });
});
