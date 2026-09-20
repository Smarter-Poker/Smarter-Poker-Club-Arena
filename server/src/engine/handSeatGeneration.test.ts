import { describe, expect, it } from 'vitest';
import {
  captureHandSeatGenerations,
  handStackBefore,
  requireHandSeatGeneration,
} from './handSeatGeneration.js';

const player = () => ({
  user_id: 'player-one',
  seat_id: '10000000-0000-4000-8000-000000000001',
  seat_joined_at: '2026-09-09T10:00:00.123456+00:00',
});

describe('dealt hand seat generation', () => {
  it('never certifies an ending-stack fallback as an original starting observation', () => {
    const generations = captureHandSeatGenerations([player()]);
    expect(handStackBefore(generations, new Map(), player().user_id, 50)).toBe(50);
    generations.set(player().user_id, {
      ...generations.get(player().user_id)!,
      funding_manifest_id: player().seat_id,
      funding_stack_before: 0,
    });
    expect(handStackBefore(generations, new Map(), player().user_id, 50)).toBe(0);
    expect(
      handStackBefore(generations, new Map([[player().user_id, 99]]), player().user_id, 50)
    ).toBe(0);
  });
  it('retains microsecond identity when the roster row changes after dealing', () => {
    const row = player();
    const dealt = captureHandSeatGenerations([row]);
    const settled = new Map(dealt);
    row.seat_joined_at = '2026-09-09T10:00:01.123456+00:00';
    row.seat_id = '10000000-0000-4000-8000-000000000002';
    expect(requireHandSeatGeneration(settled, row.user_id)).toEqual({
      seat_id: player().seat_id,
      seat_joined_at: player().seat_joined_at,
    });
  });

  it.each([
    { seat_id: undefined },
    { seat_joined_at: undefined },
    { seat_id: 'not-a-seat' },
    { seat_joined_at: 'not-a-timestamp' },
  ])('refuses an incomplete dealt identity %j', (invalid) => {
    expect(() => captureHandSeatGenerations([{ ...player(), ...invalid }])).toThrow(
      'invalid_seat_generation'
    );
  });

  it('refuses duplicate roster users before a hand is opened', () => {
    expect(() => captureHandSeatGenerations([player(), player()])).toThrow(
      'invalid_seat_generation'
    );
  });

  it('cannot substitute a current roster for a missing dealt participant', () => {
    expect(() =>
      requireHandSeatGeneration(captureHandSeatGenerations([player()]), 'other-player')
    ).toThrow('missing_dealt_seat_generation');
  });
});
